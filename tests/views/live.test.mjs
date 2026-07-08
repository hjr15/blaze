import { test } from "node:test";
import assert from "node:assert/strict";
import * as live from "../../scripts/views/live.mjs";

test("live module exposes the view contract", () => {
  assert.equal(typeof live.render, "function");
  assert.equal(typeof live.styles, "string");
  assert.equal(typeof live.clientScript, "string");
});

test("live.render emits the live section container", () => {
  assert.match(live.render(), /class="live"/);
});

test("live.clientScript polls /api/live", () => {
  assert.match(live.clientScript, /\/api\/live/);
});

test("live.styles carries the livecard rules", () => {
  assert.match(live.styles, /\.livecard/);
});
