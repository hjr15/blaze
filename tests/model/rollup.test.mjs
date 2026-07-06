import { test } from "node:test";
import assert from "node:assert/strict";
import { rollUp } from "../../scripts/model/rollup.mjs";

// Hand-built index stub: only `rows` is read by rollUp.
function idx(rows) { return { rows }; }

test("rolls leaves up through Epic into Goal (own-inclusive subtree sum)", () => {
  const m = rollUp(idx([
    { id: "G-1", type: "goal", parent: null, estimate: 0, worklog_minutes: 0 },
    { id: "E-1", type: "epic", parent: "G-1", estimate: 0, worklog_minutes: 0 },
    { id: "S-1", type: "story", parent: "E-1", estimate: 60, worklog_minutes: 30 },
    { id: "T-1", type: "task", parent: "E-1", estimate: 30, worklog_minutes: 0 },
  ]));
  assert.deepEqual(
    { ...m.get("E-1") },
    { own_estimate: 0, own_worklog: 0, rolled_estimate: 90, rolled_worklog: 30, descendant_count: 2 });
  assert.equal(m.get("G-1").rolled_estimate, 90);
  assert.equal(m.get("G-1").rolled_worklog, 30);
  assert.equal(m.get("G-1").descendant_count, 3);
  // Leaf: rolled == own, no descendants.
  assert.deepEqual(
    { ...m.get("S-1") },
    { own_estimate: 60, own_worklog: 30, rolled_estimate: 60, rolled_worklog: 30, descendant_count: 0 });
});

test("an Epic with its own estimate and no children rolls to its own time", () => {
  const m = rollUp(idx([
    { id: "G-1", type: "goal", parent: null, estimate: 0, worklog_minutes: 0 },
    { id: "E-9", type: "epic", parent: "G-1", estimate: 120, worklog_minutes: 45 },
  ]));
  assert.equal(m.get("E-9").rolled_estimate, 120);
  assert.equal(m.get("E-9").rolled_worklog, 45);
  assert.equal(m.get("E-9").descendant_count, 0);
  assert.equal(m.get("G-1").rolled_estimate, 120);   // own 0 + epic's own 120
  assert.equal(m.get("G-1").rolled_worklog, 45);
});

test("null estimates contribute 0; an empty subtree rolls to 0 (not null)", () => {
  const m = rollUp(idx([
    { id: "E-1", type: "epic", parent: null, estimate: null, worklog_minutes: 0 },
    { id: "T-1", type: "task", parent: "E-1", estimate: null, worklog_minutes: 0 },
  ]));
  assert.equal(m.get("E-1").own_estimate, 0);
  assert.equal(m.get("E-1").rolled_estimate, 0);
});

test("an orphan-parent row is treated as a root and counts its own time", () => {
  const m = rollUp(idx([
    { id: "T-1", type: "task", parent: "GHOST-1", estimate: 25, worklog_minutes: 10 },
  ]));
  assert.equal(m.get("T-1").rolled_estimate, 25);
  assert.equal(m.get("T-1").rolled_worklog, 10);
  assert.equal(m.get("T-1").descendant_count, 0);
});

test("a parent cycle does not hang and each node is counted once", () => {
  // Malformed: A↔B point at each other. rollUp must terminate.
  const m = rollUp(idx([
    { id: "A", type: "epic", parent: "B", estimate: 10, worklog_minutes: 0 },
    { id: "B", type: "epic", parent: "A", estimate: 20, worklog_minutes: 0 },
  ]));
  assert.ok(m.has("A") && m.has("B"));
  // Each node's subtree sum is finite and does not double-count itself.
  assert.equal(m.get("A").rolled_estimate, 30);   // A.own 10 + B.own 20, B not re-expanded into A
  assert.equal(m.get("B").rolled_estimate, 30);
});
