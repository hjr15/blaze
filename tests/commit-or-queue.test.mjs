import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { commitOrQueue } from "../scripts/commit-or-queue.mjs";
import { readEntries, sessionId } from "../scripts/pending-ledger.mjs";

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "seed"), "seed");
  execFileSync("git", ["-C", root, "add", "seed"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

test("batch mode appends to the ledger and makes no commit", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  const f = join(root, "projects", "OBA", "backlog", "OBA-1.md");
  writeFileSync(f, "one");
  const before = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const prev = process.env.BLAZE_SESSION;
  delete process.env.BLAZE_SESSION;
  let r;
  try {
    r = commitOrQueue({ root, mode: "batch", op: "new", id: "OBA-1", message: "OBA-1: create task", files: [f] });
  } finally {
    if (prev !== undefined) process.env.BLAZE_SESSION = prev;
  }

  assert.deepEqual(r, { ok: true, queued: true });
  const after = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(before, after, "HEAD must not move in batch mode");
  // Whatever commitOrQueue's own sessionId() resolved to for this process's
  // real env (harness-derived if CLAUDE_CODE_SESSION_ID is set, else null ->
  // the fallback) — compute it the same way, rather than hard-coding a shape.
  const entries = readEntries(root, sessionId(process.env));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].message, "OBA-1: create task");
  assert.deepEqual(entries[0].files, ["projects/OBA/backlog/OBA-1.md"]); // root-relative
  rmSync(root, { recursive: true, force: true });
});

test("per-op mode commits only the given files", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  const f = join(root, "projects", "OBA", "backlog", "OBA-1.md");
  writeFileSync(f, "one");
  writeFileSync(join(root, "untracked-other"), "should NOT be committed");

  const r = commitOrQueue({ root, mode: "per-op", op: "new", id: "OBA-1", message: "OBA-1: create task", files: [f] });

  assert.equal(r.ok, true);
  const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  assert.match(status, /\?\? untracked-other/); // not swept in
  assert.doesNotMatch(status, /OBA-1\.md/);      // committed
  rmSync(root, { recursive: true, force: true });
});

test("batch mode routes to the session queue and stamps session", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  const prev = process.env.BLAZE_SESSION;
  process.env.BLAZE_SESSION = "alpha";
  try {
    commitOrQueue({ root, mode: "batch", op: "new", id: "X-1", message: "X-1: create", files: [join(root, "projects/X/backlog/X-1.md")] });
  } finally {
    if (prev === undefined) delete process.env.BLAZE_SESSION; else process.env.BLAZE_SESSION = prev;
  }
  assert.deepEqual(readEntries(root), []); // fallback untouched
  const entries = readEntries(root, "alpha");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, "alpha");
  assert.equal(entries[0].id, "X-1");
  rmSync(root, { recursive: true, force: true });
});

// BLZ-120: unset BLAZE_SESSION but a harness id present must NOT land in the
// shared legacy fallback — it gets its own auto-derived queue (and a matching
// `session` field), same as an explicit session would. CLAUDE_CODE_SESSION_ID
// is pinned to a known value so this is deterministic regardless of whatever
// ambient env the test happens to run under.
test("batch mode without BLAZE_SESSION but with a harness id queues to an auto-derived session, not the legacy fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  const prevSession = process.env.BLAZE_SESSION;
  const prevHarness = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.BLAZE_SESSION;
  process.env.CLAUDE_CODE_SESSION_ID = "test-harness-uuid";
  try {
    commitOrQueue({ root, mode: "batch", op: "new", id: "X-2", message: "X-2: create", files: [join(root, "projects/X/backlog/X-2.md")] });
  } finally {
    if (prevSession !== undefined) process.env.BLAZE_SESSION = prevSession; else delete process.env.BLAZE_SESSION;
    if (prevHarness !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prevHarness; else delete process.env.CLAUDE_CODE_SESSION_ID;
  }
  assert.deepEqual(readEntries(root), []); // legacy fallback untouched
  const auto = "auto-test-harness-uuid";
  const entries = readEntries(root, auto);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, auto);
  rmSync(root, { recursive: true, force: true });
});

// BLZ-120: neither BLAZE_SESSION nor a harness id present — sessionId() is
// null, so batch mode restores the pre-BLZ-120 behaviour for non-harness
// callers: queue to the shared legacy fallback (no `session` field stamped).
test("batch mode with neither BLAZE_SESSION nor a harness id queues to the shared legacy fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  const prevSession = process.env.BLAZE_SESSION;
  const prevHarness = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.BLAZE_SESSION;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    commitOrQueue({ root, mode: "batch", op: "new", id: "X-3", message: "X-3: create", files: [join(root, "projects/X/backlog/X-3.md")] });
  } finally {
    if (prevSession !== undefined) process.env.BLAZE_SESSION = prevSession;
    if (prevHarness !== undefined) process.env.CLAUDE_CODE_SESSION_ID = prevHarness;
  }
  const entries = readEntries(root); // the shared fallback, no session arg
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "X-3");
  assert.ok(!("session" in entries[0]), "no session field stamped when there is no identity");
  rmSync(root, { recursive: true, force: true });
});
