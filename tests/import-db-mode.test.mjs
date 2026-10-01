// tests/import-db-mode.test.mjs — BLZ-671 + BLZ-672.
//
// BLZ-671: `applyImport` allocated with ids.mjs and wrote an `.ids/` claim directly, so a
// db-mode import took numbers from the FILE ledger while db-mode `new` took them from
// `project_counter` — the two collide. Now both go through the port (`allocate`, `reserve`).
// BLZ-672: a db-mode import row with no `created` bound undefined to `created_on NOT NULL`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { resolvePorts } from "../scripts/model/write-port-resolve.mjs";
import { applyNew } from "../scripts/new.mjs";
import { runImport } from "../scripts/model/import-apply.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const isoToday = () => new Date().toISOString().slice(0, 10);

function csvAt(dataRoot, name, ...rows) {
  const p = join(dataRoot, `${name}.csv`);
  const base = { schema_version: "1", project: "ENG", type: "task", status: "defined",
                 description: "body", estimate: "30" };
  writeFileSync(p, writeCsv([COLUMN_NAMES.slice(),
    ...rows.map((r) => COLUMN_NAMES.map((n) => ({ ...base, ...r })[n] ?? ""))]));
  return p;
}

test("sqlite db mode: an imported row with no `created` lands with today's date; one with a date keeps it",
     async () => {
  const roots = dbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const d0 = isoToday();
    const r = await runImport({
      projectsDir: roots.projectsDir, dataRoot: roots.dataRoot, apply: true,
      writePort: ports.writePort, readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }),
      file: csvAt(roots.dataRoot, "dates",
        { id: "ENG-7", title: "no dates" },
        { id: "ENG-8", title: "dated", created: "2026-01-02", updated: "2026-01-03" }),
    });
    assert.equal(r.exitCode, 0, r.report);
    const undated = (await ports.readStorage.getTicket(null, "ENG-7")).found.frontmatter;
    assert.ok([d0, isoToday()].includes(undated.created), `created=${undated.created}`);
    assert.equal(undated.updated, undated.created);
    const dated = (await ports.readStorage.getTicket(null, "ENG-8")).found.frontmatter;
    assert.equal(dated.created, "2026-01-02");
    assert.equal(dated.updated, "2026-01-03");
  } finally { await ports.close(); }
});

/** A db board that is also a GIT repo. The file allocator (ids.mjs) reserves under the git
 *  common dir and refuses outside a worktree; with a repo, the pre-BLZ-671 importer runs to
 *  completion and the red run shows the real defect — the collision — not a missing repo. */
function gitDbBoard() {
  const roots = dbBoard();
  for (const a of [["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", roots.dataRoot, ...a]);
  }
  return roots;
}

/** new, import --allocate-ids, new, explicit-id import of a HIGH id, new — all through one
 *  resolved db-mode port pair, exactly as the runners resolve it. */
async function interleave(roots, ports) {
  const { projectsDir, dataRoot } = roots;
  const common = { projectsDir, dataRoot, apply: true, writePort: ports.writePort,
                   readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }) };
  const ids = [];
  const make = async (title) => {
    const n = await applyNew(projectsDir, { project: "ENG", type: "task", title, today: "2026-09-30",
      extra: { estimate: 15 }, writePort: ports.writePort, readStorage: ports.readStorage });
    assert.equal(n.ok, true, JSON.stringify(n.errors));
    ids.push(n.id);
  };
  await make("first new");
  const a = await runImport({ ...common, allocateIds: true,
    file: csvAt(dataRoot, "alloc", { id: "", title: "allocated by import" }) });
  assert.equal(a.exitCode, 0, a.report);
  ids.push(...a.result.written);
  await make("second new");
  const b = await runImport({ ...common,
    file: csvAt(dataRoot, "explicit", { id: "ENG-50", title: "explicit high id" }) });
  assert.equal(b.exitCode, 0, b.report);
  ids.push(...b.result.written);
  await make("after the high id");
  return ids;
}

test("sqlite db mode: new / import / new / explicit high id / new — all distinct, last is high + 1, no .ids/",
     async () => {
  const roots = gitDbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    const ids = await interleave(roots, ports);
    assert.deepEqual(ids, ["ENG-2", "ENG-3", "ENG-4", "ENG-50", "ENG-51"]);
    assert.equal(existsSync(join(roots.projectsDir, "ENG", ".ids")), false,
      "db mode must not write a file-ledger claim");
  } finally { await ports.close(); }
});

