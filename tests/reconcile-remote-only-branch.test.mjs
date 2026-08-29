// tests/reconcile-remote-only-branch.test.mjs — BLZ-492.
//
// `gatherRepo` lists refs with `for-each-ref refs/heads refs/remotes/origin` and strips
// `origin/` from every one. That stripped name is RIGHT for the record — a ticket's
// `branch:` field names a branch, not a remote-tracking ref, and it is what makes a branch
// that exists both locally and on the remote ONE branch rather than two. It was also, until
// this ticket, the name the two branch-inspect probes were asked about, and no local ref
// answers to it for a branch that exists only under `refs/remotes/origin`:
//
//   git log INF-1-work ^origin/main --format=%s   →  exit 128, `ambiguous argument`
//   git rev-parse INF-1-work                      →  exit 128, `ambiguous argument`
//
// Measured across the reconcile suite at 1b00f3a: 52 occurrences each, every one on a
// stripped remote-only ref. `buildBranchMap` then read `own: []` and
// `sameTipAsDefault: false` and declined to corroborate the branch on its own evidence —
// silently, because a non-zero exit at those two sites is deliberately not a finding.
//
// This file constructs the shape the whole suite had never constructed: a clone whose
// working branch exists ONLY as `origin/INF-1-work`. Three branches, three answers, so the
// fix is a discrimination and not a blanket "corroborate everything":
//
//   INF-1-work — its own commit subject claims INF-1        → corroborated (own evidence)
//   INF-2-work — its own commit subject claims nothing      → NOT corroborated
//   INF-3-work — no commits of its own, tip IS the default  → corroborated (FRESH)
//
// The middle one is the control. Without it, a fix that simply returned "corroborated" for
// every remote-only branch would pass every other test here.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitStatus = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).status;

/** An upstream repo carrying three branches, and a CLONE of it that holds none of them
 *  locally — the ordinary state of a checkout that has fetched but never checked out. */
