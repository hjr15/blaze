// scripts/model/identity-db.mjs — where a board's identities actually live (BLZ-348).
//
// ADR-0013 gave identity four tables and a store; it did not say where the file goes,
// and nothing opened one. This is that missing half-inch of plumbing.
//
// `<dataRoot>/.blaze/identity.db`, beside the shadow database and under the same
// gitignored directory. NOT inside the shadow database, and deliberately so: the shadow
// is a soak artifact that `blaze db init` may recreate from the corpus at will, and
// credentials must not be destroyed by an operation whose stated purpose is "reload the
// tickets". They are also on different lifecycles — a board with no database at all can
// still have users.
//
// ADR-0014 holds: these are the identity tables for THIS board and no other. There is no
// tenant or board discriminator; `membership.scope_key` is the sanctioned widening seam
// and it stays '*'.
//
// Everything here is SYNCHRONOUS. `startServer()` must decide whether it may bind at all
// before it calls `.listen()`, and a bind check that resolves a microtask later is a bind
// check that runs after the socket is open.
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { identityDdl } from "./identity-schema.mjs";
import { identityStore } from "./identity-store.mjs";

/** The one location. Exported so tests and docs cannot drift from it. */
export const identityDbPath = (dataRoot) => join(dataRoot, ".blaze", "identity.db");

// node:sqlite is loaded through createRequire rather than a static import so that the
// overwhelmingly common case — a loopback board with no identity file — never pays for
// it, and never prints its experimental warning.
function DatabaseSync() {
  return createRequire(import.meta.url)("node:sqlite").DatabaseSync;
}

/**
 * Tighten permissions, best-effort.
 *
 * Never fatal: on a read-only mount or a filesystem with no POSIX modes the chmod
 * cannot succeed and must not stop a board from authenticating. It is defence for the
 * machine that CREATED the file, which is the machine that can act on it.
 */
function harden(target, mode) {
  try { chmodSync(target, mode); } catch { /* not ours to tighten */ }
}

