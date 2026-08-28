// tests/reconcile-git-probe-unreadable.test.mjs — BLZ-484.
//
// `sh()` collapsed `{ok:false}` into `null`, so A GIT PROBE THAT COULD NOT FORK WAS
// INDISTINGUISHABLE FROM "THE REF DOES NOT EXIST". The Lane J reviewer demonstrated it end
// to end: with the `git log --format=%x00%B` probe unable to run, reconcile went from
// `moved ZZZ-1: defined -> done` to `no code-bound change found - nothing to do.` — exit 0,
// and not one word on stderr.
//
// This file is that demonstration, kept. `codeRepoWithMergedCommit` builds a repo whose
// default branch carries an `INF-1:` commit, so a run that CAN look moves the ticket; the
// same board with `git` unreachable must not produce the sentence a clean board produces.
//
// AC-4 is the load-bearing one, and it is why the probe is disabled by removing `git` from
// PATH rather than by pointing reconcile at an empty repo: a test that makes a probe RETURN
// EMPTY proves nothing about this defect, because returning empty is the behaviour that was
// already correct. `execFileSync` reports a binary it could not launch as `status: null` —
// the same shape ENOENT, EAGAIN (cannot fork), ETIMEDOUT and a killing signal all produce —
// and that null is the discriminator the whole fix turns on.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";

const CLI = join(import.meta.dirname, "..", "scripts", "reconcile.mjs");

/** A board with one project, one `defined` ticket, and a code repo whose default branch
 *  already carries the `INF-1:` commit that should drive it to `done`. */
function board(tmp) {
  const repo = join(tmp, "repo-INF");
  mkdirSync(repo, { recursive: true });
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", repo, ...a]);
  }
  writeFileSync(join(repo, "README.md"), "x\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "INF-1: the work"]);

  const root = join(tmp, "board");
  const dir = join(root, "projects", "INF", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INF-1-t.md"),
    "---\nid: INF-1\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"] }));
  return root;
}

/** A `gh` reporting no pull requests, written with shell BUILTINS only and an absolute
 *  interpreter path — so it still works when PATH holds nothing but its own directory,
 *  which is how `git` is made unreachable below. */
function ghOnlyBin(tmp) {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  return bin;
}

const run = (root, bin, extraPath) => spawnSync(process.execPath, [CLI], {
  cwd: root, encoding: "utf8",
  env: { ...process.env, PATH: extraPath ? `${bin}:${process.env.PATH}` : bin },
});

