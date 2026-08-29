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

// =============================================================================
// BLZ-492 ROUND 2 — THE FIX REGRESSED A NEIGHBOUR, AND REVIEW CAUGHT IT.
//
// `%(refname:short)` renders `refs/heads/origin/<x>` and `refs/remotes/origin/<x>`
// IDENTICALLY, so stripping `origin/` cannot tell them apart. Round 1's `askable` loop took
// the FIRST raw ref to claim each stripped name, on the stated ground that `for-each-ref`
// sorts `refs/heads/…` before `refs/remotes/…` so a local ref always wins. That ground is
// false for a whole class of names: the sort is on the FULL refname, so
// `refs/heads/origin/task/…` sorts before `refs/heads/task/…` — before ANY local head whose
// name begins with a character after `o`. A stale local branch literally called
// `origin/task/INF-1-work` therefore captured the slot for `task/INF-1-work`, `inspect`
// probed the wrong ref, and the real branch lost its corroboration.
//
// Measured on the reviewer's construction: at 1b00f3a the board reports
// `[["INF-1","in-progress"]]`; at round 1 it reports `[]` — `ok: true`, `gitErrors: []`, not
// one word. That is the BLZ-470 / ADR-0030 failure class exactly, introduced by a change
// whose whole subject is that class, and round 1's "nothing loses corroboration, the change
// is one-directional BY CONSTRUCTION" was an argument standing where BLZ-353 requires a
// measurement — taken over a suite that contains no `refs/heads/origin/*` and so could not
// have seen it.
//
// The rule now: an EXACT local head outranks a stripped collision for the same name.
// Residual, stated: a local head named `origin/<x>` sitting beside a remote-tracking
// `origin/<x>` renders one string for two refs and is still ambiguous. That is the full
// namespace split, which is BLZ-506, not this ticket.
// =============================================================================

/** The reviewer's construction, widened to BOTH sides of the ordering boundary.
 *
 *  Two real work branches, each carrying a commit that claims its own ticket, each shadowed
 *  by a STALE local branch literally named `origin/<same name>`:
 *
 *    feature/INF-2-work   — `f` sorts BEFORE `o`, so the real head is listed FIRST
 *    task/INF-1-work      — `t` sorts AFTER  `o`, so the SHADOW is listed first
 *
 *  Round 1 got the first one right by accident of ordering and the second one wrong. Having
 *  both is what makes the rule ORDERING-INDEPENDENT rather than "reversed the tie-break". */
function shadowedByOriginNamedLocalBranch(tmp, { withRealBranches = true } = {}) {
  const repo = join(tmp, "repo-INF");
  mkdirSync(repo, { recursive: true });
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) {
    git(repo, ...a);
  }
  git(repo, "commit", "-q", "--allow-empty", "-m", "seed");
  const seed = git(repo, "rev-parse", "HEAD");
  if (withRealBranches) {
    for (const [branch, id] of SHADOWED) {
      git(repo, "checkout", "-q", "-b", branch, "main");
      writeFileSync(join(repo, `${id}.txt`), "x\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", `${id}: the work`);
    }
    git(repo, "checkout", "-q", "main");
  }
  git(repo, "commit", "-q", "--allow-empty", "-m", "second on main");
  for (const [branch] of SHADOWED) git(repo, "branch", `origin/${branch}`, seed);

  const root = join(tmp, "board");
  const dir = join(root, "projects", "INF", "defined");
  mkdirSync(dir, { recursive: true });
  for (const [, id] of SHADOWED) {
    writeFileSync(join(dir, `${id}-t.md`),
      `---\nid: ${id}\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n`);
  }
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"] }));
  return { root, repo };
}

/** branch name -> the ticket its own commit claims. Sorted here the way the assertions read
 *  them, not the way `for-each-ref` lists them — that ordering is the thing under test. */
const SHADOWED = [["feature/INF-2-work", "INF-2"], ["task/INF-1-work", "INF-1"]];

