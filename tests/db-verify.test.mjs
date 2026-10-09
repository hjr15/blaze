// tests/db-verify.test.mjs — BLZ-679, `blaze db verify`: the migration gate (spec §5.3).
//
// zeroDiff (BLZ-281) is the oracle; this is its first production caller. The pure verdict is
// tested with no server — including each of the four conditions failing ON ITS OWN, because a
// gate whose conditions only ever fail together cannot be shown to check any one of them. The
// Postgres block runs the command end to end, and proves it discriminates by changing ONE value
// in a loaded board (prove-test-discriminates-by-injecting-regression).
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { verifyLoad, expectedCounts, criteriaFromBody, extraDiffs, VERIFY_TABLES } from "../scripts/migrate/verify-load.mjs";
import { runner } from "./helpers/db-board.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

function board() {
  const roots = dbBoard();
  writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-b.md"),
    ["---", "id: ENG-2", "title: B task", "type: task", "project: ENG", "priority: high",
     "assignee: unassigned", "estimate: 15", "parent: ENG-1", "labels: [x, y]",
     "created: 2026-01-02", "updated: 2026-01-03", "custom_key: keepme",
     "worklog:", "  - { date: 2026-01-03, minutes: 10, note: first }",
     "links:", "  - { type: Blocks, target: ENG-1 }",
     "---", "", "## Acceptance Criteria", "", "- [x] done", "- [ ] open", ""].join("\n"));
  return roots;
}

/** The filesystem's own tickets as the "loaded" side: a perfect load, by construction. */
const asLoaded = (projectsDir) => [...fsReadStorage.listTickets(projectsDir)]
  .map((t) => ({ ...t, frontmatter: { ...t.frontmatter } }));

test("a perfect load passes all four conditions", () => {
  const { projectsDir } = board();
  const counts = expectedCounts(fsReadStorage, projectsDir);
  assert.deepEqual(counts, { ticket: 2, ticket_link: 1, worklog_entry: 1, ticket_label: 2, ticket_component: 0 });
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: asLoaded(projectsDir), counts });
  assert.equal(v.ok, true, v.failures.join("; "));
  assert.equal(v.report.criteriaChecked, 3, "ENG-1's one criterion and ENG-2's two were checked, not skipped");
  assert.deepEqual(v.failures, []);
});

test("condition 1 alone: one changed VALUE fails, and names the field", () => {
  const { projectsDir } = board();
  const loaded = asLoaded(projectsDir);
  loaded.find((t) => t.frontmatter.id === "ENG-2").frontmatter.priority = "low";
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: loaded,
                         counts: expectedCounts(fsReadStorage, projectsDir) });
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ["1 value difference(s)"]);
  assert.deepEqual(v.report.valueDiffs, [{ id: "ENG-2", field: "priority", source: "high", loaded: "low" }]);
});

test("condition 1 alone, the unknown keys: an extra field the database lost fails, and is named", () => {
  const { projectsDir } = board();
  const loaded = asLoaded(projectsDir);
  delete loaded.find((t) => t.frontmatter.id === "ENG-2").frontmatter.custom_key;
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: loaded,
                         counts: expectedCounts(fsReadStorage, projectsDir) });
  assert.deepEqual(v.failures, ["1 value difference(s)"]);
  assert.deepEqual(v.report.valueDiffs, [{ id: "ENG-2", field: "extra", source: '{"custom_key":"keepme"}', loaded: "{}" }]);
});

test("extraDiffs ignores key order and the keys that have a column", () => {
  const src = [{ frontmatter: { id: "A-1", title: "t", b: 2, a: { y: 1, x: 2 } } }];
  const same = [{ frontmatter: { id: "A-1", title: "other", a: { x: 2, y: 1 }, b: 2 } }];
  assert.deepEqual(extraDiffs(src, same), []);
  assert.deepEqual(extraDiffs(src, []), [], "a missing ticket is condition 2's");
});

test("condition 2 alone: a ticket missing from the database fails", () => {
  const { projectsDir } = board();
  const loaded = asLoaded(projectsDir).filter((t) => t.frontmatter.id !== "ENG-2");
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: loaded,
                         counts: expectedCounts(fsReadStorage, projectsDir) });
  assert.deepEqual(v.failures, ["the id sets differ: 1 missing from the database, 0 only in the database"]);
  assert.deepEqual(v.report.missing, ["ENG-2"]);
});

test("condition 3 alone: a row count the builder does not predict fails, every table checked", () => {
  const { projectsDir } = board();
  for (const table of VERIFY_TABLES) {
    const counts = { ...expectedCounts(fsReadStorage, projectsDir) };
    counts[table] += 1;
    const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: asLoaded(projectsDir), counts });
    assert.deepEqual(v.failures, [`row counts differ in ${table}`], table);
  }
});

test("condition 4 alone: criteria that disagree fail even when every value agrees", () => {
  const { projectsDir } = board();
  const v = verifyLoad({ source: fsReadStorage, sourceRoot: projectsDir, loadedTickets: asLoaded(projectsDir),
                         counts: expectedCounts(fsReadStorage, projectsDir),
                         criteriaOf: (body) => criteriaFromBody(body).map((c) => ({ ...c, checked: !c.checked })) });
  assert.deepEqual(v.report.valueDiffs, []);
  assert.deepEqual(v.failures, ["3 acceptance-criteria difference(s)"]);
});

