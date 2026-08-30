// tests/reconcile-refname-namespace.test.mjs — BLZ-506.
//
// `git` permits a LOCAL branch literally named `origin/x` — `refs/heads/origin/x` — and
// `for-each-ref --format=%(refname:short)` renders it and `refs/remotes/origin/x` as the
// SAME STRING. `gatherRepo` then stripped `origin/` from that string, so two different refs
// arrived as one name, and the ref the probes were actually asked about (`origin/x`) is
// ambiguous to `git`, which resolves it under `refs/heads` first — the STALE local head.
//
// BLZ-492 fixed the ORDERING symptom (an exact local head outranks a stripped collision for
// the same name) and stated this residual rather than implying it fixed. This file is the
// residual: the namespace split, done on `%(refname)` — the full ref path, which is
// unambiguous both as a name and as a revision.
//
// Two shapes, and they fail in opposite directions:
//
//   1. A stale `refs/heads/origin/task/INF-1-work` shadowing a real
//      `refs/remotes/origin/task/INF-1-work`. The stale head answers the probe, has no
//      commit claiming INF-1 and is not at the default tip, so the REAL branch's own
//      evidence is never read and INF-1 silently stops corroborating.
//   2. A lone `refs/heads/origin/INF-2-shadow` with no remote-tracking twin. Here the probe
//      resolves correctly by accident, and it is the NAME that is wrong: `origin/` is
//      stripped, so reconcile records `branch: INF-2-shadow` — a branch that does not
//      exist in this repository at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const gitStatus = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).status;

/** An upstream carrying `task/INF-1-work`, a clone that holds it only as a remote-tracking
 *  ref, and — when `shadow` is set — a stale LOCAL head called `origin/task/INF-1-work`
 *  beside it. The stale head carries its own commit that claims nothing and is NOT at the
 *  default tip, so if it is the ref that answers, nothing corroborates INF-1. */
