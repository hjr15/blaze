import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForest } from "../scripts/map-view.mjs";

const tk = (id, parent = "") => ({ id, parent, status: "todo", updated: "2026-06-28" });

test("buildForest: flat orphans are all roots", () => {
  const f = buildForest([tk("A"), tk("B")]);
  assert.deepEqual(f.roots.map((t) => t.id), ["A", "B"]);
  assert.equal(f.childrenOf.size, 0);
  assert.equal(f.epicIds.size, 0);
});

test("buildForest: epic with two children", () => {
  const f = buildForest([tk("E"), tk("C1", "E"), tk("C2", "E")]);
  assert.deepEqual(f.roots.map((t) => t.id), ["E"]);
  assert.deepEqual(f.childrenOf.get("E").map((t) => t.id), ["C1", "C2"]);
  assert.ok(f.epicIds.has("E"));
  assert.equal(f.byId.get("E").id, "E");
  assert.equal(f.byId.size, 3);
});

test("buildForest: unresolvable or self parent becomes a root", () => {
  const f = buildForest([tk("A", "GHOST"), tk("B", "B")]);
  assert.deepEqual(f.roots.map((t) => t.id).sort(), ["A", "B"]);
});
