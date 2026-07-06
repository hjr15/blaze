// tests/model/time.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { roundEstimate, roundWorklog, formatMinutes } from "../../scripts/model/time.mjs";

test("roundEstimate rounds to the nearest 5 minutes", () => {
  assert.equal(roundEstimate(33), 35);
  assert.equal(roundEstimate(32), 30);
  assert.equal(roundEstimate(90), 90);
  assert.equal(roundEstimate(7.5), 10);   // 7.5/5 = 1.5 → 2 → 10
});

test("roundEstimate: a positive value never becomes null", () => {
  assert.equal(roundEstimate(2), 5);      // would round to 0 → bumped to 5
  assert.equal(roundEstimate(1), 5);
});

test("roundEstimate: zero / null / absent / junk → null", () => {
  assert.equal(roundEstimate(0), null);
  assert.equal(roundEstimate(null), null);
  assert.equal(roundEstimate(undefined), null);
  assert.equal(roundEstimate(-10), null);
  assert.equal(roundEstimate(NaN), null);
  assert.equal(roundEstimate("abc"), null);
});

test("roundWorklog rounds to the nearest integer minute", () => {
  assert.equal(roundWorklog(59.6), 60);
  assert.equal(roundWorklog(1), 1);
  assert.equal(roundWorklog(30.4), 30);
});

test("roundWorklog throws on non-positive / non-finite", () => {
  assert.throws(() => roundWorklog(0), RangeError);
  assert.throws(() => roundWorklog(-5), RangeError);
  assert.throws(() => roundWorklog(NaN), RangeError);
  assert.throws(() => roundWorklog("x"), RangeError);
});

test("formatMinutes renders human time", () => {
  assert.equal(formatMinutes(90), "1h 30m");
  assert.equal(formatMinutes(45), "45m");
  assert.equal(formatMinutes(120), "2h");
  assert.equal(formatMinutes(0), "0m");
  assert.equal(formatMinutes(null), "");
  assert.equal(formatMinutes(undefined), "");
});
