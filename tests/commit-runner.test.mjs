import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync, execFile } from "node:child_process";
import { appendEntry, readEntries, ledgerPath } from "../scripts/pending-ledger.mjs";
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// A temp board with a real copy of scripts/, so the copied commit-runner.mjs
// resolves its script-relative ROOT to this temp repo (not the worktree).
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-commitrun-"));
  cpSync(join(REPO, "scripts"), join(root, "scripts"), { recursive: true });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}
// Invoke the temp repo's OWN copy of the runner. cwdSub (a relative subdir)
// proves ROOT is script-relative, not cwd-based.
function runCommit(root, cwdSub, { session, args = [] } = {}) {
  const runner = join(root, "scripts", "commit-runner.mjs");
  const cwd = cwdSub ? join(root, cwdSub) : root;
  const env = { ...process.env, ...(session ? { BLAZE_SESSION: session } : {}) };
  if (!session) delete env.BLAZE_SESSION;
  const r = spawnSync(process.execPath, [runner, ...args], { cwd, env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
const headOf = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

test("empty ledger is a friendly no-op", () => {
  const root = gitRepo();
  const before = headOf(root);
  const r = runCommit(root);
  assert.match(r.stdout, /nothing to flush/);
  assert.doesNotMatch(r.stderr, /queued in other sessions/); // no orphan hint when there's nothing anywhere
  assert.equal(headOf(root), before);
  rmSync(root, { recursive: true, force: true });
});

// BLZ-120: a harness restart auto-derives a NEW ppid, orphaning the previous
// run's queue under its old id. Without this hint, "nothing to flush" reads
// as "nothing was ever queued" — signpost what's actually still sitting there.
test("orphan hint: own queue empty but other sessions hold ops — named on stderr", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-40.md"), "orphaned");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-41.md"), "legacy leftover");
  appendEntry(root, { id: "OBA-40", op: "new", message: "OBA-40: orphaned", files: ["projects/OBA/backlog/OBA-40.md"], ts: "t", session: "auto-1200" }, "auto-1200");
  appendEntry(root, { id: "OBA-41", op: "new", message: "OBA-41: legacy", files: ["projects/OBA/backlog/OBA-41.md"], ts: "t" });

  const before = headOf(root);
  const r = runCommit(root); // BLAZE_SESSION unset — own auto-<ppid> queue is empty

  assert.match(r.stdout, /nothing to flush/);
  assert.match(r.stderr, /nothing to flush for session auto-\d+ — 2 op\(s\) queued in other sessions \(legacy, auto-1200\); use --all to sweep them/);
  assert.equal(headOf(root), before); // still a no-op — hint is informational only
  assert.equal(readEntries(root, "auto-1200").length, 1); // untouched
  assert.equal(readEntries(root).length, 1);              // untouched
  rmSync(root, { recursive: true, force: true });
});

test("no orphan hint when the caller's own queue has ops (the normal flush path)", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-42.md"), "mine");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-43.md"), "someone else");
  const mySession = `auto-${process.pid}`;
  appendEntry(root, { id: "OBA-42", op: "new", message: "OBA-42: mine", files: ["projects/OBA/backlog/OBA-42.md"], ts: "t", session: mySession }, mySession);
  appendEntry(root, { id: "OBA-43", op: "new", message: "OBA-43: other", files: ["projects/OBA/backlog/OBA-43.md"], ts: "t", session: "s1" }, "s1");

  const r = runCommit(root); // BLAZE_SESSION unset — own queue is non-empty, flushes normally

  assert.match(r.stdout, /flushed 1 op/);
  assert.doesNotMatch(r.stderr, /queued in other sessions/); // no hint fires once the flush actually happens
  rmSync(root, { recursive: true, force: true });
});

test("drains the ledger into one commit and truncates it — even when invoked from a subdirectory", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "one");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-2.md"), "two");
  writeFileSync(join(root, "untracked-other"), "should NOT be committed");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: create task", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t", session: "t1" }, "t1");
  appendEntry(root, { id: "OBA-2", op: "new", message: "OBA-2: create task", files: ["projects/OBA/backlog/OBA-2.md"], ts: "t", session: "t1" }, "t1");

  // Invoke from a subdirectory to prove ROOT is script-relative, not cwd-based.
  runCommit(root, "projects/OBA", { session: "t1" });

  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(subject, /^blaze: \d{4}-\d{2}-\d{2} board update \(2 new\)$/);
  assert.match(body, /- OBA-1: create task/);
  assert.match(body, /- OBA-2: create task/);
  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? untracked-other/);
  assert.deepEqual(readEntries(root, "t1"), []);
  rmSync(root, { recursive: true, force: true });
});

