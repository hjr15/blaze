import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaxonomy, warnMissingRequired } from "../../scripts/model/taxonomy.mjs";

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

test("warns when a required field is empty and no reason given", () => {
  const project = { components: ["auth"], labels: [], requireComponents: true };
  const w = warnMissingRequired({ components: [], labels: [] }, project, {});
  assert.equal(w.length, 1);
  assert.match(w[0], /component/);
});

test("no warning when required field is filled", () => {
  const project = { components: ["auth"], requireComponents: true };
  assert.deepEqual(warnMissingRequired({ components: ["auth"], labels: [] }, project, {}), []);
});

test("no warning when a blank-reason is supplied", () => {
  const project = { components: ["auth"], requireComponents: true };
  assert.deepEqual(warnMissingRequired({ components: [], labels: [] }, project, { reason: "cross-cutting" }), []);
});

test("default off (requireComponents falsy) never warns", () => {
  assert.deepEqual(warnMissingRequired({ components: [], labels: [] }, { components: ["auth"] }, {}), []);
});
