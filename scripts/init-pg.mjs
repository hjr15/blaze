// scripts/init-pg.mjs — the Postgres side of `blaze init`'s connection test.
//
// Separate from init.mjs so the wizard's logic is testable without `pg` installed, and
// so testConnection can be driven by a fake. `pg` is an optional peer dependency
// (ADR-0011) — it is genuinely absent for most users, which is the ordinary case here
// rather than a broken install.
export async function openPostgres({ host, port, database, user, password }) {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch (cause) {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND") throw cause;
    throw new Error(
      "The Postgres driver needs the 'pg' package, which Blaze does not install by "
      + "default. Install it alongside Blaze to use a Postgres board:\n\n"
      + "    npm install pg\n\n"
      + "No other driver requires it — sqlite works without.", { cause });
  }
  // Built from PARSED PARTS, never a composed URL: an error handler structurally
  // cannot print a password it never held a reference to.
  const client = new pg.Client({ host, port, database, user, password });
  await client.connect();
  return {
    async serverVersionNum() {
      const r = await client.query("SHOW server_version_num");
      return Number(r.rows[0].server_version_num);
    },
    async encoding() {
      const r = await client.query(
        "SELECT pg_encoding_to_char(encoding) AS e FROM pg_database WHERE datname = current_database()");
      return r.rows[0]?.e;
    },
    async probeCreate() {
      // Rolled back: proves the privilege without leaving anything behind. Without
      // this the wizard can report "connection OK" and `blaze db init` then fail,
      // which means the wizard lied.
      await client.query("BEGIN");
      try {
        await client.query("CREATE TABLE blaze_init_probe (x integer)");
      } finally {
        await client.query("ROLLBACK");
      }
    },
    async close() { await client.end(); },
  };
}

/** The production write-port's connection: the raw, connected client, no test wrapper.
 *  Separate from openPostgres() above, which is testConnection-shaped for the wizard —
 *  reusing that wrapper here would give write-port callers no .query to call.
 *  `Client` is injectable so tests never open a real socket. */
export async function openPostgresClient({ host, port, database, user, password }, { Client } = {}) {
  if (!Client) Client = (await importPg()).Client;
  const client = new Client({ host, port, database, user, password });
  await client.connect();
  return client;
}

/** `pg`, or the same named refusal `openPostgres` gives when it is not installed. */
async function importPg() {
  try {
    return (await import("pg")).default;
  } catch (cause) {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND") throw cause;
    throw new Error(
      "The Postgres driver needs the 'pg' package, which Blaze does not install by "
      + "default. Install it alongside Blaze to use a Postgres board:\n\n"
      + "    npm install pg\n\n"
      + "No other driver requires it — sqlite works without.", { cause });
  }
}

/**
 * BLZ-706: the server's IDENTITY connection — a small pool, held for the life of the process,
 * because every authenticated request asks the roster (token lookup, last-used touch, sign-in)
 * and a fresh connection per request would be a connect per request. `max: 4`: identity queries
 * are single-row and short. Built from parsed parts, like the client above, never a URL.
 *
 * The `error` listener is not optional. An idle pooled client whose server goes away emits
 * `error` on the pool, and an unhandled `error` event ends the process; logged instead, the next
 * query fails, and the request that made it answers 503/500 rather than the board vanishing.
 * Only the driver's MESSAGE is printed — never the config, which holds the password.
 */
export async function openPostgresPool({ host, port, database, user, password }, { Pool } = {}) {
  if (!Pool) Pool = (await importPg()).Pool;
  const pool = new Pool({ host, port, database, user, password, max: 4 });
  pool.on("error", (e) => console.error("blaze: identity connection pool:", e.message));
  return pool;
}
