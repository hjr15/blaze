import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardModel } from "../../scripts/views/data.mjs";

test("boardModel groups tickets into status columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-data-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: t\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  const m = boardModel(dir, { project: "all" });
  assert.equal(m.total, 1);
  assert.ok(m.columns.some((c) => c.dir === "todo" && c.tickets.length === 1));
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
