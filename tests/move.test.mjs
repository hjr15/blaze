// tests/move.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMove } from "../scripts/move.mjs";

function fixture(status = "in-review", fm = "") {
  const root = mkdtempSync(join(tmpdir(), "blaze-move-"));
  const dir = join(root, "projects", "OBA", status);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "OBA-1.md"),
    `---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n${fm}created: 2026-06-01\nupdated: 2026-06-01\n---\nbody\n`);
  return { root, projects: join(root, "projects") };
}

test("applyMove relocates the file and sets resolution on terminal entry", () => {
  const { root, projects } = fixture("in-review");
  const r = applyMove(projects, "OBA-1", "done", { today: "2026-06-29" });
  assert.equal(r.ok, true);
  assert.equal(r.from, "in-review");
  assert.equal(r.to, "done");
  assert.ok(existsSync(join(projects, "OBA", "done", "OBA-1.md")));
  assert.ok(!existsSync(join(projects, "OBA", "in-review", "OBA-1.md")));
  const moved = readFileSync(join(projects, "OBA", "done", "OBA-1.md"), "utf8");
  assert.match(moved, /resolution: done/);
  assert.match(moved, /updated: 2026-06-29/);
  rmSync(root, { recursive: true, force: true });
});

test("applyMove rejects an illegal transition and leaves the file in place", () => {
  const { root, projects } = fixture("defined");
  const r = applyMove(projects, "OBA-1", "done", { today: "2026-06-29" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /illegal transition/.test(e)));
  assert.ok(existsSync(join(projects, "OBA", "defined", "OBA-1.md")));
  rmSync(root, { recursive: true, force: true });
});

test("applyMove reports a missing ticket", () => {
  const { root, projects } = fixture("defined");
  const r = applyMove(projects, "OBA-404", "in-progress", { today: "2026-06-29" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /not found/.test(e)));
  rmSync(root, { recursive: true, force: true });
});

test("applyMove relocates to a non-terminal status with no resolution", () => {
  const { root, projects } = fixture("defined");
  const r = applyMove(projects, "OBA-1", "in-progress", { today: "2026-06-29" });
  assert.equal(r.ok, true);
  assert.equal(r.to, "in-progress");
  assert.ok(existsSync(join(projects, "OBA", "in-progress", "OBA-1.md")));
  assert.equal(r.resolution, null);
  assert.deepEqual(r.warnings, []);
  rmSync(root, { recursive: true, force: true });
});

test("applyMove warns (does not block) when moved to in-progress under an open Blocks", () => {
  const { root, projects } = fixture("defined");
  const blockerDir = join(projects, "OBA", "in-progress");
  mkdirSync(blockerDir, { recursive: true });
  writeFileSync(join(blockerDir, "OBA-9.md"),
    "---\nid: OBA-9\ntitle: blocker\ntype: task\nproject: OBA\nestimate: 30\n" +
    "links:\n  - { type: Blocks, target: OBA-1 }\ncreated: 2026-06-01\nupdated: 2026-06-01\n---\nbody\n");
  const r = applyMove(projects, "OBA-1", "in-progress", { today: "2026-07-15" });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /OBA-9/.test(w) && /block/i.test(w)));
  rmSync(root, { recursive: true, force: true });
});

test("applyMove has no block-warning when the blocker is already done", () => {
  const { root, projects } = fixture("defined");
  const blockerDir = join(projects, "OBA", "done");
  mkdirSync(blockerDir, { recursive: true });
  writeFileSync(join(blockerDir, "OBA-9.md"),
    "---\nid: OBA-9\ntitle: blocker\ntype: task\nproject: OBA\nestimate: 30\n" +
    "links:\n  - { type: Blocks, target: OBA-1 }\ncreated: 2026-06-01\nupdated: 2026-06-01\nresolution: done\n---\nbody\n");
  const r = applyMove(projects, "OBA-1", "in-progress", { today: "2026-07-15" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  rmSync(root, { recursive: true, force: true });
});
