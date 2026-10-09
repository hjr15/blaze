// tests/model/pg-one-query-at-a-time.test.mjs — BLZ-675.
//
// `createDbSchema` issued every DDL statement before awaiting the first, and the Postgres
// reader hydrated tickets through `Promise.all` — both N concurrent `client.query()` calls on
// ONE pg.Client. pg 8 queues them but prints "Calling client.query() when the client is
// already executing a query is deprecated"; pg 9 is set to refuse. The fakes below FAIL the
// moment a second query starts before the first has settled, so they discriminate without a
// server; the last test proves the real driver prints no such warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDbSchema } from "../../scripts/model/db-schema-version.mjs";
import { postgresReader } from "../../scripts/model/pg-storage.mjs";
import { PG_SKIP, scratchPgDb } from "../helpers/pg-scratch.mjs";

/** Settles on a LATER macrotask, so an overlapping caller is really overlapping. */
const later = (v) => new Promise((resolve) => setImmediate(() => resolve(v)));

function oneAtATime(answer) {
  const seen = { calls: 0, overlaps: [] };
  let busy = null;
  const query = async (sql) => {
    seen.calls++;
    if (busy !== null) seen.overlaps.push({ running: busy.slice(0, 60), started: String(sql).slice(0, 60) });
    busy = String(sql);
    try { return await later(answer(String(sql))); } finally { busy = null; }
  };
  return { seen, query };
}

test("createDbSchema on an async driver runs ONE statement at a time", async () => {
  const { seen, query } = oneAtATime(() => ({ rows: [] }));   // every lookup: empty database
  const exec = { run: (sql) => query(sql), all: async (sql) => (await query(sql)).rows };
  const r = await createDbSchema(exec, { dialect: "postgres" });
  assert.deepEqual(r, { created: true, version: 5 });
  assert.ok(seen.calls > 10, `only ${seen.calls} statements seen — the fake is not observing the create`);
  assert.deepEqual(seen.overlaps, [], "a statement started while another was still running");
});

test("the Postgres reader issues one query at a time on its client", async () => {
  const row = (id, parent = null) => ({ id, project_key: "BLZ", num: Number(id.split("-")[1]), type: "task",
    status: "defined", title: id, priority: "medium", assignee: "unassigned", parent_id: parent,
    body: "", created_on: "2026-01-01", updated_on: "2026-01-01" });
  const { seen, query } = oneAtATime((sql) => {
    if (/FROM ticket WHERE id = \$1/.test(sql)) return { rows: [row("BLZ-1")] };
    if (/FROM ticket WHERE parent_id = \$1/.test(sql)) return { rows: [row("BLZ-2", "BLZ-1"), row("BLZ-3", "BLZ-1")] };
    if (/FROM ticket WHERE deleted_at IS NULL ORDER BY id/.test(sql)) return { rows: [row("BLZ-1"), row("BLZ-2")] };
    if (/JOIN ticket t/.test(sql)) return { rows: [row("BLZ-4")] };
    return { rows: [] };
  });
  const r = postgresReader({ query, end: async () => {} });
  assert.equal((await r.getTicket(null, "BLZ-1")).found.frontmatter.id, "BLZ-1");
  assert.equal((await r.listChildren(null, "BLZ-1")).length, 2);
  assert.equal((await r.blockersOf(null, "BLZ-1")).length, 1);
  assert.equal((await r.listTickets(null)).length, 2);
  assert.ok(seen.calls >= 20, `only ${seen.calls} queries seen — the fake is not observing the reads`);
  assert.deepEqual(seen.overlaps, [], "a query started while another was still running");
});

test("real Postgres: init, a write and every reader path print no pg deprecation warning", PG_SKIP, async () => {
  const db = await scratchPgDb("seq");
  try {
    // A CHILD process, because Node prints a given deprecation once per process: a warning an
    // earlier test in this file triggered would hide this one's. Its stderr is the evidence.
    const mod = (p) => JSON.stringify(new URL(`../../scripts/${p}`, import.meta.url).href);
    const src = `
      import pg from "pg";
      import { createDbSchema } from ${mod("model/db-schema-version.mjs")};
      import { dbWritePort } from ${mod("model/write-port.mjs")};
      import { pgExec } from ${mod("model/write-port-resolve.mjs")};
      import { postgresReader } from ${mod("model/pg-storage.mjs")};
      const c = new pg.Client(process.env.SCRATCH_URL);
      await c.connect();
      try {
        await createDbSchema(pgExec(c), { dialect: "postgres" });
        const port = dbWritePort(pgExec(c), { dialect: "postgres", today: () => "2026-10-05" });
        for (const [id, parent] of [["ENG-1", ""], ["ENG-2", "ENG-1"]]) {
          await port.write({ project: "ENG", status: "defined", body: "b",
            frontmatter: { id, title: id, type: "task", estimate: 30, parent, labels: ["x"],
                           worklog: [{ date: "2026-10-05", minutes: 5 }],
                           links: parent ? [{ type: "Blocks", target: parent }] : [] } });
        }
        const r = postgresReader(c);
        await r.listTickets(null); await r.getTicket(null, "ENG-1");
        await r.listChildren(null, "ENG-1"); await r.blockersOf(null, "ENG-1");
        console.log("done");
      } finally { await c.end(); }`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", src], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8",
      env: { ...process.env, SCRATCH_URL: db.url },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /done/);
    assert.doesNotMatch(run.stderr, /already executing a query/);
  } finally { await db.drop(); }
});

