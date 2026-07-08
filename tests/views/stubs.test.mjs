import { test } from "node:test";
import assert from "node:assert/strict";
import * as metrics from "../../scripts/views/metrics.mjs";
import * as map from "../../scripts/views/map.mjs";

for (const [name, mod] of [["metrics", metrics], ["map", map]]) {
  test(`${name} stub honours the view contract and renders empty`, () => {
    assert.equal(typeof mod.render, "function");
    assert.equal(typeof mod.styles, "string");
    assert.equal(typeof mod.clientScript, "string");
    assert.equal(mod.render({}), "");
  });
}
