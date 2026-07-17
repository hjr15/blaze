import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPath, appendEntry, readEntries, clearLedger, readForDrain } from "../scripts/pending-ledger.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "blaze-ledger-")); }

test("readEntries returns [] when the ledger is absent", () => {
  const root = tmp();
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("appendEntry creates .blaze and readEntries round-trips", () => {
  const root = tmp();
  const e1 = { id: "OBA-400", op: "log", message: "OBA-400: log 180m", files: ["projects/OBA/in-progress/OBA-400.md"], ts: "2026-07-03T12:00:00+10:00" };
  const e2 = { id: "OBA-400", op: "move", message: "OBA-400: in-progress → in-review", files: ["projects/OBA/in-progress/OBA-400.md", "projects/OBA/in-review/OBA-400.md"], ts: "2026-07-03T12:01:00+10:00" };
  appendEntry(root, e1);
  appendEntry(root, e2);
  assert.ok(existsSync(ledgerPath(root)));
  assert.deepEqual(readEntries(root), [e1, e2]);
  rmSync(root, { recursive: true, force: true });
});

test("clearLedger empties the ledger", () => {
  const root = tmp();
  appendEntry(root, { id: "X-1", op: "new", message: "X-1: create task", files: ["projects/X/backlog/X-1.md"], ts: "t" });
  clearLedger(root);
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("clearLedger with no third arg still empties fully (back-compat)", () => {
  const root = tmp();
  appendEntry(root, { id: "X-1", op: "new", message: "X-1: create task", files: ["projects/X/backlog/X-1.md"], ts: "t" });
  appendEntry(root, { id: "X-2", op: "new", message: "X-2: create task", files: ["projects/X/backlog/X-2.md"], ts: "t" });
  clearLedger(root, null); // explicit session, no consumedBytes
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});

test("readForDrain returns entries plus the exact byte length of the file", () => {
  const root = tmp();
  const e1 = { id: "X-1", op: "new", message: "X-1: create task", files: ["projects/X/backlog/X-1.md"], ts: "t" };
  appendEntry(root, e1);
  const { entries, bytes } = readForDrain(root);
  assert.deepEqual(entries, [e1]);
  assert.equal(bytes, Buffer.byteLength(readFileSync(ledgerPath(root), "utf8")));
  rmSync(root, { recursive: true, force: true });
});

test("readForDrain on an absent ledger returns empty entries and zero bytes", () => {
  const root = tmp();
  assert.deepEqual(readForDrain(root), { entries: [], bytes: 0 });
  rmSync(root, { recursive: true, force: true });
});

test("drain-exact: an op appended after the drain read survives clearLedger(bytes)", () => {
  const root = tmp();
  const op1 = { id: "X-1", op: "new", message: "X-1: create task", files: ["projects/X/backlog/X-1.md"], ts: "t1" };
  const op2 = { id: "X-2", op: "new", message: "X-2: create task (late, mid-drain)", files: ["projects/X/backlog/X-2.md"], ts: "t2" };
  appendEntry(root, op1);
  const { entries, bytes } = readForDrain(root);
  assert.deepEqual(entries, [op1]);
  appendEntry(root, op2); // simulates another session appending while the drainer is mid-commit
  clearLedger(root, null, bytes);
  assert.deepEqual(readEntries(root), [op2]); // only the late op survives
  rmSync(root, { recursive: true, force: true });
});

test("drain-exact: bytes measured on the raw buffer — a trailing partial multibyte char must not inflate the offset", () => {
  const root = tmp();
  const op1 = { id: "X-1", op: "new", message: "X-1: create task", files: ["projects/X/backlog/X-1.md"], ts: "t1" };
  const op2 = { id: "X-2", op: "new", message: "X-2: late op after crash residue", files: ["projects/X/backlog/X-2.md"], ts: "t2" };
  appendEntry(root, op1);
  // Process killed mid-append: raw partial UTF-8 on disk (0xe6 is a 3-byte
  // lead with no continuation bytes), no trailing newline. Decoding turns the
  // invalid byte into U+FFFD, which RE-encodes at 3 bytes — so measuring bytes
  // on the decoded string overstates the on-disk length by 2 here, and a later
  // clearLedger(bytes) subarray would chop the head off the next line.
  appendFileSync(ledgerPath(root), Buffer.from([0x7b, 0x22, 0xe6]));
  const { entries, bytes } = readForDrain(root);
  assert.deepEqual(entries, [op1]); // the corrupt partial line is skipped
  assert.equal(bytes, Buffer.byteLength(JSON.stringify(op1) + "\n") + 3); // raw on-disk bytes, not re-encoded length
  // The late op lands on its own clean line after the crash residue.
  appendFileSync(ledgerPath(root), "\n");
  appendEntry(root, op2);
  clearLedger(root, null, bytes);
  assert.deepEqual(readEntries(root), [op2]); // op2 survives intact — no head-chop
  rmSync(root, { recursive: true, force: true });
});

test("readEntries tolerates a trailing partial/corrupt line", () => {
  const root = tmp();
  appendEntry(root, { id: "X-1", op: "new", message: "X-1: create task", files: ["projects/X/backlog/X-1.md"], ts: "t" });
  // Simulate a process killed mid-append: a partial JSON line with no newline.
  appendFileSync(ledgerPath(root), '{"id":"X-2","op":"log"');
  const entries = readEntries(root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, "X-1");
  rmSync(root, { recursive: true, force: true });
});

import { sessionId, listQueues } from "../scripts/pending-ledger.mjs";

// BLZ-120: unset/empty-after-sanitize no longer returns null (which routed
// both write and read to the shared fallback for EVERY such caller) — it
// auto-derives from ppid instead, so sessions isolate by default. The
// optional second param exists purely so tests can inject a ppid instead of
// forking a real process.
test("sessionId: set and sanitized BLAZE_SESSION values pass through unchanged", () => {
  assert.equal(sessionId({ BLAZE_SESSION: "alpha-1" }), "alpha-1");
  assert.equal(sessionId({ BLAZE_SESSION: "a b/c$!" }), "abc");
});

test("sessionId: empty-after-sanitize and fully-unset both auto-derive from ppid", () => {
  assert.equal(sessionId({ BLAZE_SESSION: "$$/ " }, 4242), "auto-4242");
  assert.equal(sessionId({}, 4242), "auto-4242");
});

test("sessionId: an explicit BLAZE_SESSION always wins over the ppid-derived fallback", () => {
  assert.equal(sessionId({ BLAZE_SESSION: "explicit" }, 99999), "explicit");
});

test("sessionId: defaults to the real process.ppid when no override is given", () => {
  assert.equal(sessionId({}), `auto-${process.ppid}`);
});

test("ledgerPath: session-keyed vs legacy fallback", () => {
  assert.match(ledgerPath("/r"), /\.blaze\/pending-commit\.jsonl$/);
  assert.match(ledgerPath("/r", "alpha"), /\.blaze\/pending\/alpha\.jsonl$/);
});

test("session queues are isolated from each other and the fallback", () => {
  const root = tmp();
  const mk = (id, session) => ({ id, op: "new", message: `${id}: create`, files: [`projects/X/backlog/${id}.md`], ts: "t", ...(session ? { session } : {}) });
  appendEntry(root, mk("X-1", "a"), "a");
  appendEntry(root, mk("X-2", "b"), "b");
  appendEntry(root, mk("X-3", null));
  assert.equal(readEntries(root, "a").length, 1);
  assert.equal(readEntries(root, "a")[0].id, "X-1");
  assert.equal(readEntries(root, "b")[0].id, "X-2");
  assert.equal(readEntries(root)[0].id, "X-3");
  clearLedger(root, "a");
  assert.deepEqual(readEntries(root, "a"), []);
  assert.equal(readEntries(root, "b").length, 1);
  assert.equal(readEntries(root).length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("listQueues: fallback first, then session queues sorted", () => {
  const root = tmp();
  assert.deepEqual(listQueues(root), []);
  // "main" vs "main-2" catches filename-vs-name sorting: as filenames,
  // "main-2.jsonl" < "main.jsonl" ('-' < '.'), but as names "main" < "main-2".
  appendEntry(root, { id: "X-2", op: "new", message: "m", files: [], ts: "t", session: "main-2" }, "main-2");
  appendEntry(root, { id: "X-1", op: "new", message: "m", files: [], ts: "t", session: "main" }, "main");
  appendEntry(root, { id: "X-4", op: "new", message: "m", files: [], ts: "t", session: "alpha" }, "alpha");
  appendEntry(root, { id: "X-3", op: "new", message: "m", files: [], ts: "t" });
  const qs = listQueues(root);
  assert.deepEqual(qs.map((q) => q.session), [null, "alpha", "main", "main-2"]);
  assert.ok(qs.every((q) => q.path.endsWith(".jsonl")));
  rmSync(root, { recursive: true, force: true });
});
