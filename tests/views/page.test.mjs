import { test } from "node:test";
import assert from "node:assert/strict";
import { pageHtml, CSRF } from "../../scripts/views/page.mjs";

test("page.mjs exports CSRF and a composing pageHtml", () => {
  assert.equal(typeof CSRF, "string");
  const html = pageHtml({ project: "all" });
  // shared chrome present
  assert.match(html, /window\.__csrf/);
  assert.match(html, /blazePost/);
  assert.match(html, /id="toast"/);
  assert.match(html, /"urgent"/);            // injected PRIORITIES
  // each view section wired
  assert.match(html, /class="board"/);
  assert.match(html, /class="list"/);
  assert.match(html, /class="live"/);
  assert.match(html, /id="blaze-panel"/);
  assert.match(html, /window\.blazePanel/);
});
