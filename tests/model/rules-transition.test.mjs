// tests/model/rules-transition.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTransition } from "../../scripts/model/rules.mjs";

test("legal adjacent transition returns no errors", () => {
  assert.deepEqual(validateTransition("task", "defined", "in-progress"), []);
  assert.deepEqual(validateTransition("task", "in-review", "done"), []);
  assert.deepEqual(validateTransition("task", "done", "defined"), []); // reopen
});

test("skipping a status is rejected", () => {
  const errs = validateTransition("task", "defined", "done");
  assert.ok(errs.some((e) => /illegal transition/.test(e)));
});

test("unknown target status is rejected", () => {
  const errs = validateTransition("task", "defined", "achieved"); // goal status, not delivery
  assert.ok(errs.some((e) => /invalid status/.test(e)));
});

test("unknown type is rejected", () => {
  assert.ok(validateTransition("nope", "a", "b").some((e) => /unknown type/.test(e)));
});
