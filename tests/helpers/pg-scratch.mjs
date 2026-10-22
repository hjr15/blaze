// tests/helpers/pg-scratch.mjs — BLZ-668. One fresh Postgres DATABASE per test, dropped after.
// Helpers ONLY (a module that declared tests would re-register them in every importer).
// The pattern is write-port.test.mjs's and allocate-concurrency.test.mjs's: two tests sharing
// one database collide on schema creation, so each gets its own.
import { randomUUID } from "node:crypto";

export const PG = process.env.BLAZE_TEST_PG_URL ?? null;
export const PG_SKIP = { skip: PG ? false : "set BLAZE_TEST_PG_URL" };

async function admin(fn) {
  const pg = (await import("pg")).default;
  const c = new pg.Client(PG);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Create an empty scratch database. Returns its URL and a `drop()` for the test's `finally`. */
export async function scratchPgDb(tag) {
  const name = `blz668_${tag}_${process.pid}_${randomUUID().slice(0, 8)}`.toLowerCase();
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(PG);
  url.pathname = `/${name}`;
  return {
    name, url: url.toString(),
    drop: () => admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)),
  };
}

/** A connected pg.Client on `url` — the openPostgresClient shape resolvePorts injects. */
export async function pgClient(url) {
  const pg = (await import("pg")).default;
  const c = new pg.Client(url);
  await c.connect();
  return c;
}

/**
 * BLZ-705: shape `url`'s (empty) database exactly as a 0.9.0 engine created it — schema v5, with
 * no identity or sprint tables. A v6 create, minus what v6 added, restamped 5.
 */
export async function makeV5(url) {
  const { createDbSchema } = await import("../../scripts/model/db-schema-version.mjs");
  const { pgExec } = await import("../../scripts/model/write-port-resolve.mjs");
  const c = await pgClient(url);
  try {
    await createDbSchema(pgExec(c), { dialect: "postgres" });
    await c.query("DROP TABLE user_session, local_password, api_token, membership, user_identity, "
      + "app_user, sprint, sprint_registry");
    await c.query("UPDATE blaze_meta SET value = '5' WHERE key = 'schema_version'");
  } finally { await c.end(); }
}

/**
 * BLZ-705: the `BLAZE_DB_*` env a spawned engine resolves `url` from. The password travels in
 * BLAZE_TEST_PG_PASSWORD, named by BLAZE_DB_PASSWORD_ENV — never in a URL on a command line.
 */
export function pgEnvFor(url) {
  const u = new URL(url);
  return {
    BLAZE_DB_HOST: u.hostname,
    BLAZE_DB_PORT: u.port || "5432",
    BLAZE_DB_NAME: decodeURIComponent(u.pathname.replace(/^\//, "")),
    BLAZE_DB_USER: decodeURIComponent(u.username),
    BLAZE_DB_PASSWORD_ENV: "BLAZE_TEST_PG_PASSWORD",
    BLAZE_TEST_PG_PASSWORD: decodeURIComponent(u.password),
  };
}