test("criteriaFromBody is the engine's parser: criteria only, in order, with their checks", () => {
  assert.deepEqual(criteriaFromBody("## Acceptance Criteria\nprose\n- [x] a\n- [ ] b\n"),
    [{ text: "a", checked: true }, { text: "b", checked: false }]);
  assert.deepEqual(criteriaFromBody(undefined), []);
});

// --- Postgres ---------------------------------------------------------------------------------
const capture = () => {
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
  return { io, text: () => out.join("\n") };
};
const pgIo = (url) => ({
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPostgresClient: (c) => pgClient(c),
});
async function loadedBoard(tag) {
  const db = await scratchPgDb(tag);
  const roots = board();
  assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
  assert.equal(await runDb(["load"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
  return { db, roots };
}
const sql = async (url, text) => {
  const c = await pgClient(url);
  try { await c.query(text); } finally { await c.end(); }
};

test("acceptance: load → verify exits 0 and prints PASS", PG_SKIP, async () => {
  const { db, roots } = await loadedBoard("verify");
  try {
    const c = capture();
    assert.equal(await runDb(["verify"], { ...c.io, roots, ...pgIo(db.url) }), 0, c.text());
    assert.match(c.text(), /compared\s+2 tickets/);
    assert.match(c.text(), /criteria\s+3 checked, 0 diffs/);
    assert.match(c.text(), /verify: PASS/);
  } finally { await db.drop(); }
});

test("one injected value change in the database → exit 1, naming the ticket and field", PG_SKIP, async () => {
  const { db, roots } = await loadedBoard("verifyval");
  try {
    await sql(db.url, "UPDATE ticket SET title = 'tampered' WHERE id = 'ENG-2'");
    const c = capture();
    assert.equal(await runDb(["verify"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /ENG-2 {2}title: "B task" → "tampered"/);
    assert.match(c.text(), /verify: FAIL — 1 value difference\(s\)/);
  } finally { await db.drop(); }
});

test("the database losing a ticket's unknown keys (extra_json) → exit 1, naming it", PG_SKIP, async () => {
  const { db, roots } = await loadedBoard("verifyextra");
  try {
    await sql(db.url, "UPDATE ticket SET extra_json = '{}' WHERE id = 'ENG-2'");
    const c = capture();
    assert.equal(await runDb(["verify"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /ENG-2 {2}extra: "\{\\"custom_key\\":\\"keepme\\"\}" → "\{\}"/);
  } finally { await db.drop(); }
});

test("a db-mode edit keeps a ticket's unknown keys — the readers surface extra_json", async () => {
  const roots = dbBoard();
  writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md"),
    ["---", "id: ENG-1", "title: A task", "type: task", "project: ENG", "estimate: 30",
     "custom_key: keepme", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  assert.equal(await runDb(["init"], { log() {}, err() {}, env: {}, roots }), 0);
  const r = runner("edit-runner.mjs", ["ENG-1", "priority", "low"], roots);
  assert.equal(r.status, 0, r.stderr);
  const { openSqliteRead } = await import("../scripts/model/sqlite-storage.mjs");
  const { shadowDbPath } = await import("../scripts/model/write-port-resolve.mjs");
  const rs = openSqliteRead(shadowDbPath(roots.dataRoot));
  try {
    const fm = rs.getTicket(null, "ENG-1").found.frontmatter;
    assert.equal(fm.priority, "low");
    assert.equal(fm.custom_key, "keepme", "before the readers surfaced it, the edit wrote {} over it");
  } finally { rs.close(); }
});

test("a row the reader never shows (a soft-deleted ticket) still fails the row count", PG_SKIP, async () => {
  const { db, roots } = await loadedBoard("verifycount");
  try {
    await sql(db.url, `INSERT INTO ticket (id, project_key, num, type, status, title, created_on, updated_on, deleted_at)
                       VALUES ('ENG-3', 'ENG', 3, 'task', 'defined', 'gone', '2026-01-01', '2026-01-01', now())`);
    const c = capture();
    assert.equal(await runDb(["verify"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /rows ticket\s+3 loaded, 2 expected/);
    assert.match(c.text(), /verify: FAIL — row counts differ in ticket$/m);
  } finally { await db.drop(); }
});

test("could not run → exit 2: not Postgres, no schema, an unreadable source ticket", PG_SKIP, async () => {
  const db = await scratchPgDb("verifyrefuse");
  try {
    const roots = board();
    const sq = capture();
    assert.equal(await runDb(["verify"], { ...sq.io, roots, resolveDbConfig: () => ({ driver: "sqlite" }) }), 2);
    assert.match(sq.text(), /could not run/);

    const empty = capture();
    assert.equal(await runDb(["verify"], { ...empty.io, roots, ...pgIo(db.url) }), 2);
    assert.match(empty.text(), /has no Blaze schema/);

    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-9-bad.md"), "no frontmatter at all\n");
    const bad = capture();
    assert.equal(await runDb(["verify"], { ...bad.io, roots, ...pgIo(db.url) }), 2);
    assert.match(bad.text(), /missing frontmatter/);
    assert.doesNotMatch(bad.text(), /PASS/);
  } finally { await db.drop(); }
});
