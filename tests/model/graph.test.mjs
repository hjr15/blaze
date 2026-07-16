import { test } from "node:test";
import assert from "node:assert/strict";
import { neighbourhood, layoutNeighbourhood, graphModel } from "../../scripts/model/graph.mjs";

// Index shim: rows + links, get() by id.
function fullIdx(rows, links = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, links, get: (id) => byId.get(id) };
}
const T = (id, type = "task", project = "A") =>
  ({ id, type, title: id.toLowerCase(), status: "todo", project, parent: null });

// ---- neighbourhood: role selection ----------------------------------------

test("neighbourhood: an incoming Blocks (target=focus) puts the blocker UPSTREAM", () => {
  const i = fullIdx([T("A-1"), T("A-2")], [{ src: "A-2", type: "Blocks", target: "A-1" }]);
  const nb = neighbourhood(i, "A-1");
  assert.equal(nb.nodes.find((n) => n.id === "A-2").role, "upstream");
  // directed edge points blocker -> blocked (A-2 -> A-1)
  assert.deepEqual(nb.edges, [{ src: "A-2", target: "A-1", type: "Blocks", directed: true }]);
});

test("neighbourhood: an outgoing Blocks (src=focus) puts the blocked ticket DOWNSTREAM", () => {
  const i = fullIdx([T("A-1"), T("A-2")], [{ src: "A-1", type: "Blocks", target: "A-2" }]);
  const nb = neighbourhood(i, "A-1");
  assert.equal(nb.nodes.find((n) => n.id === "A-2").role, "downstream");
  assert.deepEqual(nb.edges, [{ src: "A-1", target: "A-2", type: "Blocks", directed: true }]);
});

test("neighbourhood: upstream and downstream are NOT swapped (direction discriminating)", () => {
  // A-2 blocks focus (upstream); focus blocks A-3 (downstream). A test that
  // passed with src/target swapped would be non-discriminating — assert the
  // specific id lands in the specific role.
  const i = fullIdx([T("A-1"), T("A-2"), T("A-3")], [
    { src: "A-2", type: "Blocks", target: "A-1" },
    { src: "A-1", type: "Blocks", target: "A-3" },
  ]);
  const nb = neighbourhood(i, "A-1");
  assert.equal(nb.nodes.find((n) => n.id === "A-2").role, "upstream");
  assert.equal(nb.nodes.find((n) => n.id === "A-3").role, "downstream");
});

test("neighbourhood: Relates/Duplicate/Cloners → related, undirected", () => {
  const i = fullIdx([T("A-1"), T("A-2"), T("A-3"), T("A-4")], [
    { src: "A-1", type: "Relates", target: "A-2" },
    { src: "A-3", type: "Duplicate", target: "A-1" },
    { src: "A-1", type: "Cloners", target: "A-4" },
  ]);
  const nb = neighbourhood(i, "A-1");
  assert.deepEqual(nb.nodes.filter((n) => n.role === "related").map((n) => n.id).sort(), ["A-2", "A-3", "A-4"]);
  assert.ok(nb.edges.every((e) => e.directed === false));
});

test("neighbourhood: a node that is both blocker and blocked de-dupes to ONE role (upstream wins)", () => {
  const i = fullIdx([T("A-1"), T("A-2")], [
    { src: "A-2", type: "Blocks", target: "A-1" }, // A-2 upstream
    { src: "A-1", type: "Blocks", target: "A-2" }, // A-2 also downstream (cycle)
  ]);
  const nb = neighbourhood(i, "A-1");
  assert.equal(nb.nodes.filter((n) => n.id === "A-2").length, 1);
  assert.equal(nb.nodes.find((n) => n.id === "A-2").role, "upstream");
});

test("neighbourhood: a self-link (src === target === focus) is skipped, no duplicate anchor node", () => {
  const i = fullIdx([T("A-1"), T("A-2")], [
    { src: "A-1", type: "Blocks", target: "A-1" }, // pathological self-link
    { src: "A-2", type: "Blocks", target: "A-1" }, // one real neighbour
  ]);
  const nb = neighbourhood(i, "A-1");
  assert.equal(nb.nodes.filter((n) => n.id === "A-1").length, 1);
  assert.equal(nb.edges.filter((e) => e.src === e.target).length, 0);
});

test("neighbourhood: the anchor node is present, marked anchor, and first", () => {
  const i = fullIdx([T("A-1"), T("A-2")], [{ src: "A-1", type: "Blocks", target: "A-2" }]);
  const nb = neighbourhood(i, "A-1");
  assert.equal(nb.nodes[0].id, "A-1");
  assert.equal(nb.nodes[0].anchor, true);
  assert.equal(nb.anchor.id, "A-1");
});

test("neighbourhood: links not involving the focus are ignored", () => {
  const i = fullIdx([T("A-1"), T("A-2"), T("A-3")], [{ src: "A-2", type: "Blocks", target: "A-3" }]);
  const nb = neighbourhood(i, "A-1");
  assert.deepEqual(nb.nodes.map((n) => n.id), ["A-1"]); // only the anchor
  assert.deepEqual(nb.edges, []);
});

// ---- neighbourhood: unresolved --------------------------------------------

test("neighbourhood: a dangling target (id absent from index) goes to unresolved, no phantom node", () => {
  const i = fullIdx([T("A-1")], [{ src: "A-1", type: "Blocks", target: "GONE-9" }]);
  const nb = neighbourhood(i, "A-1");
  assert.equal(nb.nodes.find((n) => n.id === "GONE-9"), undefined);
  assert.deepEqual(nb.unresolved, [{ type: "Blocks", target: "GONE-9" }]);
  assert.deepEqual(nb.edges, []);
});

