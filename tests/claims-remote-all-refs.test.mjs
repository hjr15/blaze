// INF-682 — remoteMaxClaim must see ids claimed on UNMERGED remote branches.
//
// BLZ-136 turned a same-id collision from silent corruption into loud detection
// (O_EXCL reservation + a merge conflict on projects/<KEY>/.ids/<N>). It did not
// prevent it: `remoteMaxClaim` fetches `origin/main` only, so an id reserved on a
// branch that has not merged yet is still invisible at allocation time — which is
// precisely the scenario INF-682 was filed for, hit twice in one session on
// 2026-07-30.
//
// The no-network contract is load-bearing and must survive the widening:
//   null  = the remote could not be READ (offline, no remote)     -> provisional
//   0     = the remote WAS read and its claim ledger is empty     -> not provisional
// Never throws. Refusing to create tickets without a network is a worse
// regression than a collision caught loudly at merge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeClaim, remoteMaxClaim } from "../scripts/model/claims.mjs";

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "seed"), "s");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "seed"]);
  return dir;
}

function commitClaim(repo, key, n, slug, msg) {
  writeClaim(join(repo, "projects"), key, n, slug);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", msg]);
}

function cloneOf(origin, label) {
  const c = mkdtempSync(join(tmpdir(), `inf682-clone-${label}`));
  rmSync(c, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin, c]);
  return c;
}

test("INF-682: an id claimed on an UNMERGED remote branch is visible to remoteMaxClaim", () => {
  const origin = initRepo(mkdtempSync(join(tmpdir(), "inf682-origin-")));
  commitClaim(origin, "PROJ", 10, "on-main", "claim 10 on main");

  // A sister session reserves 99 on a branch that never merges to main.
  execFileSync("git", ["-C", origin, "checkout", "-q", "-b", "PROJ-99-sister-work"]);
  commitClaim(origin, "PROJ", 99, "on-branch", "claim 99 on an unmerged branch");
  execFileSync("git", ["-C", origin, "checkout", "-q", "main"]);

  const clone = cloneOf(origin, "inf682-cl-");
  assert.equal(
    remoteMaxClaim(clone, "PROJ"), 99,
    "a claim on an unmerged remote branch must still be seen — this is INF-682's exact scenario",
  );

  rmSync(clone, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

test("INF-682: the highest claim wins whichever ref it sits on", () => {
  const origin = initRepo(mkdtempSync(join(tmpdir(), "inf682-origin2-")));
  execFileSync("git", ["-C", origin, "checkout", "-q", "-b", "PROJ-5-early"]);
  commitClaim(origin, "PROJ", 5, "branch-low", "claim 5 on a branch");
  execFileSync("git", ["-C", origin, "checkout", "-q", "main"]);
  commitClaim(origin, "PROJ", 40, "main-high", "claim 40 on main");

  const clone = cloneOf(origin, "inf682-cl2-");
  assert.equal(remoteMaxClaim(clone, "PROJ"), 40, "main's higher claim must still win");

  rmSync(clone, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

test("INF-682: claims on main are still found when no other branch exists", () => {
  // Guards against a widening that accidentally stops reading the default branch.
  const origin = initRepo(mkdtempSync(join(tmpdir(), "inf682-origin3-")));
  commitClaim(origin, "PROJ", 4242, "published", "publish claim");

  const clone = cloneOf(origin, "inf682-cl3-");
  assert.equal(remoteMaxClaim(clone, "PROJ"), 4242);

  rmSync(clone, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

test("INF-682: the null-vs-0 contract survives the widening", () => {
  // 0 = reachable remote, empty ledger (normal for a new board) -> NOT provisional.
  const origin = initRepo(mkdtempSync(join(tmpdir(), "inf682-empty-origin-")));
  const clone = cloneOf(origin, "inf682-empty-cl-");
  assert.equal(remoteMaxClaim(clone, "PROJ"), 0,
    "a reachable remote with no claims is a known-empty set, not a failure");

  // null = could not be read at all -> caller marks the allocation provisional.
  const solo = initRepo(mkdtempSync(join(tmpdir(), "inf682-solo-")));
  assert.equal(remoteMaxClaim(solo, "PROJ"), null,
    "an unreachable remote must stay null so the caller can mark the claim provisional");

  rmSync(solo, { recursive: true, force: true });
  rmSync(clone, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

test("INF-682: never throws when the remote is unreachable", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "inf682-nothrow-")));
  execFileSync("git", ["-C", repo, "remote", "add", "origin",
    join(tmpdir(), "inf682-definitely-not-a-repo")]);
  assert.doesNotThrow(() => remoteMaxClaim(repo, "PROJ"));
  assert.equal(remoteMaxClaim(repo, "PROJ"), null);
  rmSync(repo, { recursive: true, force: true });
});
