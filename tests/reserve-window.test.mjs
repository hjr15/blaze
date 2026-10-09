// tests/reserve-window.test.mjs — BLZ-683 (spec §5.8). The db `reserve` check-then-upsert window
// is ACCEPTED (import is single-operator and refused in remote mode), on one condition the spec
// states: the losing writer fails LOUDLY and never overwrites. Before this, a ticket created by
// another writer after `reserve` (or after `new`'s `exists`) was silently upserted over by the
// create that followed. These tests put a second writer in exactly that window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts, resolveWritePort, pgExec } from "../scripts/model/write-port-resolve.mjs";
import { execFileSync } from "node:child_process";
import { dbWritePort } from "../scripts/model/write-port.mjs";
import { createDbSchema } from "../scripts/model/db-schema-version.mjs";
import { applyNew } from "../scripts/new.mjs";
import { runImport } from "../scripts/model/import-apply.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const theirs = (id) => ({ project: "ENG", status: "defined", body: "theirs",
  frontmatter: { id, title: "written by the other writer", type: "task", project: "ENG",
                 estimate: 30, created: "2026-10-05", updated: "2026-10-05" } });

test("import: a ticket created AFTER reserve, before the write — exit 4, the other writer's ticket survives",
     async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    // reserve finds ENG-50 free and raises the counter; THEN the other writer lands.
    const racing = { ...ports.writePort, async reserve(id, opts) {
      const r = await ports.writePort.reserve(id, opts);
      await ports.writePort.write(theirs(id));
      return r;
    } };
    const csv = join(roots.dataRoot, "race.csv");
    const base = { schema_version: "1", project: "ENG", type: "task", status: "defined",
                   description: "body", estimate: "30", id: "ENG-50", title: "from the csv" };
    writeFileSync(csv, writeCsv([COLUMN_NAMES.slice(), COLUMN_NAMES.map((n) => base[n] ?? "")]));
    const r = await runImport({ projectsDir: roots.projectsDir, dataRoot: roots.dataRoot, apply: true,
      writePort: racing, readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }), file: csv });
    assert.equal(r.exitCode, 4, r.report);
    assert.match(r.report, /ENG-50 already exists in the database/);
    assert.match(r.report, /NOT written/);
    const back = (await ports.readStorage.getTicket(roots.projectsDir, "ENG-50")).found;
    assert.equal(back.frontmatter.title, "written by the other writer", "never overwritten");
  } finally { await ports.close(); }
});

test("new: a ticket created after the exists-check, before the write — refused, never overwritten",
     async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const racing = { ...ports.writePort, async exists(t) {
      const there = await ports.writePort.exists(t);
      await ports.writePort.write(theirs(t.frontmatter.id));
      return there;
    } };
    await assert.rejects(applyNew(roots.projectsDir, {
      project: "ENG", type: "task", title: "mine", today: "2026-10-05", extra: { estimate: 15 },
      writePort: racing, readStorage: ports.readStorage,
    }), /ENG-2 already exists in the database.*NOT written/);
    const back = (await ports.readStorage.getTicket(roots.projectsDir, "ENG-2")).found;
    assert.equal(back.frontmatter.title, "written by the other writer");
  } finally { await ports.close(); }
});

test("an edit or a move is still an upsert — only a create refuses an existing row", async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    await ports.writePort.write(theirs("ENG-7"), { create: true });
    await ports.writePort.write({ ...theirs("ENG-7"), status: "in-progress" });
    assert.equal((await ports.readStorage.getTicket(roots.projectsDir, "ENG-7")).found.status, "in-progress");
  } finally { await ports.close(); }
});

test("dual: a stale SHADOW row is still upserted by a create — no divergence, as before", async () => {
  const roots = dbBoard();
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", roots.dataRoot, ...a]);
  }
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(join(roots.dataRoot, ".blaze", "blaze.db"));
  raw.prepare(`INSERT INTO ticket (id, project_key, num, type, status, title, body, estimate_minutes, created_on, updated_on)
               VALUES ('ENG-2','ENG',2,'task','defined','stale shadow row','old body',30,'2026-01-01','2026-01-01')`).run();
  raw.close();
  const divergences = [];
  const w = await resolveWritePort({ ...roots, env: { BLAZE_WRITE_PORT: "dual" },
                                     onDivergence: (d) => divergences.push(d) });
  try {
    const n = await applyNew(roots.projectsDir, { project: "ENG", type: "task", title: "fresh",
      today: "2026-10-05", extra: { estimate: 15 }, writePort: w.port });
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    assert.equal(n.id, "ENG-2");
  } finally { w.close(); }
  assert.deepEqual(divergences, [], "the shadow converged, exactly as before BLZ-683");
  const check = new DatabaseSync(join(roots.dataRoot, ".blaze", "blaze.db"));
  try {
    assert.equal(check.prepare("SELECT title FROM ticket WHERE id = 'ENG-2'").get().title, "fresh");
  } finally { check.close(); }
});

test("Postgres, two connections: the loser's INSERT meets the primary key inside its own transaction",
     PG_SKIP, async () => {
  const db = await scratchPgDb("window");
  const a = await pgClient(db.url), b = await pgClient(db.url);
  try {
    await createDbSchema(pgExec(a), { dialect: "postgres" });
    // B pauses right after reading "no such row", exactly where a concurrent create can land.
    let release, paused;
    const gate = new Promise((r) => { release = r; });
    const reached = new Promise((r) => { paused = r; });
    const base = pgExec(b);
    const execB = { run: base.run, async all(sql, params) {
      const rows = await base.all(sql, params);
      if (/SELECT status FROM ticket WHERE id/.test(sql)) { paused(); await gate; }
      return rows;
    } };
    const loser = dbWritePort(execB, { dialect: "postgres" }).write({ ...theirs("ENG-9"),
      frontmatter: { ...theirs("ENG-9").frontmatter, title: "the loser" } }, { create: true });
    await reached;
    await dbWritePort(pgExec(a), { dialect: "postgres" }).write(theirs("ENG-9"), { create: true });
    release();
    await assert.rejects(loser, /duplicate key value violates unique constraint "ticket_pkey"/);
    const rows = (await a.query("SELECT title FROM ticket WHERE id = 'ENG-9'")).rows;
    assert.deepEqual(rows, [{ title: "written by the other writer" }]);
    const events = Number((await a.query("SELECT count(*) AS n FROM ticket_event WHERE ticket_id = 'ENG-9'")).rows[0].n);
    assert.equal(events, 1, "the loser's transaction — its event included — rolled back");
  } finally { await a.end(); await b.end(); await db.drop(); }
});
