import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardModel, contentHash } from "../../scripts/views/data.mjs";
import { buildIndex } from "../../scripts/model/index.mjs";
import { viewEnvelope } from "../../scripts/views/page.mjs";

// Two-project fixture (T + U, one ticket each) for contentHash project-scoping
// tests — follows the single-project inline style used by the tests above.
function fixtureTwoProjects() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-hash-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  mkdirSync(join(dir, "U", "todo"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: t\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  writeFileSync(join(dir, "U", "todo", "U-1.md"),
    "---\nid: U-1\ntitle: u\ntype: task\nproject: U\nestimate: 5\n---\nbody\n");
  return dir;
}

test("boardModel groups tickets into status columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-data-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: t\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  const m = boardModel(dir, { project: "all" });
  assert.equal(m.total, 1);
  assert.ok(m.columns.some((c) => c.dir === "todo" && c.tickets.length === 1));
});

test("boardModel returns the index it built, and reuses a prebuilt one when passed", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-data-idx-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: t\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");

  const built = boardModel(dir, { project: "all" });
  assert.equal(built.index.count(), 1);
  assert.equal(built.index.get("T-1").title, "t");

  const prebuilt = buildIndex(dir);
  const reused = boardModel(dir, { project: "all", index: prebuilt });
  assert.equal(reused.index, prebuilt); // same object, not rebuilt
});

test("boardModel adds per-workflow boards while leaving columns intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-data-"));
  mkdirSync(join(dir, "INF", "achieved"), { recursive: true });
  mkdirSync(join(dir, "INF", "identified"), { recursive: true });
  mkdirSync(join(dir, "INF", "defined"), { recursive: true });
  writeFileSync(join(dir, "INF", "achieved", "INF-1.md"), "---\nid: INF-1\ntitle: g\ntype: goal\nproject: INF\n---\nx\n");
  writeFileSync(join(dir, "INF", "identified", "INF-2.md"), "---\nid: INF-2\ntitle: r\ntype: risk\nproject: INF\n---\nx\n");
  writeFileSync(join(dir, "INF", "defined", "INF-3.md"), "---\nid: INF-3\ntitle: t\ntype: task\nproject: INF\n---\nx\n");

  const m = boardModel(dir, {});
  // columns untouched: still one column per raw status that has tickets
  assert.equal(m.total, 3);
  assert.ok(m.columns.some((c) => c.dir === "achieved"), "columns keeps achieved as its own column");

  // boards: delivery (goal folded) + risk
  assert.deepEqual(m.boards.map((b) => b.name), ["delivery", "risk"]);
  const done = m.boards[0].columns.find((c) => c.dir === "done");
  assert.equal(done.tickets.length, 1, "achieved goal folds into Done");
  assert.equal(done.tickets[0].badge, "achieved");
  const risk = m.boards[1];
  assert.equal(risk.columns.find((c) => c.dir === "identified").tickets.length, 1);
  const defined = m.boards[0].columns.find((c) => c.dir === "defined");
  assert.equal(defined.tickets[0].badge, null);
});

test("boardModel omits an empty board (single visible board, no switcher)", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-onebo-"));
  mkdirSync(join(dir, "INF", "defined"), { recursive: true });
  writeFileSync(join(dir, "INF", "defined", "INF-3.md"), "---\nid: INF-3\ntitle: t\ntype: task\nproject: INF\n---\nx\n");
  const m = boardModel(dir, {});
  assert.equal(m.boards.length, 1);
  assert.equal(m.boards[0].name, "delivery");
});

