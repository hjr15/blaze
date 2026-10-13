// tests/db-load.test.mjs — BLZ-678, `blaze db load`: the board's tickets into Postgres.
//
// One row builder (`corpusRows`), two executors (the sync SQLite `loadCorpus`, the async
// `loadCorpusAsync`). The first block proves the executors cannot drift without a server; the
// Postgres block proves the command: one transaction, refuses a non-empty table unless
// --replace, all-or-nothing on a refused row, and the counter seeded from what loaded.
// Each Postgres test gets its OWN scratch database. Run with --test-concurrency=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../scripts/model/sqlite-schema.mjs";
import { corpusRows, relationRows, loadCorpus, loadCorpusAsync, verifyDiffRows } from "../scripts/migrate/load-corpus.mjs";
import { buildTransitions } from "../scripts/model/transitions.mjs";
import { shadowDbPath } from "../scripts/model/write-port-resolve.mjs";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { sqliteExec } from "../scripts/model/write-port-resolve.mjs";
import { postgresReader } from "../scripts/model/pg-storage.mjs";
import { writeClaim } from "../scripts/model/claims.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { dbBoard } from "./helpers/db-board.mjs";
import { PG, PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pgHost = () => escapeRegExp(new URL(PG).hostname);

/** dbBoard()'s ENG-1, plus ENG-2: a child of ENG-1 that Blocks it, with a repeated label, a
 *  worklog entry, a sub-half-minute worklog entry, and a link to a ticket that does not exist. */
function board() {
  const roots = dbBoard();
  writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-2-b.md"),
    ["---", "id: ENG-2", "title: B task", "type: task", "project: ENG", "priority: high",
     "assignee: unassigned", "estimate: 15", "parent: ENG-1", "labels: [x, y, x]",
     "created: 2026-01-02", "updated: 2026-01-03",
     "worklog:", "  - { date: 2026-01-03, minutes: 10, note: first }", "  - { date: 2026-01-03, minutes: 0.2 }",
     "links:", "  - { type: Blocks, target: ENG-1 }", "  - { type: Relates, target: ENG-99 }",
     "---", "", "B body", ""].join("\n"));
  return roots;
}

const capture = () => {
  const out = [];
  const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
  return { io, text: () => out.join("\n") };
};
const pgIo = (url) => ({
  resolveDbConfig: () => ({ driver: "postgres", connection: url }),
  openPostgresClient: (c) => pgClient(c),
});
const count = async (url, sql) => {
  const c = await pgClient(url);
  try { return Number((await c.query(sql)).rows[0].n); } finally { await c.end(); }
};

test("corpusRows builds once: repeated labels collapse, a dropped worklog is named, links stay raw", () => {
  const { projectsDir } = board();
  const { tickets, maxNum, report } = corpusRows(fsReadStorage, projectsDir, { today: "2026-10-05" });
  const two = tickets.find((t) => t.id === "ENG-2");
  assert.deepEqual(two.labels, ["x", "y"], "a repeated label is one row — the PK refuses the second");
  assert.deepEqual(two.worklog, [{ date: "2026-01-03", minutes: 10, note: "first" }]);
  assert.deepEqual(two.worklogDropped, [{ id: "ENG-2", minutes: "0.2" }]);
  assert.equal(two.parent, "ENG-1");
  assert.equal(two.links.length, 2, "dangling is decided by the executor, against what loaded");
  assert.deepEqual([...maxNum], [["ENG", 2]]);
  assert.equal(report.tickets, 0, "the builder inserts nothing, so it counts no loaded ticket");
  assert.deepEqual(report.collapsed, { labels: 1, components: 0 }, "the repeated x is counted, not just dropped");
});

test("relationRows counts a repeated link it collapses", () => {
  const t = (id, links) => ({ id, parent: "", links });
  const rel = relationRows([t("A-1", [{ type: "Blocks", target: "A-2" }, { type: "Blocks", target: "A-2" }]), t("A-2", [])],
                           new Map([["A-1", "task"], ["A-2", "task"]]));
  assert.equal(rel.links.length, 1);
  assert.equal(rel.duplicateLinks, 1);
});

