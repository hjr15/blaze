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
