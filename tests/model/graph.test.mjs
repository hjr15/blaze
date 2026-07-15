import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../../scripts/model/graph.mjs";

function idx(rows, links = []) { return { rows, links }; }

test("buildGraph: nodes carry id/type/title/status/project/level + childCount/stub/anchor", () => {
  const g = buildGraph(idx([
    { id: "A-1", type: "epic", title: "Epic one", status: "defined", project: "A", parent: null },
  ]));
  assert.deepEqual(g.nodes, [
    { id: "A-1", type: "epic", title: "Epic one", status: "defined", project: "A", level: 1,
      childCount: 0, stub: false, anchor: false },
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

test("graphModel: flat builds the whole laid-out graph from ticket files", () => {
  const gm = graphModel({ projectsDir: fixtureDir(), project: "all", flat: true });
  assert.equal(gm.nodes.length, 3);
  assert.equal(gm.edges.filter((e) => e.kind === "parent").length, 1);
  assert.ok(gm.width > 0 && gm.height > 0);
  // epic (level 1) is left of task (level 0)
  const x = (id) => gm.nodes.find((n) => n.id === id).x;
  assert.ok(x("A-1") < x("A-2"));
});

test("graphModel: project filter restricts the node set (excludes other projects)", () => {
  const gm = graphModel({ projectsDir: fixtureDir(), project: "A", flat: true });
  assert.equal(gm.nodes.length, 2);
  assert.ok(gm.nodes.every((n) => n.project === "A"));
  assert.equal(gm.nodes.find((n) => n.id === "B-1"), undefined);
});

test("graphModel: a passed index is used as-is, disk is never walked", () => {
  // projectsDir points at a directory that doesn't exist — if graphModel fell
  // back to walking disk it would find zero rows. Passing a full Index-shaped
  // object ({rows, links, get} — v2 needs get for focus/stub resolution) must
  // short-circuit that walk entirely.
  const gm = graphModel({ projectsDir: "/nonexistent-dir-should-not-be-read", index: fullIdx([
    { id: "Z-1", type: "epic", title: "fake epic", status: "defined", project: "Z", parent: null },
    { id: "Z-2", type: "task", title: "fake task", status: "todo", project: "Z", parent: "Z-1" },
  ]), flat: true });
  assert.deepEqual(gm.nodes.map((n) => n.id).sort(), ["Z-1", "Z-2"]);
  assert.equal(gm.nodes.length, 2);
});

// v2 (BLZ-89): drill scope, anchor, childCount, cross-scope link stubs.
const T = (id, type, parent = null, project = "A") =>
  ({ id, type, title: id.toLowerCase(), status: "todo", project, parent });

function fullIdx(rows, links = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, links, get: (id) => byId.get(id) };
}

test("graphModel: focus scopes to anchor + DIRECT children (grandchildren excluded)", () => {
  const i = fullIdx([T("A-g", "goal"), T("A-e1", "epic", "A-g"), T("A-e2", "epic", "A-g"), T("A-t", "task", "A-e1")]);
  const gm = graphModel({ projectsDir: "/nonexistent", index: i, focus: "A-g" });
  assert.deepEqual(gm.nodes.map((n) => n.id).sort(), ["A-e1", "A-e2", "A-g"]);
  assert.equal(gm.nodes.find((n) => n.id === "A-g").anchor, true);
  assert.equal(gm.nodes.find((n) => n.id === "A-e1").anchor, false);
  // parent edges children→anchor survive the scoping
  assert.equal(gm.edges.filter((e) => e.kind === "parent").length, 2);
});

test("graphModel: default scope is parentless-only; flat is the whole corpus", () => {
  const i = fullIdx([T("A-g", "goal"), T("A-e1", "epic", "A-g"), T("A-t", "task", "A-e1")]);
  assert.deepEqual(graphModel({ projectsDir: "/nonexistent", index: i }).nodes.map((n) => n.id), ["A-g"]);
  assert.equal(graphModel({ projectsDir: "/nonexistent", index: i, flat: true }).nodes.length, 3);
});

test("graphModel: nodes carry childCount tallied from the FULL index", () => {
  const i = fullIdx([T("A-g", "goal"), T("A-e1", "epic", "A-g"), T("A-t", "task", "A-e1")]);
  const gm = graphModel({ projectsDir: "/nonexistent", index: i, focus: "A-g" });
  assert.equal(gm.nodes.find((n) => n.id === "A-e1").childCount, 1); // A-t counts though out of scope
  assert.equal(gm.nodes.find((n) => n.id === "A-g").childCount, 1);
});

test("graphModel: a cross-scope link pulls the outside endpoint in as a stub", () => {
  // Focus A-e1: child A-t1 Blocks B-x (outside the scope) — B-x must appear as
  // a stub with the dashed edge intact, not silently drop (operator decision).
  const i = fullIdx(
    [T("A-g", "goal"), T("A-e1", "epic", "A-g"), T("A-t1", "task", "A-e1"), T("B-x", "task", null, "B")],
    [{ src: "A-t1", type: "Blocks", target: "B-x" }],
  );
  const gm = graphModel({ projectsDir: "/nonexistent", index: i, focus: "A-e1" });
  const stub = gm.nodes.find((n) => n.id === "B-x");
  assert.equal(stub.stub, true);
  assert.equal(gm.nodes.find((n) => n.id === "A-t1").stub, false);
  assert.deepEqual(gm.edges.filter((e) => e.kind === "link").map((e) => [e.src, e.target]), [["A-t1", "B-x"]]);
});

test("graphModel: two cross-scope links to one outside id yield a single stub", () => {
  const i = fullIdx(
    [T("A-g", "goal"), T("A-t1", "task", "A-g"), T("A-t2", "task", "A-g"), T("B-x", "task", null, "B")],
    [{ src: "A-t1", type: "Blocks", target: "B-x" }, { src: "A-t2", type: "Relates", target: "B-x" }],
  );
  const gm = graphModel({ projectsDir: "/nonexistent", index: i, focus: "A-g" });
  assert.equal(gm.nodes.filter((n) => n.id === "B-x").length, 1);
  assert.equal(gm.edges.filter((e) => e.kind === "link").length, 2);
});

test("graphModel: a link dangling to an id absent from the index still drops", () => {
  const i = fullIdx([T("A-g", "goal"), T("A-t1", "task", "A-g")],
    [{ src: "A-t1", type: "Blocks", target: "GONE-9" }]);
  const gm = graphModel({ projectsDir: "/nonexistent", index: i, focus: "A-g" });
  assert.equal(gm.edges.filter((e) => e.kind === "link").length, 0);
  assert.equal(gm.nodes.find((n) => n.id === "GONE-9"), undefined);
});

// Deliberate — a link that crosses projects is still a real dependency;
// BLZ-2 says the board must not lie by hiding it.
test("graphModel: a project filter still resolves a cross-project stub", () => {
  const i = fullIdx(
    [T("A-g", "goal", null, "A"), T("A-t1", "task", "A-g", "A"), T("B-x", "task", null, "B")],
    [{ src: "A-t1", type: "Blocks", target: "B-x" }],
  );
  const gm = graphModel({ projectsDir: "/nonexistent", index: i, project: "A", flat: true });
  assert.deepEqual(gm.nodes.map((n) => n.id).sort(), ["A-g", "A-t1", "B-x"]);
  const stub = gm.nodes.find((n) => n.id === "B-x");
  assert.equal(stub.stub, true);
  assert.equal(stub.project, "B"); // rendered though it's outside the ?project=A filter
});

test("graphModel: a stub never produces a solid parent edge, even when its parent is in scope", () => {
  // Focus A-e1: direct children A-t1, A-t2 are in scope. A-t1 Blocks A-s1 (a
  // subtask of in-scope A-t2, but out of scope itself — grandchildren are
  // excluded) pulls A-s1 in as a stub. A stub is a link endpoint, not a
  // child: it must not sprout a solid hierarchy edge to A-t2 just because
  // its `parent` field happens to still resolve in-scope.
  const i = fullIdx(
    [T("A-g", "goal"), T("A-e1", "epic", "A-g"), T("A-t1", "task", "A-e1"), T("A-t2", "task", "A-e1"),
     T("A-s1", "subtask", "A-t2")],
    [{ src: "A-t1", type: "Blocks", target: "A-s1" }],
  );
  const gm = graphModel({ projectsDir: "/nonexistent", index: i, focus: "A-e1" });
  const stub = gm.nodes.find((n) => n.id === "A-s1");
  assert.equal(stub.stub, true);
  assert.equal(gm.edges.filter((e) => e.kind === "parent" && (e.src === "A-s1" || e.target === "A-s1")).length, 0);
  assert.deepEqual(gm.edges.filter((e) => e.kind === "link").map((e) => [e.src, e.target]), [["A-t1", "A-s1"]]);
});

// BLZ-36: deterministic lane wrapping.
const wrapRows = (n, type = "task") => Array.from({ length: n }, (_, i) =>
  ({ id: `A-${type[0]}${String(i + 1).padStart(2, "0")}`, type, title: "t", status: "todo", project: "A", parent: null }));

test("layoutGraph: a column wraps into a new sub-column after WRAP_ROWS (12) nodes", () => {
  const L = layoutGraph(buildGraph({ rows: wrapRows(13), links: [] }));
  const n = (id) => L.nodes.find((x) => x.id === id);
  assert.equal(n("A-t01").x, n("A-t12").x, "first 12 share a sub-column");
  assert.ok(n("A-t13").x > n("A-t12").x, "the 13th wraps right");
  assert.equal(n("A-t13").y, n("A-t01").y, "a wrapped sub-column restarts at the top");
});

test("layoutGraph: wrapping bounds column height at the corpus worst case (49 nodes)", () => {
  const L = layoutGraph(buildGraph({ rows: wrapRows(49), links: [] }));
  // 12 rows max per sub-column: height = PAD(40) + 11*ROW_STRIDE(60) + NODE_H(44) + PAD(40) = 784
  assert.equal(L.height, 784);
  // 49 nodes / WRAP_ROWS(12) → 5 sub-columns (indices 0..4; node 49 is the
  // first row of sub-column 4, since floor(48/12)=4). Rightmost sub-column
  // x = PAD(40) + 4*SUB_STRIDE(180) = 760; maxRight = 760 + NODE_W(160) = 920;
  // width = maxRight + PAD(40) = 960.
  assert.equal(L.width, 960);
});

test("layoutGraph: wrapping is deterministic (same input, identical output)", () => {
  const rows = [...wrapRows(15, "epic"), { id: "A-x1", type: "task", title: "t", status: "todo", project: "A", parent: null }];
  const L1 = layoutGraph(buildGraph({ rows, links: [] }));
  assert.deepEqual(L1, layoutGraph(buildGraph({ rows, links: [] })));
});

test("layoutGraph: levelX advances by full sub-column width, clearing the widest (3rd) sub-column of the previous level", () => {
  // 25 epics in ONE project (no lane gap noise), WRAP_ROWS=12 → wraps at rows
  // 13 and 25: sub-column 0 = epics 1-12, sub-column 1 = epics 13-24,
  // sub-column 2 = epic 25 alone. This needs >=3 sub-columns (>=25 nodes)
  // because with only 2 sub-columns the max x offset (1*SUB_STRIDE=180) is
  // smaller than COL_STRIDE(240) — a loose "next level's x > previous max x"
  // check can't fail even if the sub-column term is dropped from levelX
  // entirely. With 3 sub-columns it can, and does.
  const rows = [...wrapRows(25, "epic"), { id: "A-x1", type: "task", title: "t", status: "todo", project: "A", parent: null }];
  const L = layoutGraph(buildGraph({ rows, links: [] }));
  const x = (id) => L.nodes.find((n) => n.id === id).x;
  const PAD = 40, SUB_STRIDE = 180, COL_STRIDE = 240;
  assert.equal(x("A-e01"), PAD, "sub-column 0 starts at PAD");
  assert.equal(x("A-e12"), PAD, "row 12 is still sub-column 0");
  assert.equal(x("A-e13"), PAD + SUB_STRIDE, "row 13 wraps into sub-column 1");
  assert.equal(x("A-e24"), PAD + SUB_STRIDE, "row 24 is still sub-column 1");
  assert.equal(x("A-e25"), PAD + 2 * SUB_STRIDE, "row 25 wraps into sub-column 2 (the 3rd sub-column)");
  // levelX for the next (task) level = PAD + (final subCol=2)*SUB_STRIDE + COL_STRIDE
  //                                   = 40 + 2*180 + 240 = 640.
  // The regression (levelX += COL_STRIDE, dropping the subCol term) would give
  // levelX = 40 + 240 = 280 — LESS than the widest epic sub-column's x (400),
  // so the task level would overlap sub-column 2 of the epic level.
  assert.equal(x("A-x1"), PAD + 2 * SUB_STRIDE + COL_STRIDE, "task level clears the widest (3rd) epic sub-column");
});
