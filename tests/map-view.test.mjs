import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForest, layoutTree, NODE_H, ROW_H, PAD, ticketMatches, computeVisible } from "../scripts/map-view.mjs";

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

test("layoutTree: single orphan sits at the origin pad", () => {
  const l = layoutTree(buildForest([tk("A")]));
  assert.equal(l.nodes.length, 1);
  assert.equal(l.nodes[0].x, PAD);
  assert.equal(l.nodes[0].y, PAD);
  assert.equal(l.standaloneY, null); // no epics -> no separator needed
});

test("layoutTree: standalone divider sits below epics and above orphans", () => {
  const l = layoutTree(buildForest([tk("E"), tk("c", "E"), tk("O")]));
  const by = Object.fromEntries(l.nodes.map((n) => [n.ticket.id, n]));
  assert.ok(l.standaloneY != null);
  assert.ok(l.standaloneY > by.E.y, "divider below the epic tree");
  assert.ok(by.O.y > l.standaloneY, "orphan below the divider");
});

test("layoutTree: parent centers on its two children", () => {
  const l = layoutTree(buildForest([tk("E"), tk("C1", "E"), tk("C2", "E")]));
  const by = Object.fromEntries(l.nodes.map((n) => [n.ticket.id, n]));
  assert.equal(by.C1.depth, 1);
  assert.equal(by.E.depth, 0);
  assert.equal(by.E.y, (by.C1.y + by.C2.y) / 2);
  assert.deepEqual(l.edges, [{ from: "E", to: "C1" }, { from: "E", to: "C2" }]);
  assert.equal(l.standaloneY, null); // no orphans
});

test("layoutTree: a second tree never overlaps the first", () => {
  const l = layoutTree(
    buildForest([tk("E1"), tk("a", "E1"), tk("E2"), tk("b", "E2")]),
  );
  const by = Object.fromEntries(l.nodes.map((n) => [n.ticket.id, n]));
  assert.ok(by.E2.y > by.a.y, "second epic starts below first epic's child");
});

test("layoutTree: a parent cycle still places every node once", () => {
  const l = layoutTree(buildForest([tk("A", "B"), tk("B", "A")]));
  assert.equal(l.nodes.length, 2);
  assert.deepEqual(l.nodes.map((n) => n.ticket.id).sort(), ["A", "B"]);
});

const NOW = Date.parse("2026-06-28T00:00:00Z");
const at = (date, status = "todo") => ({ id: "x", parent: "", status, updated: date });

test("ticketMatches: window keeps recent, drops old, boundary inclusive", () => {
  assert.equal(ticketMatches(at("2026-06-28"), { window: 7, status: "all", now: NOW }), true);
  assert.equal(ticketMatches(at("2026-06-21"), { window: 7, status: "all", now: NOW }), true); // exactly 7d
  assert.equal(ticketMatches(at("2026-06-20"), { window: 7, status: "all", now: NOW }), false); // 8d
  assert.equal(ticketMatches(at("2020-01-01"), { window: null, status: "all", now: NOW }), true); // all
  assert.equal(ticketMatches(at("not-a-date"), { window: 7, status: "all", now: NOW }), false); // unparseable + window -> excluded
  assert.equal(ticketMatches(at("not-a-date"), { window: null, status: "all", now: NOW }), true); // null window skips parse
});

test("ticketMatches: status sets", () => {
  assert.equal(ticketMatches(at("2026-06-28", "in-progress"), { window: null, status: "active", now: NOW }), true);
  assert.equal(ticketMatches(at("2026-06-28", "backlog"), { window: null, status: "active", now: NOW }), false);
  assert.equal(ticketMatches(at("2026-06-28", "in-review"), { window: null, status: "inactive", now: NOW }), true);
  assert.equal(ticketMatches(at("2026-06-28", "todo"), { window: null, status: "inactive", now: NOW }), false);
});

test("ticketMatches: filters AND together", () => {
  // active but stale -> excluded by window
  assert.equal(ticketMatches(at("2020-01-01", "in-progress"), { window: 7, status: "active", now: NOW }), false);
});

const tree = [tk("E"), tk("C1", "E"), tk("C2", "E"), tk("G", "C1")];

test("computeVisible: matched child pulls in its epic as context", () => {
  const { visibleIds, contextOnlyIds } = computeVisible(tree, new Set(["C1"]));
  assert.deepEqual([...visibleIds].sort(), ["C1", "E"]);
  assert.deepEqual([...contextOnlyIds], ["E"]);
});

test("computeVisible: matched epic does NOT pull in its children", () => {
  const { visibleIds } = computeVisible(tree, new Set(["E"]));
  assert.deepEqual([...visibleIds], ["E"]);
});

test("computeVisible: whole ancestor chain is context", () => {
  const { visibleIds, contextOnlyIds } = computeVisible(tree, new Set(["G"]));
  assert.deepEqual([...visibleIds].sort(), ["C1", "E", "G"]);
  assert.deepEqual([...contextOnlyIds].sort(), ["C1", "E"]);
});

test("computeVisible: empty match is empty", () => {
  const { visibleIds } = computeVisible(tree, new Set());
  assert.equal(visibleIds.size, 0);
});
