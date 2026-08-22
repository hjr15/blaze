import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lintStatement, BLOCK_TIER, WARN_TIER } from "../../scripts/model/wording-lint.mjs";

describe("ISO 29148 §5.2.7 banned constructions, in two tiers", () => {
  test("an untestable construction is BLOCKED", () => {
    const r = lintStatement("The system shall be user friendly.");
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0].phrase, /user friendly/);
  });

  test("the finding explains WHY, not just that it matched", () => {
    const r = lintStatement("The system shall respond as fast as possible.");
    assert.ok(r.blocked[0].why.length > 10, "a bare match is not actionable");
  });

  test("THE DECISIVE CASE: 'never' only WARNS, because this is a real requirement", () => {
    // "the system shall never store plaintext passwords" is genuine, testable and
    // correct. Blocking it would be absurd, which is why the warn tier exists.
    const r = lintStatement("The system shall never store plaintext passwords.");
    assert.equal(r.blocked.length, 0, "must not block a correct requirement");
    assert.equal(r.warnings.length, 1);
  });

  test("a clean quantified requirement produces nothing", () => {
    const r = lintStatement("The system shall respond within 200ms at 500 concurrent users.");
    assert.deepEqual(r.blocked, []);
    assert.deepEqual(r.warnings, []);
  });

  test("matching is case-insensitive and word-bounded, so 'fastener' is not 'fast'", () => {
    assert.equal(lintStatement("The fastener shall be steel.").blocked.length, 0);
    assert.equal(lintStatement("The system shall be FAST.").blocked.length, 1);
  });

  test("the lists are OVERRIDABLE per project — a client's contract language is not ours to overrule", () => {
    const r = lintStatement("The system shall be user friendly.", { blockList: [] });
    assert.deepEqual(r.blocked, []);
  });

  test("the two tiers are disjoint — no phrase both blocks and warns", () => {
    const overlap = BLOCK_TIER.filter((b) => WARN_TIER.some((w) => w.phrase === b.phrase));
    assert.deepEqual(overlap, []);
  });
});
