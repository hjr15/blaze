import { test } from "node:test";
import assert from "node:assert/strict";
import { focusScope } from "../../scripts/model/focus.mjs";

function fakeIndex(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, get: (id) => byId.get(id) };
}

const idx = fakeIndex([
  { id: "G", parent: null, title: "goal" },
  { id: "E", parent: "G", title: "epic" },
  { id: "T1", parent: "E", title: "t1" },
  { id: "T2", parent: "E", title: "t2" },
  { id: "S1", parent: "T1", title: "s1" },
]);

test("crumbs walk root→focus inclusive", () => {
  assert.deepEqual(focusScope(idx, "E").crumbs.map((c) => c.id), ["G", "E"]);
});
test("descendants are transitive and exclude the focus node", () => {
  const d = focusScope(idx, "E").descendantIds;
  assert.deepEqual([...d].sort(), ["S1", "T1", "T2"]);
  assert.equal(d.has("E"), false);
});
test("unknown id degrades to empty scope", () => {
  const r = focusScope(idx, "NOPE");
  assert.deepEqual(r.crumbs, []);
  assert.equal(r.descendantIds.size, 0);
});
test("descendant traversal excludes focus id under a cyclic parent graph", () => {
  const cyclic = fakeIndex([
    { id: "A", parent: "B", title: "a" },
    { id: "B", parent: "A", title: "b" },
  ]);
  const { descendantIds } = focusScope(cyclic, "A");
  assert.equal(descendantIds.has("A"), false);
  assert.deepEqual([...descendantIds].sort(), ["B"]);
});
test("focusScope exposes direct children separately from descendants", () => {
  // G-1 ← E-1 ← T-1 ; G-1 ← E-2
  const idx = fakeIndex([
    { id: "G-1", parent: null }, { id: "E-1", parent: "G-1" },
    { id: "E-2", parent: "G-1" }, { id: "T-1", parent: "E-1" },
  ]);
  const s = focusScope(idx, "G-1");
  assert.deepEqual([...s.childrenIds].sort(), ["E-1", "E-2"]);
  assert.deepEqual([...s.descendantIds].sort(), ["E-1", "E-2", "T-1"]);
});
