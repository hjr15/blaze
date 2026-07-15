import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../../scripts/views/map.mjs";
import { buildGraph, layoutGraph } from "../../scripts/model/graph.mjs";

test("render: empty graph shows the no-data empty state", () => {
  const html = render({ nodes: [], edges: [], width: 80, height: 80 });
  assert.match(html, /no-data/);
  assert.match(html, /No tickets to map/);
});

test("render: a graph emits an svg with a node carrying data-node-id", () => {
  const gm = layoutGraph(buildGraph({
    rows: [
      { id: "A-1", type: "epic", title: "Epic <one>", status: "defined", project: "A", parent: null },
      { id: "A-2", type: "task", title: "task two", status: "todo", project: "A", parent: "A-1" },
    ],
    links: [],
  }));
  const html = render(gm);
  assert.match(html, /<svg class="graph"/);
  assert.match(html, /data-node-id="A-1"/);
  assert.match(html, /data-node-id="A-2"/);
  // parent edge rendered as a line
  assert.match(html, /<line /);
  // title is escaped (no raw <one>)
  assert.doesNotMatch(html, /Epic <one>/);
});

test("render: a link edge is dashed and carries its label", () => {
  const gm = layoutGraph(buildGraph({
    rows: [
      { id: "A-1", type: "task", title: "a", status: "todo", project: "A", parent: null },
      { id: "A-2", type: "task", title: "b", status: "todo", project: "A", parent: null },
    ],
    links: [{ src: "A-1", type: "Blocks", target: "A-2" }],
  }));
  const html = render(gm);
  assert.match(html, /stroke-dasharray/);
  assert.match(html, />Blocks</);
});

// BLZ-36: flat mode with no node-count signpost renders 1,310 real tickets as
// an illegible 20,220-wide smear (browser-verified, 0.069x effective scale).
// The hint should show only when it's actually warranted: flat mode AND a
// node count over map.mjs's FLAT_HINT_THRESHOLD (150, mirrored here as a
// literal per this file's existing convention — see WRAP_ROWS/SUB_STRIDE
// literals in tests/model/graph.test.mjs).
function manyTaskRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `A-${i + 1}`, type: "task", title: `t${i + 1}`, status: "todo", project: "A", parent: null,
  }));
}

test("render: flat mode over the node-count threshold shows the real count in a hint", () => {
  const gm = layoutGraph(buildGraph({ rows: manyTaskRows(200), links: [] }));
  const html = render(gm, { flat: true });
  assert.match(html, /class="map-hint"/);
  // Discriminating: with 200 rows the id "A-200" appears in the markup many
  // times regardless of the hint, so a bare /200/ match doesn't prove the
  // hint shows the real count — anchor it to the hint element's own text.
  assert.match(html, /class="map-hint"[^>]*>200 nodes/);
  assert.match(html, /nested/i);
});

test("render: nested mode with the SAME large node count shows no hint (flat-only)", () => {
  const gm = layoutGraph(buildGraph({ rows: manyTaskRows(200), links: [] }));
  const html = render(gm, { flat: false });
  assert.doesNotMatch(html, /class="map-hint"/);
});

test("render: flat mode with a small corpus (below threshold) shows no hint (not noise)", () => {
  const gm = layoutGraph(buildGraph({ rows: manyTaskRows(5), links: [] }));
  const html = render(gm, { flat: true });
  assert.doesNotMatch(html, /class="map-hint"/);
});

test("render: flat mode with no opts arg at all defaults to no hint (backward compatible)", () => {
  const gm = layoutGraph(buildGraph({ rows: manyTaskRows(200), links: [] }));
  const html = render(gm);
  assert.doesNotMatch(html, /class="map-hint"/);
});

test("render v2: anchor + stub classes; drill affordance only on in-scope nodes with children", () => {
  const gm = layoutGraph(buildGraph({
    rows: [
      { id: "A-g", type: "goal", title: "goal", status: "defined", project: "A", parent: null, anchor: true, childCount: 2 },
      { id: "A-e", type: "epic", title: "epic", status: "defined", project: "A", parent: "A-g", childCount: 3 },
      { id: "B-x", type: "task", title: "ext", status: "todo", project: "B", parent: null, stub: true, childCount: 5 },
    ],
    links: [{ src: "A-e", type: "Blocks", target: "B-x" }],
  }));
  const html = render(gm);
  assert.match(html, /class="node anchor"[^>]*data-node-id="A-g"/);
  assert.match(html, /class="node stub"[^>]*data-node-id="B-x"/);
  // the in-scope epic gets a drill affordance carrying its child count
  assert.match(html, /data-drill="A-e"/);
  assert.match(html, /⤵ 3/);
  // the anchor (already the focus) and the stub (design §5) never get one
  assert.doesNotMatch(html, /data-drill="A-g"/);
  assert.doesNotMatch(html, /data-drill="B-x"/);
});
