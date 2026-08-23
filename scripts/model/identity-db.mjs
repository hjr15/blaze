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
import { existsSync, mkdirSync } from "node:fs";
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
  mkdirSync(dirname(path), { recursive: true });
  const db = new (DatabaseSync())(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (create) db.exec(identityDdl("sqlite"));
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
