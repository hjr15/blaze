// tests/model/link-rules.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkLink } from "../../scripts/model/link-rules.mjs";

const ADDRESSES = { name: "Addresses", source_kinds: ["architecture"],
                    target_kinds: ["requirement"], min_card: 0, max_card: null };
const SUPERSEDES = { name: "Supersedes", source_kinds: ["architecture"],
                     target_kinds: ["architecture"], min_card: 0, max_card: 1 };

describe("link endpoint enforcement", () => {
  test("a declared combination is allowed", () => {
    assert.equal(checkLink({ linkType: ADDRESSES, sourceKind: "architecture",
                             targetKind: "requirement" }).ok, true);
  });

  test("a wrong source kind is REFUSED, and the error names both kinds", () => {
    const r = checkLink({ linkType: ADDRESSES, sourceKind: "task", targetKind: "requirement" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Addresses/);
    assert.match(r.error, /task/);
    assert.match(r.error, /architecture/);
  });

  test("a wrong target kind is refused", () => {
    assert.equal(checkLink({ linkType: ADDRESSES, sourceKind: "architecture",
                             targetKind: "task" }).ok, false);
  });

  test("DEFAULT DENY: an unknown link type is refused, never passed through", () => {
    // The Jama failure mode (CS-012): an undeclared type relating to anything.
    const r = checkLink({ linkType: null, sourceKind: "architecture", targetKind: "requirement" });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown link type/i);
  });

  test("max cardinality is enforced against the existing count", () => {
    assert.equal(checkLink({ linkType: SUPERSEDES, sourceKind: "architecture",
                             targetKind: "architecture", existingCount: 0 }).ok, true);
    const r = checkLink({ linkType: SUPERSEDES, sourceKind: "architecture",
                          targetKind: "architecture", existingCount: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /at most 1/);
  });

  test("the check is SYNCHRONOUS — a sync driver cannot await", () => {
    const r = checkLink({ linkType: ADDRESSES, sourceKind: "architecture", targetKind: "requirement" });
    assert.equal(typeof r.then, "undefined");
  });
});