function remoteOnlyBoard(tmp) {
  const upstream = join(tmp, "upstream");
  mkdirSync(upstream, { recursive: true });
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) {
    git(upstream, ...a);
  }
  writeFileSync(join(upstream, "README.md"), "x\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "seed");

  // INF-3-work: no commits of its own. Its tip IS main's tip — the FRESH case.
  git(upstream, "branch", "INF-3-work");
  // INF-1-work: one commit whose subject claims INF-1 by the house convention.
  git(upstream, "checkout", "-q", "-b", "INF-1-work");
  writeFileSync(join(upstream, "a.txt"), "a\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "INF-1: the work");
  // INF-2-work: one commit whose subject claims NOTHING. The control.
  git(upstream, "checkout", "-q", "main");
  git(upstream, "checkout", "-q", "-b", "INF-2-work");
  writeFileSync(join(upstream, "b.txt"), "b\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "chore: unrelated tidy-up");
  git(upstream, "checkout", "-q", "main");

  const repo = join(tmp, "repo-INF");
  execFileSync("git", ["clone", "-q", upstream, repo]);

  const root = join(tmp, "board");
  const dir = join(root, "projects", "INF", "defined");
  mkdirSync(dir, { recursive: true });
  for (const n of [1, 2, 3]) {
    writeFileSync(join(dir, `INF-${n}-t.md`),
      `---\nid: INF-${n}\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n`);
  }
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"] }));
  return { root, repo, upstream };
}

/** A `gh` answering with no pull requests, so the BRANCH is the only signal in play. */
function noPrBin(tmp) {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  return () => { process.env.PATH = prev; };
}

describe("BLZ-492: a remote-only branch is asked about by a name that resolves", () => {
  test("the construction is what it claims: the branches exist ONLY under refs/remotes/origin", () => {
    // Ground truth from git itself, not from reconcile. Without this the tests below could
    // be passing on a clone that quietly created local branches, which is not the shape.
    const tmp = mkdtempSync(join(tmpdir(), "blz492-shape-"));
    try {
      const { repo } = remoteOnlyBoard(tmp);
      const heads = git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads");
      assert.deepEqual(heads.split("\n").filter(Boolean), ["main"],
        "the clone must hold exactly one local branch, or these branches are not remote-only");
      for (const b of ["INF-1-work", "INF-2-work", "INF-3-work"]) {
        assert.equal(gitStatus(repo, "rev-parse", "--verify", b), 128,
          `${b}: the STRIPPED name must be one no local ref answers to — that is the defect`);
        assert.equal(gitStatus(repo, "rev-parse", "--verify", `origin/${b}`), 0,
          `origin/${b}: …while the ref reconcile should be asking about resolves fine`);
      }
      // …and the id must not be recoverable from the shipped set, or the branch signal is
      // not what moves the ticket and this whole file proves nothing.
      const mainLog = git(repo, "log", "origin/main", "--format=%s");
      assert.doesNotMatch(mainLog, /INF-\d/,
        "no INF-n: commit may be reachable from the default branch, or shippedSet corroborates instead");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a remote-only branch whose own commit claims the id moves the ticket to in-progress", async () => {
    // The defect itself. Before the fix `git log INF-1-work ^origin/main` exited 128, `own`
    // read `[]`, `sameTipAsDefault` read false, and the ticket did not move.
    const tmp = mkdtempSync(join(tmpdir(), "blz492-own-"));
    const { root } = remoteOnlyBoard(tmp);
    const restore = noPrBin(tmp);
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.equal(r.ok, true);
      const moved = new Map(r.changes.map((c) => [c.id, c.to]));
      assert.equal(moved.get("INF-1"), "in-progress",
        "a branch whose own commit subject claims the id corroborates itself, remote-only or not");
      // …and the 52 exits are GONE rather than made quieter. `exitIsAnAnswer` already kept
      // them silent, so this line cannot go red on its own; it is here so that a "fix" which
      // widened the laundering instead of resolving the ref would not read as a pass.
      assert.deepEqual(r.gitErrors, [],
        "every probe on this board runs and answers — nothing is being swallowed");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a remote-only branch with NO commits of its own, at the default tip, is FRESH and corroborates", async () => {
    // The other half of the discriminator `sameTipAsDefault` exists for, and the arm that
    // `rev-parse INF-3-work` exiting 128 had been silently answering "false" for.
    const tmp = mkdtempSync(join(tmpdir(), "blz492-fresh-"));
    const { root, repo } = remoteOnlyBoard(tmp);
    const restore = noPrBin(tmp);
    try {
      assert.equal(git(repo, "rev-parse", "origin/INF-3-work"), git(repo, "rev-parse", "origin/main"),
        "the fixture's FRESH branch must actually sit at the default tip");
      const r = await reconcile({ root, dryRun: true });
      const moved = new Map(r.changes.map((c) => [c.id, c.to]));
      assert.equal(moved.get("INF-3"), "in-progress");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("THE CONTROL: a remote-only branch whose commits claim nothing still corroborates nothing", async () => {
    // Fixing the ref name must widen WHICH branches corroborate by exactly the branches that
    // have the evidence — not by every branch that used to fail the probe. INF-2-work now
    // answers the probe and the answer is still no.
    const tmp = mkdtempSync(join(tmpdir(), "blz492-control-"));
    const { root } = remoteOnlyBoard(tmp);
    const restore = noPrBin(tmp);
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.changes.filter((c) => c.id === "INF-2"), [],
        "an uncorroborated ref is still dropped — INF-735's fail-closed rule is untouched");
      assert.ok(existsSync(join(root, "projects", "INF", "defined", "INF-2-t.md")));
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the RECORD keeps the branch's own name, not the remote-tracking ref", async () => {
    // The stripped name is right for the record and wrong for the question; this is the
    // half that says so. A fix that stopped stripping would write `branch: origin/INF-1-work`
    // into a ticket and pass every other test in this file.
    const tmp = mkdtempSync(join(tmpdir(), "blz492-record-"));
    const { root } = remoteOnlyBoard(tmp);
    const restore = noPrBin(tmp);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.equal(r.ok, true);
      const written = readFileSync(
        join(root, "projects", "INF", "in-progress", "INF-1-t.md"), "utf8");
      assert.match(written, /^branch: INF-1-work$/m);
      assert.doesNotMatch(written, /^branch: origin\//m,
        "a remote-tracking ref is not a branch name and must never reach a ticket's frontmatter");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// BLZ-492, the other half: `exitIsAnAnswer: true` at those two sites STAYS, and this is
// what it is load-bearing for now that the ref name is right.
//
// `git log <branch> ^<ref>` NAMES `ref`, so it is a DEPENDENT probe on the default-branch
// resolution — exactly like `defaultTip` and the `%x00%B` log walk, which are already told
// `exitIsAnAnswer: !resolved` for this reason. When nothing resolved, `ref` is the string
// "main" and no such ref exists: every branch-inspect probe on the repo exits 128 for ONE
// condition, which `no-default-branch` has already reported by name. Dropping the opt-in
// turns one warning into one warning plus one `git-failed` ERROR PER BRANCH, and a board
// whose default branch is called something else exits 1.
//
// This pins `exitIsAnAnswer` against `false`. It does not distinguish `true` from
// `!resolved`; the narrower form is a behaviour change (it would start reporting a branch
// walk that fails on a repo whose default branch DID resolve) and is not made here.
// =============================================================================

/** A repo with no `main`, no `master` and no origin — its default branch is `trunk`, which
 *  `defaultBranchRef` cannot find, so `ref` is the unresolved guess "main". */
function unresolvedDefaultBoard(tmp) {
  const repo = join(tmp, "svc");
  mkdirSync(repo, { recursive: true });
  for (const a of [["init", "-q", "-b", "trunk"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) {
    git(repo, ...a);
  }
  git(repo, "commit", "-q", "--allow-empty", "-m", "seed");
  git(repo, "branch", "INF-1-work");

  const root = join(tmp, "board");
  const dir = join(root, "projects", "INF", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "INF-1-t.md"),
    "---\nid: INF-1\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"] }));
  return { root, repo };
}

describe("BLZ-492: exitIsAnAnswer on the branch-inspect probes is load-bearing, and this is why", () => {
  test("the construction is what it claims: no default ref resolves, and the branch walk exits 128", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz492-unresolved-shape-"));
    try {
      const { repo } = unresolvedDefaultBoard(tmp);
      for (const b of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
        assert.notEqual(gitStatus(repo, "rev-parse", "--verify", "--quiet", b), 0,
          `${b} must not resolve, or \`ref\` is not the unresolved guess this test needs`);
      }
      assert.equal(gitStatus(repo, "log", "INF-1-work", "^main", "--format=%s"), 128,
        "the branch-inspect walk fails for the ONE condition no-default-branch already names");
      assert.deepEqual(
        git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean),
        ["INF-1-work", "trunk"], "two branches, so a per-branch report would be two lines");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an unresolved default branch is ONE warning, not one warning plus a git-failed per branch", async () => {
    // The pin. Dropping `exitIsAnAnswer: true` from the branch-inspect `git log` turns this
    // red with two extra `git-failed` entries — `git log INF-1-work ^main --format=%s` and
    // `git log trunk ^main --format=%s` — at severity `error`, which is exit 1 for the run.
    const tmp = mkdtempSync(join(tmpdir(), "blz492-unresolved-"));
    const { root } = unresolvedDefaultBoard(tmp);
    const restore = noPrBin(tmp);
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.gitErrors.map((e) => e.reason), ["no-default-branch"],
        `one condition, one line — got ${JSON.stringify(r.gitErrors.map((e) => e.command))}`);
      assert.equal(r.gitErrors[0].severity, "warning",
        "…and it stays a warning, so a repo whose default branch is called trunk still exits 0");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
