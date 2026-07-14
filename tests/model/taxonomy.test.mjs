import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaxonomy } from "../../scripts/model/taxonomy.mjs";

test("off-taxonomy component is rejected when taxonomy declared", () => {
  const project = { components: ["auth", "gateway"], labels: [] };
  const errs = validateTaxonomy({ components: ["auth", "nope"], labels: [] }, project);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /nope/);
  assert.match(errs[0], /component/);
});

test("in-taxonomy values pass silently", () => {
  const project = { components: ["auth"], labels: ["area:cms"] };
  assert.deepEqual(validateTaxonomy({ components: ["auth"], labels: ["area:cms"] }, project), []);
});

test("empty declared taxonomy skips validation (backward compat)", () => {
  const project = { components: [], labels: [] };
  assert.deepEqual(validateTaxonomy({ components: ["anything"], labels: ["freeform"] }, project), []);
});
