import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../../scripts/views/map.mjs";
import { neighbourhood, layoutNeighbourhood } from "../../scripts/model/graph.mjs";

function fullIdx(rows, links = []) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, links, get: (id) => byId.get(id) };
}
const T = (id, type = "task", project = "A") =>
  ({ id, type, title: id.toLowerCase(), status: "todo", project, parent: null });
const gm = (rows, links, focus) => layoutNeighbourhood(neighbourhood(fullIdx(rows, links), focus));

test("render: no anchor (no focus) shows the pick-a-ticket prompt, no svg", () => {
  const html = render(layoutNeighbourhood({ anchor: null, nodes: [], edges: [], unresolved: [] }));
  assert.match(html, /no-data/);
  assert.match(html, /Select a ticket to see its dependencies/);
  assert.doesNotMatch(html, /<svg/);
});

test("render: a focused ticket with links emits an svg with the anchor + neighbour nodes", () => {
  const html = render(gm([T("A-1"), T("A-2")], [{ src: "A-2", type: "Blocks", target: "A-1" }], "A-1"));
  assert.match(html, /<svg class="graph"/);
  assert.match(html, /class="node anchor"[^>]*data-node-id="A-1"/);
  assert.match(html, /data-node-id="A-2"/);
});

test("render: a directed Blocks edge carries the arrowhead marker + label", () => {
  const html = render(gm([T("A-1"), T("A-2")], [{ src: "A-2", type: "Blocks", target: "A-1" }], "A-1"));
  assert.match(html, /<marker id="arrow"/);
  assert.match(html, /marker-end="url\(#arrow\)"/);
  assert.match(html, />Blocks</);
});

test("render: an undirected Relates edge is dashed and has NO arrowhead", () => {
  const html = render(gm([T("A-1"), T("A-2")], [{ src: "A-1", type: "Relates", target: "A-2" }], "A-1"));
  assert.match(html, /stroke-dasharray/);
  // the single edge line must not carry marker-end (arrowhead) — Relates is undirected
  const lineMatch = html.match(/<line [^>]*\/>/g) || [];
  assert.ok(lineMatch.length >= 1);
  assert.ok(lineMatch.every((l) => !/marker-end/.test(l)), "no Relates line has an arrowhead");
});

test("render: a non-anchor neighbour carries the re-focus affordance (data-drill), the anchor does not", () => {
  const html = render(gm([T("A-1"), T("A-2")], [{ src: "A-2", type: "Blocks", target: "A-1" }], "A-1"));
  assert.match(html, /data-drill="A-2"/);
  assert.doesNotMatch(html, /data-drill="A-1"/);
});

test("render: a focused ticket with NO links shows the plain caption (not an empty frame)", () => {
  const html = render(gm([T("A-1")], [], "A-1"));
  assert.match(html, /No links on this ticket/);
  assert.match(html, /data-node-id="A-1"/); // anchor still drawn
});

test("render: unresolved anchor links surface a count note", () => {
  const html = render(gm([T("A-1")], [{ src: "A-1", type: "Blocks", target: "GONE-9" }], "A-1"));
  assert.match(html, /class="map-note map-warn"/);
  assert.match(html, /1 link[^s]/); // singular
});

test("render: an anchor whose sole link is a dangling target shows only the warn note, not the No-links caption", () => {
  const html = render(gm([T("A-1")], [{ src: "A-1", type: "Blocks", target: "GONE-9" }], "A-1"));
  assert.match(html, /map-note map-warn/);
  assert.doesNotMatch(html, /No links on this ticket/);
});

test("render: title is escaped (no raw markup leaks)", () => {
  const html = render(gm([{ id: "A-1", type: "task", title: "t <x>", status: "todo", project: "A", parent: null }], [], "A-1"));
  assert.doesNotMatch(html, /t <x>/);
});
