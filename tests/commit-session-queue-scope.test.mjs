// tests/commit-session-queue-scope.test.mjs — what ONE `blaze commit` run actually
// scopes itself to, and the two tickets that describe it from opposite sides.
//
// BLZ-124 (filed 2026-07-17): "a subagent running `blaze commit` flushes its sibling
// subagents' in-flight ops."
// BLZ-498 (filed 2026-08-29): "`blaze commit` drains only the caller's own session queue,
// so an abandoned session's pending ops orphan forever."
//
// Read side by side those look like opposite claims about one mechanism, and the backlog
// brief flagged them as a contradiction to resolve before either was worked. They are NOT
// opposites, and NEITHER is stale. They are the same rule — "drain exactly the queue your
// own session id resolves to" (`commit-runner.mjs:74,97`) — observed at two different
// boundaries:
//
//   * `sessionId()` derives `auto-<CLAUDE_CODE_SESSION_ID>`, and the harness EXPORTS that
//     variable into every descendant process. So a session and all its subagents resolve to
//     ONE queue name, and any of them flushing takes all of them.        <- BLZ-124
//   * A different top-level session has a different `CLAUDE_CODE_SESSION_ID`, so it resolves
//     to a DIFFERENT queue name, which the flush never looks at.         <- BLZ-498
//
// The decisive observation is that both happen in a SINGLE run, which is what T1 constructs:
// one `blaze commit`, one commit object, sibling ops swept in and a foreign session's queue
// left byte-for-byte alone. A test that showed only one of the two could be quoted as
// evidence that the other ticket was wrong; this one cannot.
//
// BLZ-124's decision, recorded here because this is where it is observable: option (a),
// STATUS QUO + DISCIPLINE. Not (b) "refuse to flush from a subagent". Two reasons, the
// second new:
//   1. The sharing is load-bearing, not incidental — per-agent queues strand a subagent's
//      work under an id nobody flushes (the failure mode that sank the ppid attempt), and
//      the ratified batch unit is the session.
//   2. BLZ-500 established that the `blaze-flush` CronJob's `blaze commit --all` has never
//      run against the real ledger (docs/reports/2026-08-30-blz-500-ledger-capture.md §4).
//      The operator's own interactive sessions ARE the board's merger — 128 of 361 commits
//      on `BLZ-305-v4-spine`. Adding a second harness-env coupling that can REFUSE on the
//      only merge path that actually works trades a bounded, recoverable annoyance for a
//      new way to stop the board merging at all. `BLAZE_READONLY=1` already removes the
//      hazard for inspection-only subagents, which was the original incident's shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { appendEntry, readEntries, ledgerPath, readForDrain, clearLedger, listQueues } from "../scripts/pending-ledger.mjs";

const REPO = join(import.meta.dirname, "..");

/** A temp board carrying its own copy of scripts/, so the copied runner resolves its
 *  script-relative root to the fixture and never to this worktree. The mkdtempSync prefix
 *  is a LITERAL at the call site (BLZ-491) — `tests/tmp-scratch-attribution.test.mjs`
 *  reads it statically, and a variable would drop this suite out of the attribution
 *  buckets. */
function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-queuescope-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "projects", "ZZZ", "defined"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

/** Env for a process that belongs to harness session `id` and sets NOTHING else — exactly
 *  what a subagent inherits. BLAZE_SESSION is deleted rather than left ambient so the
 *  fixture cannot accidentally pass because the outer test runner set one. */
function sessionEnv(id) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: id };
  delete env.BLAZE_SESSION;
  return env;
}

const runIn = (root, file, env) =>
  spawnSync(process.execPath, [file], { cwd: root, env, encoding: "utf8" });