function board(tmp, { shadow = true, lone = false, shadowFresh = false, both = false } = {}) {
  const upstream = join(tmp, "upstream");
  mkdirSync(upstream, { recursive: true });
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) git(upstream, ...a);
  writeFileSync(join(upstream, "README.md"), "x\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "seed");
  git(upstream, "checkout", "-q", "-b", "task/INF-1-work");
  writeFileSync(join(upstream, "a.txt"), "a\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "INF-1: the work this branch actually carries");
  git(upstream, "checkout", "-q", "main");

  const repo = join(tmp, "repo-INF");
  execFileSync("git", ["clone", "-q", upstream, repo]);
  for (const a of [["config", "user.email", "t@t.t"], ["config", "user.name", "t"]]) git(repo, ...a);

  if (shadow) {
    // A stale local head under the `origin/` name, with a commit of its own that claims
    // nothing. `git checkout -b` on a slash-name is ordinary; nothing stops this existing.
    git(repo, "checkout", "-q", "-b", "origin/task/INF-1-work");
    writeFileSync(join(repo, "stale.txt"), "stale\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "wip: a stale local branch that claims no ticket");
    git(repo, "checkout", "-q", "main");
  }
  if (shadowFresh) {
    // The same shadow, but FRESH: no commits of its own and its tip IS the default tip, so
    // `sameTipAsDefault` corroborates it on its own terms. This is the shape where ordering
    // decides the outcome — the shadow does not merely fail to answer, it WINS.
    git(repo, "branch", "origin/task/INF-1-work");
  }
  if (both) {
    // A branch that exists in BOTH namespaces and whose two tips differ — the ordinary
    // state of a checkout with a local commit not yet pushed. Only the LOCAL tip carries
    // the commit that claims INF-2, so which of the two `inspect` reads decides whether the
    // ticket corroborates at all.
    git(upstream, "checkout", "-q", "-b", "INF-2-both");
    writeFileSync(join(upstream, "b.txt"), "b\n");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "chore: an earlier tip that claims nothing");
    git(upstream, "checkout", "-q", "main");
    git(repo, "fetch", "-q", "origin");
    git(repo, "checkout", "-q", "-b", "INF-2-both", "origin/INF-2-both");
    writeFileSync(join(repo, "b2.txt"), "b2\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "INF-2: the local commit that is not pushed yet");
    git(repo, "checkout", "-q", "main");
  }
  if (lone) {
    // No remote-tracking twin. Its own commit claims INF-2, so it corroborates on its own
    // evidence and the only question left is what it is CALLED.
    git(repo, "checkout", "-q", "-b", "origin/INF-2-shadow");
    writeFileSync(join(repo, "lone.txt"), "lone\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "INF-2: the work on the oddly named branch");
    git(repo, "checkout", "-q", "main");
  }

  const root = join(tmp, "board");
  const dir = join(root, "projects", "INF", "defined");
  mkdirSync(dir, { recursive: true });
  for (const n of [1, 2]) {
    writeFileSync(join(dir, `INF-${n}-t.md`),
      `---\nid: INF-${n}\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n`);
  }
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"] }));
  return { root, repo };
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

/** Where a ticket landed, and the text it landed with. */
function read(root, id) {
  const projectDir = join(root, "projects", "INF");
  for (const st of readdirSync(projectDir)) {
    try { return { status: st, text: readFileSync(join(projectDir, st, `${id}-t.md`), "utf8") }; }
    catch { /* not here */ }
  }
  return { status: null, text: null };
}

describe("BLZ-506: refs/heads/origin/x and refs/remotes/origin/x are two refs, not one name", () => {
  test("the construction is what it claims: one name, two refs, and git prefers the local head", () => {
    // Ground truth from git, not from reconcile. Without this every test below could be
    // passing on a repository that never had the ambiguity in it.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz506-shape-"));
    try {
      const { repo } = board(tmp);
      const short = git(repo, "for-each-ref", "--format=%(refname:short)",
        "refs/heads", "refs/remotes/origin").split("\n").filter(Boolean);
      const full = git(repo, "for-each-ref", "--format=%(refname)",
        "refs/heads", "refs/remotes/origin").split("\n").filter(Boolean);
      assert.ok(full.includes("refs/heads/origin/task/INF-1-work"));
      assert.ok(full.includes("refs/remotes/origin/task/INF-1-work"));

      // THE PREMISE THE TICKET STATED, CORRECTED. `%(refname:short)` does not render the
      // two identically: `shorten_unambiguous_ref` disambiguates them the moment both
      // exist. What it does instead is worse, because it is CONTEXT-DEPENDENT — the same
      // ref renders differently depending on which OTHER refs are present, so the `origin/`
      // strip is a text rule applied to a spelling that moves under it.
      assert.ok(short.includes("heads/origin/task/INF-1-work"),
        "the local head renders with a `heads/` prefix once the remote-tracking twin exists");
      assert.ok(short.includes("remotes/origin/task/INF-1-work"),
        "and the remote-tracking ref, which alone would render `origin/task/INF-1-work`, "
        + "renders with a `remotes/` prefix");
      assert.equal(short.includes("origin/task/INF-1-work"), false,
        "so NEITHER of them renders as the branch's name, and stripping `origin/` from "
        + "either spelling produces a name no ref in this repository answers to");

      // …and asked by the name a person would use, git answers with the LOCAL head.
      assert.equal(git(repo, "rev-parse", "origin/task/INF-1-work"),
        git(repo, "rev-parse", "refs/heads/origin/task/INF-1-work"),
        "git resolves refs/heads first — the stale branch is what an ambiguous ask reads");
      assert.notEqual(git(repo, "rev-parse", "refs/heads/origin/task/INF-1-work"),
        git(repo, "rev-parse", "refs/remotes/origin/task/INF-1-work"),
        "the two refs must point at different commits, or the shadow costs nothing");
      // The id must be unavailable from the shipped set, or something other than the branch
      // signal moves the ticket and this file proves nothing.
      assert.doesNotMatch(git(repo, "log", "origin/main", "--format=%s"), /INF-\d/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("PREMISE: with no shadow beside it, the remote-only branch corroborates INF-1", async () => {
    // The control for the test below. Without it, "INF-1 moved" could be passing for a
    // reason that has nothing to do with which ref answered.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz506-premise-"));
    const restore = noPrBin(tmp);
    try {
      const { root } = board(tmp, { shadow: false });
      await reconcile({ root, dryRun: false });
      const t = read(root, "INF-1");
      assert.equal(t.status, "in-progress");
      assert.match(t.text, /^branch: task\/INF-1-work$/m);
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a stale local head named origin/<x> does not answer for the remote-tracking origin/<x>", async () => {
    // The regression BLZ-492's round-2 review found and could only partly close: the stale
    // head captured the probe, `own: []` came back, and INF-1 silently stopped
    // corroborating with `ok: true` and no gitErrors at all.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz506-shadowed-"));
    const restore = noPrBin(tmp);
    try {
      const { root } = board(tmp, { shadow: true });
      const r = await reconcile({ root, dryRun: false });
      assert.equal(r.ok, true);
      const t = read(root, "INF-1");
      assert.equal(t.status, "in-progress",
        "the real branch's own commit claims INF-1; a stale namesake must not hide it");
      assert.match(t.text, /^branch: task\/INF-1-work$/m,
        "and the record must name the branch that carries the work");
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a local head named origin/<x> is recorded under the name it actually has", async () => {
    // The other direction. Here the probe resolved correctly by accident — there is no
    // remote-tracking twin — and it is the NAME that was wrong: stripping `origin/` wrote
    // `branch: INF-2-shadow`, naming a branch this repository does not contain.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz506-lone-"));
    const restore = noPrBin(tmp);
    try {
      const { root, repo } = board(tmp, { shadow: false, lone: true });
      await reconcile({ root, dryRun: false });
      const t = read(root, "INF-2");
      assert.equal(t.status, "in-progress");
      assert.match(t.text, /^branch: origin\/INF-2-shadow$/m,
        "the branch is called `origin/INF-2-shadow`; that is what a delivery record must say");
      assert.equal(gitStatus(repo, "rev-parse", "--verify", "refs/heads/INF-2-shadow"), 128,
        "…and `INF-2-shadow` is a name nothing in this repository answers to");
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });
  test("a FRESH shadow does not take the slot from the branch that carries the work", async () => {
    // The case that would pass by accident. In the two tests above the shadow simply fails
    // to corroborate, so `buildBranchMap` falls through to the real branch whatever order
    // the refs arrived in — which means neither of them holds the ORDERING rule. Here the
    // shadow is fresh: `sameTipAsDefault` is true, it corroborates on its own terms, and
    // `refs/heads/origin/task/…` sorts before every `refs/remotes/…`. Without ordinary
    // branches being taken before the `refs/heads/origin/*` namespace, the record becomes
    // `branch: origin/task/INF-1-work` and the branch carrying INF-1's actual work loses.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz506-fresh-"));
    const restore = noPrBin(tmp);
    try {
      const { root, repo } = board(tmp, { shadow: false, shadowFresh: true });
      assert.equal(git(repo, "rev-parse", "refs/heads/origin/task/INF-1-work"),
        git(repo, "rev-parse", "refs/remotes/origin/main"),
        "the shadow must be at the default tip, or it is not the fresh case");
      await reconcile({ root, dryRun: false });
      const t = read(root, "INF-1");
      assert.equal(t.status, "in-progress");
      assert.match(t.text, /^branch: task\/INF-1-work$/m,
        "an ordinary branch outranks a `refs/heads/origin/*` namesake for the same id");
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });
  test("a branch that exists locally AND on the remote is read through the LOCAL ref", async () => {
    // `refs/heads/<n>` and `refs/remotes/origin/<n>` are ONE branch and must produce one
    // name — but the two tips differ the moment a commit is unpushed, so which ref answers
    // decides what the branch is taken to have done. The local head is the working truth;
    // reading the remote-tracking tip instead loses every unpushed commit's claim.
    //
    // This rule was previously enforced only by `for-each-ref`'s sort order, which puts
    // `refs/heads/…` before `refs/remotes/…` — the exact ground BLZ-492's round-2 review
    // showed to be unsafe, and nothing in the suite held it. It is a rank now, and this is
    // the test that kills a swap of ranks 0 and 1.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz506-both-"));
    const restore = noPrBin(tmp);
    try {
      const { root, repo } = board(tmp, { shadow: false, both: true });
      assert.notEqual(git(repo, "rev-parse", "refs/heads/INF-2-both"),
        git(repo, "rev-parse", "refs/remotes/origin/INF-2-both"),
        "the two tips must differ, or reading either one costs nothing");
      await reconcile({ root, dryRun: false });
      const t = read(root, "INF-2");
      assert.equal(t.status, "in-progress",
        "the LOCAL tip carries the commit claiming INF-2; the remote tip does not");
      assert.match(t.text, /^branch: INF-2-both$/m,
        "…and the branch is recorded once, under its name, not twice under two spellings");
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });
});