test("neighbourhood: a malformed anchor link (no target) goes to unresolved", () => {
  // index.mjs builds { src, type: undefined, target: undefined } for a
  // 'malformed link entry (not an object)'. It belongs to the anchor (src=focus).
  const i = fullIdx([T("A-1")], [{ src: "A-1", type: undefined, target: undefined }]);
  const nb = neighbourhood(i, "A-1");
  assert.deepEqual(nb.unresolved, [{ type: null, target: null }]);
  assert.deepEqual(nb.nodes.map((n) => n.id), ["A-1"]);
});

test("neighbourhood: no focus / focus absent from index → empty anchor", () => {
  const i = fullIdx([T("A-1")]);
  assert.deepEqual(neighbourhood(i, null), { anchor: null, nodes: [], edges: [], unresolved: [] });
  assert.deepEqual(neighbourhood(i, "NOPE-1"), { anchor: null, nodes: [], edges: [], unresolved: [] });
});

// ---- layoutNeighbourhood: role columns ------------------------------------

test("layoutNeighbourhood: upstream is LEFT of anchor is LEFT of downstream", () => {
  const i = fullIdx([T("A-1"), T("A-2"), T("A-3")], [
    { src: "A-2", type: "Blocks", target: "A-1" },
    { src: "A-1", type: "Blocks", target: "A-3" },
  ]);
  const L = layoutNeighbourhood(neighbourhood(i, "A-1"));
  const x = (id) => L.nodes.find((n) => n.id === id).x;
  assert.ok(x("A-2") < x("A-1"), "upstream left of anchor");
  assert.ok(x("A-1") < x("A-3"), "anchor left of downstream");
});

test("layoutNeighbourhood: a forward Blocks edge runs left→right (x1 < x2), arrow toward the blocked", () => {
  const i = fullIdx([T("A-1"), T("A-2")], [{ src: "A-2", type: "Blocks", target: "A-1" }]);
  const L = layoutNeighbourhood(neighbourhood(i, "A-1"));
  const e = L.edges[0];
  assert.equal(e.directed, true);
  assert.ok(e.x1 < e.x2, "edge points from upstream blocker (left) to anchor (right)");
});

test("layoutNeighbourhood: related sits BELOW the anchor", () => {
  const i = fullIdx([T("A-1"), T("A-2")], [{ src: "A-1", type: "Relates", target: "A-2" }]);
  const L = layoutNeighbourhood(neighbourhood(i, "A-1"));
  const y = (id) => L.nodes.find((n) => n.id === id).y;
  assert.ok(y("A-2") > y("A-1"), "related node is below the anchor");
});

test("layoutNeighbourhood: anchor-only (no links) yields sane dims and a single node", () => {
  const i = fullIdx([T("A-1")]);
  const L = layoutNeighbourhood(neighbourhood(i, "A-1"));
  assert.equal(L.nodes.length, 1);
  assert.equal(L.anchor.id, "A-1");
  assert.ok(L.width > 0 && L.height > 0);
});

test("layoutNeighbourhood: no anchor → empty nodes, sane dims, anchor null", () => {
  const L = layoutNeighbourhood({ anchor: null, nodes: [], edges: [], unresolved: [] });
  assert.deepEqual(L.nodes, []);
  assert.equal(L.anchor, null);
  assert.ok(L.width > 0 && L.height > 0);
});

test("layoutNeighbourhood: deterministic (same input → identical output)", () => {
  const nb = neighbourhood(
    fullIdx([T("A-1"), T("A-2"), T("A-3")], [
      { src: "A-2", type: "Blocks", target: "A-1" },
      { src: "A-1", type: "Relates", target: "A-3" },
    ]),
    "A-1",
  );
  assert.deepEqual(layoutNeighbourhood(nb), layoutNeighbourhood(nb));
});

test("layoutNeighbourhood: unresolved is passed through", () => {
  const nb = neighbourhood(fullIdx([T("A-1")], [{ src: "A-1", type: "Blocks", target: "GONE-9" }]), "A-1");
  assert.deepEqual(layoutNeighbourhood(nb).unresolved, [{ type: "Blocks", target: "GONE-9" }]);
});

// ---- graphModel: FS wrapper ------------------------------------------------

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-nb-"));
  mkdirSync(join(dir, "A", "todo"), { recursive: true });
  writeFileSync(join(dir, "A", "todo", "A-1.md"),
    "---\nid: A-1\ntitle: one\ntype: task\nproject: A\nlinks:\n  - { type: Blocks, target: A-2 }\n---\nbody\n");
  writeFileSync(join(dir, "A", "todo", "A-2.md"),
    "---\nid: A-2\ntitle: two\ntype: task\nproject: A\n---\nbody\n");
  return dir;
}

test("graphModel: reads disk, builds the focused neighbourhood", () => {
  const gm = graphModel({ projectsDir: fixtureDir(), focus: "A-1" });
  assert.equal(gm.anchor.id, "A-1");
  assert.equal(gm.nodes.find((n) => n.id === "A-2").role, "downstream");
});

test("graphModel: a passed index short-circuits the disk walk", () => {
  const gm = graphModel({
    projectsDir: "/nonexistent-should-not-be-read",
    index: fullIdx([T("Z-1"), T("Z-2")], [{ src: "Z-2", type: "Blocks", target: "Z-1" }]),
    focus: "Z-1",
  });
  assert.equal(gm.nodes.find((n) => n.id === "Z-2").role, "upstream");
});

test("graphModel: no focus → empty-shaped result with anchor null", () => {
  const gm = graphModel({ projectsDir: "/nonexistent", index: fullIdx([T("Z-1")]) });
  assert.equal(gm.anchor, null);
  assert.deepEqual(gm.nodes, []);
});
