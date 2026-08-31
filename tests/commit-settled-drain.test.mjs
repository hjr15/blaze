// tests/commit-settled-drain.test.mjs — BLZ-590: "nothing to commit" is not
// "the commit failed".
//
// Hit live on 2026-08-31 draining the 210 ops BLZ-556 had just consolidated.
// Every op was ORPHANED — its recorded file already matched HEAD, because the
// work had been filed by hand during the weeks the flush was broken. So
// `git add` staged nothing, `git commit` exited 1, and `commit-runner.mjs` read
// that exit code as a failure: the operator was told to "resolve manually" a
// situation with nothing to resolve, and the ledger was KEPT — so the queue
// could never empty and every later run hit the same wall. A board whose
// recorded work is entirely settled could never drain.
//
// This is BLZ-502's class one line down. BLZ-502 separated "`git add` failed"
// from "`git commit` failed" because the wrong one sent the operator to read
// hooks. The same conflation survived at `git commit`: nothing staged because
// the work is already filed is not a failure at all.
//
// The distinction that must survive, and the reason these are four tests and
// not one: collapsing "settled" into "committed" would be WORSE than the bug,
// because it would clear a ledger whose work never landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, readEntries, ledgerPath } from "../scripts/pending-ledger.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS_ID = "test-harness-uuid";
const SESSION = "t1";

// A temp board with a real copy of scripts/, so the copied commit-runner.mjs
// resolves its script-relative ROOT to this temp repo (not the worktree).
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-settled-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

