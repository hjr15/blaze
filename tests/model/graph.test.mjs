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