test("postgres db mode: the same interleave — all distinct, last is high + 1, no .ids/", PG_SKIP, async () => {
  const db = await scratchPgDb("interleave");
  try {
    const roots = gitDbBoard();
    const pgOpts = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                     openPostgresClient: pgClient };
    assert.equal(await runDb(["init"], { ...QUIET, roots, ...pgOpts }), 0);
    const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...pgOpts });
    try {
      // Postgres init loads no tickets, so ENG-1 exists only as a file; the counter still starts past it.
      const ids = await interleave(roots, ports);
      assert.deepEqual(ids, ["ENG-2", "ENG-3", "ENG-4", "ENG-50", "ENG-51"]);
      assert.equal(existsSync(join(roots.projectsDir, "ENG", ".ids")), false);
      const undated = (await ports.readStorage.getTicket(null, "ENG-50")).found.frontmatter;
      assert.match(undated.created, /^\d{4}-\d{2}-\d{2}$/, "BLZ-672 on Postgres: created_on was stamped");
    } finally { await ports.close(); }
  } finally { await db.drop(); }
});

test("sqlite db mode: an explicit id created by another writer between plan and apply stops the import at exit 4 — nothing overwritten",
     async () => {
  const roots = gitDbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try {
    // The concurrent writer lands in the window the planner cannot see: after planImport read
    // the board (ENG-50 absent), before the apply reserves it.
    const racing = { ...ports.writePort, async reserve(id, opts) {
      await ports.writePort.write({ project: "ENG", status: "defined", body: "theirs",
        frontmatter: { id: "ENG-50", title: "written concurrently", type: "task", project: "ENG",
                       estimate: 30, created: "2026-09-30", updated: "2026-09-30" } });
      return ports.writePort.reserve(id, opts);
    } };
    const r = await runImport({ projectsDir: roots.projectsDir, dataRoot: roots.dataRoot, apply: true,
      writePort: racing, readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }),
      file: csvAt(roots.dataRoot, "race", { id: "ENG-50", title: "from the csv" }) });
    assert.equal(r.exitCode, 4, r.report);
    assert.match(r.report, /ENG-50 already exists in the database/);
    assert.match(r.report, /NOT written/);
    const back = (await ports.readStorage.getTicket(roots.projectsDir, "ENG-50")).found;
    assert.equal(back.frontmatter.title, "written concurrently", "the concurrent ticket survives");
  } finally { await ports.close(); }
});

/** BLZ-671 I-1: a stale counter (after a dual soak, or a missed seed-counter) sits BELOW rows
 *  already in `ticket`. Rows ENG-2 and ENG-3 are written straight through the port, which does
 *  not touch project_counter, so the counter still stands at 1. An --allocate-ids import must
 *  land at ENG-4 and leave both existing rows exactly as they were — not upsert over ENG-2. */
async function staleCounterImport(roots, ports) {
  for (const n of [2, 3]) {
    await ports.writePort.write({ project: "ENG", status: "defined", body: "existing",
      frontmatter: { id: `ENG-${n}`, title: `existing ${n}`, type: "task", project: "ENG",
                     estimate: 30, created: "2026-09-30", updated: "2026-09-30" } });
  }
  const r = await runImport({ projectsDir: roots.projectsDir, dataRoot: roots.dataRoot, apply: true,
    writePort: ports.writePort, readStorage: ports.readStorage, stage: () => ({ ok: true, queued: true }),
    allocateIds: true, file: csvAt(roots.dataRoot, "stale", { id: "", title: "allocated over a stale counter" }) });
  assert.equal(r.exitCode, 0, r.report);
  assert.deepEqual(r.result.written, ["ENG-4"]);
  for (const n of [2, 3]) {
    const back = (await ports.readStorage.getTicket(roots.projectsDir, `ENG-${n}`)).found;
    assert.equal(back.frontmatter.title, `existing ${n}`, `ENG-${n} must survive the import unchanged`);
  }
  const fresh = (await ports.readStorage.getTicket(roots.projectsDir, "ENG-4")).found;
  assert.equal(fresh.frontmatter.title, "allocated over a stale counter");
}

test("sqlite db mode: --allocate-ids over a stale counter skips existing rows — nothing overwritten",
     async () => {
  const roots = gitDbBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" } });
  try { await staleCounterImport(roots, ports); } finally { await ports.close(); }
});

test("postgres db mode: --allocate-ids over a stale counter skips existing rows — nothing overwritten",
     PG_SKIP, async () => {
  const db = await scratchPgDb("stalecounter");
  try {
    const roots = gitDbBoard();
    const pgOpts = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                     openPostgresClient: pgClient };
    assert.equal(await runDb(["init"], { ...QUIET, roots, ...pgOpts }), 0);
    const ports = await resolvePorts({ ...roots, env: { BLAZE_WRITE_PORT: "db" }, ...pgOpts });
    try { await staleCounterImport(roots, ports); } finally { await ports.close(); }
  } finally { await db.drop(); }
});
