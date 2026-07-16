import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { decide, reconcile, idFromSubject } from "../scripts/reconcile.mjs";

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

// --- Finding 3: shipped must NOT widen behaviour for an already-terminal ticket.
// A same-id commit on the default branch must not re-enter the shipped path when
// the ticket is already terminal — otherwise terminal-sticky blocks the move but
// `resolution` gets recomputed (widening an existing resolution). Gating on
// isTerminal(type, currentStatus) makes it take the skip path: no move, and
// resolution left undefined so reconcile() never overwrites it. Delivery's sole
// terminal status is "done" (scripts/model/workflows.mjs), so that is the only
// real terminal status a delivery-type decide() can be called with.
test("shipped on an already-terminal ticket takes the skip path (no resolution recompute)", () => {
  const d = decide({ shipped: true }, "done", "task");
  assert.equal(d.skip, true);
  assert.equal(d.moved, false);
  assert.equal(d.target, "done");
  assert.equal(d.resolution, undefined); // NOT recomputed to "done"
});

test("shipped on a non-delivery type is skipped", () => {
  assert.equal(decide({ shipped: true }, "defined", "goal").skip, true);
});

test("no signal at all (no pr/branch/shipped) is still skipped", () => {
  assert.equal(decide({}, "defined", "task").skip, true);
});

// --- Task 2: idFromSubject — anchored leading-id parse of a commit subject -----
test("idFromSubject extracts the leading id, greedy digits", () => {
  assert.equal(idFromSubject("BLZ-43: reconcile completeness", "BLZ"), "BLZ-43");
  assert.equal(idFromSubject("BLZ-4: other", "BLZ"), "BLZ-4");
});
test("idFromSubject does not confuse BLZ-4 with BLZ-43", () => {
  assert.equal(idFromSubject("BLZ-43: fixes BLZ-4 mention", "BLZ"), "BLZ-43");
});
test("idFromSubject ignores a non-leading id (no mis-attribution)", () => {
  assert.equal(idFromSubject("chore: bump BLZ-36 dep", "BLZ"), null);
});
test("idFromSubject returns null on a non-conforming subject", () => {
  assert.equal(idFromSubject("just a message", "BLZ"), null);
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

// --- Task 3: end-to-end proof — bundled epic-children move on a default-branch --
// commit, an open-epic-PR child (commit only on a feature branch) does NOT move,
// and a second run is a no-op. This committed test IS the permanent regression
// guard for the merged-vs-open discrimination.
test("bundled children: commit on default branch → done; open-epic-PR child NOT moved; idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reconcile-bundled-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-reconcile-bundled-code-"));
  // Explicit default branch — do NOT rely on the env's git init default.
  execFileSync("git", ["-C", codeRepo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", codeRepo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", codeRepo, "config", "user.name", "t"]);
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  // ZZZ-2 shipped: its commit is on the default branch (merged epic PR).
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m", "ZZZ-2: bundled child work"]);
  // ZZZ-3 unmerged: commit lives on a feature branch, NOT on main (epic PR still open).
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "-b", "epic/ZZZ-9-bundle"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m", "ZZZ-3: unmerged child work"]);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "main"]);

  const projectsDir = join(root, "projects");
  const definedDir = join(projectsDir, "ZZZ", "defined");
  const doneDir = join(projectsDir, "ZZZ", "done");
  mkdirSync(definedDir, { recursive: true });
  for (const n of [2, 3]) {
    writeFileSync(
      join(definedDir, `ZZZ-${n}-child.md`),
      `---\nid: ZZZ-${n}\ntype: task\nstatus: defined\nproject: ZZZ\nestimate: 30\n---\n\nbody\n`,
    );
  }
  writeFileSync(
    join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], codeRepos: [codeRepo] }),
  );

  try {
    const applied = reconcile({ dryRun: false, root });
    assert.equal(applied.ok, true);
    // ZZZ-2 shipped → done
    assert.ok(existsSync(join(doneDir, "ZZZ-2-child.md")), "shipped child moved to done/");
    assert.ok(!existsSync(join(definedDir, "ZZZ-2-child.md")), "shipped child left defined/");
    // ZZZ-3 open-epic-PR → NOT moved (commit not on default branch)
    assert.ok(existsSync(join(definedDir, "ZZZ-3-child.md")), "unmerged child stays in defined/");
    assert.ok(!existsSync(join(doneDir, "ZZZ-3-child.md")), "unmerged child NOT in done/");
    // Idempotent: a second run makes no ZZZ-2 change.
    const again = reconcile({ dryRun: false, root });
    assert.ok(!again.changes.some((c) => c.id === "ZZZ-2"), "second run is a no-op for the shipped child");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  }
});