test("drops a stale intermediate path from a ticket moved twice in one batch", () => {
  const root = gitRepo();

  // Ticket starts out committed at defined/.
  mkdirSync(join(root, "projects", "INF", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "INF", "defined", "X.md"), "x v1");
  execFileSync("git", ["-C", root, "add", "projects/INF/defined/X.md"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed ticket"]);
  const beforeCount = Number(
    execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(),
  );

  // Move 1: defined -> in-progress (on-disk relocation, matching what applyMove does).
  mkdirSync(join(root, "projects", "INF", "in-progress"), { recursive: true });
  writeFileSync(join(root, "projects", "INF", "in-progress", "X.md"), "x v2");
  rmSync(join(root, "projects", "INF", "defined", "X.md"));
  appendEntry(root, {
    id: "INF-1",
    op: "move",
    message: "INF-1: defined → in-progress",
    files: ["projects/INF/defined/X.md", "projects/INF/in-progress/X.md"],
    ts: "t",
    session: "t1",
  }, "t1");

  // Move 2: in-progress -> in-review, within the SAME batch. in-progress/X.md
  // (created by move 1, relocated again by move 2) is now neither on disk nor in HEAD.
  mkdirSync(join(root, "projects", "INF", "in-review"), { recursive: true });
  writeFileSync(join(root, "projects", "INF", "in-review", "X.md"), "x v3");
  rmSync(join(root, "projects", "INF", "in-progress", "X.md"));
  appendEntry(root, {
    id: "INF-1",
    op: "move",
    message: "INF-1: in-progress → in-review",
    files: ["projects/INF/in-progress/X.md", "projects/INF/in-review/X.md"],
    ts: "t",
    session: "t1",
  }, "t1");

  writeFileSync(join(root, "untracked-other"), "should NOT be committed");

  const out = runCommit(root, null, { session: "t1" }).stdout;
  assert.match(out, /blaze commit: flushed 2 op/);

  const afterCount = Number(
    execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(),
  );
  assert.equal(afterCount, beforeCount + 1, "exactly one new commit");

  const changed = execFileSync("git", ["-C", root, "show", "--name-status", "--format=", "HEAD"], {
    encoding: "utf8",
  });
  assert.match(changed, /^D\s+projects\/INF\/defined\/X\.md$/m);
  assert.match(changed, /^A\s+projects\/INF\/in-review\/X\.md$/m);
  assert.doesNotMatch(changed, /in-progress\/X\.md/);

  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? untracked-other/);
  assert.deepEqual(readEntries(root, "t1"), []);
  rmSync(root, { recursive: true, force: true });
});

test("runner exits 1 and keeps the queue when the lock is held", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-8.md"), "x");
  appendEntry(root, { id: "OBA-8", op: "new", message: "OBA-8: x", files: ["projects/OBA/backlog/OBA-8.md"], ts: "t", session: "t1" }, "t1");
  assert.equal(acquireLock(root, { session: "other" }).ok, true);
  const r = runCommit(root, null, { session: "t1" }); // waits out the bounded retry (~2 s), then fails
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit\.lock held/);
  assert.equal(readEntries(root, "t1").length, 1); // queue kept
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("two concurrent session flushes serialize: two clean commits, nothing lost", async () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-A.md"), "a");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-B.md"), "b");
  appendEntry(root, { id: "OBA-A", op: "new", message: "OBA-A: a", files: ["projects/OBA/backlog/OBA-A.md"], ts: "t", session: "a" }, "a");
  appendEntry(root, { id: "OBA-B", op: "new", message: "OBA-B: b", files: ["projects/OBA/backlog/OBA-B.md"], ts: "t", session: "b" }, "b");
  const run = (session) => new Promise((res, rej) => {
    const env = { ...process.env, BLAZE_SESSION: session };
    execFile(process.execPath, [join(root, "scripts", "commit-runner.mjs")], { cwd: root, env, encoding: "utf8" },
      (err, stdout, stderr) => (err ? rej(Object.assign(err, { stdout, stderr })) : res({ stdout, stderr })));
  });
  await Promise.all([run("a"), run("b")]);
  const count = execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(count, "3"); // seed + one commit per session
  const log = execFileSync("git", ["-C", root, "log", "--format=%b", "-2"], { encoding: "utf8" });
  assert.match(log, /OBA-A: a \[a\]/);
  assert.match(log, /OBA-B: b \[b\]/);
  assert.deepEqual(readEntries(root, "a"), []);
  assert.deepEqual(readEntries(root, "b"), []);
  assert.ok(!existsSync(join(root, ".blaze", "commit.lock")));
  rmSync(root, { recursive: true, force: true });
});

