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
