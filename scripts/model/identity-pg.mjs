// scripts/model/identity-pg.mjs — a board's identities, read from Postgres (BLZ-706, spec D2).
//
// The Postgres twin of `identity-db.mjs`'s `loadIdentity`, and it returns the SAME four states
// (absent, broken, empty, healthy) so `startServer` and `createApp` decide on it exactly as they
// decide on the SQLite roster. It is ASYNC, which is why it never runs inside the server: the
// entry points await it BEFORE bind (`resolveIdentity` in identity-db.mjs) and pass the result
// in, so the bind check itself stays synchronous.
//
// The six tables are `identityDdl("postgres")`'s, created by schema v6 (`blaze db init` or
// `blaze db migrate`). The store is `identityStore`'s postgres dialect — the one this repo has
// carried since ADR-0013 and nothing constructed until now.
import { identityStore } from "./identity-store.mjs";

/** The `{ run, all }` shape `identityStore` wants, over a `pg.Pool` — `pgExec`'s, per query. */
export function poolExec(pool) {
  return {
    async run(sql, params = []) { await pool.query(sql, params); },
    async all(sql, params = []) { return (await pool.query(sql, params)).rows; },
  };
}

/** Deliberately the SQLite loader's argument: a roster that exists but will not read is a
 *  refusal, never "no users". The cause is the driver's MESSAGE only — no row, no value. */
function brokenIdentityPgError(cause) {
  return "blaze: refusing to serve — the identity tables in Postgres exist but cannot be read.\n\n"
    + `    ${String(cause?.message ?? cause).trim()}\n\n`
    + "This is a refusal, not \"no users\": a damaged roster must never disarm authentication. "
    + "Restore the database from a pg_dump.\n";
}

/**
 * What the server needs to know before it binds, read from Postgres.
 *
 *   absent   no `app_user` table             -> as SQLite's absent
 *   broken   any query throws                -> REFUSE (never absent)
 *   empty    the tables, zero users          -> as SQLite's empty
 *   healthy  at least one user               -> authenticate every request
 *
 * `close` is a no-op in every state: the caller owns the connection (`resolveIdentity`'s pool).
 */
export async function loadIdentityPg(exec) {
  const close = () => {};
  try {
    const reg = await exec.all("SELECT to_regclass('app_user') AS r", []);
    if (reg?.[0]?.r === null || reg?.[0]?.r === undefined) {
      return { state: "absent", store: null, hasIdentity: false, error: null, close };
    }
    const rows = await exec.all("SELECT count(*) AS n FROM app_user", []);
    if (Number(rows?.[0]?.n ?? 0) === 0) {
      return { state: "empty", store: null, hasIdentity: false, error: null, close };
    }
    return { state: "healthy", store: identityStore(exec, { dialect: "postgres" }),
             hasIdentity: true, error: null, close };
  } catch (e) {
    return { state: "broken", store: null, hasIdentity: false, error: brokenIdentityPgError(e), close };
  }
}
