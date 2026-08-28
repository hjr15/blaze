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
// needed) and a real git repo at `root` so the commit can actually land, then asserting the
// precondition rather than trusting the test's own prose. BLZ-423 then replaced THAT
// assertion's source: it read `r.changes`/`r.committed`/`r.commitOutcome`, which is the
// subject certifying itself, and now reads the filesystem and `git log`.
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

  // BLZ-423. GROUND TRUTH FOR "this run really applied and really committed" IS THE
  // FILESYSTEM AND `git log`, NOT `reconcile()`'S OWN RETURN. The de-vacuity guard used
  // to read `r.changes.length`, `r.committed` and `r.commitOutcome` — three fields of
  // the very object under test — so the test trusted the subject to certify that the
  // subject had done something. Measured: with reconcile's commit block wired to stage
  // NOTHING while still setting `commitOutcome = "committed"`, this named test stayed
  // green with an empty `git log`. The whole sentence it exists to pin ("on an applied,
  // committing run") was then supplied by the thing being asked about.
  //
  // `r.pushed` / `r.dryRun` are still read from the return, and must be: they ARE the
  // contract statement under test. What has moved off the return is the PRECONDITION.
  const commitsBefore = Number(execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"],
    { encoding: "utf8" }).trim());
  const r = await reconcile({ fetch: false, commit: true, dryRun: false, root });

  // (1) the filesystem: the ticket really left `defined/` and really arrived in `done/`.
  assert.equal(existsSync(join(projects, "OBA", "defined", "OBA-1.md")), false,
    "the fixture must produce a real move — OBA-1 is still in defined/, so this is a dry run in disguise");
  assert.ok(existsSync(join(projects, "OBA", "done", "OBA-1.md")),
    "the fixture must produce a real move — OBA-1 never arrived in done/");

  // (2) git log: a commit really exists, and its diff really carries the moved ticket.
  const commitsAfter = Number(execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"],
    { encoding: "utf8" }).trim());
  assert.equal(commitsAfter, commitsBefore + 1,
    "this must be a genuinely COMMITTING run: `git log` must hold exactly one new commit");
  const diffFiles = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"],
    { encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(diffFiles.some((f) => f.includes("OBA-1")),
    `the new commit's diff must carry the moved ticket, it carries ${JSON.stringify(diffFiles)}`);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "",
    "the applied run must leave the board's tree fully committed");

  // Only now is the contract statement itself worth reading off the return.
  assert.equal(r.pushed, false, "an applied, committing run must still never report a push");
  assert.equal(r.dryRun, false);
  rmSync(root, { recursive: true, force: true });
  rmSync(codeRepo, { recursive: true, force: true });
});