/** The {run, all} shape identityStore wants, over a synchronous node:sqlite handle. */
export function identityExec(db) {
  return {
    run(sql, params = []) { return db.prepare(sql).run(...params); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
  };
}

/**
 * Open the identity database.
 *
 * @param create  when false (the default) a missing file is `null` rather than an empty
 *                database — "no identities configured" is a real state with defined
 *                behaviour (loopback-only), not an error and not something to
 *                materialise by accident.
 */
export function openIdentityDb(dataRoot, { create = false } = {}) {
  const path = identityDbPath(dataRoot);
  if (!create && !existsSync(path)) return null;
  // 0700, not the default 0755. The roster and its roles are not world-readable, and a
  // group-writable .blaze/ would let any same-group local user REPLACE identity.db with
  // one naming themselves admin — a substitution the token hashes do nothing to prevent.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  harden(dirname(path), 0o700);
  const db = new (DatabaseSync())(path);
  // busy_timeout, because node:sqlite defaults to 0: an authentication's last-used UPDATE
  // collided instantly with any concurrent `blaze user add` and threw SQLITE_BUSY. Five
  // seconds is far beyond a write this small; it waits instead of failing.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  //
  // DELIBERATELY NOT WAL, and this is not an oversight — please do not "fix" it.
  // A WAL database on a READ-ONLY filesystem cannot be QUERIED: SQLite must create
  // -wal/-shm to read it. Measured against a 0444 file in a 0555 directory:
  //
  //   journal_mode=delete, clean close      ctor ok,  SELECT ok
  //   journal_mode=wal,    clean close      ctor ok,  SELECT FAILS
  //                                                   "attempt to write a readonly database"
  //   journal_mode=wal,    unclean exit     ctor ok,  SELECT ok  (sidecars still present)
  //
  // Two details worth stating exactly, so nobody disproves a sloppy version of this and
  // re-adds WAL on the strength of it. The CONSTRUCTOR always succeeds — node:sqlite
  // opens lazily, so the failure surfaces on the first statement, not on open. And a WAL
  // database whose -wal/-shm sidecars survived an unclean exit reads fine read-only.
  // Neither rescues the case that matters: SQLite REMOVES those sidecars on a clean
  // close, so a board shut down properly and then mounted read-only is the failing row.
  //
  // `docker run -v <board>:/data:ro` is the Dockerfile's own hardened deployment, and the
  // mode is sticky: setting WAL once on a writable board breaks every later read-only
  // mount of it. busy_timeout already fixes the contention this was meant to address.
  if (create) db.exec(identityDdl("sqlite"));
  // Tightened on EVERY open, not only on creation. The read path — loadIdentity, which
  // every startServer boot takes — is the one that runs constantly, and leaving it out
  // meant a file loosened after creation stayed loosened for the life of the board.
  harden(path, 0o600);
  const exec = identityExec(db);
  return { db, exec, path, store: identityStore(exec, { dialect: "sqlite" }) };
}

/**
 * The message a board gets when its roster exists but cannot be read.
 *
 * Deliberately NOT the bind-safety wording. Diagnosing a corrupt roster as "no users
 * configured" sent operators to `blaze user add` for a database that was already there —
 * the one instruction guaranteed not to help.
 */
function brokenIdentityError(path, cause) {
  return `blaze: refusing to serve — the identity database at ${path}\n`
    + "exists but cannot be read.\n\n"
    + `    ${String(cause?.message ?? cause).trim()}\n\n`
    + "This is a REFUSAL rather than a warning because the two possibilities are\n"
    + "indistinguishable from here: a stray file on a board that never had users, or the\n"
    + "roster of a protected board that has just been truncated. Treating the second as\n"
    + "the first silently removes authentication from a board that had it.\n\n"
    + "If this board genuinely has no users and the file is a stray, remove it:\n"
    + `    rm ${path}\n\n`
    + "Otherwise restore it from a backup, or start a new roster:\n"
    + "    blaze user add --email you@example.com --role admin\n";
}

/**
 * What the server needs to know before it binds.
 *
 * THREE STATES, and the distinction between the first two is the whole point:
 *
 *   absent   no .blaze/identity.db at all   -> loopback serves unauthenticated, exactly
 *                                              as Blaze always has. The back-compat path.
 *   broken   the file is there but will not open, or carries no identity schema
 *                                           -> REFUSE. Never "no identities".
 *   empty    schema present, zero users     -> loopback, as for absent. This is the state
 *                                              a future `user remove` of the last user
 *                                              reaches, and it is a working database
 *                                              saying something true.
 *   healthy  schema present, at least one user -> authenticate every request.
 *
 * An earlier revision collapsed broken into absent, justified as tolerating "a stray file
 * in .blaze/". That justification only holds for a board that NEVER HAD USERS, and on
 * disk those two cases look identical — so corrupting a protected board's identity.db
 * removed its authentication outright (no-token went from 401 to 200). Anything that
 * exists at this path must be a working identity database or the board does not come up.
 *
 * A 0-byte file counts as broken, not absent, even though SQLite opens it happily as an
 * empty database: nothing creates this path except openIdentityDb(create: true), which
 * always applies the DDL, and truncation-to-zero is the single most common way a file is
 * destroyed. Reading it as "no users" would leave the widest hole of all of them open.
 *
 * @returns { state, store, hasIdentity, error, close } — `store` is null unless healthy,
 *   which is exactly the argument `gate()` wants for the loopback case. `close` is always
 *   callable.
 */
export function loadIdentity(dataRoot) {
  const path = identityDbPath(dataRoot);
  const absent = { state: "absent", store: null, hasIdentity: false, error: null, close() {} };
  if (!existsSync(path)) return absent;

  const broken = (cause) => ({
    state: "broken", store: null, hasIdentity: false,
    error: brokenIdentityError(path, cause), close() {},
  });

  let opened;
  try { opened = openIdentityDb(dataRoot); } catch (e) { return broken(e); }
  // Vanished between the existsSync and the open. Genuinely absent, not damaged.
  if (!opened) return absent;

  const close = () => { try { opened.db.close(); } catch { /* already closed */ } };
  let n;
  try {
    n = Number(opened.exec.all("SELECT count(*) AS n FROM app_user", [])?.[0]?.n ?? 0);
  } catch (e) {
    close();
    return broken(e);
  }
  if (n === 0) {
    close();
    return { state: "empty", store: null, hasIdentity: false, error: null, close() {} };
  }
  return { state: "healthy", store: opened.store, hasIdentity: true, error: null, close };
}