describe("BLZ-484: a git probe that could not RUN is not a git probe that found nothing", () => {
  test("the control: with git reachable the same board moves the ticket and reports no git condition", () => {
    // Without this the test below proves only that a broken PATH breaks things. This is the
    // half that says the fixture really does carry a move for a run that can look.
    const tmp = mkdtempSync(join(tmpdir(), "blz484-control-"));
    try {
      const root = board(tmp);
      const res = run(root, ghOnlyBin(tmp), true);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /would move INF-1: defined → done/);
      assert.doesNotMatch(res.stderr, /GIT UNREADABLE/);
      assert.doesNotMatch(res.stderr, /GIT DEGRADED/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("with git unreachable the run does NOT print the clean-board sentence", () => {
    // The exact regression the reviewer demonstrated: `no code-bound change found — nothing
    // to do.` on exit 0, said by a run that never got an answer from a single probe.
    const tmp = mkdtempSync(join(tmpdir(), "blz484-silent-"));
    try {
      const root = board(tmp);
      const res = run(root, ghOnlyBin(tmp), false);
      assert.doesNotMatch(res.stdout + res.stderr, /no code-bound change found/,
        "a run that could not complete its probes must not report what a clean board reports");
      assert.notEqual(res.status, 0,
        "…nor exit 0. AC-3: it fails, or says plainly what it could not read — it does both");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("it names the command, the repo and the reading — on stderr, every run", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz484-loud-"));
    try {
      const root = board(tmp);
      const res = run(root, ghOnlyBin(tmp), false);
      assert.match(res.stderr, /GIT UNREADABLE/, "AC-2: the condition is reported on stderr");
      assert.match(res.stderr, /COULD NOT RUN/);
      assert.match(res.stderr, /this is not `git` saying no/,
        "the sentence must say WHICH of the two outcomes it is — that is the whole ticket");
      assert.match(res.stderr, /git log main --format=%x00%B/,
        "the demonstrated probe must be named, not summarised");
      assert.match(res.stderr, /UNKNOWN for this repo, not empty/);
      assert.match(res.stderr, /FAILED — \d+ git probe\(s\) could not be completed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--quiet does not hide it, the same way it does not hide FORGE UNREADABLE", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz484-quiet-"));
    try {
      const root = board(tmp);
      const bin = ghOnlyBin(tmp);
      const res = spawnSync(process.execPath, [CLI, "--quiet"],
        { cwd: root, encoding: "utf8", env: { ...process.env, PATH: bin } });
      assert.match(res.stderr, /GIT UNREADABLE/);
      assert.notEqual(res.status, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the condition TRAVELS WITH THE RESULT, not only to the terminal", () => {
    // AC-2's other half, and what makes `serve.mjs`'s preview and any other consumer able
    // to tell the two outcomes apart without re-running anything.
    const tmp = mkdtempSync(join(tmpdir(), "blz484-result-"));
    const prev = process.env.PATH;
    try {
      const root = board(tmp);
      process.env.PATH = ghOnlyBin(tmp);
      return reconcile({ root, dryRun: true }).then((r) => {
        assert.equal(r.ok, true, "the run still returns a result — this is a report, not a throw");
        assert.ok(r.gitErrors.length > 0, "the git conditions are on the result");
        for (const e of r.gitErrors) {
          assert.equal(e.reason, "git-unrunnable");
          assert.equal(e.status, null, "`status: null` IS the could-not-run discriminator");
          assert.equal(e.severity, "error");
        }
        assert.deepEqual(r.changes, [],
          "and the board legitimately did not move — which is exactly why the silence was fatal");
      });
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a probe that RAN and answered no is still silent — the discrimination, not just the alarm", async () => {
    // The negative side, and the reason this is not simply "report every failure". Measured
    // across the 330 reconcile tests on the parent commit, `git rev-parse --verify --quiet`
    // exits 1 on 474 occasions and `rev-parse --abbrev-ref origin/HEAD` exits 128 on 239 —
    // every one an ordinary "no such ref" on a fixture repo with no origin. If those were
    // reported, every run on this suite would print a git condition and the real one would
    // be buried. `origin/HEAD` and `origin/main` do not exist in this fixture, so both
    // probes fail here, by exit code, and neither may say a word.
    const tmp = mkdtempSync(join(tmpdir(), "blz484-answered-"));
    try {
      const root = board(tmp);
      assert.equal(existsSync(join(tmp, "repo-INF", ".git", "refs", "remotes")), false,
        "the fixture must have no remote-tracking refs, or the probes under test never fail");
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.gitErrors, [],
        "a ref probe that ran and said `no such ref` is an ANSWER, and answers are not findings");
      assert.deepEqual(r.changes.map((c) => c.id), ["INF-1"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// BLZ-484 round 2 — PROBE FAILURES ARE NOT ALL-OR-NOTHING.
//
// Round 1 claimed the FAILED block's fall-through half — print the changes, THEN exit 1 —
// was unreachable, reasoning that every signal which can become a change comes from `git`,
// so a `git` that cannot run takes them all down and `changes` is empty by construction.
//
// THAT CLAIM WAS FALSE, and falsely in this lane's own defect class: it asserted more than
// was established. It assumed probe failures are all-or-nothing. They are not — a probe can
// fail on its own merits while its siblings succeed. A missing commit object breaks the log
// walk and nothing else: `rev-parse` exits 0, `for-each-ref` exits 0, `git log` exits 128.
// That is an ordinary real-world state (an interrupted fetch, a partial clone, a damaged
// object store), reachable with plain git and no spawn manipulation at all.
//
// So the guard is reachable, and until now it was unpinned: mutating
// `if (!r.changes.length) process.exit(1);` to an unconditional `process.exit(1)` left the
// whole suite green while hiding real work behind a probe failure — the second silence the
// split exists to prevent.
// =============================================================================

/** The construction: a repo whose commit-log walk is broken and whose ref probes are fine.
 *  `withBranch` decides whether the run also has a change to report. */
function corruptObjectBoard(tmp, { withBranch }) {
  const repo = join(tmp, "svc");
  mkdirSync(repo, { recursive: true });
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", repo, ...a]);
  }
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);
  const parent = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "second"]);
  // The BRANCH is the change signal, and it is what makes `changes` non-empty while the log
  // walk is broken — the exact combination round 1 argued could not occur.
  if (withBranch) execFileSync("git", ["-C", repo, "branch", "INF-1-work"]);
  rmSync(join(repo, ".git", "objects", parent.slice(0, 2), parent.slice(2)), { force: true });

  const root = join(tmp, "board");
  const dir = join(root, "projects", "INF", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INF-1-t.md"),
    "---\nid: INF-1\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"] }));
  return root;
}

describe("BLZ-484: a single probe can fail while its siblings answer", () => {
  test("the construction is what it claims: ref probes succeed, only the log walk fails", () => {
    // Without this the tests below could be passing because the whole repo is broken, which
    // is the state round 1 already covered and is not the one in question.
    const tmp = mkdtempSync(join(tmpdir(), "blz484-shape-"));
    try {
      const root = corruptObjectBoard(tmp, { withBranch: true });
      const repo = join(tmp, "svc");
      const st = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).status;
      assert.equal(st(["rev-parse", "main"]), 0, "the ref still resolves");
      assert.equal(st(["for-each-ref", "--format=%(refname:short)", "refs/heads"]), 0,
        "the refs still list");
      assert.equal(st(["log", "main", "--format=%x00%B"]), 128,
        "and ONLY the commit-log walk is broken — that asymmetry is the whole finding");
      assert.ok(existsSync(join(root, "projects", "INF", "defined", "INF-1-t.md")));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a run that DID find work prints it BEFORE exiting 1 — the second silence", () => {
    // The pin for the fall-through half. Mutating the guard to an unconditional
    // `process.exit(1)` removes the `would move` line and turns this red for the reason its
    // name gives: real work hidden behind a probe failure.
    const tmp = mkdtempSync(join(tmpdir(), "blz484-fallthrough-"));
    try {
      const root = corruptObjectBoard(tmp, { withBranch: true });
      const res = run(root, ghOnlyBin(tmp), true);
      assert.match(res.stderr, /GIT UNREADABLE/, "the condition is named…");
      assert.match(res.stderr, /FAILED — 1 git probe\(s\) could not be completed/, "…and the run is failed…");
      assert.match(res.stdout, /would move INF-1: defined → in-progress/,
        "…and the work it DID find is still printed. Exiting before this hides real work behind " +
        "a probe failure, which is the second silence the split exists to prevent");
      assert.equal(res.status, 1, "both at once: the changes are reported AND the run is not clean");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a non-zero exit from the log walk is NOT an answer — BLZ-484's stated AC", () => {
    // `exitIsAnAnswer: !resolved` on the `git log` probe. `main` resolves here, so the probe
    // is told its failure is not an answer; mutating that to `true` makes an exit-128 log
    // walk silent, the shipped set reads as empty, and the run reports a clean board — this
    // ticket's defect reintroduced through the exit-code door instead of the spawn door, on
    // a path an ordinary damaged object store reaches.
    const tmp = mkdtempSync(join(tmpdir(), "blz484-exitisnotananswer-"));
    const prev = process.env.PATH;
    try {
      const root = corruptObjectBoard(tmp, { withBranch: false });
      // `git` stays REACHABLE here — that is the point. The probe must run, exit 128, and
      // still be reported; a PATH without `git` would prove only what the suite above proves.
      process.env.PATH = `${ghOnlyBin(tmp)}:${prev}`;
      return reconcile({ root, dryRun: true }).then((r) => {
        const logProbe = r.gitErrors.filter((e) => /^git log main/.test(e.command || ""));
        assert.equal(logProbe.length, 1,
          "the log walk failed and must be reported, even though `git` ran and exited");
        assert.equal(logProbe[0].reason, "git-failed",
          "reported as a FAILURE, not as an answer — and distinctly from a probe that could not run");
        assert.equal(logProbe[0].status, 128, "`git` ran and exited 128; that is not `no commits`");
        assert.equal(logProbe[0].severity, "error");
        assert.deepEqual(r.changes, [],
          "with no branch there is genuinely nothing to move — so the ONLY thing standing " +
          "between this run and a false clean board is the finding above");
      });
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("…and the CLI refuses to call that a clean board", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz484-nocleanboard-"));
    try {
      const root = corruptObjectBoard(tmp, { withBranch: false });
      const res = run(root, ghOnlyBin(tmp), true);
      assert.doesNotMatch(res.stdout + res.stderr, /no code-bound change found/);
      assert.equal(res.status, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
