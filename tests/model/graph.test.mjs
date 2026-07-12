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

import { graphModel } from "../../scripts/model/graph.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-graph-"));
  mkdirSync(join(dir, "A", "defined"), { recursive: true });
  mkdirSync(join(dir, "A", "todo"), { recursive: true });
  mkdirSync(join(dir, "B", "todo"), { recursive: true });
  writeFileSync(join(dir, "A", "defined", "A-1.md"),
    "---\nid: A-1\ntitle: epic\ntype: epic\nproject: A\n---\nbody\n");
  writeFileSync(join(dir, "A", "todo", "A-2.md"),
    "---\nid: A-2\ntitle: task\ntype: task\nproject: A\nestimate: 5\nparent: A-1\n---\nbody\n");
  // A second project so the project filter has something to exclude.
  writeFileSync(join(dir, "B", "todo", "B-1.md"),
    "---\nid: B-1\ntitle: other\ntype: task\nproject: B\nestimate: 5\n---\nbody\n");
  return dir;
}

test("graphModel: builds a laid-out graph from ticket files", () => {
  const gm = graphModel({ projectsDir: fixtureDir(), project: "all" });
  assert.equal(gm.nodes.length, 3);
  assert.equal(gm.edges.filter((e) => e.kind === "parent").length, 1);
  assert.ok(gm.width > 0 && gm.height > 0);
  // epic (level 1) is left of task (level 0)
  const x = (id) => gm.nodes.find((n) => n.id === id).x;
  assert.ok(x("A-1") < x("A-2"));
});

test("graphModel: project filter restricts the node set (excludes other projects)", () => {
  const gm = graphModel({ projectsDir: fixtureDir(), project: "A" });
  assert.equal(gm.nodes.length, 2);
  assert.ok(gm.nodes.every((n) => n.project === "A"));
  assert.equal(gm.nodes.find((n) => n.id === "B-1"), undefined);
});

test("graphModel: a passed index is used as-is, disk is never walked", () => {
  // projectsDir points at a directory that doesn't exist — if graphModel fell
  // back to walking disk it would find zero rows. Passing an index-shaped
  // object must short-circuit that walk entirely.
  const fakeIndex = {
    rows: [
      { id: "Z-1", type: "epic", title: "fake epic", status: "defined", project: "Z", parent: null },
      { id: "Z-2", type: "task", title: "fake task", status: "todo", project: "Z", parent: "Z-1" },
    ],
    links: [],
  };
  const gm = graphModel({ projectsDir: "/nonexistent-dir-should-not-be-read", index: fakeIndex });
  assert.deepEqual(gm.nodes.map((n) => n.id).sort(), ["Z-1", "Z-2"]);
  assert.equal(gm.nodes.length, 2);
});
