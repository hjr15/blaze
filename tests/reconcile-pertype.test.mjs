// tests/reconcile-pertype.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
//
// REVIEW (2026-08-27): this test was REFUTED. The original fixture had no `codeRepos` and
// no branch/pr on the ticket, so `decide()` took the skip path for OBA-1 (no git signal at
// all) — the reviewer ran it and got `changes: 0, committed: false, scannedRepos: 0`.
// NOTHING was applied and NOTHING was committed: `pushed` read `false` for the same reason
// it reads `false` on a dry run — the assertion was identical under `dryRun: true`, which
// is exactly what the comment above claims "proves nothing". Fixed by giving the fixture a
// real code repo with a `<KEY>-<n>: shipped work` commit on the default branch (BLZ-131's
// shipped-commit signal — genuinely drives `defined` -> `done`, no PR/branch fixture
// needed) and a real git repo at `root` so the commit can actually land, then asserting
// `changes`/`committed`/`commitOutcome` directly rather than trusting the test's own prose.
test("pushed stays false on an applied, committing run — the contract push once contradicted", async () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-rec-push-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-rec-push-code-"));
  execFileSync("git", ["-C", codeRepo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", codeRepo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", codeRepo, "config", "user.name", "t"]);
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m", "OBA-1: shipped work"]);

  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", codeRepos: [codeRepo] }));
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\nb\n");
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed board"]);

  const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });
  // The distinction the sentence draws, proven rather than asserted only in prose: this
  // run really moved a ticket and really committed — not the `changes: 0, committed: false`
  // shape the reviewer measured on the old fixture.
  assert.ok(r.changes.length >= 1, "the fixture must produce a real move, or this is a dry run in disguise");
  assert.equal(r.committed, true, "this must be a genuinely COMMITTING run, not merely an applied one");
  assert.equal(r.commitOutcome, "committed");
  assert.equal(r.pushed, false, "an applied, committing run must still never report a push");
  assert.equal(r.dryRun, false);
  rmSync(root, { recursive: true, force: true });
  rmSync(codeRepo, { recursive: true, force: true });
});
