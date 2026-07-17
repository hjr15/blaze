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
  // Unset BLAZE_SESSION now auto-derives a queue from ppid — not the legacy fallback.
  const entries = readEntries(root, sessionId({}));
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

// BLZ-120: unset BLAZE_SESSION must NOT land in the shared legacy fallback —
// it gets its own auto-derived queue (and a matching `session` field), same
// as an explicit session would.
test("batch mode without BLAZE_SESSION queues to an auto-derived session, not the legacy fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  const prev = process.env.BLAZE_SESSION;
  delete process.env.BLAZE_SESSION;
  try {
    commitOrQueue({ root, mode: "batch", op: "new", id: "X-2", message: "X-2: create", files: [join(root, "projects/X/backlog/X-2.md")] });
  } finally {
    if (prev !== undefined) process.env.BLAZE_SESSION = prev;
  }
  assert.deepEqual(readEntries(root), []); // legacy fallback untouched
  const auto = sessionId({});
  const entries = readEntries(root, auto);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, auto);
  rmSync(root, { recursive: true, force: true });
});
