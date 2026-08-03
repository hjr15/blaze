// INF-763 — relative `codeRepos` must resolve against the repo's MAIN working
// tree, not the worktree the command happened to run from.
//
// `codeRepos` are stored relative (`../service-platform`, …) and resolved against
// the board root the command ran from. Run from a linked worktree and every path
// resolves to a sibling of the WORKTREE, which does not exist — so `gatherRepo`
// returns its empty sentinel for each, and `reconcile` prints
// "already in sync — nothing to do" with exit 0, having scanned zero repos.
//
// That is indistinguishable from a genuine no-op, and the documented INF-673
// workaround ("run blaze from the board-main worktree") walks straight into it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadProject } from "../scripts/config.mjs";

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

// Reproduces the real layout: the worktree lives under a DIFFERENT parent than
// the main checkout, so `../svc` from the worktree is a genuinely missing path.
//
//   <tmp>/board/          main working tree (has projects/)
//   <tmp>/svc/            the codeRepo, a sibling of the MAIN tree
//   <tmp>/wt/board-main/  linked worktree — `../svc` here is <tmp>/wt/svc (missing)
function makeFixture() {
  const tmp = mkdtempSync(join(tmpdir(), "inf763-"));
  const board = join(tmp, "board");
  const svc = join(tmp, "svc");
  const wtParent = join(tmp, "wt");
  const wt = join(wtParent, "board-main");

  mkdirSync(svc, { recursive: true });
  execFileSync("git", ["-C", svc, "init", "-q", "-b", "main"]);

  mkdirSync(join(board, "projects", "PROJ", "defined"), { recursive: true });
  writeFileSync(join(board, "projects", "PROJ", "project.json"),
    JSON.stringify({ codeRepos: ["../svc"] }));
  writeFileSync(join(board, "blaze.config.json"),
    JSON.stringify({ key: "PROJ", projects: ["PROJ"], codeRepos: [] }));
  execFileSync("git", ["-C", board, "init", "-q", "-b", "main"]);
  git(board, "config", "user.email", "t@t.t");
  git(board, "config", "user.name", "t");
  git(board, "add", "-A");
  git(board, "commit", "-qm", "seed");

  mkdirSync(wtParent, { recursive: true });
  git(board, "worktree", "add", "-q", wt, "-b", "board-main-wt");

  return { tmp, board, svc, wt };
}

test("INF-763: relative codeRepos resolve to the MAIN working tree's siblings, not the worktree's", () => {
  const { tmp, board, svc, wt } = makeFixture();
  try {
    // Sanity: the fixture really does reproduce the trap.
    assert.equal(
      require$missing(join(tmp, "wt", "svc")), true,
      "fixture invalid — the worktree's sibling must NOT exist for this to be the real bug",
    );

    const fromWorktree = loadProject("PROJ", { root: wt, projectsDir: join(wt, "projects") });
    assert.deepEqual(
      fromWorktree.codeRepoPaths, [svc],
      "a codeRepo must resolve to the main tree's sibling even when invoked from a worktree",
    );

    // And the main checkout must be unaffected.
    const fromMain = loadProject("PROJ", { root: board, projectsDir: join(board, "projects") });
    assert.deepEqual(fromMain.codeRepoPaths, [svc]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("INF-763: an absolute codeRepo path is untouched from a worktree", () => {
  const { tmp, svc, wt } = makeFixture();
  try {
    // Written into the WORKTREE's own tree — loadProject reads projectsDir, and a
    // commit in the main tree does not update a linked worktree's working files.
    writeFileSync(join(wt, "projects", "PROJ", "project.json"),
      JSON.stringify({ codeRepos: [svc] }));
    const p = loadProject("PROJ", { root: wt, projectsDir: join(wt, "projects") });
    assert.deepEqual(p.codeRepoPaths, [svc], "absolute paths must pass through unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("INF-763: a non-git board root still resolves relative to itself", () => {
  // Packaged/no-git installs must not regress just because `git rev-parse` fails.
  const tmp = mkdtempSync(join(tmpdir(), "inf763-nogit-"));
  try {
    const board = join(tmp, "board");
    mkdirSync(join(board, "projects", "PROJ"), { recursive: true });
    writeFileSync(join(board, "projects", "PROJ", "project.json"),
      JSON.stringify({ codeRepos: ["../svc"] }));
    writeFileSync(join(board, "blaze.config.json"),
      JSON.stringify({ key: "PROJ", projects: ["PROJ"] }));
    const p = loadProject("PROJ", { root: board, projectsDir: join(board, "projects") });
    assert.deepEqual(p.codeRepoPaths, [join(tmp, "svc")],
      "with no git repo the old relative-to-root behaviour must stand");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// tiny helper kept local so the test file has no extra imports
function require$missing(p) {
  try { execFileSync("test", ["-e", p]); return false; } catch { return true; }
}
