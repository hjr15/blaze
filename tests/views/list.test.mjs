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