// T1 — THE RESOLUTION. Pins: commit-runner.mjs's `mySession`/`targets` scoping
// (`:74`, `:97`) and pending-ledger.mjs's `sessionId` harness fallback (`:19-20`).
//
// Constructed, not asserted: the two "subagents" are REAL child processes that are handed
// the harness variable and nothing else, and they print the session id they derived — so
// the shared queue name is an observation of inheritance, not a constant this test wrote
// down and then checked against itself.
test("BLZ-124 and BLZ-498 are one mechanism: a single flush sweeps a sibling subagent's ops AND leaves a foreign session's queue untouched", () => {
  const root = board();
  try {
    const HARNESS = "session-under-test";
    const FOREIGN = "auto-a-previous-abandoned-session";

    // Two sibling subagents of ONE harness session. Each queues its own op through the
    // real `sessionId()`/`appendEntry` pair, and reports the id it derived.
    writeFileSync(join(root, "subagent.mjs"), `
      import { appendEntry, sessionId } from "./scripts/pending-ledger.mjs";
      const id = process.argv[2];
      const session = sessionId();
      process.stdout.write(session + "\\n");
      appendEntry(process.cwd(), {
        id, op: "new", message: id + ": queued by a subagent",
        files: ["projects/ZZZ/defined/" + id + ".md"], ts: "t",
        ...(session ? { session } : {}),
      }, session);
    `);
    for (const id of ["ZZZ-10", "ZZZ-11"]) {
      writeFileSync(join(root, "projects", "ZZZ", "defined", `${id}.md`), `${id}\n`);
    }
    const a = spawnSync(process.execPath, ["subagent.mjs", "ZZZ-10"], { cwd: root, env: sessionEnv(HARNESS), encoding: "utf8" });
    const b = spawnSync(process.execPath, ["subagent.mjs", "ZZZ-11"], { cwd: root, env: sessionEnv(HARNESS), encoding: "utf8" });
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    // OBSERVED, not assumed: two separate processes derived the same queue name purely
    // from the inherited harness variable. This is BLZ-124's premise, by construction.
    assert.equal(a.stdout.trim(), b.stdout.trim(),
      "two sibling subagents of one harness session must derive one queue name");
    assert.equal(a.stdout.trim(), `auto-${HARNESS}`);
    const shared = a.stdout.trim();
    assert.equal(readEntries(root, shared).length, 2);

    // A THIRD session's queue, abandoned: its owner is never coming back. BLZ-498's premise.
    writeFileSync(join(root, "projects", "ZZZ", "defined", "ZZZ-99.md"), "ZZZ-99\n");
    appendEntry(root, {
      id: "ZZZ-99", op: "new", message: "ZZZ-99: queued by a session that never returned",
      files: ["projects/ZZZ/defined/ZZZ-99.md"], ts: "t", session: FOREIGN,
    }, FOREIGN);
    const foreignBytes = readFileSync(ledgerPath(root, FOREIGN));

    // ONE flush, by a third process of the SAME harness session (the parent).
    const r = runIn(root, join(root, "scripts", "commit-runner.mjs"), sessionEnv(HARNESS));
    assert.equal(r.status, 0, r.stderr);

    const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
    // BLZ-124's claim, true of live HEAD: the flusher took BOTH siblings' ops.
    assert.match(body, /ZZZ-10: queued by a subagent/);
    assert.match(body, /ZZZ-11: queued by a subagent/);
    // BLZ-498's claim, true of live HEAD in the SAME run: the foreign queue is untouched.
    assert.doesNotMatch(body, /ZZZ-99/);
    assert.deepEqual(readFileSync(ledgerPath(root, FOREIGN)), foreignBytes,
      "an abandoned session's queue must survive another session's flush byte-for-byte");
    const tree = execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" });
    assert.doesNotMatch(tree, /ZZZ-99/);
    // And it is exactly ONE commit — the two facts are not two runs dressed up as one.
    assert.equal(execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// T2 — BLZ-498, the file leak, stated literally by the ticket's own title: "every abandoned
// session leaks one forever". Pins: pending-ledger.mjs `clearLedger`'s empty-remainder unlink.
// Before the fix, a fully drained queue was truncated to a zero-byte file and left on disk,
// so `.blaze/pending/` grew by one entry per session that had ever run and never shrank —
// 28 queues holding 19 ops in the operator's `blaze-pm` checkout, 14 holding 185 in the
// worktree (docs/reports/2026-08-30-blz-500-ledger-capture.md §1, §4).
test("BLZ-498: a fully drained queue file is REMOVED, so a finished session stops leaking a queue forever", () => {
  const root = board();
  try {
    appendEntry(root, { id: "ZZZ-1", op: "new", message: "m", files: [], ts: "t", session: "s1" }, "s1");
    assert.ok(existsSync(ledgerPath(root, "s1")));
    const { bytes } = readForDrain(root, "s1");
    clearLedger(root, "s1", bytes);
    assert.equal(existsSync(ledgerPath(root, "s1")), false,
      "a queue with nothing left in it is not evidence of anything — it must not be left on disk");
    assert.deepEqual(readEntries(root, "s1"), []);   // and reads still answer cleanly
    assert.deepEqual(listQueues(root), []);          // and it stops being counted as a queue
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// T3 — the case that must NOT be swept up by T2's fix, and the one that would pass by
// accident if the unlink were unconditional. Pins the SAME hunk as T2, from the other side:
// a drain-exact clear that leaves bytes behind must leave the FILE behind too, or the op an
// unrelated session appended mid-commit is destroyed rather than preserved.
test("BLZ-498: a partially drained queue keeps its file and its un-drained bytes", () => {
  const root = board();
  try {
    const op1 = { id: "ZZZ-1", op: "new", message: "first", files: [], ts: "t1", session: "s1" };
    const op2 = { id: "ZZZ-2", op: "new", message: "late, mid-drain", files: [], ts: "t2", session: "s1" };
    appendEntry(root, op1, "s1");
    const { bytes } = readForDrain(root, "s1");
    appendEntry(root, op2, "s1");
    clearLedger(root, "s1", bytes);
    assert.ok(existsSync(ledgerPath(root, "s1")), "the late op's queue file must survive the drain");
    assert.deepEqual(readEntries(root, "s1"), [op2]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// T4 — BLZ-498 AC1, the half that is not about deletion: "a queue's age and owner are
// visible without reading the ledger by hand". Pins: commit-summary.mjs `renderQueueStatus`'s
// age clause and own-queue marker.
//
// Before this, `--status` printed a queue's name and its oldest timestamp. Neither answers
// the question an operator actually has in front of eight orphaned queues — "which of these
// is MINE, and how long has that one been sitting there" — and working it out meant
// subtracting ISO timestamps by hand, which is how the 185 ops sat unexamined for five days.
test("BLZ-498: --status marks the caller's own queue and gives each queue's age, not just a raw timestamp", () => {
  const root = board();
  try {
    const HARNESS = "session-under-test";
    const mine = `auto-${HARNESS}`;
    const old = new Date(Date.now() - 5 * 86400000).toISOString();
    writeFileSync(join(root, "projects", "ZZZ", "defined", "ZZZ-1.md"), "one\n");
    writeFileSync(join(root, "projects", "ZZZ", "defined", "ZZZ-2.md"), "two\n");
    appendEntry(root, { id: "ZZZ-1", op: "new", message: "mine", files: ["projects/ZZZ/defined/ZZZ-1.md"], ts: new Date().toISOString(), session: mine }, mine);
    appendEntry(root, { id: "ZZZ-2", op: "new", message: "theirs", files: ["projects/ZZZ/defined/ZZZ-2.md"], ts: old, session: "auto-abandoned" }, "auto-abandoned");

    const r = spawnSync(process.execPath, [join(root, "scripts", "commit-runner.mjs"), "--status"],
      { cwd: root, env: sessionEnv(HARNESS), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split("\n");
    const mineLine = lines.find((l) => l.includes(mine));
    const theirsLine = lines.find((l) => l.includes("auto-abandoned"));
    assert.ok(mineLine, "the caller's own queue must be listed");
    assert.match(mineLine, /\(yours\)/, "the caller's own queue must say so — that is the whole attribution question");
    assert.doesNotMatch(theirsLine, /\(yours\)/, "another session's queue must NOT be marked as the caller's");
    assert.match(theirsLine, /5\.0 d old/, "an abandoned queue's AGE must be rendered, not left as an ISO stamp to subtract by hand");
    // Read-only is the property that must not regress: no commit, nothing cleared.
    assert.equal(execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "1");
    assert.equal(readEntries(root, mine).length, 1);
    assert.equal(readEntries(root, "auto-abandoned").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
