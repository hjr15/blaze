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
