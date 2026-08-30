// tests/commit-four-working-copies.test.mjs — BLZ-556 acceptance: the design is proven
// against the condition that was actually measured, not a single-worktree synthetic.
//
// The operator's board on 2026-08-30, counted three times independently and re-counted at
// the close of this work:
//
//   blaze-pm    (main checkout, on a feature branch, the ONLY store the flush mounts)  19 ops
//   v4-spine    (worktree, on BLZ-305-v4-spine)                                       185 ops
//   v3-phase0   (worktree, on v3)                                                       6 ops
//   board-main  (worktree, permanently on main)                                          0 ops
//                                                                                 total 210
//
// This fixture reproduces that topology and those exact op counts, with each lane's files
// existing only in its own checkout — which is what made the naive shared store dangerous.
// It asserts the three things the ticket asks for:
//
//   1. one store: all 210 ops are visible from every working copy, including the flush's
//   2. the refuted alternative stays refuted: a flush from `board-main` cannot be green
//   3. the ops are reachable from the lane that owns them, and only from there
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, readEntries, listQueues } from "../scripts/pending-ledger.mjs";

const REPO = join(import.meta.dirname, "..");
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

// The four working copies, with the live board's branches. The main checkout sits on a
// feature branch exactly as `blaze-pm` does — it is NOT the one on `main`.
const LANES = [
  { dir: "v4-spine", branch: "BLZ-305-v4-spine", ops: 185 },
  { dir: "v3-phase0", branch: "v3", ops: 6 },
  { dir: "board-main", branch: "main", ops: 0 },
];
const MAIN_BRANCH = "BLZ-143-engineering-method-and-work-item-model";

function board() {
  // The mkdtempSync prefix is a LITERAL at the call site (BLZ-491).
  const root = mkdtempSync(join(tmpdir(), "blaze-fourcopies-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "projects", "BLZ", "defined", "BLZ-1.md"), "seed\n");
  git(root, "add", "--", "projects");
  git(root, "commit", "-q", "-m", "seed");
  // `main` must stay available for the board-main worktree, so the main checkout moves to
  // its own feature branch first — the live board's shape.
  git(root, "checkout", "-q", "-b", MAIN_BRANCH);
  return root;
}

const runCommit = (main, where, args) => {
  const env = { ...process.env, BLAZE_SESSION: "s1" };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [join(main, "scripts", "commit-runner.mjs"), ...args],
    { cwd: where, env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
};

/** Queue `n` ops recorded against `branch`, touching files that exist only in `where`. */
function queueInto(store, where, branch, n, tag) {
  for (let i = 0; i < n; i += 1) {
    const rel = join("projects", "BLZ", "defined", `${tag}-${i % 3}.md`);
    writeFileSync(join(where, rel), `${tag} ${i}\n`);
    appendEntry(store, { id: `BLZ-${tag}-${i}`, op: "edit", message: `BLZ-${tag}-${i}: edit`,
      files: [rel], ts: "2026-08-30T00:00:00.000Z", branch }, "s1");
  }
}

test("BLZ-556 acceptance: 210 ops across four working copies are ONE store, and no flush can be green while it does not reach them", () => {
  const main = board();
  const dirs = {};
  try {
    for (const l of LANES) {
      dirs[l.dir] = join(dirname(main), `blaze-fourcopies-${l.dir}-${process.pid}-${Math.random().toString(36).slice(2)}`);
      // A new branch off `main` for the feature lanes; `board-main` checks out `main` itself.
      git(main, "worktree", "add", "-q", ...(l.branch === "main"
        ? [dirs[l.dir], "main"]
        : ["-b", l.branch, dirs[l.dir], "main"]));
    }
    // Every op is queued through the SHARED store, from the working copy that owns it.
    queueInto(main, main, MAIN_BRANCH, 19, "pm");
    for (const l of LANES) queueInto(dirs[l.dir], dirs[l.dir], l.branch, l.ops, l.dir);

    // 1. ONE store. Every working copy — the flush's included — sees all 210.
    for (const where of [main, ...Object.values(dirs)]) {
      const total = listQueues(where).reduce((n, q) => n + readEntries(where, q.session).length, 0);
      assert.equal(total, 210, `all 210 ops are visible from ${where}`);
    }
    assert.equal(readEntries(main, "s1").length, 210, "in one queue file, in the main checkout");

    // 2. THE REFUTED ALTERNATIVE, still refuted. `board-main` holds 0 ops of its own. Before
    //    BLZ-556 a flush pointed here exited 0 green having flushed nothing. It cannot now.
    const fromBoardMain = runCommit(main, dirs["board-main"], ["--all"]);
    assert.equal(fromBoardMain.status, 3, `board-main must not be green: ${fromBoardMain.stdout}${fromBoardMain.stderr}`);
    assert.doesNotMatch(fromBoardMain.stdout, /nothing to flush/);
    assert.match(fromBoardMain.stderr, /210 op\(s\)/, "and it says how many it did not reach");
    assert.equal(readEntries(main, "s1").length, 210, "having cleared nothing");

    // 3. Each lane's ops are reachable — from the lane that owns them, and only there.
    const fromSpine = runCommit(main, dirs["v4-spine"], ["--all"]);
    assert.equal(fromSpine.status, 3, `${fromSpine.stdout}${fromSpine.stderr}`);
    assert.match(fromSpine.stdout, /flushed 185 op\(s\)/, "the 185 stranded ops flush from their own worktree");
    assert.match(fromSpine.stderr, /25 op\(s\)/, "and the remaining 19 + 6 are named, not swallowed");
    assert.equal(readEntries(main, "s1").length, 25);
    assert.match(git(dirs["v4-spine"], "log", "-1", "--format=%s"), /board update/);

    const fromMain = runCommit(main, main, ["--all"]);
    assert.equal(fromMain.status, 3, `${fromMain.stdout}${fromMain.stderr}`);
    assert.match(fromMain.stdout, /flushed 19 op\(s\)/);
    assert.deepEqual([...new Set(readEntries(main, "s1").map((e) => e.branch))], ["v3"],
      "only v3-phase0's 6 remain, and they are still exactly where they were queued");
    assert.equal(readEntries(main, "s1").length, 6);

    const fromV3 = runCommit(main, dirs["v3-phase0"], ["--all"]);
    assert.equal(fromV3.status, 0, `the last lane drains the store and IS green: ${fromV3.stderr}`);
    assert.match(fromV3.stdout, /flushed 6 op\(s\)/);
    assert.deepEqual(readEntries(main, "s1"), [], "210 ops, all published, none destroyed");
    assert.deepEqual(listQueues(main), [], "and the emptied queue is removed, not left behind");
  } finally {
    for (const d of Object.values(dirs)) rmSync(d, { recursive: true, force: true });
    rmSync(main, { recursive: true, force: true });
  }
});