test("boardModel focus filters to a parent's descendants + exposes crumbs", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-focus-"));
  mkdirSync(join(dir, "INF", "defined"), { recursive: true });
  writeFileSync(join(dir, "INF", "defined", "INF-9.md"), "---\nid: INF-9\ntitle: epic\ntype: epic\nproject: INF\n---\nx\n");
  writeFileSync(join(dir, "INF", "defined", "INF-10.md"), "---\nid: INF-10\ntitle: kid\ntype: task\nproject: INF\nparent: INF-9\n---\nx\n");
  writeFileSync(join(dir, "INF", "defined", "INF-11.md"), "---\nid: INF-11\ntitle: other\ntype: task\nproject: INF\n---\nx\n");

  const m = boardModel(dir, { focus: "INF-9" });
  assert.equal(m.focus.id, "INF-9");
  assert.deepEqual(m.focus.crumbs.map((c) => c.id), ["INF-9"]);
  const ids = m.boards.flatMap((b) => b.columns.flatMap((c) => c.tickets.map((t) => t.meta.id)));
  assert.deepEqual(ids.sort(), ["INF-10"]);  // only the descendant
});

// Goals-first nesting fixture: G-1 (goal) ← E-1, E-2 (epics) ; E-1 ← T-1 (task).
function fixtureNesting() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-nesting-"));
  mkdirSync(join(dir, "N", "defined"), { recursive: true });
  writeFileSync(join(dir, "N", "defined", "G-1.md"),
    "---\nid: G-1\ntitle: goal\ntype: goal\nproject: N\n---\nx\n");
  writeFileSync(join(dir, "N", "defined", "E-1.md"),
    "---\nid: E-1\ntitle: epic one\ntype: epic\nproject: N\nparent: G-1\n---\nx\n");
  writeFileSync(join(dir, "N", "defined", "E-2.md"),
    "---\nid: E-2\ntitle: epic two\ntype: epic\nproject: N\nparent: G-1\n---\nx\n");
  writeFileSync(join(dir, "N", "defined", "T-1.md"),
    "---\nid: T-1\ntitle: task\ntype: task\nproject: N\nparent: E-1\nestimate: 5\n---\nx\n");
  return dir;
}

test("boardModel with no focus and flat:false shows only parentless tickets (goals-first default)", () => {
  const dir = fixtureNesting();
  const m = boardModel(dir, { project: "N" });
  const ids = m.columns.flatMap((c) => c.tickets.map((t) => t.meta.id));
  assert.deepEqual(ids.sort(), ["G-1"]);
});

test("boardModel focus:G-1 shows exactly its direct children, not grandchildren", () => {
  const dir = fixtureNesting();
  const m = boardModel(dir, { project: "N", focus: "G-1" });
  const ids = m.columns.flatMap((c) => c.tickets.map((t) => t.meta.id));
  assert.deepEqual(ids.sort(), ["E-1", "E-2"]);
});

test("boardModel flat:true shows the whole corpus", () => {
  const dir = fixtureNesting();
  const m = boardModel(dir, { project: "N", flat: true });
  const ids = m.columns.flatMap((c) => c.tickets.map((t) => t.meta.id));
  assert.deepEqual(ids.sort(), ["E-1", "E-2", "G-1", "T-1"]);
});

test("viewEnvelope metrics keeps whole-project scope even though the default board is parentless-only", () => {
  const dir = fixtureNesting();
  const envelope = viewEnvelope({ view: "metrics", project: "N", projectsDir: dir, transitions: [] });
  // all four fixture tickets should be reflected, not just the parentless goal.
  assert.match(envelope.html, /class="tile-value">4</);
});

test("contentHash scoped to a project ignores other projects' changes", () => {
  const dir = fixtureTwoProjects();
  const scopedBefore = contentHash({ projectsDir: dir, project: "T" });
  const wholeBefore = contentHash({ projectsDir: dir });
  writeFileSync(join(dir, "U", "todo", "U-1.md"), "---\nid: U-1\ntitle: changed\ntype: task\nproject: U\nestimate: 5\n---\nx\n");
  assert.equal(contentHash({ projectsDir: dir, project: "T" }), scopedBefore); // T-scope blind to U
  assert.notEqual(contentHash({ projectsDir: dir }), wholeBefore);             // whole tree sees it
});
