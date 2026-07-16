import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { decide, reconcile } from "../scripts/reconcile.mjs";

test("merged PR → done and sets resolution via the post-function", () => {
  const d = decide({ pr: { state: "MERGED", number: 5, url: "u", headRefName: "you/OBA-5-x" } }, "in-review", "task");
  assert.equal(d.target, "done");
  assert.equal(d.moved, true);
  assert.equal(d.prVal, "#5 — u");
  assert.equal(d.branchVal, "you/OBA-5-x");
  assert.equal(d.resolution, "done");
});

test("open PR → in-review (no resolution)", () => {
  const d = decide({ pr: { state: "OPEN", number: 6, url: "u", headRefName: "b" } }, "defined", "task");
  assert.equal(d.target, "in-review");
  assert.equal(d.moved, true);
  assert.equal(d.resolution, undefined);
});

test("closed unmerged PR → in-progress", () => {
  const d = decide({ pr: { state: "CLOSED", number: 7, url: "u", headRefName: "b" } }, "in-review", "task");
  assert.equal(d.target, "in-progress");
});

test("branch with no PR → in-progress", () => {
  const d = decide({ branch: "you/OBA-8-y" }, "defined", "task");
  assert.equal(d.target, "in-progress");
  assert.equal(d.branchVal, "you/OBA-8-y");
  assert.equal(d.prVal, null);
});

test("no git signal is skipped and left in place", () => {
  const d = decide({}, "defined", "task");
  assert.equal(d.skip, true);
  assert.equal(d.moved, false);
  assert.equal(d.target, "defined");
});

test("terminal status is sticky — a merged PR on a done ticket does not move it", () => {
  const d = decide({ pr: { state: "MERGED", number: 9, url: "u", headRefName: "b" } }, "done", "task");
  assert.equal(d.target, "done");
  assert.equal(d.moved, false);
});

test("non-delivery types (goal/risk) are never auto-transitioned", () => {
  assert.equal(decide({ pr: { state: "MERGED", number: 1, url: "u", headRefName: "b" } }, "defined", "goal").skip, true);
  assert.equal(decide({ branch: "b" }, "identified", "risk").skip, true);
});

// --- Task 1: the shipped fallback (bundled epic-children with no branch/PR) ----
test("shipped (no pr/branch) → done for a delivery child", () => {
  const d = decide({ shipped: true }, "defined", "task");
  assert.equal(d.target, "done");
  assert.equal(d.moved, true);
  assert.equal(d.resolution, "done");
  assert.equal(d.skip, false);
});

test("shipped is ignored when a branch signal is present", () => {
  const d = decide({ branch: "you/BLZ-8-y", shipped: true }, "defined", "task");
  assert.equal(d.target, "in-progress"); // branch path wins, shipped not consulted
});

test("shipped is ignored when a pr signal is present", () => {
  const d = decide({ pr: { state: "OPEN", number: 6, url: "u", headRefName: "b" }, shipped: true }, "defined", "task");
  assert.equal(d.target, "in-review");
});

test("shipped + already done → terminal-sticky, no move", () => {
  const d = decide({ shipped: true }, "done", "task");
  assert.equal(d.target, "done");
  assert.equal(d.moved, false);
});

test("shipped on a non-delivery type is skipped", () => {
  assert.equal(decide({ shipped: true }, "defined", "goal").skip, true);
});

test("no signal at all (no pr/branch/shipped) is still skipped", () => {
  assert.equal(decide({}, "defined", "task").skip, true);
});

// --- reconcile() must honour a custom-named projectsDir, not just dataRoot ----
// (Review fix.) BLAZE_PROJECTS_DIR is documented (tests/roots.test.mjs)
// to allow a projects dir that isn't literally named "projects". reconcile()'s
// no-args default previously recomputed join(root, "projects") itself instead
// of reusing resolveRoots().projectsDir, so a custom-named dir silently found
// zero tickets. This is a throwaway git fixture (per tests/runner-dataroot.test.mjs's
// isolation pattern) — dryRun so no git/network side effects land anywhere real.
function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

test("reconcile() with no explicit root resolves a custom-named projectsDir via BLAZE_PROJECTS_DIR", () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "blaze-reconcile-dataroot-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-reconcile-codereo-"));
  const prevEnv = process.env.BLAZE_PROJECTS_DIR;

  gitInit(codeRepo);
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "-b", "you/ZZZ-1-fix-thing"]);

  // "tickets" — deliberately NOT named "projects".
  const ticketsDir = join(dataRoot, "tickets");
  mkdirSync(join(ticketsDir, "ZZZ", "defined"), { recursive: true });
  writeFileSync(
    join(ticketsDir, "ZZZ", "defined", "ZZZ-1-fix-thing.md"),
    "---\nid: ZZZ-1\ntype: task\nstatus: defined\nproject: ZZZ\nestimate: 30\n---\n\nbody\n",
  );
  writeFileSync(
    join(dataRoot, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], codeRepos: [codeRepo] }),
  );

  try {
    process.env.BLAZE_PROJECTS_DIR = ticketsDir;
    const r = reconcile();
    assert.equal(r.ok, true);
    assert.equal(r.changes.length, 1, "reconcile must find the ticket under the custom-named projects dir");
    assert.equal(r.changes[0].id, "ZZZ-1");
    assert.equal(r.changes[0].to, "in-progress");
  } finally {
    if (prevEnv === undefined) delete process.env.BLAZE_PROJECTS_DIR;
    else process.env.BLAZE_PROJECTS_DIR = prevEnv;
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  }
});

