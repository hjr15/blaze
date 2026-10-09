// tests/model/allocate-concurrency.test.mjs — BLZ-667.
//
// Proves the id allocator's concurrent-write guarantee — BLZ-254's acceptance criteria (two
// agents on two machines, zero collisions) — using two GENUINELY SEPARATE Postgres
// connections. An earlier draft ran all 100 `allocate()` calls through one shared `pg.Client`,
// and node-postgres queues every query on that client's own `_queryQueue`, so the calls ran
// one after another regardless of the `Promise.all` wrapping them: a test of sequential
// correctness under one connection, not of the property BLZ-254 actually names. This draft
// uses two separate `pg.Client` connections, so the database's own row-level locking is what
// is actually being exercised.
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { dbWritePort } from "../../scripts/model/write-port.mjs";
import { pgExec } from "../../scripts/model/write-port-resolve.mjs";
import { createDbSchema } from "../../scripts/model/db-schema-version.mjs";

/** One fresh, isolated database, schema applied, two connections into it — mirrors
 *  config-install.test.mjs's own dedicated-database pattern, since two tests (or two
 *  connections) sharing ONE database collide on schema creation.
 *
 *  Corrected after a fifth-round review reproduced a leak-then-hang: if `createDbSchema`
 *  (or either `connect()`) throws, the caller's OWN try/finally never starts (its
 *  destructuring assignment hasn't run yet), so any client already opened here is never
 *  closed and the test process hangs. This function now closes whatever it opened,
 *  itself, on its own failure — the caller's try/finally only needs to cover the
 *  ordinary post-setup path. Also returns `dbName` so the caller can drop the database
 *  on cleanup, which the second-to-last review round found this test never did. */
async function isolatedDbTwoConnections(name) {
  const dbName = `blz_allocate_${name}_${process.pid}`;
  const admin = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const dbUrl = new URL(process.env.BLAZE_TEST_PG_URL);
  dbUrl.pathname = `/${dbName}`;
  const clientA = new pg.Client(dbUrl.toString());
  const clientB = new pg.Client(dbUrl.toString());
  try {
    await Promise.all([clientA.connect(), clientB.connect()]);
    await createDbSchema(pgExec(clientA), { dialect: "postgres" });
  } catch (e) {
    await Promise.allSettled([clientA.end(), clientB.end()]); // close whatever opened, even on failure
    // A sixth-round review found this path left the just-created database behind
    // (cosmetic, since it only fires when the test is already failing, but free to fix):
    await dropDb(dbName).catch(() => {}); // best-effort — don't mask the real error below
    throw e;
  }
  return { clientA, clientB, dbName };
}

/** BLZ-675: `n` calls on ONE connection, each awaited before the next. A `Promise.all` here
 *  issued them all at once on one pg.Client — which pg queues anyway (the header above), and
 *  deprecates. The race this file proves is BETWEEN the two connections, and that stays. */
async function inTurn(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await fn());
  return out;
}

/** Drops the database this helper created — call in the test's own `finally`. */
async function dropDb(dbName) {
  const admin = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
}

test("50x50 concurrent allocations on one project, across two real connections: exactly {1..100}, no dup, no gap",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const key = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const { clientA, clientB, dbName } = await isolatedDbTwoConnections("onekey");
  try {
    const portA = dbWritePort(pgExec(clientA), { dialect: "postgres" });
    const portB = dbWritePort(pgExec(clientB), { dialect: "postgres" });
    const [a, b] = await Promise.all([
      inTurn(50, () => portA.allocate(key)),
      inTurn(50, () => portB.allocate(key)),
    ]);
    const all = [...a, ...b].map((r) => r.n).sort((x, y) => x - y);
    assert.deepEqual(all, Array.from({ length: 100 }, (_, i) => i + 1));
  } finally {
    await Promise.all([clientA.end(), clientB.end()]); // runs even if an assertion above throws
    await dropDb(dbName);
  }
});

test("concurrent allocations on two DIFFERENT projects, across two connections, never collide",
     { skip: !process.env.BLAZE_TEST_PG_URL }, async () => {
  const keyA = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const keyB = `CT${randomUUID().slice(0, 8).toUpperCase()}`;
  const { clientA, clientB, dbName } = await isolatedDbTwoConnections("twokeys"); // its OWN database, not the prior test's
  try {
    const portA = dbWritePort(pgExec(clientA), { dialect: "postgres" });
    const portB = dbWritePort(pgExec(clientB), { dialect: "postgres" });
    const [resA, resB] = await Promise.all([
      inTurn(20, () => portA.allocate(keyA)),
      inTurn(20, () => portB.allocate(keyB)),
    ]);
    assert.deepEqual(resA.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual(resB.map((r) => r.n).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => i + 1));
  } finally {
    await Promise.all([clientA.end(), clientB.end()]);
    await dropDb(dbName);
  }
});
