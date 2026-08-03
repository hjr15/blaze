// tests/commit-runner-branch-guard.test.mjs — INF-673: `blaze commit` must not
// commit board ops onto a branch that isn't the caller's.
//
// The bug has fired three times in production (CRP-51 2026-07-30, INF-663 the
// same day, INF-748 2026-08-02). Shape every time: a parallel lane leaves the
// SHARED blaze-pm checkout on its own feature branch; an unrelated session runs
// `blaze commit`; the ops land on that lane's unmerged branch with exit 0 and no
// warning. Recovery was an identical worktree cherry-pick all three times —
// which is the argument for hard-refuse over warn-and-proceed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { defaultBranch } from "../scripts/branch-guard.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_ID = "test-harness-uuid";

// A temp board with a real copy of scripts/, so the copied commit-runner.mjs
// resolves its script-relative ROOT to this temp repo. `-b main` pins the
// initial branch so default-branch detection is deterministic regardless of
// the host's init.defaultBranch.
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-branchguard-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "projects", "INF", "defined"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const headOf = (root, ref) => git(root, "rev-parse", ref);
const countCommits = (root, ref) => Number(git(root, "rev-list", "--count", ref));

// Queue a board op through the REAL production path (commitOrQueue), so the
// branch-provenance recording is exercised rather than hand-faked.
function queueOp(root, { id, message, file }) {
  writeFileSync(join(root, file), `# ${id}\n`);
  const script = join(root, "queue-op.mjs");
  writeFileSync(
    script,
    `import { commitOrQueue } from "./scripts/commit-or-queue.mjs";\n` +
      `commitOrQueue({ root: process.cwd(), mode: "batch", op: "move", id: ${JSON.stringify(id)},\n` +
      `  message: ${JSON.stringify(message)}, files: [${JSON.stringify(join(root, file))}] });\n`,
  );
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: HARNESS_ID, BLAZE_SESSION: "" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `queueing failed: ${r.stderr}`);
  rmSync(script);
}

