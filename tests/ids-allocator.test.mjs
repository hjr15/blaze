// tests/ids-allocator.test.mjs — BLZ-136 / ADR-0005, the three-layer allocator.
//
// Covers acceptance criteria ①–⑤: a fresh clone allocates above the true disk
// max; concurrent worktrees never collide; a same-id claim conflicts while
// different ids do not; claims survive squash-merge + branch-delete; offline
// behaviour is specified rather than accidental.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../scripts/model/index.mjs";
import { maxId } from "../scripts/model/ids.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-alloc-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ", "defined"), { recursive: true });
  mkdirSync(join(projects, "PROJ", ".ids"), { recursive: true });
  return { root, projects };
}

function ticket(projects, status, name, id) {
  const dir = join(projects, "PROJ", status);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name),
    `---\nid: ${id}\ntitle: t\ntype: task\nproject: PROJ\npriority: medium\n---\nbody\n`);
}

// The walkers previously skipped claim files only because those files have no
// .md extension — an accident, not a guard. These fixtures deliberately USE a
// .md suffix inside .ids/ so they fail unless the dot-dir rule is explicit.
test("BLZ-136: dot-directories are excluded from the ticket walk explicitly", () => {
  const { root, projects } = board();
  ticket(projects, "defined", "PROJ-1-real.md", "PROJ-1");
  writeFileSync(join(projects, "PROJ", ".ids", "2.md"), "not a ticket\n");
  const idx = buildIndex(projects);
  assert.equal(idx.count(), 1, "only the real ticket may be indexed");
  assert.deepEqual(idx.rows.map((r) => r.id), ["PROJ-1"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: maxId ignores dot-directories", () => {
  const { root, projects } = board();
  ticket(projects, "defined", "PROJ-3-real.md", "PROJ-3");
  writeFileSync(join(projects, "PROJ", ".ids", "PROJ-99.md"), "decoy\n");
  assert.equal(maxId(projects, "PROJ"), 3, "a dot-dir decoy must not raise the max");
  rmSync(root, { recursive: true, force: true });
});

import { execFileSync } from "node:child_process";
import { commonDirFor } from "../scripts/model/git-common.mjs";

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

test("BLZ-136: commonDirFor returns an absolute shared .git for a repo", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "blaze-gc-")));
  const cd = commonDirFor(repo);
  assert.ok(cd.startsWith("/"), `expected absolute path, got ${cd}`);
  assert.equal(existsSync(cd), true);
  rmSync(repo, { recursive: true, force: true });
});

test("BLZ-136: a linked worktree resolves to the SAME common dir as its main checkout", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "blaze-gc-")));
  const wt = mkdtempSync(join(tmpdir(), "blaze-gc-wt-"));
  rmSync(wt, { recursive: true, force: true });
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "feat"]);
  assert.equal(commonDirFor(wt), commonDirFor(repo),
    "worktree and main checkout must share one reservation namespace");
  rmSync(wt, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

// The silent-misresolution hole: `git -C <dir> rev-parse` succeeds for ANY
// ancestor repo, so a non-repo dataRoot nested under an unrelated repo resolves
// that repo's .git with exit 0. Two sessions would then reserve in different
// namespaces, never contend, and collide on one machine.
test("BLZ-136: a non-board dataRoot under an unrelated repo FAILS LOUD, not silently", () => {
  const outer = initRepo(mkdtempSync(join(tmpdir(), "blaze-gc-outer-")));
  const nested = join(outer, "unrelated", "board");
  mkdirSync(nested, { recursive: true });
  assert.throws(() => commonDirFor(nested), /blaze:/);
  rmSync(outer, { recursive: true, force: true });
});

import { readFileSync } from "node:fs";
import { claimPath, writeClaim, maxClaim, claimedNumbers } from "../scripts/model/claims.mjs";

test("BLZ-136: writeClaim records id + slug so a same-id collision differs in CONTENT", () => {
  const { root, projects } = board();
  const p = writeClaim(projects, "PROJ", 7, "wire-the-gateway");
  assert.equal(p, claimPath(projects, "PROJ", 7));
  const body = readFileSync(p, "utf8");
  assert.match(body, /PROJ-7/);
  assert.match(body, /wire-the-gateway/);
  assert.doesNotMatch(body, /provisional/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: a provisional claim is marked, so a stale-view allocation is identifiable", () => {
  const { root, projects } = board();
  const p = writeClaim(projects, "PROJ", 8, "slug", { provisional: true });
  assert.match(readFileSync(p, "utf8"), /provisional/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: maxClaim and claimedNumbers read the claim set", () => {
  const { root, projects } = board();
  assert.equal(maxClaim(projects, "PROJ"), 0, "empty claim set is 0");
  writeClaim(projects, "PROJ", 3, "a");
  writeClaim(projects, "PROJ", 11, "b");
  assert.equal(maxClaim(projects, "PROJ"), 11);
  assert.deepEqual([...claimedNumbers(projects, "PROJ")].sort((x, y) => x - y), [3, 11]);
  rmSync(root, { recursive: true, force: true });
});