test("verifyDiffRows: every row the load dropped or collapsed — each one a value diff in verify", () => {
  const tally = { danglingParents: 1, danglingLinks: 2, duplicateLinks: 1,
                  skipped: { worklogDropped: [{}, {}, {}] }, collapsed: { labels: 4, components: 5 } };
  assert.deepEqual(verifyDiffRows(tally),
    { danglingParents: 1, danglingLinks: 2, duplicateLinks: 1, worklogDropped: 3, labels: 4, components: 5, total: 16 });
  assert.equal(verifyDiffRows({ skipped: { worklogDropped: [] } }).total, 0);
});

test("relationRows links only what loaded: a dangling link and parent are counted, never forged", () => {
  const { projectsDir } = board();
  const { tickets } = corpusRows(fsReadStorage, projectsDir);
  const all = relationRows(tickets, new Map([["ENG-1", "task"], ["ENG-2", "task"]]));
  assert.deepEqual(all.parents, [{ id: "ENG-2", parent: "ENG-1", parentType: "task" }]);
  assert.deepEqual(all.links, [{ src: "ENG-2", type: "Blocks", target: "ENG-1" }]);
  assert.equal(all.danglingLinks, 1);
  const withoutOne = relationRows(tickets, new Map([["ENG-2", "task"]]));   // ENG-1 refused
  assert.equal(withoutOne.danglingParents, 1);
  assert.equal(withoutOne.danglingLinks, 2);
});

test("the two executors cannot drift: async over SQLite tallies exactly what the sync loader does", async () => {
  const { projectsDir } = board();
  const sync = new DatabaseSync(":memory:");
  sync.exec(SQLITE_PRAGMAS); sync.exec(SQLITE_DDL);
  const a = loadCorpus(sync, projectsDir, { today: "2026-10-05" });

  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
  const exec = sqliteExec(db);
  exec.run("BEGIN", []);
  const { typeById, ...b } = await loadCorpusAsync(exec, projectsDir, { today: "2026-10-05", dialect: "sqlite" });
  exec.run("COMMIT", []);

  // The tally agrees on everything except the derived AC index, which only the shadow fills.
  const drop = ({ criteria, notes, acHeadings, ...rest }) => rest;
  assert.deepEqual(drop(b), drop(a));
  assert.deepEqual([...typeById.keys()].sort(), ["ENG-1", "ENG-2"]);
  // Row VALUES, not just counts: two executors that inserted the same number of rows with a
  // different value in one of them have drifted. `ac_heading` is the derived AC index the async
  // executor leaves empty (below); worklog's `id` is an autoincrement surrogate.
  const rows = (h, sql) => h.prepare(sql).all().map((r) => ({ ...r }));
  const cols = (h, table, skip) => h.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()
    .map((r) => r.name).filter((c) => !skip.includes(c));
  for (const [table, skip, order] of [["ticket", ["ac_heading"], "id"],
                                      ["ticket_link", [], "src_id, link_type, target_id"],
                                      ["ticket_label", [], "ticket_id, ord"],
                                      ["ticket_component", [], "ticket_id, ord"],
                                      ["worklog_entry", ["id"], "ticket_id, on_date, minutes"]]) {
    const sql = `SELECT ${cols(sync, table, skip).join(", ")} FROM ${table} ORDER BY ${order}`;
    assert.deepEqual(rows(db, sql), rows(sync, sql), table);
  }
  assert.ok(rows(sync, "SELECT * FROM ticket").length === 2 && rows(sync, "SELECT * FROM worklog_entry").length === 1,
    "the comparison above compared real rows, not two empty tables");
  assert.equal(db.prepare("SELECT count(*) n FROM acceptance_criterion").get().n, 0,
    "the async executor leaves the derived AC index empty (spec §5.2)");
  assert.equal(sync.prepare("SELECT count(*) n FROM acceptance_criterion").get().n, 1);
  assert.equal(b.labels, 2, "x, y — the repeated x is not a row and is not counted");
});