describe("BLZ-492 round 2: a local branch named `origin/<x>` must not shadow the real `<x>`", () => {
  test("the construction is what it claims: BOTH listing orders are present, and both strip to one name", () => {
    // The precondition the whole defect rests on, taken from `git` rather than assumed, and
    // the oracle's own size asserted with it: if `for-each-ref`'s ordering ever changed, or
    // if a name were dropped from SHADOWED, this says so rather than the suite quietly
    // ceasing to exercise the half that regressed.
    const tmp = mkdtempSync(join(tmpdir(), "blz492r2-shape-"));
    try {
      const { repo } = shadowedByOriginNamedLocalBranch(tmp);
      const listed = git(repo, "for-each-ref", "--format=%(refname:short)",
        "refs/heads", "refs/remotes/origin").split("\n").filter(Boolean);
      assert.deepEqual(listed, [
        "feature/INF-2-work", "main", "origin/feature/INF-2-work",
        "origin/task/INF-1-work", "task/INF-1-work",
      ], "the exact listing is the premise — read it, do not assume it");

      let shadowFirst = 0, realFirst = 0;
      for (const [branch] of SHADOWED) {
        assert.ok(listed.indexOf(branch) >= 0 && listed.indexOf(`origin/${branch}`) >= 0);
        if (listed.indexOf(`origin/${branch}`) < listed.indexOf(branch)) shadowFirst += 1;
        else realFirst += 1;
        assert.equal(`origin/${branch}`.replace(/^origin\//, ""), branch,
          "…and both refs strip to ONE name, which is why the stripped form cannot pick between them");
        assert.notEqual(git(repo, "rev-parse", branch), git(repo, "rev-parse", `origin/${branch}`),
          `${branch}: the shadow must be STALE, or probing the wrong one would cost nothing`);
      }
      assert.equal(SHADOWED.length, 2, "two names, one either side of the `o` boundary");
      assert.equal(shadowFirst, 1, "exactly one case must list the SHADOW first — that is the one round 1 broke");
      assert.equal(realFirst, 1, "…and exactly one the REAL head first — the one it got right by accident");

      // Both are local heads. Neither is a remote-tracking ref — there is no remote at all.
      assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes"), "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("BOTH real branches still corroborate, whichever order they were listed in", async () => {
    // The regression, stated as the product behaviour it costs. At 1b00f3a the reviewer's
    // single-branch construction reports [["INF-1","in-progress"]]; under round 1 it reports
    // [] with `ok: true` and `gitErrors: []` — not one word.
    const tmp = mkdtempSync(join(tmpdir(), "blz492r2-shadow-"));
    const { root } = shadowedByOriginNamedLocalBranch(tmp);
    const restore = noPrBin(tmp);
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.equal(r.ok, true);
      assert.deepEqual(r.changes.map((c) => [c.id, c.to]).sort(),
        [["INF-1", "in-progress"], ["INF-2", "in-progress"]],
        "an origin-named local branch must not capture the slot the real branch answers for");
      assert.deepEqual(r.gitErrors, [],
        "…and losing it was SILENT, which is the half that makes this the BLZ-470 class");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the record names the real branch, not the shadow", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz492r2-record-"));
    const { root } = shadowedByOriginNamedLocalBranch(tmp);
    const restore = noPrBin(tmp);
    try {
      await reconcile({ root, dryRun: false });
      for (const [branch, id] of SHADOWED) {
        const written = readFileSync(
          join(root, "projects", "INF", "in-progress", `${id}-t.md`), "utf8");
        assert.match(written, new RegExp(`^branch: ${branch}$`, "m"));
        assert.doesNotMatch(written, /^branch: origin\//m);
      }
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("THE CONTROL: with no real branches, the origin-named ones alone corroborate nothing", async () => {
    // The upgrade rule must prefer an exact local head, not manufacture one. With the real
    // branches absent, the only refs carrying the ids are the stale shadows — no unique
    // commits, tip behind the default — and neither ticket may move.
    const tmp = mkdtempSync(join(tmpdir(), "blz492r2-control-"));
    const { root } = shadowedByOriginNamedLocalBranch(tmp, { withRealBranches: false });
    const restore = noPrBin(tmp);
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.changes, []);
      for (const [, id] of SHADOWED) {
        assert.ok(existsSync(join(root, "projects", "INF", "defined", `${id}-t.md`)));
      }
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
