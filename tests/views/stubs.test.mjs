import { test } from "node:test";
import assert from "node:assert/strict";
import * as map from "../../scripts/views/map.mjs";

// metrics.mjs graduated from stub to a real view (see tests/views/metrics.test.mjs) —
// only the still-stubbed map view is covered by this generic contract check now.
for (const [name, mod] of [["map", map]]) {
  test(`${name} stub honours the view contract and renders empty`, () => {
    assert.equal(typeof mod.render, "function");
    assert.equal(typeof mod.styles, "string");
    assert.equal(typeof mod.clientScript, "string");
    assert.equal(mod.render({}), "");
  });
}
