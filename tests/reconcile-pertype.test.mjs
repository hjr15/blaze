// tests/reconcile-pertype.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, reconcile } from "../scripts/reconcile.mjs";

test("delivery type with a merged PR targets done", () => {
  const d = decide({ pr: { state: "MERGED", number: 5, url: "u", headRefName: "OBA-1-x" }, branch: null }, "in-review", "task");
  assert.equal(d.skip, false);
  assert.equal(d.target, "done");
});

test("goal type is never reconciled even with git signal", () => {
  const d = decide({ pr: { state: "MERGED", number: 5, url: "u", headRefName: "OBA-1-x" }, branch: null }, "in-progress", "goal");
  assert.equal(d.skip, true);
  assert.equal(d.moved, false);
  assert.equal(d.target, "in-progress");
});

test("risk type is never reconciled", () => {
  const d = decide({ pr: null, branch: "OBA-2-x" }, "identified", "risk");
  assert.equal(d.skip, true);
});

test("delivery type with no git signal is skipped (unchanged behaviour)", () => {
  const d = decide({ pr: null, branch: null }, "defined", "task");
  assert.equal(d.skip, true);
});

test("reconcile dry-run makes no file moves", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-rec-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  mkdirSync(join(projects, "OBA"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", name: "OBA" }));
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\nbranch: OBA-1-x\n---\nb\n");
  const r = reconcile({ fetch: false, commit: false, push: true, dryRun: true, root });
  // dry-run never moves the file regardless of derived target
  assert.ok(existsSync(join(projects, "OBA", "defined", "OBA-1.md")));
  assert.equal(r.pushed, false);   // push is never performed
  rmSync(root, { recursive: true, force: true });
});
