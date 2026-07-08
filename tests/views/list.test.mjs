import { test } from "node:test";
import assert from "node:assert/strict";
import * as list from "../../scripts/views/list.mjs";

const model = { columns: [{ dir: "todo", label: "Todo", tickets: [
  { file: "T-1.md", meta: { id: "T-1", title: "t", priority: "medium", type: "task" }, body: "" },
] }] };

test("list exposes the view contract", () => {
  assert.equal(typeof list.render, "function");
  assert.equal(typeof list.styles, "string");
  assert.equal(typeof list.clientScript, "string");
});

test("list.render emits a group with a row", () => {
  const html = list.render(model);
  assert.match(html, /class="list"/);
  assert.match(html, /data-group="todo"/);
  assert.match(html, /class="row/);
  assert.match(html, /data-id="T-1"/);
});

test("list.render stamps a lowercased data-search index on each row", () => {
  const m = { columns: [{ dir: "todo", label: "Todo", tickets: [
    { file: "T-9.md", meta: { id: "T-9", title: "Alpha", labels: ["Beta"], assignee: "Ryan", priority: "low", type: "task" }, body: "" },
  ] }] };
  assert.match(list.render(m), /data-search="t-9 alpha beta ryan"/);
});

test("render emits one list container per board, tagged data-board", () => {
  const model = { boards: [
    { name: "delivery", label: "Delivery", columns: [{ dir: "defined", label: "Defined", tickets: [
      { file: "INF-3.md", meta: { id: "INF-3", title: "t", type: "task", priority: "none" }, body: "", status: "defined" },
    ] }] },
    { name: "risk", label: "Risk", columns: [{ dir: "identified", label: "Identified", tickets: [] }] },
  ] };
  const html = list.render(model);
  assert.match(html, /class="list" data-board="delivery"/);
  assert.match(html, /class="list" data-board="risk"/);
});
