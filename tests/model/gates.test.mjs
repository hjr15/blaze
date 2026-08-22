// tests/model/gates.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkGate, GATED_ACTIONS } from "../../scripts/model/gates.mjs";

describe("gates", () => {
  test("the gated actions are ENUMERATED — an unlisted action is not a gate", () => {
    assert.deepEqual([...GATED_ACTIONS].sort(),
      ["architecture:accepted", "document:baselined", "goal:achieved", "requirement:verified"]);
  });

  test("an unknown action passes through rather than silently blocking everything", () => {
    const r = checkGate({ action: "task:done", subject: {}, context: {} });
    assert.equal(r.ok, true);
  });

  test("requirement -> verified is refused without a resolving Verifies link (RQ-6)", () => {
    const r = checkGate({ action: "requirement:verified",
      subject: { id: "a1", ref: "REQ-014" }, context: { links: [] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-014/);
    assert.match(r.error, /Verifies/);
  });

  test("...and allowed with one", () => {
    const r = checkGate({ action: "requirement:verified", subject: { id: "a1", ref: "REQ-014" },
      context: { links: [{ type_name: "Verifies", source_id: "s1", target_id: "a1" }] } });
    assert.equal(r.ok, true);
  });

  test("goal -> achieved is refused while ANY child requirement is non-terminal (RQ-7)", () => {
    const r = checkGate({ action: "goal:achieved", subject: { id: "g1" }, context: {
      children: [{ ref: "REQ-001", kind: "requirement", status: "implemented", terminal: true },
                 { ref: "REQ-002", kind: "requirement", status: "proposed", terminal: false }] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-002/);
    assert.doesNotMatch(r.error, /REQ-001/, "a satisfied child must not be listed as a failure");
  });

  test("architecture -> accepted requires Context, Decision AND Consequences (AQ-2)", () => {
    const bad = checkGate({ action: "architecture:accepted", subject: { ref: "ADR-0007",
      body: "## Context\nsome context\n## Decision\nwe will\n" }, context: {} });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Consequences/);

    const good = checkGate({ action: "architecture:accepted", subject: { ref: "ADR-0007",
      body: "## Context\nc\n## Decision\nd\n## Consequences\ne\n" }, context: {} });
    assert.equal(good.ok, true);
  });

  test("an EMPTY required section does not count as present", () => {
    const r = checkGate({ action: "architecture:accepted", subject: { ref: "ADR-0007",
      body: "## Context\nc\n## Decision\nd\n## Consequences\n\n" }, context: {} });
    assert.equal(r.ok, false);
  });

  test("the LAST required section is found — \\Z is not an anchor in JavaScript", () => {
    // \Z is Python/PCRE. In JS it matches a literal Z, so the final section never
    // matched and the gate refused every ADR while blaming the author.
    const body = "## Context\nc\n## Decision\nd\n## Consequences\ne\n";
    assert.equal(checkGate({ action: "architecture:accepted",
                             subject: { ref: "ADR-0001", body }, context: {} }).ok, true);
  });

  test("EVERY failure is listed, not just the first", () => {
    const r = checkGate({ action: "goal:achieved", subject: { id: "g1" }, context: {
      children: [{ ref: "REQ-001", kind: "requirement", terminal: false },
                 { ref: "REQ-002", kind: "requirement", terminal: false },
                 { ref: "REQ-003", kind: "requirement", terminal: false }] } });
    assert.equal(r.failures.length, 3);
  });
});
