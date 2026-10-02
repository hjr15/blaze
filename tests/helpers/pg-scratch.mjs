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