// --- Finding 1+2: the shipped signal must read the REMOTE-TRACKING default -----
// branch (origin/main), not local main. prMap comes from live `gh pr list` and
// branchMap reads refs/remotes/origin, so a bundled child merged on origin/main
// must be seen even when local main is behind (blaze reconcile --fetch updates
// remote-tracking refs, NOT local main). This fixture gives a real `origin`
// remote whose main carries the child commit while LOCAL main is deliberately
// one commit behind — reconcile must still move the child to done/, which both
// proves Finding 1 AND exercises the production `origin/HEAD` detection arm
// (untested before — every other fixture here is remote-less). See Finding 2.
test("shipped reads origin/main (remote-tracking), not a stale local main", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reconcile-remotetrack-"));
  const originRepo = mkdtempSync(join(tmpdir(), "blaze-reconcile-remotetrack-origin-"));
  const codeRepo = mkdtempSync(join(tmpdir(), "blaze-reconcile-remotetrack-code-"));

  // Bare origin + a code checkout that pushes the child commit to origin/main,
  // then rewinds LOCAL main one commit behind origin/main.
  execFileSync("git", ["-C", originRepo, "init", "-q", "--bare", "-b", "main"]);
  execFileSync("git", ["-C", codeRepo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", codeRepo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", codeRepo, "config", "user.name", "t"]);
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  execFileSync("git", ["-C", codeRepo, "add", "-A"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", codeRepo, "remote", "add", "origin", originRepo]);
  // ZZZ-2's shipped commit lands on origin/main…
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m", "ZZZ-2: bundled child work"]);
  execFileSync("git", ["-C", codeRepo, "push", "-q", "origin", "main"]);
  // …but LOCAL main is rewound behind it (still points at seed only).
  execFileSync("git", ["-C", codeRepo, "reset", "--hard", "-q", "HEAD~1"]);
  execFileSync("git", ["-C", codeRepo, "fetch", "-q", "origin"]);
  execFileSync("git", ["-C", codeRepo, "remote", "set-head", "origin", "main"]); // origin/HEAD → origin/main

  const projectsDir = join(root, "projects");
  const definedDir = join(projectsDir, "ZZZ", "defined");
  const doneDir = join(projectsDir, "ZZZ", "done");
  mkdirSync(definedDir, { recursive: true });
  writeFileSync(
    join(definedDir, "ZZZ-2-child.md"),
    "---\nid: ZZZ-2\ntype: task\nstatus: defined\nproject: ZZZ\nestimate: 30\n---\n\nbody\n",
  );
  writeFileSync(
    join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ"], codeRepos: [codeRepo] }),
  );

  try {
    const applied = reconcile({ dryRun: false, root });
    assert.equal(applied.ok, true);
    // The child ships only on origin/main; local main lacks the commit. Moving
    // it proves the resolver logs the remote-tracking ref via origin/HEAD.
    assert.ok(existsSync(join(doneDir, "ZZZ-2-child.md")), "child on origin/main moved to done/");
    assert.ok(!existsSync(join(definedDir, "ZZZ-2-child.md")), "child left defined/");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(originRepo, { recursive: true, force: true });
    rmSync(codeRepo, { recursive: true, force: true });
  }
});
