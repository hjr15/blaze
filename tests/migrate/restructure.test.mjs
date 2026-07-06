// tests/migrate/restructure.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeStructure } from "../../scripts/migrate/restructure.mjs";

const N = (key, type, parent = null, links = []) =>
  ({ key, type, parent, links, project: key.split("-")[0] });

test("keeps a legal native parent", () => {
  const { parents } = proposeStructure([N("OBA-1", "Goal"), N("OBA-2", "Epic", "OBA-1")]);
  assert.equal(parents.get("OBA-2"), "OBA-1");
});

test("normalises an OBA Goal↔Epic Relates link into a native parent", () => {
  const r = proposeStructure([
    N("OBA-1", "Goal", null, [{ type: "Relates", target: "OBA-2" }]),
    N("OBA-2", "Epic", null, [{ type: "Relates", target: "OBA-1" }]),
  ]);
  assert.equal(r.parents.get("OBA-2"), "OBA-1");            // Epic adopts the Goal as parent
  assert.ok(r.flags.relatesNormalised.includes("OBA-2"));
});

test("flags an orphan child with no resolvable parent", () => {
  const r = proposeStructure([N("OBA-5", "Task")]);          // task needs an epic parent
  assert.equal(r.parents.get("OBA-5"), null);
  assert.ok(r.flags.orphans.includes("OBA-5"));
});

test("flags a mis-levelled native parent and clears it", () => {
  const r = proposeStructure([N("OBA-1", "Goal"), N("OBA-7", "Task", "OBA-1")]); // task→goal illegal
  assert.equal(r.parents.get("OBA-7"), null);
  assert.ok(r.flags.misLevelled.includes("OBA-7"));
});

test("flags ambiguity when multiple legal Relates parents exist", () => {
  const r = proposeStructure([
    N("OBA-1", "Epic"), N("OBA-2", "Epic"),
    N("OBA-3", "Task", null, [{ type: "Relates", target: "OBA-1" }, { type: "Relates", target: "OBA-2" }]),
  ]);
  assert.ok(r.flags.ambiguous.includes("OBA-3"));
});

test("a Goal with no parent is not an orphan", () => {
  const r = proposeStructure([N("OBA-1", "Goal")]);
  assert.equal(r.flags.orphans.includes("OBA-1"), false);
});