/** A real node:sqlite handle whose statements throw when `failWhen(sql, args)` says so. */
function failingDb(failWhen) {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
  return { db, handle: {
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const st = db.prepare(sql);
      return { run: (...args) => { if (failWhen(sql, args)) throw new Error("injected refusal"); return st.run(...args); },
               get: (...a) => st.get(...a), all: (...a) => st.all(...a) };
    },
  } };
}

test("sync loadCorpus: a ticket whose LABEL is refused goes whole — no half-loaded ticket row", () => {
  const { projectsDir } = board();
  const { db, handle } = failingDb((sql, args) => /INTO ticket_label/.test(sql) && args[0] === "ENG-2");
  const r = loadCorpus(handle, projectsDir, { today: "2026-10-05" });
  assert.deepEqual(r.skipped.insertFailed.map((f) => f.id), ["ENG-2"]);
  assert.equal(r.tickets, 1);
  assert.deepEqual(db.prepare("SELECT id FROM ticket").all().map((x) => x.id), ["ENG-1"],
    "ENG-2's ticket row rolled back with its refused label (a savepoint per ticket)");
  assert.equal(db.prepare("SELECT count(*) n FROM worklog_entry").get().n, 0);
});

test("sync loadCorpus: a failure outside the per-ticket savepoint rolls the whole load back", () => {
  const { projectsDir } = board();
  const { db, handle } = failingDb((sql) => /project_counter/.test(sql));
  assert.throws(() => loadCorpus(handle, projectsDir, { today: "2026-10-05" }), /injected refusal/);
  assert.equal(db.isTransaction, false, "no transaction left open on the handle");
  assert.equal(db.prepare("SELECT count(*) n FROM ticket").get().n, 0);
});

test("an unknown dialect is refused before anything runs", async () => {
  await assert.rejects(loadCorpusAsync({ run() {}, all() { return []; } }, "/nowhere", { dialect: "mysql" }),
    /unknown dialect "mysql"/);
});

test("acceptance: init → load → the reader holds the board; the counter follows the highest CLAIM",
     PG_SKIP, async () => {
  const db = await scratchPgDb("load");
  try {
    const roots = board();
    writeClaim(roots.projectsDir, "ENG", 9, "claimed-no-ticket");
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c = capture();
    assert.equal(await runDb(["load"], { ...c.io, roots, ...pgIo(db.url) }), 0, c.text());
    assert.match(c.text(), new RegExp(`loaded ${pgHost()}/${db.name}`));
    assert.match(c.text(), /tickets\s+2/);
    assert.match(c.text(), /links\s+1/);
    assert.match(c.text(), /dangling links dropped: 1/);
    assert.match(c.text(), /worklog entries dropped: 1/);
    assert.match(c.text(), /repeated labels\/components collapsed: 1/);
    assert.match(c.text(), /3 row\(s\) above were dropped or collapsed — 'blaze db verify' will report each as a value difference/);
    assert.match(c.text(), /ENG\s+9 → 9/, "init already seeded 9 from the claim; load keeps it");
    assert.match(c.text(), /blaze db verify/);

    const client = await pgClient(db.url);
    try {
      const two = (await postgresReader(client).getTicket(null, "ENG-2")).found;
      assert.equal(two.frontmatter.parent, "ENG-1");
      assert.deepEqual(two.frontmatter.labels, ["x", "y"]);
      assert.deepEqual(two.frontmatter.links, [{ type: "Blocks", target: "ENG-1" }]);
      assert.deepEqual(two.frontmatter.worklog, [{ date: "2026-01-03", minutes: 10, note: "first" }]);
      assert.equal(two.frontmatter.created, "2026-01-02");
      assert.match(two.body, /B body/);
    } finally { await client.end(); }
    assert.equal(await count(db.url, "SELECT count(*) n FROM acceptance_criterion"), 0);
    assert.equal(await count(db.url, "SELECT n FROM project_counter WHERE project_key = 'ENG'"), 9);
  } finally { await db.drop(); }
});

