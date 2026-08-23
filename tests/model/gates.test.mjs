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

  test("goal -> achieved is refused while ANY child requirement is unsatisfied (RQ-7)", () => {
    // BLZ-353 changed the satisfying set: this case used `implemented` as the satisfied
    // child, which no longer satisfies a goal. `verified` carries the original intent —
    // that a genuinely satisfied child is not listed among the failures.
    const r = checkGate({ action: "goal:achieved", subject: { id: "g1" }, context: {
      children: [{ ref: "REQ-001", kind: "requirement", status: "verified", terminal: true },
                 { ref: "REQ-002", kind: "requirement", status: "proposed", terminal: false }] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-002/);
    assert.doesNotMatch(r.error, /REQ-001/, "a satisfied child must not be listed as a failure");
  });

  test("goal -> achieved is refused while a child requirement is implemented-but-unverified (R48)", () => {
    // BLZ-353. `implemented` is terminal for the requirement's OWN lifecycle, so the old
    // `!terminal` filter let an unverified requirement satisfy a goal. Verification is now
    // required: a goal cannot be achieved carrying a requirement nobody verified.
    const r = checkGate({ action: "goal:achieved", subject: { id: "g1" }, context: {
      children: [{ ref: "REQ-001", kind: "requirement", status: "implemented", terminal: true }] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-001/);
    assert.match(r.error, /implemented/, "the refusal must name the status, not just the ref");
  });

  test("goal -> achieved accepts verified, rejected and obsolete requirements (R48)", () => {
    // rejected and obsolete are decisions NOT to deliver the requirement, so they do not
    // block. Only `implemented` — delivered but unverified — does.
    const r = checkGate({ action: "goal:achieved", subject: { id: "g1" }, context: {
      children: [{ ref: "REQ-001", kind: "requirement", status: "verified", terminal: true },
                 { ref: "REQ-002", kind: "requirement", status: "rejected", terminal: true },
                 { ref: "REQ-003", kind: "requirement", status: "obsolete", terminal: true }] } });
    assert.equal(r.ok, true);
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

  test("GATED_ACTIONS is derived from the handlers — the two cannot drift apart", () => {
    // Previously the set was hand-maintained beside the handlers, so a gate could be
    // implemented without being registered, or registered without being implemented,
    // and no test could tell. Deriving it makes both impossible by construction.
    for (const action of GATED_ACTIONS) {
      const r = checkGate({ action, subject: { ref: "X", body: "" }, context: {} });
      assert.equal(typeof r.ok, "boolean", `${action} has no handler`);
    }
  });

  test("document -> baselined is refused when coverage rules are unmet, and lists every item", () => {
    // The gate where coverage actually bites. Previously untested: replacing this
    // handler with () => [] passed the whole suite.
    const r = checkGate({ action: "document:baselined", subject: { id: "d1" }, context: {
      coverageViolations: [
        { ref: "REQ-014", why: "needs at least 1 inbound Addresses link, has 0" },
        { ref: "REQ-019", why: "needs at least 1 inbound Verifies link, has 0" },
      ] } });
    assert.equal(r.ok, false);
    assert.equal(r.failures.length, 2);
    assert.match(r.error, /REQ-014/);
    assert.match(r.error, /REQ-019/);
    assert.match(r.error, /Addresses/, "the refusal carries the reason, not just the ref");
  });

  test("document -> baselined passes when coverage is clean", () => {
    assert.equal(checkGate({ action: "document:baselined", subject: { id: "d1" },
                             context: { coverageViolations: [] } }).ok, true);
  });

  test("document -> baselined with no coverage context at all passes rather than throwing", () => {
    // A caller that computed no coverage must not crash the gate.
    assert.equal(checkGate({ action: "document:baselined", subject: { id: "d1" }, context: {} }).ok, true);
  });
});
