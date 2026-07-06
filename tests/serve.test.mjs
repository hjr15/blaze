// tests/serve.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardModel } from "../scripts/serve.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-serve-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "in-progress"), { recursive: true });
  mkdirSync(join(projects, "OBA", "done"), { recursive: true });
  mkdirSync(join(projects, "INF", "defined"), { recursive: true });
  writeFileSync(join(projects, "OBA", "in-progress", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: A\ntype: task\nproject: OBA\npriority: high\n---\n## Context\nx\n");
  writeFileSync(join(projects, "OBA", "done", "OBA-2.md"),
    "---\nid: OBA-2\ntitle: B\ntype: task\nproject: OBA\nresolution: done\n---\nbody\n");
  writeFileSync(join(projects, "INF", "defined", "INF-1.md"),
    "---\nid: INF-1\ntitle: C\ntype: task\nproject: INF\n---\nbody\n");
  return { root, projects };
}

test("boardModel aggregates all projects and counts per project", () => {
  const { root, projects } = fixture();
  const m = boardModel(projects, { project: "all" });
  assert.equal(m.total, 3);
  assert.deepEqual(m.projects, { OBA: 2, INF: 1 });
  const done = m.columns.find((c) => c.dir === "done");
  assert.equal(done.tickets.length, 1);
  assert.equal(done.tickets[0].meta.id, "OBA-2");
  rmSync(root, { recursive: true, force: true });
});

test("boardModel filters to a single project", () => {
  const { root, projects } = fixture();
  const m = boardModel(projects, { project: "INF" });
  assert.equal(m.total, 1);
  assert.equal(m.selected, "INF");
  assert.ok(m.columns.find((c) => c.dir === "defined").tickets.length === 1);
  rmSync(root, { recursive: true, force: true });
});

test("status columns are ordered by the workflow union", () => {
  const { root, projects } = fixture();
  const m = boardModel(projects, { project: "OBA" });
  const dirs = m.columns.map((c) => c.dir);
  assert.ok(dirs.indexOf("in-progress") < dirs.indexOf("done"));
  rmSync(root, { recursive: true, force: true });
});

import { rollUp } from "../scripts/model/rollup.mjs";
import { buildIndex } from "../scripts/model/index.mjs";

function rollupFixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-serve-rollup-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  mkdirSync(join(projects, "OBA", "in-progress"), { recursive: true });
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: Goal\ntype: goal\nproject: OBA\n---\nbody\n");
  writeFileSync(join(projects, "OBA", "defined", "OBA-2.md"),
    "---\nid: OBA-2\ntitle: Epic\ntype: epic\nproject: OBA\nparent: OBA-1\n---\nbody\n");
  writeFileSync(join(projects, "OBA", "in-progress", "OBA-3.md"),
    "---\nid: OBA-3\ntitle: Task\ntype: task\nproject: OBA\nparent: OBA-2\nestimate: 90\n---\nbody\n");
  return { root, projects };
}

test("boardModel exposes a rollup map with parent rolled totals", () => {
  const { root, projects } = rollupFixture();
  const m = boardModel(projects, { project: "OBA" });
  assert.ok(m.rollup instanceof Map);
  assert.equal(m.rollup.get("OBA-2").rolled_estimate, 90);   // epic rolls up the task
  assert.equal(m.rollup.get("OBA-1").rolled_estimate, 90);   // goal rolls up the epic
  rmSync(root, { recursive: true, force: true });
});

test("boardModel rollup leaves report rolled == own with no descendants", () => {
  const { root, projects } = rollupFixture();
  const m = boardModel(projects, { project: "OBA" });
  const leaf = m.rollup.get("OBA-3");                // the task
  assert.equal(leaf.own_estimate, 90);
  assert.equal(leaf.rolled_estimate, 90);            // leaf: rolled == own
  assert.equal(leaf.descendant_count, 0);
  rmSync(root, { recursive: true, force: true });
});
