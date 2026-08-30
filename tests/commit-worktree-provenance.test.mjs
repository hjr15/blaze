// tests/commit-worktree-provenance.test.mjs — BLZ-556, the other half.
//
// Sharing ONE queue store across every worktree of a repo is the fix for the 210-op
// scatter. It is also, on its own, a way to destroy 191 of those ops: an op queued in
// worktree W records paths that exist in W's checkout and nowhere else, so a flush
// running in the MAIN checkout stages almost nothing for them (`commit-runner` drops a
// path that is neither on disk nor tracked) and then clears the ledger.
//
// Measured on the operator's board, 2026-08-30: of the 186 distinct paths recorded by
// v4-spine's 185 ops, 4 exist in the main checkout; of v3-phase0's 2, none do.
//
// INF-673's `checkBranch` does NOT catch this — it returns ok the moment the checkout is
// on the default branch, without reading a single entry's provenance. So the drain itself
// has to be provenance-aware, and a flush that leaves ops behind must not exit 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync, chmodSync, accessSync, readdirSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, readEntries, listQueues, queueRoot } from "../scripts/pending-ledger.mjs";
import { commitOrQueue } from "../scripts/commit-or-queue.mjs";
import { acquireLock, releaseLock, lockPath } from "../scripts/commit-lock.mjs";

const REPO = join(import.meta.dirname, "..");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A board repo whose `projects/` is COMMITTED, so a linked worktree gets one too and
 *  `resolveRoots` resolves the worktree as its own data root. The mkdtempSync prefix is a
 *  LITERAL at the call site (BLZ-491). */
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-provenance-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "projects", "ZZZ", "defined"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "projects", "ZZZ", "defined", "ZZZ-1.md"), "seed\n");
  git(root, "add", "--", "projects");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

