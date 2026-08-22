// tests/model/ref-allocator.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nextRef, parseRef } from "../../scripts/model/ref-allocator.mjs";

describe("ref allocation", () => {
  test("REQ refs are zero-padded to three, ADR to four", () => {
    assert.equal(nextRef({ kind: "requirement", existing: [] }), "REQ-001");
    assert.equal(nextRef({ kind: "architecture", existing: [] }), "ADR-0001");
  });

  test("A GAP IS NEVER FILLED — refs are monotonic, not contiguous", () => {
    // A rejected requirement keeps its ref. Reuse is a bug: a citation in a commit
    // message or code comment would silently point at a different requirement.
    const existing = ["REQ-001", "REQ-002", "REQ-007"];
    assert.equal(nextRef({ kind: "requirement", existing }), "REQ-008");
  });

  test("allocation ignores refs of the other kind", () => {
    assert.equal(nextRef({ kind: "requirement", existing: ["ADR-0042"] }), "REQ-001");
  });

  test("parseRef rejects anything malformed rather than guessing", () => {
    for (const bad of ["REQ-1", "REQ001", "req-001", "ADR-001", "", null]) {
      assert.equal(parseRef(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(parseRef("REQ-014"), { kind: "requirement", num: 14 });
  });

  test("the sequence does not stop at 999 — refs are never reused, so a project WILL pass it", () => {
    // padStart pads but never truncates, so 1000 must round-trip rather than
    // producing a ref parseRef cannot read.
    assert.equal(nextRef({ kind: "requirement", existing: ["REQ-999"] }), "REQ-1000");
    assert.deepEqual(parseRef("REQ-1000"), { kind: "requirement", num: 1000 });
    assert.equal(nextRef({ kind: "requirement", existing: ["REQ-1000"] }), "REQ-1001");
    assert.equal(nextRef({ kind: "architecture", existing: ["ADR-9999"] }), "ADR-10000");
  });
});