test("REPRO OBA-484: default flush does NOT bundle a foreign session's queued ops", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "mine");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-2.md"), "foreign wip");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: mine", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t", session: "me" }, "me");
  appendEntry(root, { id: "OBA-2", op: "new", message: "OBA-2: foreign", files: ["projects/OBA/backlog/OBA-2.md"], ts: "t", session: "sister" }, "sister");

  runCommit(root, null, { session: "me" });

  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(body, /OBA-1: mine \[me\]/);
  assert.doesNotMatch(body, /OBA-2/);
  const shown = execFileSync("git", ["-C", root, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" });
  assert.doesNotMatch(shown, /OBA-2\.md/);
  assert.equal(readEntries(root, "sister").length, 1); // sister's WIP still queued
  assert.deepEqual(readEntries(root, "me"), []);       // mine drained
  rmSync(root, { recursive: true, force: true });
});

// BLZ-120: an unset-session flush must isolate to the caller's own queue.
// Before this fix, EVERY unset-session caller shared ONE queue (session id
// null routed both write and read to the fallback file) — so an op parked
// there from a different origin rode along on whoever flushed first.
test("REPRO BLZ-120: an unset-session flush must not pull ops parked in the shared fallback from a different origin", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-30.md"), "mine");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-31.md"), "a different origin's op");

  // My own op, unset BLAZE_SESSION: seeded at the path an auto-derived session
  // queues to. spawnSync below has no intermediate shell, so the child's
  // ppid IS this test process's pid — the exact queue it will read from.
  const mySession = `auto-${process.pid}`;
  appendEntry(
    root,
    { id: "OBA-30", op: "new", message: "OBA-30: mine", files: ["projects/OBA/backlog/OBA-30.md"], ts: "t", session: mySession },
    mySession,
  );

  // A different origin's op, parked in the shared legacy fallback — exactly
  // where every unset-session write used to land.
  appendEntry(root, { id: "OBA-31", op: "new", message: "OBA-31: other origin", files: ["projects/OBA/backlog/OBA-31.md"], ts: "t" });
  const otherBefore = readFileSync(ledgerPath(root));

  runCommit(root); // BLAZE_SESSION unset

  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(body, /OBA-30: mine/);  // POSITIVE: my own queued op was committed
  assert.doesNotMatch(body, /OBA-31/); // NEGATIVE: the other origin's op was not
  const shown = execFileSync("git", ["-C", root, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" });
  assert.doesNotMatch(shown, /OBA-31\.md/);
  assert.deepEqual(readFileSync(ledgerPath(root)), otherBefore); // still queued, byte-identical
  assert.equal(readEntries(root).length, 1);                    // still readable as pending
  rmSync(root, { recursive: true, force: true });
});

// BLZ-120: an unset-session flush drains its OWN auto-derived queue only —
// the shared legacy fallback is read-only history now, swept solely by
// `--all` (see that test below).
test("unset session drains its own auto-derived queue, leaving the legacy fallback untouched", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-3.md"), "legacy leftover");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-5.md"), "mine");
  appendEntry(root, { id: "OBA-3", op: "new", message: "OBA-3: legacy", files: ["projects/OBA/backlog/OBA-3.md"], ts: "t" });
  const mySession = `auto-${process.pid}`; // execFileSync/spawnSync child's ppid IS this process's pid
  appendEntry(root, { id: "OBA-5", op: "new", message: "OBA-5: mine", files: ["projects/OBA/backlog/OBA-5.md"], ts: "t", session: mySession }, mySession);

  runCommit(root); // BLAZE_SESSION unset

  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(body, /OBA-5: mine/);
  assert.doesNotMatch(body, /OBA-3/);
  assert.equal(readEntries(root).length, 1); // legacy fallback untouched — needs --all
  rmSync(root, { recursive: true, force: true });
});

