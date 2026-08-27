// tests/reconcile-pertype.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, reconcile } from "../scripts/reconcile.mjs";

test("delivery type with a merged PR targets done", async () => {
  const d = decide({ pr: { state: "MERGED", number: 5, url: "u", headRefName: "OBA-1-x" }, branch: null }, "in-review", "task");
  assert.equal(d.skip, false);
  assert.equal(d.target, "done");
});

test("goal type is never reconciled even with git signal", async () => {
  const d = decide({ pr: { state: "MERGED", number: 5, url: "u", headRefName: "OBA-1-x" }, branch: null }, "in-progress", "goal");
  assert.equal(d.skip, true);
  assert.equal(d.moved, false);
  assert.equal(d.target, "in-progress");
});

test("risk type is never reconciled", async () => {
  const d = decide({ pr: null, branch: "OBA-2-x" }, "identified", "risk");
  assert.equal(d.skip, true);
});

test("delivery type with no git signal is skipped (unchanged behaviour)", async () => {
  const d = decide({ pr: null, branch: null }, "defined", "task");
  assert.equal(d.skip, true);
});

test("reconcile dry-run makes no file moves", async () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-rec-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  mkdirSync(join(projects, "OBA"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", name: "OBA" }));
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\nbranch: OBA-1-x\n---\nb\n");
  const r = await reconcile({ fetch: false, commit: false, dryRun: true, root });
  // dry-run never moves the file regardless of derived target
  assert.ok(existsSync(join(projects, "OBA", "defined", "OBA-1.md")));
  assert.equal(r.pushed, false);   // push is never performed
  assert.equal(r.dryRun, true, "reconcile()'s own dryRun travels on the result too (BLZ-404)");
  rmSync(root, { recursive: true, force: true });
});

// BLZ-404 AC-4: `push` is answered by DELETING the parameter, not by refusing it —
// reconcile() never read it, and `pushed: false` was already unconditional. A removed
// parameter cannot be pinned by a mutation (there is nothing left to flip), so what is
// pinned here is the CONTRACT statement itself: `pushed` stays false even on a genuinely
// applied, committing run — the shape that matters, since a dry run proving it is cheap
// and unpersuasive.
test("pushed stays false on an applied, committing run — the contract push once contradicted", async () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-rec-push-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"] }));
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", name: "OBA" }));
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\nb\n");
  const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });
  assert.equal(r.pushed, false, "an applied, committing run must still never report a push");
  assert.equal(r.dryRun, false);
  rmSync(root, { recursive: true, force: true });
});
