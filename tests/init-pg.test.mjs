// tests/init-pg.test.mjs — new file, BLZ-667.
//
// No existing direct test of scripts/init-pg.mjs exists to extend: its only coverage so
// far is indirect, via tests/init.test.mjs injecting a fake `openPostgres` at a higher
// call site. This covers `openPostgresClient`, the production write-port's connection —
// separate from `openPostgres`, which is the wizard's connection-test wrapper and
// deliberately exposes no `.query`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openPostgresClient } from "../scripts/init-pg.mjs";

test("openPostgresClient connects via the injected Client and returns it", async () => {
  const calls = { constructed: null, connected: false };
  class FakeClient {
    constructor(conn) { calls.constructed = conn; }
    async connect() { calls.connected = true; }
    async query() { return { rows: [] }; }
    async end() {}
  }
  const client = await openPostgresClient(
    { host: "h", port: 5432, database: "d", user: "u", password: "p" },
    { Client: FakeClient });
  assert.deepEqual(calls.constructed, { host: "h", port: 5432, database: "d", user: "u", password: "p" });
  assert.equal(calls.connected, true);
  assert.equal(typeof client.query, "function");
});

test("openPostgresClient without an injected Client, and 'pg' unavailable, refuses clearly", async (t) => {
  // No Client injected, exercising the real ERR_MODULE_NOT_FOUND branch rather than a
  // mock — only meaningful when 'pg' genuinely isn't installed where the suite runs.
  // Corrected after review: an early `return` here reports as a PASS with nothing
  // asserted, not a SKIP — use node:test's own t.skip() so a run where 'pg' IS installed
  // (asserting nothing) is visibly distinguishable from one that actually proved the
  // refusal, per this repo's own "assert the observation happened" rule.
  let pgInstalled = true;
  try { await import("pg"); } catch { pgInstalled = false; }
  if (pgInstalled) { t.skip("'pg' is installed in this environment; the other test above already proves the connect path"); return; }
  await assert.rejects(
    () => openPostgresClient({ host: "h", port: 5432, database: "d", user: "u", password: "p" }),
    /npm install pg/);
});
