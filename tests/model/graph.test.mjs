import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../../scripts/model/graph.mjs";

function idx(rows, links = []) { return { rows, links }; }

test("buildGraph: nodes carry id/type/title/status/project/level", () => {
  const g = buildGraph(idx([
    { id: "A-1", type: "epic", title: "Epic one", status: "defined", project: "A", parent: null },
  ]));
  assert.deepEqual(g.nodes, [
    { id: "A-1", type: "epic", title: "Epic one", status: "defined", project: "A", level: 1 },
  ]);
});

test("buildGraph: parent edge is solid (kind=parent), child→parent", () => {
  const g = buildGraph(idx([
    { id: "A-1", type: "epic", title: "e", status: "defined", project: "A", parent: null },
    { id: "A-2", type: "task", title: "t", status: "todo", project: "A", parent: "A-1" },
  ]));
  const parents = g.edges.filter((e) => e.kind === "parent");
  assert.equal(parents.length, 1);
  assert.deepEqual(parents[0], { src: "A-2", target: "A-1", kind: "parent" });
});

test("buildGraph: dangling parent (target not a node) is dropped", () => {
  const g = buildGraph(idx([
    { id: "A-2", type: "task", title: "t", status: "todo", project: "A", parent: "GONE-9" },
  ]));
  assert.equal(g.edges.length, 0);
});

test("buildGraph: link edge is dashed+labelled (kind=link, label=type)", () => {
  const g = buildGraph(idx(
    [
      { id: "A-1", type: "task", title: "a", status: "todo", project: "A", parent: null },
      { id: "A-2", type: "task", title: "b", status: "todo", project: "A", parent: null },
    ],
    [{ src: "A-1", type: "Blocks", target: "A-2" }],
  ));
  const links = g.edges.filter((e) => e.kind === "link");
  assert.deepEqual(links, [{ src: "A-1", target: "A-2", kind: "link", label: "Blocks" }]);
});

test("buildGraph: dangling link (src or target missing) is dropped", () => {
  const g = buildGraph(idx(
    [{ id: "A-1", type: "task", title: "a", status: "todo", project: "A", parent: null }],
    [{ src: "A-1", type: "Blocks", target: "GONE-9" }],
  ));
  assert.equal(g.edges.filter((e) => e.kind === "link").length, 0);
});

test("buildGraph: unknown/null type falls back to level -2 without throwing", () => {
  const g = buildGraph(idx([
    { id: "A-1", type: "widget", title: "w", status: "todo", project: "A", parent: null },
    { id: "A-2", type: null, title: "n", status: "todo", project: "A", parent: null },
  ]));
  assert.equal(g.nodes.find((n) => n.id === "A-1").level, -2);
  assert.equal(g.nodes.find((n) => n.id === "A-2").level, -2);
});

test("buildGraph: nodes sorted level desc, project asc, id asc", () => {
  const g = buildGraph(idx([
    { id: "B-1", type: "task", title: "t", status: "todo", project: "B", parent: null },
    { id: "A-1", type: "goal", title: "g", status: "defined", project: "A", parent: null },
    { id: "A-2", type: "task", title: "t", status: "todo", project: "A", parent: null },
  ]));
  assert.deepEqual(g.nodes.map((n) => n.id), ["A-1", "A-2", "B-1"]);
});

import { layoutGraph } from "../../scripts/model/graph.mjs";

function laidOut(rows, links = []) { return layoutGraph(buildGraph(idx(rows, links))); }

test("layoutGraph: higher type level sits in a left-er column", () => {
  const L = laidOut([
    { id: "A-g", type: "goal", title: "g", status: "defined", project: "A", parent: null },
    { id: "A-e", type: "epic", title: "e", status: "defined", project: "A", parent: "A-g" },
    { id: "A-t", type: "task", title: "t", status: "todo", project: "A", parent: "A-e" },
  ]);
  const x = (id) => L.nodes.find((n) => n.id === id).x;
  assert.ok(x("A-g") < x("A-e"), "goal left of epic");
  assert.ok(x("A-e") < x("A-t"), "epic left of task");
});

test("layoutGraph: a project change inside a column adds a lane gap", () => {
  const L = laidOut([
    { id: "A-1", type: "task", title: "a", status: "todo", project: "A", parent: null },
    { id: "A-2", type: "task", title: "b", status: "todo", project: "A", parent: null },
    { id: "B-1", type: "task", title: "c", status: "todo", project: "B", parent: null },
  ]);
  const y = (id) => L.nodes.find((n) => n.id === id).y;
  // A-1, A-2 same project: one row stride apart. A-2 → B-1: a row stride PLUS a lane gap.
  const within = y("A-2") - y("A-1");
  const across = y("B-1") - y("A-2");
  assert.ok(across > within, "cross-project gap is larger than within-project gap");
});

test("layoutGraph: edges connect node centers", () => {
  const L = laidOut([
    { id: "A-e", type: "epic", title: "e", status: "defined", project: "A", parent: null },
    { id: "A-t", type: "task", title: "t", status: "todo", project: "A", parent: "A-e" },
  ]);
  const e = L.edges[0];
  const s = L.nodes.find((n) => n.id === e.src), t = L.nodes.find((n) => n.id === e.target);
  assert.equal(e.x1, s.x + s.w / 2);
  assert.equal(e.y1, s.y + s.h / 2);
  assert.equal(e.x2, t.x + t.w / 2);
  assert.equal(e.y2, t.y + t.h / 2);
});

test("layoutGraph: empty graph yields sane dims and no throw", () => {
  const L = layoutGraph({ nodes: [], edges: [] });
  assert.deepEqual(L.nodes, []);
  assert.deepEqual(L.edges, []);
  assert.ok(L.width > 0 && L.height > 0);
});

test("layoutGraph: deterministic (same input, identical output)", () => {
  const rows = [
    { id: "A-g", type: "goal", title: "g", status: "defined", project: "A", parent: null },
    { id: "A-t", type: "task", title: "t", status: "todo", project: "A", parent: "A-g" },
  ];
  assert.deepEqual(laidOut(rows), laidOut(rows));
});