// BLZ-120: `--all` semantics MUST NOT CHANGE by this fix. An automated
// end-of-day flush relies on `--all` to drain every session queue PLUS the
// legacy shared fallback (still populated by stale/pre-fix entries, or
// anything an operator queues by hand) — a scheduled sole-committer job runs
// this as its entire job, so this must keep sweeping the fallback forever.
test("--all sweeps every queue + fallback into one commit with session-tagged body", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  for (const n of ["OBA-5", "OBA-6", "OBA-7"]) writeFileSync(join(root, "projects", "OBA", "backlog", `${n}.md`), n);
  appendEntry(root, { id: "OBA-5", op: "new", message: "OBA-5: a", files: ["projects/OBA/backlog/OBA-5.md"], ts: "t", session: "a" }, "a");
  appendEntry(root, { id: "OBA-6", op: "new", message: "OBA-6: b", files: ["projects/OBA/backlog/OBA-6.md"], ts: "t", session: "b" }, "b");
  appendEntry(root, { id: "OBA-7", op: "new", message: "OBA-7: legacy", files: ["projects/OBA/backlog/OBA-7.md"], ts: "t" });
  runCommit(root, null, { args: ["--all"] });
  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(subject, /\(3 new\)$/);
  assert.match(body, /OBA-5: a \[a\]/);
  assert.match(body, /OBA-6: b \[b\]/);
  assert.match(body, /- OBA-7: legacy(?!.*\[)/m);
  assert.deepEqual(readEntries(root, "a"), []);
  assert.deepEqual(readEntries(root, "b"), []);
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("warns (stderr) when origin/main is ahead, and still commits", () => {
  const root = gitRepo();
  // Fabricate an already-fetched origin/main one commit ahead of HEAD.
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-q", "-m", "remote-only"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  execFileSync("git", ["-C", root, "reset", "-q", "--hard", "HEAD~1"]);
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-9.md"), "x");
  appendEntry(root, { id: "OBA-9", op: "new", message: "OBA-9: x", files: ["projects/OBA/backlog/OBA-9.md"], ts: "t", session: "t1" }, "t1");
  const r = runCommit(root, null, { session: "t1" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /1 commit\(s\) behind origin\/main/);
  assert.match(r.stdout, /flushed 1 op/);
  rmSync(root, { recursive: true, force: true });
});

test("no warning when origin/main is absent", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-10.md"), "x");
  appendEntry(root, { id: "OBA-10", op: "new", message: "OBA-10: x", files: ["projects/OBA/backlog/OBA-10.md"], ts: "t", session: "t1" }, "t1");
  const r = runCommit(root, null, { session: "t1" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /behind origin\/main/);
  rmSync(root, { recursive: true, force: true });
});

// BLZ-119: an unrecognised flag was previously silently ignored, falling
// through to the real drain-and-commit path. `--help` on a non-empty queue
// must print usage and exit clean WITHOUT touching the queue or HEAD.
test("--help exits 0, prints usage, and leaves the queue + HEAD untouched", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-20.md"), "x");
  appendEntry(root, { id: "OBA-20", op: "new", message: "OBA-20: x", files: ["projects/OBA/backlog/OBA-20.md"], ts: "t" });
  const queue = ledgerPath(root);
  const beforeBytes = readFileSync(queue);
  const beforeHead = headOf(root);

  const r = runCommit(root, null, { args: ["--help"] });

  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage/i);
  assert.deepEqual(readFileSync(queue), beforeBytes, "queue file must be byte-identical");
  assert.equal(headOf(root), beforeHead, "HEAD must not move");
  rmSync(root, { recursive: true, force: true });
});

// BLZ-119: an unrecognised flag must be rejected outright, not silently
// dropped into the positional/queue-drain path.
test("--bogus exits non-zero, leaves the queue + HEAD untouched", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-21.md"), "x");
  appendEntry(root, { id: "OBA-21", op: "new", message: "OBA-21: x", files: ["projects/OBA/backlog/OBA-21.md"], ts: "t" });
  const queue = ledgerPath(root);
  const beforeBytes = readFileSync(queue);
  const beforeHead = headOf(root);

  const r = runCommit(root, null, { args: ["--bogus"] });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown flag: --bogus/);
  assert.deepEqual(readFileSync(queue), beforeBytes, "queue file must be byte-identical");
  assert.equal(headOf(root), beforeHead, "HEAD must not move");
  rmSync(root, { recursive: true, force: true });
});
