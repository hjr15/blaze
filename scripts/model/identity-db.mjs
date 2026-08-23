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
  // A WAL database cannot be opened AT ALL on a read-only filesystem: SQLite needs to
  // write -wal/-shm to read it, so even a SELECT fails with "attempt to write a readonly
  // database". Measured both ways against a 0444 file in a 0555 directory:
  //     journal_mode=delete  -> SELECT ok, UPDATE refused          (what we want)
  //     journal_mode=wal     -> OPEN/SELECT FAILS                  (board unauthenticable)
  // `docker run -v <board>:/data:ro` is the Dockerfile's own hardened deployment, and the
  // mode is sticky: setting WAL once on a writable board breaks every later read-only
  // mount of it. busy_timeout already fixes the contention this was meant to address.
  if (create) {
    db.exec(identityDdl("sqlite"));
    harden(path, 0o600);
  }
  const exec = identityExec(db);
  return { db, exec, path, store: identityStore(exec, { dialect: "sqlite" }) };
}

/**
 * What the server needs to know before it binds.
 *
 * @returns { store, hasIdentity, close } — `store` is null when there is nothing to
 *   authenticate against, which is exactly the argument `gate()` wants for the
 *   loopback case. `close` is always callable.
 */
export function loadIdentity(dataRoot) {
  const none = { store: null, hasIdentity: false, close() {} };
  let opened;
  try { opened = openIdentityDb(dataRoot); } catch { return none; }
  if (!opened) return none;
  const close = () => { try { opened.db.close(); } catch { /* already closed */ } };
  let n = 0;
  try {
    n = Number(opened.exec.all("SELECT count(*) AS n FROM app_user", [])?.[0]?.n ?? 0);
  } catch {
    // A file that exists but carries no identity schema is not an identity. Treated as
    // absent rather than fatal: refusing to serve a loopback board because something
    // left a stray file in .blaze/ would be a worse failure than the one being fixed.
    close();
    return none;
  }
  if (n === 0) { close(); return none; }
  return { store: opened.store, hasIdentity: true, close };
}