// --- dry-run must SUPPRESS the write, not merely find nothing to do ----------
// The negative fixture above (reconcile-pertype.test.mjs) proves dry-run makes
// no moves, but its ticket carries no real git signal — decide() short-circuits
// via `skip: true` before the dryRun guard is ever reached, so it never exercises
// the write/rename branch (reconcile.mjs:148-157) at all. This positive test
// gives a genuine branch (mirroring :68-104's real-git-signal fixture) so
// decide() returns moved:true, then proves the *guard* — not an incidental
// skip — is what suppresses the file move under dryRun, and that the identical
// setup performs the move when dryRun is false.
test("reconcile dry-run detects the move but suppresses the write; apply performs it", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reconcile-dryrun-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-reconcile-dryrun-code-"));

  gitInit(codeRepo);
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "-b", "you/ZZZ-1-fix-thing"]);

  const projectsDir = join(root, "projects");
  const definedDir = join(projectsDir, "ZZZ", "defined");
  const inProgressDir = join(projectsDir, "ZZZ", "in-progress");
  mkdirSync(definedDir, { recursive: true });
  const ticketFile = "ZZZ-1-fix-thing.md";
  writeFileSync(
    join(definedDir, ticketFile),
    "---\nid: ZZZ-1\ntype: task\nstatus: defined\nproject: ZZZ\nestimate: 30\n---\n\nbody\n",
  );
  writeFileSync(
    join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], codeRepos: [codeRepo] }),
  );

  try {
    // Dry run: the move IS detected but the write must be suppressed.
    const dry = reconcile({ dryRun: true, root });
    assert.equal(dry.ok, true);
    assert.ok(dry.changes.length >= 1, "the would-be move is detected");
    assert.equal(dry.changes[0].id, "ZZZ-1");
    assert.ok(existsSync(join(definedDir, ticketFile)), "dry-run must NOT move the file");
    assert.ok(!existsSync(join(inProgressDir, ticketFile)), "dry-run must NOT create the destination");

    // Apply: the identical setup — untouched by the dry run above — now moves for real,
    // proving the guard (not an incidental skip) suppressed the earlier write.
    const applied = reconcile({ dryRun: false, root });
    assert.equal(applied.ok, true);
    assert.ok(applied.changes.length >= 1, "apply also detects the move");
    assert.ok(!existsSync(join(definedDir, ticketFile)), "apply moved the file out of defined/");
    assert.ok(existsSync(join(inProgressDir, ticketFile)), "apply moved it into in-progress/");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  }
});

// --- apply must commit ONLY the touched ticket file(s), never an unrelated --
// dirty file elsewhere in the shared data tree. The prior implementation ran
// `git add -A` before committing, which sweeps in whatever else is dirty on
// the board's git tree — a real risk since dataRoot is a shared working tree
// (other in-flight board ops, editor swap files, etc.). This fixture mirrors
// the real-branch apply setup above, but git-inits `root` itself (the prior
// fixtures never did — they only asserted file moves, never inspected git
// history on dataRoot) and passes commit:true so reconcile actually commits.
test("reconcile --apply commits only touched files, not an unrelated dirty file", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reconcile-scoped-commit-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-reconcile-scoped-commit-code-"));

  gitInit(codeRepo);
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "-b", "you/ZZZ-1-fix-thing"]);

  const projectsDir = join(root, "projects");
  const definedDir = join(projectsDir, "ZZZ", "defined");
  mkdirSync(definedDir, { recursive: true });
  const ticketFile = "ZZZ-1-fix-thing.md";
  writeFileSync(
    join(definedDir, ticketFile),
    "---\nid: ZZZ-1\ntype: task\nstatus: defined\nproject: ZZZ\nestimate: 30\n---\n\nbody\n",
  );
  writeFileSync(
    join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], codeRepos: [codeRepo] }),
  );

  // dataRoot itself must be a git repo with an initial commit so we can later
  // inspect `git show`/`git log` on it (the other fixtures above never do).
  gitInit(root);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);

  // An unrelated dirty file already sitting in the shared data tree — must
  // NOT be swept into the reconcile commit.
  writeFileSync(join(root, "UNRELATED.txt"), "not part of reconcile\n");

  try {
    const applied = reconcile({ dryRun: false, commit: true, root });
    assert.equal(applied.ok, true);
    assert.equal(applied.committed, true);

    const files = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    assert.doesNotMatch(files, /UNRELATED\.txt/);
    assert.match(files, /ZZZ-1-.*\.md/);

    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    assert.match(status, /UNRELATED\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  }
});
