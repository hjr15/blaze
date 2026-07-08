import { test } from "node:test";
import assert from "node:assert/strict";
import * as board from "../../scripts/views/board.mjs";
import { render, card } from "../../scripts/views/board.mjs";

const model = {
  columns: [{ dir: "todo", label: "Todo", tickets: [
    { file: "T-1.md", meta: { id: "T-1", title: "t", priority: "medium", type: "task" }, body: "" },
  ] }],
  rollup: new Map(),
};

test("board exposes the view contract", () => {
  assert.equal(typeof board.render, "function");
  assert.equal(typeof board.styles, "string");
  assert.equal(typeof board.clientScript, "string");
});

test("board.render emits a column section with a draggable card", () => {
  const html = board.render(model);
  assert.match(html, /class="board"/);
  assert.match(html, /data-status="todo"/);
  assert.match(html, /draggable="true"/);
  assert.match(html, /data-id="T-1"/);
});

test("board.render wires inline-edit affordances", () => {
  assert.match(board.render(model), /data-edit="priority"/);
});

test("board.render stamps a lowercased data-search index (id/title/labels/assignee)", () => {
  const m = { columns: [{ dir: "todo", label: "Todo", tickets: [
    { file: "T-9.md", meta: { id: "T-9", title: "Alpha", labels: ["Beta"], assignee: "Ryan", priority: "low", type: "task" }, body: "" },
  ] }], rollup: new Map() };
  assert.match(board.render(m), /data-search="t-9 alpha beta ryan"/);
});

test("render emits one board section per model board, tagged data-board, with badge", () => {
  const model = { rollup: null, boards: [
    { name: "delivery", label: "Delivery", columns: [{ dir: "done", label: "Done", tickets: [
      { file: "INF-1.md", meta: { id: "INF-1", title: "g", type: "goal", priority: "none" }, body: "", status: "achieved", badge: "achieved" },
    ] }] },
    { name: "risk", label: "Risk", columns: [{ dir: "identified", label: "Identified", tickets: [] }] },
  ] };
  const html = render(model);
  assert.match(html, /data-board="delivery"/);
  assert.match(html, /data-board="risk"/);
  assert.match(html, /class="statusbadge"[^>]*>achieved</);
});
