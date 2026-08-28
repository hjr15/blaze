// INF-763 — reconcile must not report success after scanning nothing.
//
// `gatherRepo` returns an empty sentinel for a codeRepo path that isn't a git
// repo. With every path unresolvable (the worktree case) that produced a clean
// success and exit 0, having scanned zero repos — indistinguishable from a
// genuine no-op, and the reason a wrong board state looked correct for a whole
// session.
//
// BLZ-433: the sentence INF-763 quoted for that success — "already in sync —
// nothing to do." — is no longer anything the product emits. BLZ-404 round 5
// removed it as a claim about the whole board's git tree that reconcile cannot
// support; a clean pass now says "no code-bound change found — nothing to do."
// and this case exits 1 with "FAILED — none of the N configured codeRepo(s)
// could be read". What the test asserts is the OUTCOME, not that wording.
//
// Resolution is fixed separately (codeRepos now resolve against the main working
// tree). This is the belt-and-braces half: a misconfigured or missing repo must
// be REPORTED, not silently skipped, whatever the cause.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";

function board(codeRepos) {
  const tmp = mkdtempSync(join(tmpdir(), "inf763-rec-"));
  mkdirSync(join(tmp, "projects", "PROJ", "defined"), { recursive: true });
  writeFileSync(join(tmp, "projects", "PROJ", "project.json"), JSON.stringify({ codeRepos }));
  writeFileSync(join(tmp, "blaze.config.json"),
    JSON.stringify({ key: "PROJ", projects: ["PROJ"], codeRepos: [] }));
  writeFileSync(join(tmp, "projects", "PROJ", "defined", "PROJ-1-x.md"),
    "---\nid: PROJ-1\ntype: task\nstatus: defined\nproject: PROJ\nestimate: 30\n---\n\nbody\n");
  return tmp;
}

test("INF-763: reconcile reports codeRepos it could not resolve", async () => {
  const root = board([join(tmpdir(), "inf763-definitely-not-here")]);
  try {
    const r = await reconcile({ root, projectsDir: join(root, "projects"), dryRun: true });
    assert.ok(Array.isArray(r.missingRepos), "reconcile must report unresolvable repos");
    assert.equal(r.missingRepos.length, 1, "the one bad path must be named, not silently skipped");
    assert.match(r.missingRepos[0], /inf763-definitely-not-here/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INF-763: reconcile counts how many repos it actually scanned", async () => {
  const root = board([join(tmpdir(), "inf763-nope-a"), join(tmpdir(), "inf763-nope-b")]);
  try {
    const r = await reconcile({ root, projectsDir: join(root, "projects"), dryRun: true });
    assert.equal(r.scannedRepos, 0, "zero repos were readable — that must be visible to the caller");
    assert.equal(r.configuredRepos, 2, "two were configured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("INF-763: a readable repo is counted as scanned and not reported missing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "inf763-ok-"));
  const repo = join(tmp, "svc");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "seed"), "s");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "seed"]);

  const root = board([repo]);
  try {
    const r = await reconcile({ root, projectsDir: join(root, "projects"), dryRun: true });
    assert.deepEqual(r.missingRepos, [], "a real repo must not be reported missing");
    assert.equal(r.scannedRepos, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("INF-763: a board with no codeRepos configured is not treated as a failure", async () => {
  // Legitimately empty — must stay distinguishable from "configured but all broken".
  const root = board([]);
  try {
    const r = await reconcile({ root, projectsDir: join(root, "projects"), dryRun: true });
    assert.equal(r.configuredRepos, 0);
    assert.deepEqual(r.missingRepos, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
