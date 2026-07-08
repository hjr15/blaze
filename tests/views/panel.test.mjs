import { test } from "node:test";
import assert from "node:assert/strict";
import * as panel from "../../scripts/views/panel.mjs";

test("panel honours the view contract", () => {
  assert.equal(typeof panel.render, "function");
  assert.equal(typeof panel.styles, "string");
  assert.equal(typeof panel.clientScript, "string");
});

test("panel.render emits a hidden panel container", () => {
  const html = panel.render();
  assert.match(html, /id="blaze-panel"/);
  assert.match(html, /hidden/);
});

test("panel.clientScript defines the window.blazePanel open/close contract", () => {
  assert.match(panel.clientScript, /window\.blazePanel/);
  assert.match(panel.clientScript, /open/);
  assert.match(panel.clientScript, /close/);
});

test("panel.clientScript fetches /api/panel (no DOM-clone) and supports drill navigation", () => {
  assert.match(panel.clientScript, /\/api\/panel/);      // fetches server-escaped HTML
  assert.match(panel.clientScript, /data-panel-open/);   // parent/children drill
  assert.doesNotMatch(panel.clientScript, /\.body['"]/); // no longer clones the board card body
});