function runCommit(root, { session = SESSION, args = [], env: extraEnv = {} } = {}) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: HARNESS_ID, BLAZE_SESSION: session, ...extraEnv };
  const r = spawnSync(process.execPath, [join(root, "scripts", "commit-runner.mjs"), ...args],
    { cwd: root, env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const headOf = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const currentBranchOf = (root) => execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
const namesIn = (root, rev = "HEAD") =>
  execFileSync("git", ["-C", root, "show", "--name-only", "--format=", rev], { encoding: "utf8" });

/** Queue an op AND file its work by hand — the exact shape of an orphaned op:
 *  the ledger entry survives, but the recorded file already matches HEAD. */
function queueAlreadyFiled(root, id, session = SESSION) {
  const rel = `projects/OBA/backlog/${id}.md`;
  writeFileSync(join(root, rel), `${id} body`);
  appendEntry(root, { id, op: "new", message: `${id}: create task`, files: [rel], ts: "t", session }, session);
  execFileSync("git", ["-C", root, "add", "--", rel]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", `hand-filed ${id}`]);
  return rel;
}

/** Queue an op whose work is genuinely outstanding — written, never committed. */
function queueOutstanding(root, id, session = SESSION) {
  const rel = `projects/OBA/backlog/${id}.md`;
  writeFileSync(join(root, rel), `${id} body`);
  appendEntry(root, { id, op: "new", message: `${id}: create task`, files: [rel], ts: "t", session }, session);
  return rel;
}

// ---------------------------------------------------------------------------
// 1. The operator's exact case: every op already filed.
// ---------------------------------------------------------------------------
test("BLZ-590: a drain whose ops are ALL already filed clears the ledger and exits 0", () => {
  const root = gitRepo();
  for (const id of ["OBA-1", "OBA-2", "OBA-3"]) queueAlreadyFiled(root, id);
  assert.equal(readEntries(root, SESSION).length, 3, "fixture must actually have queued three ops");
  const before = headOf(root);

  const r = runCommit(root);

  assert.equal(r.status, 0, `must exit 0 — nothing failed. stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /git commit failed/, "nothing failed, so nothing may be called a failure");
  assert.doesNotMatch(r.stderr, /resolve manually/, "there is nothing for the operator to resolve");
  assert.match(r.stdout, /already filed/, `must say plainly what happened. stdout: ${r.stdout}`);
  assert.match(r.stdout, /3 op\(s\)/, "must name how many ops were settled");
  assert.deepEqual(readEntries(root, SESSION), [], "THE BUG: the ledger must be cleared, or the queue can never drain");
  assert.equal(headOf(root), before, "no commit was needed, so none may be invented");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2. The distinction that must survive. Same "nothing was committed" surface,
//    opposite meaning — and the opposite handling.
// ---------------------------------------------------------------------------
test("BLZ-590: a genuine git commit failure (a refusing hook) still KEEPS the ledger and exits non-zero", () => {
  const root = gitRepo();
  queueOutstanding(root, "OBA-4");
  const hook = join(root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const before = headOf(root);

  const r = runCommit(root);

  assert.notEqual(r.status, 0, `a refused commit is a failure. stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stderr, /ledger kept/, "the work never landed, so the ledger must be kept");
  assert.doesNotMatch(r.stdout, /flushed/, "must not claim the work was filed");
  assert.doesNotMatch(r.stdout, /already filed/, "a hook refusal is not a settled op");
  assert.equal(readEntries(root, SESSION).length, 1, "the op must still be queued — its work never landed");
  assert.equal(headOf(root), before);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 3. Both at once: no op silently dropped, none committed twice.
// ---------------------------------------------------------------------------
test("BLZ-590: a partly settled drain commits the real part, settles the rest, and reports both", () => {
  const root = gitRepo();
  const filed = queueAlreadyFiled(root, "OBA-5");
  const real = queueOutstanding(root, "OBA-6");
  const before = headOf(root);

  const r = runCommit(root);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /flushed 1 op\(s\)/, `the real op is committed. stdout: ${r.stdout}`);
  assert.match(r.stdout, /1 op\(s\) .*already filed/, `the settled op is reported too. stdout: ${r.stdout}`);
  assert.notEqual(headOf(root), before, "the real op must produce a commit");
  const shown = namesIn(root);
  assert.match(shown, new RegExp(real.replace(/[.]/g, "\\.")), "the outstanding file is in the commit");
  assert.doesNotMatch(shown, new RegExp(filed.replace(/[.]/g, "\\.")), "the already-filed file must NOT be committed twice");
  assert.deepEqual(readEntries(root, SESSION), [], "both ops leave the queue — neither is silently dropped");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4. Detect the PROPERTY, not the spelling.
//
//    git's "nothing to commit, working tree clean" is a MESSAGE — localisable
//    and version-dependent. The fact is whether the index holds a change.
//    Pinned by observation, not by inspecting source: a `git` shim on the
//    runner's PATH records every subcommand it is asked for, and in the
//    all-settled case the runner must reach its verdict having asked
//    `diff --cached` and WITHOUT ever running `commit`. An implementation that
//    ran the commit and read its output could not pass this.
// ---------------------------------------------------------------------------
test("BLZ-590: the settled verdict comes from asking the index, not from running git commit and reading its message", () => {
  const root = gitRepo();
  for (const id of ["OBA-7", "OBA-8"]) queueAlreadyFiled(root, id);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimDir = join(root, "gitshim");
  const marker = join(root, "git-calls.log");
  mkdirSync(shimDir, { recursive: true });
  // `-C <root> <subcommand> …` is how every call in commit-runner.mjs is shaped,
  // so $3 is the subcommand. Everything is passed straight through to real git.
  writeFileSync(join(shimDir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$3" >> "$BLAZE_TEST_GIT_LOG"\nexec "$BLAZE_TEST_REAL_GIT" "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);

  const r = runCommit(root, {
    env: {
      PATH: `${shimDir}:${process.env.PATH}`,
      BLAZE_TEST_REAL_GIT: realGit,
      BLAZE_TEST_GIT_LOG: marker,
    },
  });

  // POSITIVE CONTROL first: without this the negative below measures nothing —
  // a shim that was never on the runner's PATH logs no `commit` either.
  assert.ok(existsSync(marker), "the shim never ran — the rest of this test would be vacuous");
  const calls = readFileSync(marker, "utf8").split("\n").filter(Boolean);
  assert.ok(calls.includes("add"), `the shim must be the git the runner used: ${JSON.stringify(calls)}`);
  assert.ok(calls.includes("diff"), `the verdict must come from an index probe: ${JSON.stringify(calls)}`);
  assert.ok(!calls.includes("commit"), `git commit must never be run to find out: ${JSON.stringify(calls)}`);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.deepEqual(readEntries(root, SESSION), []);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 5-6. The divergence warning, reviewed while here (BLZ-590 AC 6).
//
//   It fired as "1 commit(s) behind origin/main" on a branch git reports as up
//   to date with ITS OWN upstream. Two defects, not one:
//     - the compared ref was the hardcoded literal `origin/main`, so a board on
//       `master` got NO warning at all, ever;
//     - a branch with its own upstream was measured against a ref it does not
//       publish to, contradicting what git itself says about the branch.
// ---------------------------------------------------------------------------
test("BLZ-590: no divergence warning on a branch that is up to date with its OWN upstream", () => {
  const root = gitRepo();
  // origin/main one commit ahead of everything — the ref the warning used to hardcode.
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-q", "-m", "remote main only"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  execFileSync("git", ["-C", root, "reset", "-q", "--hard", "HEAD~1"]);
  // A feature branch whose own upstream is exactly where it is. `origin` has to be a
  // configured remote with a fetch refspec before git will accept `origin/feat` as a
  // tracking start point, so the remote is real (pointed at this same repo) rather than
  // a bare ref planted under refs/remotes/.
  execFileSync("git", ["-C", root, "checkout", "-q", "-b", "feat"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", root]);
  execFileSync("git", ["-C", root, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/feat", "HEAD"]);
  execFileSync("git", ["-C", root, "branch", "--set-upstream-to=origin/feat", "feat"]);
  assert.equal(
    execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "@{upstream}"], { encoding: "utf8" }).trim(),
    "origin/feat", "fixture is vacuous unless the branch really has its own upstream",
  );
  assert.equal(
    execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8" }).trim(),
    "1", "fixture is vacuous unless origin/main really is ahead — that is what used to warn",
  );
  const rel = "projects/OBA/backlog/OBA-9.md";
  writeFileSync(join(root, rel), "x");
  appendEntry(root, { id: "OBA-9", op: "new", message: "OBA-9: x", files: [rel], ts: "t", session: SESSION, branch: "feat" }, SESSION);

  const r = runCommit(root);

  assert.match(r.stdout, /flushed 1 op/, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /behind/,
    `git calls this branch up to date with its upstream; blaze must not contradict it. stderr: ${r.stderr}`);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: a master-based board still gets the divergence warning (the ref was hardcoded origin/main)", () => {
  const root = gitRepo(); // git init's default branch here is `master`
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-q", "-m", "remote-only"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/master", "HEAD"]);
  execFileSync("git", ["-C", root, "reset", "-q", "--hard", "HEAD~1"]);
  assert.equal(
    spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", "refs/remotes/origin/main"]).status, 1,
    "fixture is vacuous unless origin/main genuinely does not exist",
  );
  queueOutstanding(root, "OBA-10");

  const r = runCommit(root);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /1 commit\(s\) behind origin\/master/,
    `a master board must get the same signal a main board gets. stderr: ${r.stderr}`);
  assert.match(r.stdout, /flushed 1 op/);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. ADR-0030, on the probe this ticket introduced: a probe that could not look
//    does not report what a probe that looked reports. The cost of a wrong
//    "already filed" is a CLEARED queue whose work never landed, so an
//    unanswerable probe must fall to the keep-the-ledger side, not the clear-it
//    side. Reached by an ordinary environment state, not a theoretical one — a
//    `git` that cannot run in this repo answers nothing at all.
// ---------------------------------------------------------------------------
test("BLZ-590: an op whose staged-ness probe cannot answer is never reported already filed — the ledger is kept", () => {
  const root = gitRepo();
  for (const id of ["OBA-11", "OBA-12"]) queueAlreadyFiled(root, id);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimDir = join(root, "gitshim");
  const marker = join(root, "git-diff-refusals.log");
  mkdirSync(shimDir, { recursive: true });
  // Every call is shaped `-C <root> <subcommand> …`, so $3 is the subcommand. Only the
  // index probe is broken; everything else is real git, so the fixture is otherwise the
  // all-settled case that exits 0 — the difference measured is the probe alone.
  writeFileSync(join(shimDir, "git"),
    `#!/bin/sh\nif [ "$3" = "diff" ]; then\n  for a in "$@"; do\n    if [ "$a" = "--cached" ]; then\n      printf 'refused\\n' >> "$BLAZE_TEST_GIT_LOG"\n      exit 128\n    fi\n  done\nfi\nexec "$BLAZE_TEST_REAL_GIT" "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);

  const r = runCommit(root, {
    env: { PATH: `${shimDir}:${process.env.PATH}`, BLAZE_TEST_REAL_GIT: realGit, BLAZE_TEST_GIT_LOG: marker },
  });

  // POSITIVE CONTROL: the broken probe must actually have been reached, or this test is
  // just the all-settled case with extra steps — and that case exits 0 and clears.
  assert.ok(existsSync(marker), "the index probe was never asked — nothing was measured");
  assert.notEqual(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stderr, /could not say whether 2 op\(s\) had anything staged/, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /ledger kept/);
  assert.doesNotMatch(r.stdout, /already filed/, "an unanswered probe is not evidence that an op was filed");
  assert.equal(readEntries(root, SESSION).length, 2, "the queue must survive a probe that could not look");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 8-10. ROUND 2. `absent` is not `settled`.
//
// Round 1 shipped `if (own.length === 0) return "settled"` — reached exactly when
// every path an op records was dropped by the `existsSync || isTracked` filter,
// i.e. when those paths are NOT IN HEAD AT ALL. It then printed "every file they
// record already matches HEAD" about them and cleared an entry the base commit
// had kept. The sentence was false twice over: the files do not match HEAD, and
// no probe had been run to find out. That is the same class this ticket exists to
// fix — a claim asserted rather than measured — and no test in 395 suites
// executed the line.
//
// `pending-ledger.mjs`'s `outstandingFiles` has kept `settled` and `absent` in
// separate buckets since BLZ-499. These three tests hold the commit path to the
// same vocabulary, and the first of them EXECUTES the branch.
// ---------------------------------------------------------------------------

/** Queue an op recording a path that is in NO tree — the live shape: a superseded
 *  `move`/`log`/`edit` record whose source path has since moved on. `branch` defaults to
 *  the fixture's own branch, so the op's provenance says it was queued in THIS checkout;
 *  pass another to make it a lane's op that this checkout may not judge. */
function queueAbsent(root, id, { session = SESSION, branch = "master" } = {}) {
  const rel = `projects/OBA/backlog/${id}.md`;
  appendEntry(root, { id, op: "move", message: `${id}: backlog → done`, files: [rel], ts: "t", session, branch }, session);
  assert.ok(!existsSync(join(root, rel)), "fixture is vacuous unless the recorded path is really absent from disk");
  assert.notEqual(
    spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel]).status, 0,
    "fixture is vacuous unless the recorded path is really untracked",
  );
  return rel;
}

test("BLZ-590: an op recording only ABSENT paths is reported as superseded, never as matching HEAD", () => {
  const root = gitRepo();
  queueAbsent(root, "OBA-20");
  const before = headOf(root);

  const r = runCommit(root);

  assert.equal(r.status, 0, `nothing failed and nothing is stageable. stderr: ${r.stderr}`);
  assert.match(r.stdout, /superseded/, `the fact must be named. stdout: ${r.stdout}`);
  assert.match(r.stdout, /none of the three trees/,
    "the claim must be bounded by the trees actually read");
  assert.doesNotMatch(r.stdout, /matches HEAD/,
    "THE REFUTED CLAIM: these paths are in no tree, so no HEAD match may be attested");
  assert.doesNotMatch(r.stdout, /already filed/,
    "an absent path was never filed — nothing checked that it was");
  assert.equal(headOf(root), before, "there is nothing to stage, so no commit may be invented");
  assert.deepEqual(readEntries(root, SESSION), [],
    "cleared deliberately (ADR-0035): an unstageable op kept forever is the un-drainable queue this ticket removes");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: settled and absent ops in one drain are reported as two different facts", () => {
  const root = gitRepo();
  queueAlreadyFiled(root, "OBA-21");
  queueAbsent(root, "OBA-22");
  const real = queueOutstanding(root, "OBA-23");

  const r = runCommit(root);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /flushed 1 op\(s\)/, `only the outstanding op enters the commit. stdout: ${r.stdout}`);
  assert.match(r.stdout, /1 op\(s\) already filed/, `the settled one, named as filed. stdout: ${r.stdout}`);
  assert.match(r.stdout, /1 op\(s\) superseded/, `the absent one, named as superseded. stdout: ${r.stdout}`);
  assert.match(r.stdout, /OBA-21/, "the settled op is named");
  assert.match(r.stdout, /OBA-22/, "the absent op is named");
  const shown = namesIn(root);
  assert.match(shown, new RegExp(real.replace(/[.]/g, "\\.")));
  assert.doesNotMatch(shown, /OBA-21|OBA-22/, "neither the settled nor the absent op may enter the commit");
  assert.deepEqual(readEntries(root, SESSION), []);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: the commit subject and body count only the ops that entered the commit", () => {
  const root = gitRepo();
  queueAlreadyFiled(root, "OBA-24");
  queueAbsent(root, "OBA-25");
  queueOutstanding(root, "OBA-26");

  const r = runCommit(root);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(subject, /\(1 new\)$/,
    `one file changed, so the subject must say 1 — not 3. subject: ${subject}`);
  assert.match(body, /OBA-26: create task/, "the committed op is in the body");
  assert.doesNotMatch(body, /OBA-24|OBA-25/,
    "the commit message must not list work this commit does not contain");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 11-16. ROUND 3. `absent` was an inference wearing the word "measured".
//
// DEFECT 1. `existsSync` reads the WORKING TREE; `ls-files --error-unmatch` reads
// the INDEX. HEAD is a third tree and round 2 read neither of it nor from it —
// yet it printed "not in HEAD at all" and "nothing to compare against HEAD".
// `git rm <boardfile>` falsifies both clauses at once: the path IS in HEAD, the
// index holds a staged deletion, and `git diff --cached` reports a difference.
//
// DEFECT 2. Round 2 cleared such an op wherever its files were not present here.
// `belongsHere` holds a branch-recorded op back only while some OTHER worktree
// currently has that branch checked out, and `checkBranch` is a deliberate no-op
// on the default branch — so a checkout on `main` had no second guard. All 210
// live ops are exactly that shape (branch recorded, worktree not). The moment a
// lane's worktree moves off its branch, `blaze publish` — which runs
// `commit-runner --all` unattended — would clear that lane's ops at exit 0.
//
// The fix uses PROVENANCE, which the op itself records, instead of the local
// filesystem: superseded-here requires the op to say it was queued here.
// ---------------------------------------------------------------------------

test("BLZ-590: a git-rm'd path is committed as the deletion it is, never called absent", () => {
  const root = gitRepo();
  const rel = "projects/OBA/backlog/OBA-92.md";
  writeFileSync(join(root, rel), "OBA-92 body");
  // A second tracked file, so `git rm` does not prune `projects/` out of existence and
  // leave resolveRoots with no board to resolve — an artefact of the fixture, not the case.
  writeFileSync(join(root, "projects", "OBA", "backlog", "keeper.md"), "keeper");
  execFileSync("git", ["-C", root, "add", "--", rel, "projects/OBA/backlog/keeper.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "seed OBA-92"]);
  appendEntry(root, { id: "OBA-92", op: "move", message: "OBA-92: backlog → done", files: [rel], ts: "t", session: SESSION, branch: "master" }, SESSION);
  execFileSync("git", ["-C", root, "rm", "-q", "--", rel]);
  // The three trees, asserted so the fixture cannot quietly stop being this case.
  assert.ok(!existsSync(join(root, rel)), "not in the working tree");
  assert.notEqual(spawnSync("git", ["-C", root, "ls-files", "--error-unmatch", "--", rel]).status, 0, "not in the index");
  assert.equal(spawnSync("git", ["-C", root, "cat-file", "-e", `HEAD:${rel}`]).status, 0,
    "fixture is vacuous unless the path really IS in HEAD");

  const r = runCommit(root);

  assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /absent|superseded/,
    "THE REFUTED CLAIM: the path is in HEAD and the index holds a staged deletion for it");
  assert.match(r.stdout, /flushed 1 op\(s\)/, `the deletion is real work. stdout: ${r.stdout}`);
  const status = execFileSync("git", ["-C", root, "show", "--name-status", "--format=", "HEAD"], { encoding: "utf8" });
  assert.match(status, /^D\s+projects\/OBA\/backlog\/OBA-92\.md$/m,
    `the staged deletion must land in the commit, not be left behind in the index: ${JSON.stringify(status)}`);
  assert.equal(spawnSync("git", ["-C", root, "diff", "--cached", "--quiet"]).status, 0,
    "nothing of this op may be left staged after the run");
  assert.deepEqual(readEntries(root, SESSION), []);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: an absent op queued on ANOTHER branch is held back and the ledger kept, not cleared", () => {
  const root = gitRepo();
  appendEntry(root, {
    id: "OBA-93", op: "move", message: "OBA-93: in-review → done",
    files: ["projects/OBA/in-review/OBA-93.md"], ts: "t", session: SESSION, branch: "lane-v3",
  }, SESSION);
  // The exposure precisely: no other worktree holds `lane-v3`, so `belongsHere` lets it
  // through, and the checkout is on the default branch, so `checkBranch` is a no-op.
  assert.equal(currentBranchOf(root), "master", "the checkout must be on the default branch");
  const before = headOf(root);

  const r = runCommit(root);

  assert.equal(r.status, 3, `unreached work must exit 3, not 0. stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.equal(readEntries(root, SESSION).length, 1,
    "THE BASE'S SAFETY PROPERTY: work this checkout cannot judge stays queued");
  assert.match(r.stderr, /lane-v3/, `the message must name where it belongs. stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /superseded/, "this checkout established nothing about it");
  assert.equal(headOf(root), before);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: an absent op queued on THIS branch still clears — holding everything back would be the old wall", () => {
  const root = gitRepo();
  queueAbsent(root, "OBA-94"); // branch defaults to this checkout's own
  const before = headOf(root);

  const r = runCommit(root);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /superseded/, `stdout: ${r.stdout}`);
  assert.deepEqual(readEntries(root, SESSION), [], "its own checkout is the one place that CAN judge it");
  assert.equal(headOf(root), before);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: the superseded sentence claims only the three trees this run actually read", () => {
  const root = gitRepo();
  queueAbsent(root, "OBA-95");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shimDir = join(root, "gitshim");
  const marker = join(root, "git-calls.log");
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$3" >> "$BLAZE_TEST_GIT_LOG"\nexec "$BLAZE_TEST_REAL_GIT" "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);

  const r = runCommit(root, {
    env: { PATH: `${shimDir}:${process.env.PATH}`, BLAZE_TEST_REAL_GIT: realGit, BLAZE_TEST_GIT_LOG: marker },
  });

  // POSITIVE CONTROL: a HEAD claim is only allowed because HEAD was read.
  assert.ok(existsSync(marker), "the shim never ran — the rest of this test would be vacuous");
  const calls = readFileSync(marker, "utf8").split("\n").filter(Boolean);
  assert.ok(calls.includes("cat-file"),
    `HEAD must be READ before it is spoken about: ${JSON.stringify(calls)}`);
  assert.match(r.stdout, /HEAD/, "the sentence may mention HEAD, because HEAD was read");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: a reconcile op's cleared tickets are named from its ids, not its synthetic entry id", () => {
  const root = gitRepo();
  const ids = ["BLZ-1", "BLZ-2", "BLZ-3"];
  appendEntry(root, {
    id: "reconcile:BLZ", op: "reconcile", ids,
    message: "reconcile: 3 tickets", files: ["projects/OBA/backlog/gone.md"],
    ts: "t", session: SESSION, branch: "master",
  }, SESSION);

  const r = runCommit(root);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  for (const id of ids) {
    assert.match(r.stdout, new RegExp(id), `the line calls them "ticket(s)" — so name them. stdout: ${r.stdout}`);
  }
  assert.doesNotMatch(r.stdout, /reconcile:BLZ/, "the synthetic entry id is not a ticket");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-590: an op recording no paths at all is held back, never declared absent over nothing", () => {
  const root = gitRepo();
  appendEntry(root, { id: "OBA-96", op: "edit", message: "OBA-96: edit", files: [], ts: "t", session: SESSION, branch: "master" }, SESSION);

  const r = runCommit(root);

  assert.equal(r.status, 3, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /superseded|absent/, "zero paths measured is not a measurement");
  assert.match(r.stderr, /recording no files/, `stderr: ${r.stderr}`);
  assert.equal(readEntries(root, SESSION).length, 1, "kept — there is nothing to establish either way");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 17. Putting a line back is a rewrite, not a no-op: `clearLedger` writes the
//     survivors out again. So the survivors must come back BYTE-FOR-BYTE and in
//     the queue's own order — which is why `keepIdx` carries indices rather than
//     raw strings. Interleaved deliberately: the held-back ops sit either side of
//     one that really commits, so a rewrite that merely appends survivors would
//     reorder them and be caught.
// ---------------------------------------------------------------------------
test("BLZ-590: held-back ops are written back byte-for-byte, in the queue's original order", () => {
  const root = gitRepo();
  writeFileSync(join(root, "projects/OBA/backlog/OBA-1.md"), "real");
  appendEntry(root, { id: "OBA-A", op: "move", message: "OBA-A: lane", files: ["projects/OBA/gone-A.md"], ts: "t", session: SESSION, branch: "lane-x" }, SESSION);
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: real", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t", session: SESSION, branch: "master" }, SESSION);
  appendEntry(root, { id: "OBA-B", op: "move", message: "OBA-B: lane", files: ["projects/OBA/gone-B.md"], ts: "t", session: SESSION, branch: "lane-x" }, SESSION);
  const queue = ledgerPath(root, SESSION);
  const lines = readFileSync(queue, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3, "fixture is vacuous unless the held-back ops really straddle the real one");
  const expected = `${lines[0]}\n${lines[2]}\n`;

  const r = runCommit(root);

  assert.equal(r.status, 3, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /flushed 1 op\(s\)/, "the op this checkout CAN judge still commits");
  assert.equal(readFileSync(queue, "utf8"), expected,
    "the two lane ops must come back byte-for-byte, in their original order, and nothing else with them");
  rmSync(root, { recursive: true, force: true });
});

// The ordering above survives dropping the sort, because both survivors are appended in
// ascending order anyway — so on its own it leaves the sort UNPINNED, not proven. The sort
// is load-bearing only when the two SOURCES of survivors interleave: `belongsHere` puts a
// foreign op back during partition, and classification puts a held-back op back afterwards.
//
// And it is not enough for the survivors to interleave: they must interleave ACROSS A
// DECADE BOUNDARY. `[1, 0, 2]` is restored correctly by a bare `.sort()` too, because
// lexicographic and numeric orders agree below index 10 — so an interleaving in single
// digits pins that A sort happens, not that it is NUMERIC. Survivors at indices 2 and 10
// separate them: numeric gives [2, 10]; lexicographic gives ["10", "2"], and the queue comes
// back with its two survivors swapped. Same bug, one order of magnitude up.
test("BLZ-590: survivors at indices 2 and 10 come back in numeric order, not lexicographic", () => {
  const root = gitRepo();
  // 12 ops. Index 2 is held back at CLASSIFICATION (another branch, path in no tree);
  // index 10 is refused at PARTITION (another working tree) — so keepIdx is filled [10, 2].
  const lines = [];
  for (let i = 0; i < 12; i += 1) {
    const id = `OBA-L${i}`;
    if (i === 2) {
      appendEntry(root, { id, op: "move", message: `${id}: lane`, files: [`projects/OBA/gone-${i}.md`], ts: "t", session: SESSION, branch: "lane-x" }, SESSION);
    } else if (i === 10) {
      appendEntry(root, { id, op: "new", message: `${id}: foreign`, files: [`projects/OBA/backlog/${id}.md`], ts: "t", session: SESSION, worktree: "some-other-lane" }, SESSION);
    } else {
      writeFileSync(join(root, "projects", "OBA", "backlog", `${id}.md`), `real ${i}`);
      appendEntry(root, { id, op: "new", message: `${id}: real`, files: [`projects/OBA/backlog/${id}.md`], ts: "t", session: SESSION, branch: "master" }, SESSION);
    }
    lines.push(id);
  }
  const queue = ledgerPath(root, SESSION);
  const raw = readFileSync(queue, "utf8").split("\n").filter(Boolean);
  assert.equal(raw.length, 12, "fixture needs all twelve lines");
  const expected = `${raw[2]}\n${raw[10]}\n`;

  const r = runCommit(root);

  assert.equal(r.status, 3, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /flushed 10 op\(s\)/, `the other ten really commit. stdout: ${r.stdout}`);
  const after = readFileSync(queue, "utf8");
  assert.equal(after, expected,
    `survivors must come back as OBA-L2 then OBA-L10, byte-for-byte: ${JSON.stringify(after)}`);
  rmSync(root, { recursive: true, force: true });
});

// The convention this gate inherits, pinned so changing it is a deliberate red rather than
// a quiet drift: an op recording NEITHER `worktree` NOR `branch` is a pre-INF-673 op, and
// `belongsHere` documents it as "treated as this tree's". The gate keeps that rather than
// inventing a stricter rule than the guard running in front of it. 0 of the 210 live ops
// are this shape.
test("BLZ-590: an op with no recorded provenance at all is judged here, per belongsHere's convention", () => {
  const root = gitRepo();
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-97.md"), "legacy op, no provenance");
  appendEntry(root, { id: "OBA-97", op: "new", message: "OBA-97: legacy", files: ["projects/OBA/backlog/OBA-97.md"], ts: "t", session: SESSION }, SESSION);

  const r = runCommit(root);

  assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /flushed 1 op\(s\)/,
    "a legacy op with no provenance still drains — a stricter gate would strand it forever");
  assert.deepEqual(readEntries(root, SESSION), []);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 19. ROUND 4. THE PROPERTY, not the buckets.
//
// Round 1 asserted a verdict without measuring. Round 2 gated nothing. Round 3
// gated `absent` — and only `absent`, so a `settled` op belonging to another
// checkout still cleared at exit 0, its ledger line destroyed, over a sentence
// ("every file they record already matches HEAD") comparing THIS checkout's copy
// against work living somewhere else. Three rounds, one defect, three buckets.
//
// The property is single: THIS CHECKOUT MAY ONLY REACH A VERDICT ABOUT AN OP THE
// OP SAYS WAS QUEUED HERE. It is now asked twice, and neither is a clause inside
// a bucket: the partition refuses a foreign op before any path of its is even
// collected, and `classify` is called from exactly one place, past a gate, so a
// state added to the classifier cannot escape it either.
//
// Pinned as the property, table-driven over EVERY state the classifier can
// return. Each row runs twice: once with provenance here — which asserts the
// fixture really reaches that state, so the row cannot pass vacuously — and once
// with provenance elsewhere, which must be held back no matter what this
// checkout's working tree, index or HEAD say. Adding a state without gating it
// fails here.
// ---------------------------------------------------------------------------

const BROKEN_DIFF_SHIM = (root) => {
  const dir = join(root, "gitshim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "git"),
    `#!/bin/sh\nif [ "$3" = "diff" ]; then\n  for a in "$@"; do\n    if [ "$a" = "--cached" ]; then exit 128; fi\n  done\nfi\nexec "$BLAZE_TEST_REAL_GIT" "$@"\n`);
  chmodSync(join(dir, "git"), 0o755);
  return {
    PATH: `${dir}:${process.env.PATH}`,
    BLAZE_TEST_REAL_GIT: execFileSync("which", ["git"], { encoding: "utf8" }).trim(),
  };
};

const EVERY_STATE = [
  {
    state: "staged",
    files: (id) => [`projects/OBA/backlog/${id}.md`],
    seed: (root, id) => writeFileSync(join(root, "projects", "OBA", "backlog", `${id}.md`), "outstanding"),
    hereVerdict: (r) => assert.match(r.stdout, /flushed 1 op\(s\)/, `stdout: ${r.stdout}`),
  },
  {
    state: "settled",
    files: (id) => [`projects/OBA/backlog/${id}.md`],
    seed: (root, id) => {
      const rel = `projects/OBA/backlog/${id}.md`;
      writeFileSync(join(root, rel), "filed by hand");
      execFileSync("git", ["-C", root, "add", "--", rel]);
      execFileSync("git", ["-C", root, "commit", "-qm", `hand-filed ${id}`]);
    },
    hereVerdict: (r) => assert.match(r.stdout, /already filed/, `stdout: ${r.stdout}`),
  },
  {
    state: "absent",
    files: (id) => [`projects/OBA/backlog/${id}.md`],
    seed: () => {},
    hereVerdict: (r) => assert.match(r.stdout, /superseded/, `stdout: ${r.stdout}`),
  },
  {
    state: "no-paths",
    files: () => [],
    seed: () => {},
    // Held back even when it IS this checkout's — for its own reason, not provenance.
    hereVerdict: (r) => {
      assert.equal(r.status, 3, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.match(r.stderr, /recording no files/, `stderr: ${r.stderr}`);
    },
  },
  {
    state: "unknown",
    files: (id) => [`projects/OBA/backlog/${id}.md`],
    // Hand-filed AND the index probe broken: the path is on disk and tracked, so it reaches
    // the probe, and the probe cannot answer. The commit then finds nothing to commit and
    // fails, which is the arm that makes `unknown` visible on stderr.
    seed: (root, id) => {
      const rel = `projects/OBA/backlog/${id}.md`;
      writeFileSync(join(root, rel), "filed by hand");
      execFileSync("git", ["-C", root, "add", "--", rel]);
      execFileSync("git", ["-C", root, "commit", "-qm", `hand-filed ${id}`]);
    },
    env: BROKEN_DIFF_SHIM,
    hereVerdict: (r) => {
      assert.notEqual(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.match(r.stderr, /could not say whether/, `stderr: ${r.stderr}`);
    },
  },
];

for (const c of EVERY_STATE) {
  test(`BLZ-590: the fixture for '${c.state}' really reaches that state when the op is this checkout's`, () => {
    const root = gitRepo();
    const id = "OBA-100";
    c.seed(root, id);
    appendEntry(root, { id, op: "move", message: `${id}: m`, files: c.files(id), ts: "t", session: SESSION, branch: "master" }, SESSION);
    c.hereVerdict(runCommit(root, { env: c.env ? c.env(root) : {} }));
    rmSync(root, { recursive: true, force: true });
  });

  test(`BLZ-590: an op queued in ANOTHER checkout is held back whatever this tree says — the '${c.state}' case`, () => {
    const root = gitRepo();
    const id = "OBA-100";
    c.seed(root, id);
    appendEntry(root, { id, op: "move", message: `${id}: m`, files: c.files(id), ts: "t", session: SESSION, branch: "lane-x" }, SESSION);
    const before = headOf(root);

    const r = runCommit(root, { env: c.env ? c.env(root) : {} });

    assert.equal(r.status, 3, `must be reported as unreached, not judged. stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(readEntries(root, SESSION).length, 1,
      `THE PROPERTY: an op this checkout may not judge keeps its ledger line ('${c.state}')`);
    assert.match(r.stderr, /lane-x/, `the message must name where it belongs. stderr: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /already filed|superseded|flushed/,
      `no verdict of any kind may be reached about it ('${c.state}'). stdout: ${r.stdout}`);
    assert.equal(headOf(root), before, "and nothing of it may reach a commit");
    rmSync(root, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// 20. ROUND 4, second half. Holding the LEDGER LINE is only half of not judging.
//
// Found by probing the round-4 gate rather than by reading it: with the gate in
// `opState`, a foreign op was still held back correctly — and its file was
// COMMITTED by this run anyway. `recorded` is built from every entry that got
// past `belongsHere`, so a foreign op's paths reached `addPaths` and the commit
// pathspec before classification ever ran. A board file is tracked in every
// checkout, so it is stageable here the moment it is dirty here.
//
// The run then printed "an op belongs to the checkout that queued it ... Run
// `blaze commit` there" about work it had just published itself.
//
// So the refusal moved to the partition, where no path of a foreign op is
// collected at all. Provenance is a property of the RECORD, not of the tree, so
// it needs no probe and can be asked before any path is gathered. May-not-judge
// means may-not-touch.
test("BLZ-590: a foreign op's file is not committed by this checkout, even when it is dirty here", () => {
  const root = gitRepo();
  // Ours — a real outstanding op, so the run genuinely reaches `git commit`.
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "ours");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: ours", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t", session: SESSION, branch: "master" }, SESSION);
  // Theirs — queued on another branch, but its path exists HERE and is dirty.
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-F.md"), "theirs, not this checkout's to publish");
  appendEntry(root, { id: "OBA-F", op: "new", message: "OBA-F: theirs", files: ["projects/OBA/backlog/OBA-F.md"], ts: "t", session: SESSION, branch: "lane-x" }, SESSION);

  const r = runCommit(root);

  assert.equal(r.status, 3, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  const names = namesIn(root);
  assert.match(names, /OBA-1\.md/, "our own outstanding op must still land");
  assert.doesNotMatch(names, /OBA-F\.md/,
    "THE PROPERTY: an op this checkout may not judge is an op it may not commit either");
  assert.deepEqual(readEntries(root, SESSION).map((e) => e.id), ["OBA-F"], "and its ledger line is kept");
  // Not merely uncommitted — untouched. A staged-but-uncommitted foreign path would
  // leave the operator's index carrying work this run said it would not act on.
  assert.equal(
    spawnSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", "projects/OBA/backlog/OBA-F.md"]).status, 0,
    "and it is not left staged in the index either");
  rmSync(root, { recursive: true, force: true });
});

// Round 4's review found the cost of the leg above being unconditional: a DETACHED worktree
// is exactly where `checkBranch` is explicitly ok, so it would judge a no-provenance op,
// find its path in none of the three trees IT can see, call it superseded and clear it at
// exit 0 — destroying the record while the real file sat uncommitted in the tree that
// queued it. One checkout claims these ops, and it is the one the store sits beside.
test("BLZ-590: a no-provenance op is held back by a worktree that is not the store's own", () => {
  const root = gitRepo();
  const lane = join(root, "..", `lane-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", lane]);
  // The linked worktree needs its own copy of scripts/ (untracked in the fixture), and it
  // shares the store: `queueRoot` resolves through --git-common-dir back to `root`.
  cpSync(join(root, "scripts"), join(lane, "scripts"), { recursive: true });
  mkdirSync(join(lane, "projects", "OBA", "backlog"), { recursive: true });
  appendEntry(root, { id: "OBA-98", op: "new", message: "OBA-98: legacy", files: ["projects/OBA/backlog/OBA-98.md"], ts: "t", session: SESSION }, SESSION);
  assert.equal(readEntries(root, SESSION).length, 1, "fixture: the op is in the shared store");

  const r = runCommit(lane);

  assert.equal(r.status, 3, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /superseded|already filed|flushed/,
    `no verdict may be reached about it from here. stdout: ${r.stdout}`);
  assert.equal(readEntries(root, SESSION).length, 1, "THE PROPERTY: its ledger line survives");
  assert.match(r.stderr, /record no provenance at all/,
    `and the reason names the field it does not have, not one it does. stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /undefined|branch ''/, "never name a field the op never recorded");
  execFileSync("git", ["-C", root, "worktree", "remove", "--force", lane]);
  rmSync(root, { recursive: true, force: true });
});
