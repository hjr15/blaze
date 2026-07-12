import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerPath, appendEntry, readEntries, clearLedger } from "../scripts/pending-ledger.mjs";

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

test("sessionId: set, dirty, empty, unset", () => {
  assert.equal(sessionId({ BLAZE_SESSION: "alpha-1" }), "alpha-1");
  assert.equal(sessionId({ BLAZE_SESSION: "a b/c$!" }), "abc");
  assert.equal(sessionId({ BLAZE_SESSION: "$$/ " }), null);
  assert.equal(sessionId({}), null);
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
  appendEntry(root, { id: "X-2", op: "new", message: "m", files: [], ts: "t", session: "beta" }, "beta");
  appendEntry(root, { id: "X-1", op: "new", message: "m", files: [], ts: "t", session: "alpha" }, "alpha");
  appendEntry(root, { id: "X-3", op: "new", message: "m", files: [], ts: "t" });
  const qs = listQueues(root);
  assert.deepEqual(qs.map((q) => q.session), [null, "alpha", "beta"]);
  assert.ok(qs.every((q) => q.path.endsWith(".jsonl")));
  rmSync(root, { recursive: true, force: true });
});