function lane(main, name) {
  const wt = join(dirname(main), `blaze-provenance-lane-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  git(main, "worktree", "add", "-q", "-b", name, wt);
  return wt;
}

/** Run the MAIN tree's runner with cwd set to `where`; resolveRoots picks `where` up as the
 *  data root because it has projects/. That is exactly how the operator invokes it. */
function runCommit(main, where, args = [], session = "s1") {
  const env = { ...process.env, BLAZE_SESSION: session };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [join(main, "scripts", "commit-runner.mjs"), ...args],
    { cwd: where, env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const cleanup = (...p) => { for (const x of p) rmSync(x, { recursive: true, force: true }); };
const op = (over) => ({ id: "ZZZ-1", op: "edit", message: "ZZZ-1: edit", files: ["projects/ZZZ/defined/ZZZ-1.md"], ts: "t", ...over });

// ---------------------------------------------------------------------------
// T1 — the destruction this prevents, constructed end to end.
// Pins commit-runner.mjs's provenance partition. Revert it (drain every entry) and this
// fails on the surviving-op assertion: the foreign op is committed-and-cleared instead.
// ---------------------------------------------------------------------------
test("BLZ-556: a flush commits only the ops queued in ITS working tree and leaves the rest in the store", () => {
  const main = board();
  const wt = lane(main, "lane-x");
  try {
    // A file that exists ONLY in the worktree — the shape of the live board's 185 ops.
    writeFileSync(join(wt, "projects", "ZZZ", "defined", "ZZZ-2.md"), "only in the lane\n");
    appendEntry(main, op({ id: "ZZZ-1", branch: "main" }), "s1");
    appendEntry(main, op({ id: "ZZZ-2", branch: "lane-x", files: ["projects/ZZZ/defined/ZZZ-2.md"] }), "s1");
    writeFileSync(join(main, "projects", "ZZZ", "defined", "ZZZ-1.md"), "edited on main\n");

    const r = runCommit(main, main, ["--all"]);
    assert.equal(r.status, 3, `flush must not report success while ops remain: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /flushed 1 op/);

    const left = readEntries(main, "s1");
    assert.deepEqual(left.map((e) => e.id), ["ZZZ-2"], "the lane's op survives, byte-for-byte");
    assert.equal(left[0].branch, "lane-x");
    assert.match(r.stderr, /lane-x/, "and the flush names where the unreached op belongs");
    assert.match(git(main, "log", "-1", "--name-only", "--format="), /ZZZ-1\.md/);
    assert.doesNotMatch(git(main, "log", "-1", "--name-only", "--format="), /ZZZ-2\.md/);
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T2 — the case that would otherwise pass by accident: NOTHING of the caller's own.
// Before the fix the runner printed "nothing to flush" and exited 0 here, which is the
// exact false-green the ticket is about.
// ---------------------------------------------------------------------------
test("BLZ-556: a flush with only other working trees' ops does not report `nothing to flush` and exit 0", () => {
  const main = board();
  const wt = lane(main, "lane-y");
  try {
    appendEntry(main, op({ id: "ZZZ-3", branch: "lane-y" }), "s1");
    const r = runCommit(main, main, ["--all"]);
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /nothing to flush/);
    assert.match(r.stderr, /1 op/);
    assert.deepEqual(readEntries(main, "s1").map((e) => e.id), ["ZZZ-3"], "and nothing was cleared");
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T3 — the ops ARE reachable, from the tree that owns them. The fix must not merely
// refuse everywhere; the 185 ops have somewhere to go.
// ---------------------------------------------------------------------------
test("BLZ-556: the same shared store, flushed from the lane that queued them, commits them there", () => {
  const main = board();
  const wt = lane(main, "lane-z");
  try {
    writeFileSync(join(wt, "projects", "ZZZ", "defined", "ZZZ-4.md"), "lane work\n");
    appendEntry(wt, op({ id: "ZZZ-4", branch: "lane-z", files: ["projects/ZZZ/defined/ZZZ-4.md"] }), "s1");
    assert.ok(existsSync(join(main, ".blaze", "pending", "s1.jsonl")), "queued into the SHARED store");

    const r = runCommit(main, wt, ["--all"]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /flushed 1 op/);
    assert.deepEqual(readEntries(wt, "s1"), []);
    assert.match(git(wt, "log", "-1", "--name-only", "--format="), /ZZZ-4\.md/);
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T4 — MIGRATION. 210 ops sat in four stores when the store moved. The engine must not
// go quiet about the ones nobody has copied across yet, and must not touch them.
// ---------------------------------------------------------------------------
test("BLZ-556: an un-migrated per-worktree store is refused loudly and left byte-for-byte intact", () => {
  const main = board();
  const wt = lane(main, "lane-w");
  try {
    mkdirSync(join(wt, ".blaze", "pending"), { recursive: true });
    const body = `${JSON.stringify(op({ id: "ZZZ-5" }))}\n`;
    writeFileSync(join(wt, ".blaze", "pending", "legacy.jsonl"), body);

    const r = runCommit(main, wt, ["--all"]);
    assert.notEqual(r.status, 0, "a store the engine can see but no longer drains is not success");
    assert.match(r.stderr, /legacy/, "the stranded queue is named");
    assert.match(r.stderr, /1 op/);
    assert.equal(readFileSync(join(wt, ".blaze", "pending", "legacy.jsonl"), "utf8"), body,
      "and the engine moved, merged and deleted exactly nothing");
  } finally { cleanup(main, wt); }
});

test("BLZ-556: --status names the shared store and reports every working tree's ops from anywhere", () => {
  const main = board();
  const wt = lane(main, "lane-s");
  try {
    appendEntry(main, op({ id: "ZZZ-6", branch: "main" }), "s1");
    appendEntry(main, op({ id: "ZZZ-7", branch: "lane-s" }), "s2");
    for (const where of [main, wt]) {
      const r = runCommit(main, where, ["--status"]);
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /s1/, `queue s1 visible from ${where === main ? "main" : "the lane"}`);
      assert.match(r.stdout, /s2/, "and so is the other working tree's queue");
      assert.match(r.stdout, /queue store/i, "the resolved store is named, so a mismatch is visible");
    }
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T5 — the queue-time stamp. New ops record their working tree directly rather than
// relying on the branch proxy.
// ---------------------------------------------------------------------------
test("BLZ-556: commitOrQueue stamps the working tree on every queued op — the lane by path, the main tree as the empty string", () => {
  const main = board();
  const wt = lane(main, "lane-q");
  try {
    commitOrQueue({ root: main, mode: "batch", op: "edit", id: "ZZZ-1", message: "ZZZ-1: m",
      files: [join(main, "projects", "ZZZ", "defined", "ZZZ-1.md")] });
    const fromMain = readEntries(main, "s-main");
    commitOrQueue({ root: wt, mode: "batch", op: "edit", id: "ZZZ-1", message: "ZZZ-1: m",
      files: [join(wt, "projects", "ZZZ", "defined", "ZZZ-1.md")] });
    const all = readEntries(main, process.env.BLAZE_SESSION ? process.env.BLAZE_SESSION : null);
    void fromMain; void all;
    // Read whichever queue sessionId() resolved to; both ops went to the SAME store.
    const q = listQueues(main);
    const entries = q.flatMap((x) => readEntries(main, x.session));
    assert.equal(entries.length, 2);
    // This once asserted `undefined` — "the main working tree records no worktree, so the
    // ledger shape is unchanged". That stated goal is exactly what bought the detached-HEAD
    // defect below: it made "queued in the main tree" indistinguishable from "no provenance
    // recorded at all". The empty string is a real answer and is now always written.
    assert.equal(entries[0].worktree, "", "the main working tree records itself as the empty string");
    assert.equal(entries[1].worktree, `../${wt.split("/").pop()}`, "a linked worktree records itself, relative to the store");
    assert.ok(!entries[1].worktree.startsWith("/"), "recorded relative, so it survives a container mount");
    assert.equal(queueRoot(wt), main);
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T6 — THE DETACHED MAIN CHECKOUT. The regression that made the fix reintroduce the very
// false green it removes, at the one place the flush actually runs.
//
// `currentBranch` returns null on a detached HEAD (branch-guard.mjs), so before this test a
// main checkout mid-rebase, mid-bisect, on `checkout <sha>`, or in a detached review
// worktree recorded NEITHER `branch` NOR `worktree` — the latter because the main tree's
// empty string was being omitted to "keep the ledger shape unchanged". `belongsHere`'s last
// line then treated the op as this tree's from anywhere, so a flush in another worktree
// drained it, staged nothing for it (its file is in the detached checkout), committed
// something else, and DELETED the record — exit 0, "flushed 2 op(s)".
//
// `checkBranch` is not a backstop: it returns ok the moment the checkout is on the default
// branch, which is where board-main and the CronJob always are. Detached HEAD is ordinary
// here, not exotic.
// ---------------------------------------------------------------------------
test("BLZ-556: an op queued from a DETACHED main checkout is neither drained nor deleted by another working tree", () => {
  const main = board();
  let bm;
  const savedSession = process.env.BLAZE_SESSION;
  try {
    // The live shape: the main checkout is detached, and `board-main` holds the default
    // branch — which is the checkout the nightly flush runs in.
    git(main, "checkout", "-q", "--detach");
    assert.equal(git(main, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "the main checkout is detached");
    bm = join(dirname(main), `blaze-provenance-boardmain-${process.pid}-${Math.random().toString(36).slice(2)}`);
    git(main, "worktree", "add", "-q", bm, "main");

    // A real op, through the real queue path, from the detached main checkout. Its file is
    // written HERE and exists nowhere else.
    process.env.BLAZE_SESSION = "sessMain";
    writeFileSync(join(main, "projects", "ZZZ", "defined", "ZZZ-1.md"), "important main work\n");
    commitOrQueue({ root: main, mode: "batch", op: "edit", id: "ZZZ-1",
      message: "ZZZ-1: important main work",
      files: [join(main, "projects", "ZZZ", "defined", "ZZZ-1.md")] });
    const queued = readEntries(main, "sessMain");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].branch, undefined, "detached HEAD records no branch — the precondition");
    assert.equal(queued[0].worktree, "", "so the working tree is the ONLY provenance it carries");

    // The flush, from board-main, on the default branch — where checkBranch waves it through.
    const r = runCommit(main, bm, ["--all"], "sessBM");
    assert.notEqual(r.status, 0, `a flush that cannot reach this op must not be green: ${r.stdout}${r.stderr}`);

    const after = readEntries(main, "sessMain");
    assert.deepEqual(after.map((e) => e.id), ["ZZZ-1"], "the op record SURVIVES");
    assert.equal(after[0].message, "ZZZ-1: important main work", "byte-for-byte, not rewritten");
    assert.doesNotMatch(git(bm, "log", "-1", "--format=%B"), /important main work/,
      "and no commit claims to carry it");
  } finally {
    if (savedSession === undefined) delete process.env.BLAZE_SESSION;
    else process.env.BLAZE_SESSION = savedSession;
    cleanup(main, bm);
  }
});

// ---------------------------------------------------------------------------
// T7 — THE STORE LOCK. `clearLedger` does byte-offset arithmetic against a file it read
// before the git commit ran. With one store that file is shared by every worktree, while
// `commit-lock.mjs` keys on the INVOKING root — so two worktrees flushing at once held two
// different locks and read-modify-wrote one file: an op resurrected, another shredded into
// an unparseable line. Locking the STORE is what makes the second flush wait its turn.
//
// Constructed by holding the store's lock and proving a DIFFERENT worktree's flush refuses.
// A lock taken on the lane's own root would be invisible to it, which is the bug.
// ---------------------------------------------------------------------------
test("BLZ-556: a flush in one worktree is excluded by a flush already running in another", () => {
  const main = board();
  const wt = lane(main, "lane-lock");
  try {
    writeFileSync(join(wt, "projects", "ZZZ", "defined", "ZZZ-8.md"), "lane work\n");
    appendEntry(wt, op({ id: "ZZZ-8", branch: "lane-lock", files: ["projects/ZZZ/defined/ZZZ-8.md"] }), "s1");

    // Another worktree's flush is in progress: it holds the lock on the STORE, which is the
    // main checkout — not on this lane, whose own lock is free.
    const held = acquireLock(main, { session: "the-other-worktree" });
    assert.equal(held.ok, true);
    assert.ok(!existsSync(lockPath(wt)), "the lane's own lock is NOT held — only the store's");

    const blocked = runCommit(main, wt, ["--all"]);
    assert.equal(blocked.status, 1, `the lane's flush must refuse while the store is locked: ${blocked.stdout}${blocked.stderr}`);
    assert.match(blocked.stderr, /queue-store commit\.lock held/, "and say the STORE is what is held");
    assert.match(blocked.stderr, /ledger kept/);
    assert.deepEqual(readEntries(main, "s1").map((e) => e.id), ["ZZZ-8"],
      "nothing was drained, so nothing could be shredded or resurrected");

    // Released: the same flush now goes through, proving the refusal was the lock and not
    // some unrelated failure.
    releaseLock(main);
    const after = runCommit(main, wt, ["--all"]);
    assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
    assert.match(after.stdout, /flushed 1 op/);
    assert.deepEqual(readEntries(main, "s1"), []);
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T8 — THE WORKING-TREE LOCK, and its rollback. T7 pins only the STORE lock and explicitly
// asserts the lane's own lock is NOT held, so removing `treeLock` and its
// `releaseLock(store)` left the whole suite green — a guard counted as pinned that had zero
// coverage. This is the other half: the per-worktree lock still excludes a per-op commit in
// THIS checkout (which is what `serve-commit.mjs` takes), and a refusal there must hand back
// the store lock it had already acquired instead of leaking it to every other worktree.
// ---------------------------------------------------------------------------
test("BLZ-556: a flush is excluded by its OWN working tree's lock, and releases the store lock it already took", () => {
  const main = board();
  const wt = lane(main, "lane-tree");
  try {
    writeFileSync(join(wt, "projects", "ZZZ", "defined", "ZZZ-9.md"), "lane work\n");
    appendEntry(wt, op({ id: "ZZZ-9", branch: "lane-tree", files: ["projects/ZZZ/defined/ZZZ-9.md"] }), "s1");

    // A per-op commit is running in THIS worktree: it holds this working tree's lock. The
    // store's lock — the main checkout's — is free, so only the tree lock can refuse here.
    const held = acquireLock(wt, { session: "a-per-op-commit-in-this-worktree" });
    assert.equal(held.ok, true);
    assert.ok(!existsSync(lockPath(main)), "the store's lock is free — only this worktree's is held");

    const blocked = runCommit(main, wt, ["--all"]);
    assert.equal(blocked.status, 1, `the flush must refuse: ${blocked.stdout}${blocked.stderr}`);
    assert.match(blocked.stderr, /commit\.lock held/);
    assert.doesNotMatch(blocked.stderr, /queue-store commit\.lock held/,
      "this working tree's lock is what refused, not the store's");
    assert.ok(!existsSync(lockPath(main)),
      "and the store lock it had already taken was RELEASED, not leaked to every other worktree");
    assert.deepEqual(readEntries(main, "s1").map((e) => e.id), ["ZZZ-9"], "nothing drained");

    releaseLock(wt);
    const after = runCommit(main, wt, ["--all"]);
    assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
    assert.match(after.stdout, /flushed 1 op/);
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T9 — WHAT THE MESSAGE ACTUALLY SAYS. No test asserted the label text, and it was printing
// an empty string for the main working tree: `e.worktree ?? …` coalesces only on
// null/undefined, and BLZ-556 made `""` a written value, so it won the coalesce and the
// operator was told to go and run `blaze commit` in a working tree the message left blank —
// on the detached-main path the unconditional stamp exists to protect.
// ---------------------------------------------------------------------------
test("BLZ-556: the unreached-ops message NAMES the main working tree rather than leaving a blank", () => {
  const main = board();
  let bm;
  const saved = process.env.BLAZE_SESSION;
  try {
    git(main, "checkout", "-q", "--detach");
    bm = join(dirname(main), `blaze-provenance-lbl-${process.pid}-${Math.random().toString(36).slice(2)}`);
    git(main, "worktree", "add", "-q", bm, "main");
    process.env.BLAZE_SESSION = "sessMain";
    writeFileSync(join(main, "projects", "ZZZ", "defined", "ZZZ-1.md"), "main work\n");
    commitOrQueue({ root: main, mode: "batch", op: "edit", id: "ZZZ-1", message: "ZZZ-1: main work",
      files: [join(main, "projects", "ZZZ", "defined", "ZZZ-1.md")] });
    assert.equal(readEntries(main, "sessMain")[0].worktree, "", "the op records the empty string");

    const r = runCommit(main, bm, ["--all"], "sessBM");
    assert.match(r.stderr, /1 op\(s\) queued in the main working tree/,
      "the empty string is spelled out, not printed raw");
    assert.doesNotMatch(r.stderr, /queued in\s*$/m, "no line ends with a blank destination");
  } finally {
    if (saved === undefined) delete process.env.BLAZE_SESSION; else process.env.BLAZE_SESSION = saved;
    cleanup(main, bm);
  }
});

test("BLZ-556: the unreached-ops message names a lane by its path, and a branch-only op by its owning worktree", () => {
  const main = board();
  const wt = lane(main, "lane-lbl");
  try {
    const base = wt.split("/").pop();
    // Recorded worktree (a post-BLZ-556 op) — named by the path it recorded.
    appendEntry(main, op({ id: "ZZZ-2", worktree: `../${base}` }), "s1");
    // Branch only (the shape all 210 live ops carry) — named by the worktree that holds it.
    appendEntry(main, op({ id: "ZZZ-3", branch: "lane-lbl" }), "s1");

    const r = runCommit(main, main, ["--all"]);
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`1 op\\(s\\) queued in \\.\\./${base}$`, "m"),
      "the recorded worktree path, verbatim");
    assert.match(r.stderr, new RegExp(`1 op\\(s\\) queued in ${wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(branch 'lane-lbl'\\)`),
      "and the branch-only op by the worktree git says holds that branch");
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T10 — the same failure at the VERB boundary. Before this, both of these exited on an
// uncaught EACCES stack trace from module top level, which reads to an operator (and to a
// CronJob log) as a crashed engine rather than as a board state it is telling them about.
// ---------------------------------------------------------------------------
test("BLZ-556: an unreadable stranded queue makes the verb REPORT and exit, not die on a stack trace", (t) => {
  const main = board();
  const wt = lane(main, "lane-eacces");
  try {
    mkdirSync(join(wt, ".blaze", "pending"), { recursive: true });
    const bad = join(wt, ".blaze", "pending", "bad.jsonl");
    // A READABLE stranded queue beside the unreadable one, so the reported total is a real
    // number over the queues that were actually read — not a sum that silently absorbed the
    // one it could not open, and not NaN from adding a null into it.
    writeFileSync(join(wt, ".blaze", "pending", "readable.jsonl"),
      [1, 2, 3].map((i) => JSON.stringify(op({ id: `ZZZ-${i}` }))).join("\n") + "\n");
    writeFileSync(bad, `${JSON.stringify(op({ id: "ZZZ-7" }))}\n`);
    chmodSync(bad, 0o000);
    try { accessSync(bad, constants.R_OK); t.skip("running as root — chmod 000 is not a read barrier here"); return; } catch { /* unreadable */ }

    const status = runCommit(main, wt, ["--status"]);
    assert.equal(status.status, 2, "--status: the report is INCOMPLETE, which is exit 2");
    assert.doesNotMatch(status.stderr, /at readFileSync|Error: EACCES: permission denied, open/,
      "and it is a report, not a raw stack trace");
    assert.match(status.stderr, /UNREADABLE/);

    const flush = runCommit(main, wt, ["--all"]);
    assert.equal(flush.status, 3, "the flush cannot be green while part of the board is unreadable");
    assert.doesNotMatch(flush.stderr, /at readFileSync/);
    assert.match(flush.stderr, /3 op\(s\), plus 1 queue\(s\) that could not be read/,
      "the total counts the queues it READ, and names the unreadable one separately");
    assert.doesNotMatch(`${flush.stdout}${flush.stderr}`, /NaN/,
      "an unread queue must never be added into the total as a number");
    assert.ok(!existsSync(join(main, ".blaze", "pending", "bad.jsonl")),
      "and the engine moved nothing into the store — it reports, it does not migrate");
  } finally {
    try { chmodSync(join(wt, ".blaze", "pending", "bad.jsonl"), 0o644); } catch { /* gone */ }
    cleanup(main, wt);
  }
});

// ---------------------------------------------------------------------------
// T11 — A FIFO IN THE QUEUE STORE MUST NOT WEDGE THE ENGINE. BLZ-493 / ADR-0031: opening a
// FIFO with no writer blocks forever — no error, no timeout, no exit — and the ledger was
// never in that sweep. BLZ-556 widens it from one checkout to all of them plus the unattended
// flush CronJob, because there is now one store behind every worktree.
//
// Found by executing the migration runbook against a fixture: `mkfifo` hung the harness. Every
// assertion below is bounded by a spawn `timeout`, so a regression fails this test in seconds
// instead of hanging the suite the way the bug hangs the board.
// ---------------------------------------------------------------------------
test("BLZ-556: a FIFO named like a queue file is REFUSED, and never blocks the verb forever", () => {
  const main = board();
  const wt = lane(main, "lane-fifo");
  try {
    mkdirSync(join(main, ".blaze", "pending"), { recursive: true });
    execFileSync("mkfifo", [join(main, ".blaze", "pending", "wedge.jsonl")]);

    for (const args of [["--status"], ["--all"]]) {
      const env = { ...process.env, BLAZE_SESSION: "s1" };
      delete env.CLAUDE_CODE_SESSION_ID;
      const r = spawnSync(process.execPath, [join(main, "scripts", "commit-runner.mjs"), ...args],
        { cwd: main, env, encoding: "utf8", timeout: 20_000 });
      assert.notEqual(r.signal, "SIGTERM", `blaze commit ${args} HUNG on a FIFO instead of refusing it`);
      assert.match(`${r.stdout}${r.stderr}`, /FIFO \(a named pipe\)/,
        `and it must name what it refused: ${r.stdout}${r.stderr}`);
    }

    // The same thing sitting in a not-yet-migrated worktree store is reported, not fatal.
    mkdirSync(join(wt, ".blaze", "pending"), { recursive: true });
    execFileSync("mkfifo", [join(wt, ".blaze", "pending", "stranded.jsonl")]);
    const s = runCommit(main, wt, ["--status"]);
    assert.notEqual(s.signal, "SIGTERM");
    assert.equal(s.status, 2, "a report that could not open part of the board exits 2");
    assert.match(s.stderr, /UNREADABLE/);
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T12 — the same two listing sites AT THE VERB, and the exit-code contract with them.
// Both used to die on `EACCES: scandir` from module top level, which also broke the
// "--status exits 2 when the report is incomplete" contract: it exited 1.
// ---------------------------------------------------------------------------
const dirUnlistableOr = (t, dir) => {
  chmodSync(dir, 0o000);
  try { readdirSync(dir); chmodSync(dir, 0o755); t.skip("running as root"); return false; } catch { return true; }
};

test("BLZ-556: an unlistable SHARED STORE directory is reported by the verb — --status 2, --all 3, no stack", (t) => {
  const main = board();
  const wt = lane(main, "lane-dir-store");
  const dir = join(main, ".blaze", "pending");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), `${JSON.stringify(op({ id: "ZZZ-1", branch: "lane-dir-store" }))}\n`);
    if (!dirUnlistableOr(t, dir)) return;

    const st = runCommit(main, wt, ["--status"]);
    assert.equal(st.status, 2, `report incomplete => 2, got ${st.status}: ${st.stdout}${st.stderr}`);
    assert.doesNotMatch(`${st.stdout}${st.stderr}`, /at readdirSync|^\s+at /m, "reported, not a raw stack");
    assert.match(st.stderr, /queue store's own directory could not be listed/);

    const fl = runCommit(main, wt, ["--all"]);
    assert.equal(fl.status, 3, "a flush that cannot list the store is not green");
    assert.doesNotMatch(`${fl.stdout}${fl.stderr}`, /at readdirSync/);
    assert.match(fl.stderr, /cannot report the board flushed/);
  } finally { try { chmodSync(dir, 0o755); } catch { /* gone */ } cleanup(main, wt); }
});

test("BLZ-556: an unlistable STRANDED directory is reported by the verb — --status 2, --all 3, no stack", (t) => {
  const main = board();
  const wt = lane(main, "lane-dir-stranded");
  const dir = join(wt, ".blaze", "pending");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), `${JSON.stringify(op({ id: "ZZZ-2" }))}\n`);
    if (!dirUnlistableOr(t, dir)) return;

    const st = runCommit(main, wt, ["--status"]);
    assert.equal(st.status, 2, `${st.stdout}${st.stderr}`);
    assert.doesNotMatch(`${st.stdout}${st.stderr}`, /at readdirSync|^\s+at /m);
    assert.match(st.stderr, /queue directory/, "named as the directory, not as a session queue");

    const fl = runCommit(main, wt, ["--all"]);
    assert.equal(fl.status, 3);
    assert.doesNotMatch(`${fl.stdout}${fl.stderr}`, /at readdirSync/);
  } finally { try { chmodSync(dir, 0o755); } catch { /* gone */ } cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T13 — THE WRITE SIDE OF THE FIFO SWEEP. T11 planted its FIFO at `wedge.jsonl` while the
// session was `s1`, so it drove only the READ path. A FIFO at the session's OWN queue file is
// what `appendEntry` opens, and `appendFileSync` blocks in open(2) there forever — wedging
// every `blaze new`, `move`, `edit`, `log` and `resolve`, not just a flush, in every worktree
// of the repo because they all share one store.
//
// Driven in a CHILD process with a bounded timeout: a synchronous open that blocks cannot be
// rescued by `node:test`'s own timer, so a regression must not be able to hang this suite.
// ---------------------------------------------------------------------------
test("BLZ-556: appending to a queue file that is a FIFO is refused immediately, never blocked on", () => {
  const main = board();
  const dir = join(main, ".blaze", "pending");
  const fifo = join(dir, "s1.jsonl");
  try {
    mkdirSync(dir, { recursive: true });
    execFileSync("mkfifo", [fifo]);
    const probe = join(main, "probe.mjs");
    writeFileSync(probe, `
      import { appendEntry } from "./scripts/pending-ledger.mjs";
      try { appendEntry(process.cwd(), { id: "X", op: "edit", files: ["f"], ts: "t" }, "s1"); console.log("APPENDED"); }
      catch (e) { console.log("REFUSED " + (e.code ?? e.message)); }
    `);
    const env = { ...process.env, BLAZE_SESSION: "s1" };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(process.execPath, [probe], { cwd: main, env, encoding: "utf8", timeout: 20_000 });
    assert.notEqual(r.signal, "SIGTERM", "appendEntry HUNG on a FIFO instead of refusing it");
    assert.match(r.stdout, /^REFUSED /, `must refuse, not append: ${r.stdout}${r.stderr}`);
  } finally {
    try { rmSync(fifo, { force: true }); } catch { /* gone */ }
    cleanup(main);
  }
});