function runCommit(root, { args = [] } = {}) {
  const r = spawnSync(process.execPath, [join(root, "scripts", "commit-runner.mjs"), ...args], {
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: HARNESS_ID, BLAZE_SESSION: "" },
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

// ---------------------------------------------------------------------------
// THE REGRESSION TEST — the INF-748 reproduction, captured verbatim from the
// ticket: ops queued while on main, a parallel lane's branch checked out
// underneath, then `blaze commit`.
// ---------------------------------------------------------------------------
test("REGRESSION (INF-673): `blaze commit` refuses to commit onto a foreign branch, before the commit exists", () => {
  const root = gitRepo();

  // Three tickets from three DIFFERENT lanes queue board ops while the
  // checkout is legitimately on main — this is the ordinary case.
  queueOp(root, { id: "INF-755", message: "INF-755: move to done", file: "projects/INF/defined/INF-755.md" });
  queueOp(root, { id: "INF-746", message: "INF-746: move to done", file: "projects/INF/defined/INF-746.md" });
  queueOp(root, { id: "INF-657", message: "INF-657: log 45m", file: "projects/INF/defined/INF-657.md" });

  // A parallel lane (INF-748) creates ITS branch in the shared checkout and
  // leaves it checked out. Our session never touched this branch.
  execFileSync("git", ["-C", root, "checkout", "-q", "-b", "INF-748-config-json-projects-drift"]);
  const mainBefore = headOf(root, "main");
  const foreignBefore = headOf(root, "HEAD");
  const foreignCountBefore = countCommits(root, "HEAD");

  const r = runCommit(root);

  // 1. Non-zero exit — the pre-fix behaviour was exit 0.
  assert.notEqual(r.status, 0, "expected `blaze commit` to refuse; it exited 0 (the INF-748 bug)");

  // 2. The guard fires BEFORE the commit exists, so there is no duplicate to
  //    clean up off the feature branch (the ticket calls this out explicitly).
  assert.equal(countCommits(root, "HEAD"), foreignCountBefore, "a commit was created on the foreign branch");
  assert.equal(headOf(root, "HEAD"), foreignBefore, "foreign branch HEAD moved");

  // 3. main is untouched.
  assert.equal(headOf(root, "main"), mainBefore, "main HEAD moved");

  // 4. The warning must be unambiguous: name the branch, say it is not the
  //    default, and name the tickets whose work would have been stranded.
  //    The pre-fix output printed the branch too — but only inside an ordinary
  //    git summary line, which is exactly why nobody noticed.
  assert.match(r.stderr, /INF-748-config-json-projects-drift/, "stderr must name the offending branch");
  assert.match(r.stderr, /main/, "stderr must name the default branch");
  for (const id of ["INF-755", "INF-746", "INF-657"]) {
    assert.match(r.stderr, new RegExp(id), `stderr must name the stranded ticket ${id}`);
  }

  // 5. The queue is preserved — nothing is lost, the caller just re-runs it
  //    from a main-based checkout.
  const after = runCommit(root, { args: ["--branch-ok"] });
  assert.equal(after.status, 0, `queue was not preserved: ${after.stderr}`);
  assert.match(after.stdout, /flushed 3 op\(s\)/);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC3 — no false positive on a branch the session created for its OWN board ops.
// ---------------------------------------------------------------------------
test("INF-673: does NOT fire when the session queued its ops on the branch it is committing to", () => {
  const root = gitRepo();

  // This session makes its own branch FIRST, then does its board ops on it.
  execFileSync("git", ["-C", root, "checkout", "-q", "-b", "INF-999-my-own-board-ops"]);
  queueOp(root, { id: "INF-999", message: "INF-999: move to in-review", file: "projects/INF/defined/INF-999.md" });

  const r = runCommit(root);
  assert.equal(r.status, 0, `guard false-positived on the session's own branch: ${r.stderr}`);
  assert.match(r.stdout, /flushed 1 op\(s\)/);
  assert.equal(countCommits(root, "HEAD"), 2, "the commit should have landed on the session's own branch");

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The ordinary path stays silent — a guard that nags on every normal commit
// gets ignored, and then it protects nothing.
// ---------------------------------------------------------------------------
test("INF-673: committing on the default branch is unaffected and prints no guard noise", () => {
  const root = gitRepo();
  queueOp(root, { id: "INF-100", message: "INF-100: move to done", file: "projects/INF/defined/INF-100.md" });

  const r = runCommit(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /flushed 1 op\(s\)/);
  assert.doesNotMatch(r.stderr, /REFUS|not the default branch/i, "guard should be silent on the default branch");
  assert.equal(countCommits(root, "main"), 2);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Detached HEAD is not this guard's business, and must not become a new way to
// wedge board ops.
// ---------------------------------------------------------------------------
test("INF-673: detached HEAD is not treated as a foreign branch", () => {
  const root = gitRepo();
  queueOp(root, { id: "INF-101", message: "INF-101: move to done", file: "projects/INF/defined/INF-101.md" });
  execFileSync("git", ["-C", root, "checkout", "-q", "--detach"]);

  const r = runCommit(root);
  assert.equal(r.status, 0, `guard fired on detached HEAD: ${r.stderr}`);

  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// origin/HEAD, not a hardcoded "main": a board whose default branch is `master`
// must not have every single commit refused.
// ---------------------------------------------------------------------------
test("INF-673: default branch is read from the repo, not hardcoded to main", () => {
  const root = gitRepo();
  execFileSync("git", ["-C", root, "branch", "-q", "-m", "main", "master"]);
  queueOp(root, { id: "INF-102", message: "INF-102: move to done", file: "projects/INF/defined/INF-102.md" });

  const r = runCommit(root);
  assert.equal(r.status, 0, `guard fired on a master-default board: ${r.stderr}`);
  assert.equal(countCommits(root, "master"), 2);

  rmSync(root, { recursive: true, force: true });
});

// A master-based checkout that merely HAS an origin/main ref must not have
// every commit refused. Caught by an existing commit-runner test whose fixture
// is exactly this shape; pinned here so the local-before-remote precedence in
// defaultBranch() can't be quietly reversed.
test("INF-673: a local master checkout with a stray origin/main ref is not 'foreign'", () => {
  const root = gitRepo();
  execFileSync("git", ["-C", root, "branch", "-q", "-m", "main", "master"]);
  // origin/HEAD deliberately unset — this is the ambiguous case.
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  queueOp(root, { id: "INF-103", message: "INF-103: move to done", file: "projects/INF/defined/INF-103.md" });

  const r = runCommit(root);
  assert.equal(r.status, 0, `guard false-positived on a master checkout with origin/main: ${r.stderr}`);
  assert.equal(countCommits(root, "master"), 2);

  rmSync(root, { recursive: true, force: true });
});

// ...but origin/HEAD, when it IS set, still outranks the local-name fallback.
// Tested directly: going through the runner would prove nothing here, because
// the provenance allowance (queued-on === committing-on) short-circuits before
// the default-branch name is ever consulted.
test("INF-673: defaultBranch() precedence — origin/HEAD, then local name, then remote name", () => {
  const root = gitRepo(); // on `main`, no remote refs

  assert.equal(defaultBranch(root), "main", "local main should be found when nothing else exists");

  // A stray origin/main must not outrank the local branch actually in use.
  execFileSync("git", ["-C", root, "branch", "-q", "-m", "main", "master"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal(defaultBranch(root), "master", "local master should outrank a stray origin/main");

  // But an explicit origin/HEAD is authoritative over both.
  execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  assert.equal(defaultBranch(root), "main", "origin/HEAD should outrank the local-name fallback");

  rmSync(root, { recursive: true, force: true });
});

// The provenance allowance is what makes AC3 work, so pin its exact boundary:
// same branch throughout = fine; branch changed underneath = refused, even when
// only SOME of the batch was queued elsewhere.
test("INF-673: a batch part-queued on another branch is refused, not partially committed", () => {
  const root = gitRepo();
  queueOp(root, { id: "INF-200", message: "INF-200: move to done", file: "projects/INF/defined/INF-200.md" });
  execFileSync("git", ["-C", root, "checkout", "-q", "-b", "OBA-612-someone-elses-lane"]);
  queueOp(root, { id: "INF-201", message: "INF-201: move to done", file: "projects/INF/defined/INF-201.md" });

  const before = countCommits(root, "HEAD");
  const r = runCommit(root);
  assert.notEqual(r.status, 0, "a mixed-provenance batch must be refused");
  assert.equal(countCommits(root, "HEAD"), before, "nothing may be committed");
  assert.match(r.stderr, /INF-200/);
  assert.match(r.stderr, /INF-201/);

  rmSync(root, { recursive: true, force: true });
});