test("a second load is REFUSED and changes nothing; --replace reloads and never lowers the counter",
     PG_SKIP, async () => {
  const db = await scratchPgDb("reload");
  try {
    const roots = board();
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    assert.equal(await runDb(["load"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c1 = await pgClient(db.url);
    try { await c1.query("UPDATE project_counter SET n = 40 WHERE project_key = 'ENG'"); } finally { await c1.end(); }

    const again = capture();
    assert.equal(await runDb(["load"], { ...again.io, roots, ...pgIo(db.url) }), 1);
    assert.match(again.text(), /already holds 2 ticket\(s\)\. Nothing was loaded/);
    assert.match(again.text(), /blaze db verify/);
    assert.match(again.text(), /--replace/);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket"), 2, "the refused load changed no ticket");
    assert.equal(await count(db.url, "SELECT n FROM project_counter WHERE project_key = 'ENG'"), 40,
      "the refused load left the counter alone");

    const rep = capture();
    assert.equal(await runDb(["load", "--replace"], { ...rep.io, roots, ...pgIo(db.url) }), 0, rep.text());
    assert.match(rep.text(), /--replace: the previous 2 ticket\(s\) were erased first/);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket"), 2);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket_link"), 1);
    assert.equal(await count(db.url, "SELECT n FROM project_counter WHERE project_key = 'ENG'"), 40,
      "a number already issued is never issued again — --replace does not reset the counter");
  } finally { await db.drop(); }
});

test("--replace on an EMPTY database says nothing was erased", PG_SKIP, async () => {
  const db = await scratchPgDb("replaceempty");
  try {
    const roots = board();
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c = capture();
    assert.equal(await runDb(["load", "--replace"], { ...c.io, roots, ...pgIo(db.url) }), 0, c.text());
    assert.doesNotMatch(c.text(), /were erased/);
    assert.match(c.text(), /--replace: the database held no tickets — nothing to erase/);
  } finally { await db.drop(); }
});

test("the git history is read BEFORE the load's transaction opens", PG_SKIP, async () => {
  const db = await scratchPgDb("buildfirst");
  try {
    const roots = board();
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const order = [];
    const io = {
      ...pgIo(db.url),
      openPostgresClient: async (url) => {
        const cl = await pgClient(url);
        const query = cl.query.bind(cl);
        cl.query = (text, ...rest) => { if (/^\s*BEGIN/i.test(String(text))) order.push("BEGIN"); return query(text, ...rest); };
        return cl;
      },
      buildTransitions: (opts) => { order.push("build"); return buildTransitions(opts); },
    };
    const c = capture();
    assert.equal(await runDb(["load"], { ...c.io, roots, ...io }), 0, c.text());
    assert.deepEqual(order, ["build", "BEGIN"], "a git walk must not hold the transaction open");
  } finally { await db.drop(); }
});

test("a failing load --replace leaves the previous tickets, events and counter intact", PG_SKIP, async () => {
  const db = await scratchPgDb("replacefail");
  try {
    const roots = board();
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    assert.equal(await runDb(["load"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const snap = async () => [
      await count(db.url, "SELECT count(*) n FROM ticket"),
      await count(db.url, "SELECT count(*) n FROM ticket_event"),
      await count(db.url, "SELECT n FROM project_counter WHERE project_key = 'ENG'")];
    const before = await snap();
    mkdirSync(join(roots.projectsDir, "ENG", "done"), { recursive: true });
    writeFileSync(join(roots.projectsDir, "ENG", "done", "eng-7-bad.md"),
      ["---", "id: eng-7", "title: bad", "type: task", "project: ENG", "---", "", "x", ""].join("\n"));
    const c = capture();
    assert.equal(await runDb(["load", "--replace"], { ...c.io, roots, ...pgIo(db.url) }), 1, c.text());
    assert.deepEqual(await snap(), before, "the TRUNCATE rolled back with the refused load");
  } finally { await db.drop(); }
});

test("a row Postgres refuses rolls the WHOLE load back and names every refusal", PG_SKIP, async () => {
  const db = await scratchPgDb("refused");
  try {
    const roots = board();
    // Filed under ENG, but its id is lower-case: ticket's CHECK (id = project_key || '-' || num)
    // refuses it. The builder cannot know that; the database can.
    mkdirSync(join(roots.projectsDir, "ENG", "done"), { recursive: true });
    writeFileSync(join(roots.projectsDir, "ENG", "done", "eng-7-bad.md"),
      ["---", "id: eng-7", "title: bad", "type: task", "project: ENG", "---", "", "x", ""].join("\n"));
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c = capture();
    assert.equal(await runDb(["load"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /refused 1 row\(s\), so NOTHING was loaded/);
    assert.match(c.text(), /eng-7: .*check constraint/i);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket"), 0, "ENG-1 and ENG-2 rolled back too");
  } finally { await db.drop(); }
});

test("a refused PARENT is named with its ticket too, and the load still rolls back whole", PG_SKIP, async () => {
  const db = await scratchPgDb("refusedparent");
  try {
    const roots = board();
    // Its own parent: ticket's CHECK (parent_id IS DISTINCT FROM id) refuses pass two's UPDATE.
    writeFileSync(join(roots.projectsDir, "ENG", "defined", "ENG-3-self.md"),
      ["---", "id: ENG-3", "title: self", "type: task", "project: ENG", "estimate: 30",
       "parent: ENG-3", "---", "", "x", ""].join("\n"));
    assert.equal(await runDb(["init"], { ...capture().io, roots, ...pgIo(db.url) }), 0);
    const c = capture();
    assert.equal(await runDb(["load"], { ...c.io, roots, ...pgIo(db.url) }), 1);
    assert.match(c.text(), /refused 1 row\(s\), so NOTHING was loaded/);
    assert.match(c.text(), /ENG-3: parent: .*ticket_not_own_parent/);
    assert.equal(await count(db.url, "SELECT count(*) n FROM ticket"), 0);
  } finally { await db.drop(); }
});

test("load refuses a SQLite board, a database with no schema, and BLAZE_READONLY", PG_SKIP, async () => {
  const db = await scratchPgDb("loadrefuse");
  try {
    const roots = board();
    const sq = capture();
    assert.equal(await runDb(["load"], { ...sq.io, roots, resolveDbConfig: () => ({ driver: "sqlite" }) }), 1);
    assert.match(sq.text(), /loads a Postgres database/);

    const empty = capture();
    assert.equal(await runDb(["load"], { ...empty.io, roots, ...pgIo(db.url) }), 1);
    assert.match(empty.text(), /has no Blaze schema/);
    assert.match(empty.text(), /blaze db init/);

    const ro = capture();
    assert.equal(await runDb(["load"], { ...ro.io, env: { BLAZE_READONLY: "1" }, roots, ...pgIo(db.url) }), 1);
    assert.match(ro.text(), /read-only mode \(BLAZE_READONLY=1\) — refusing to run blaze db load/);
  } finally { await db.drop(); }
});

test("SQLite init: a transition import that fails is ROLLED BACK and named, never a crash", async () => {
  const roots = board();
  const c = capture();
  const exploding = { head: "x", get transitions() { throw new Error("injected transitions failure"); } };
  assert.equal(await runDb(["init"], { ...c.io, roots, buildTransitions: () => exploding }), 1, c.text());
  assert.match(c.text(), /importing the git history failed: injected transitions failure/);
  assert.match(c.text(), /blaze db init --force/);
  const h = new DatabaseSync(shadowDbPath(roots.dataRoot));
  try {
    assert.equal(h.prepare("SELECT count(*) n FROM ticket_event").get().n, 0);
    h.exec("BEGIN IMMEDIATE"); h.exec("ROLLBACK");   // not left locked mid-transaction
  } finally { h.close(); }
});
