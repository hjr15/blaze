// tests/model/advisory.test.mjs — BLZ-333, spec §4.3.
//
// "Reported, NEVER BLOCKING: RQ-4b warn tier, singularity, necessity,
// verification-method appropriateness, architecture-coverage percentage."
//
// Only the warn tier existed. The §4 tier split is load-bearing and must not blur: §4.1
// blocks, §4.2 gates, §4.3 reports. The spec's own test for which tier a rule belongs to
// is that a blocking rule must be true of every legitimate case — and every check here
// fails it. A requirement can legitimately contain "and"; an architecture item can
// legitimately address nothing yet.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkSingularity, checkNecessity, checkVerificationMethod,
  architectureCoverage, adviseStatement,
} from "../../scripts/model/advisory.mjs";

describe("singularity — one requirement per statement", () => {
  test("a single obligation is clean", () => {
    assert.deepEqual(checkSingularity("The system shall lock the account after 5 failed attempts."), []);
  });

  test("two conjoined obligations are flagged", () => {
    const f = checkSingularity("The system shall lock the account and shall email the user.");
    assert.equal(f.length >= 1, true);
    assert.match(f[0].why, /more than one/i);
  });

  test("two `shall`s are flagged even without an 'and'", () => {
    assert.equal(checkSingularity("The system shall lock the account; it shall email the user.").length >= 1, true);
  });

  test("'and' joining a NOUN PHRASE is not a second requirement", () => {
    // The discriminating case. Flagging every "and" makes the check noise, and a noisy
    // advisory is one people learn to ignore — which is worse than not having it.
    assert.deepEqual(checkSingularity("The system shall record the user's first and last name."), []);
  });

  test("a semicolon inside a list is not two requirements either", () => {
    assert.deepEqual(checkSingularity("The system shall accept CSV, TSV; nothing else."), []);
  });
});

describe("necessity — is there an obligation at all", () => {
  test("a statement with `shall` states an obligation", () => {
    assert.deepEqual(checkNecessity("The system shall retain audit records for 7 years."), []);
  });

  test("`must` also counts", () => {
    assert.deepEqual(checkNecessity("The API must reject an expired token."), []);
  });

  test("pure description with no obligation is flagged", () => {
    const f = checkNecessity("The system is a web application written in TypeScript.");
    assert.equal(f.length, 1);
    assert.match(f[0].why, /obligation/i);
  });

  test("an empty statement is flagged AS EMPTY, not as 'no obligation'", () => {
    // Asserting only the COUNT proved nothing: with the empty branch removed, an empty
    // string still fails the obligation test and still returns exactly one finding. The
    // message is the only thing that distinguishes "you wrote nothing" from "you wrote a
    // description", and they need different fixes.
    for (const empty of ["", "   ", null, undefined]) {
      const f = checkNecessity(empty);
      assert.equal(f.length, 1, `${JSON.stringify(empty)} must be flagged`);
      assert.match(f[0].why, /empty/i,
        `${JSON.stringify(empty)} must be reported as empty, not as a missing obligation`);
    }
    assert.doesNotMatch(checkNecessity("The system is a web app.")[0].why, /empty/i);
  });
});

describe("verification-method appropriateness", () => {
  test("a quantitative threshold verified by INSPECTION is flagged", () => {
    const f = checkVerificationMethod({
      statement: "The API shall respond within 200 ms at the 95th percentile.",
      method: "inspection" });
    assert.equal(f.length, 1);
    assert.match(f[0].why, /inspection/i);
  });

  test("the same statement verified by TEST is fine", () => {
    assert.deepEqual(checkVerificationMethod({
      statement: "The API shall respond within 200 ms at the 95th percentile.",
      method: "test" }), []);
  });

  test("a non-quantitative statement verified by inspection is fine", () => {
    assert.deepEqual(checkVerificationMethod({
      statement: "The licence header shall name the copyright holder.",
      method: "inspection" }), []);
  });

  test("an unknown method is flagged by name", () => {
    const f = checkVerificationMethod({ statement: "x", method: "vibes" });
    assert.equal(f.length, 1);
    assert.match(f[0].why, /vibes/);
  });

  test("no method stated is flagged AS MISSING, not as an unrecognised method name", () => {
    // Same trap as the empty-statement case: with the branch removed, String(undefined)
    // becomes "undefined", fails the known-methods check, and still returns one finding.
    // "you did not say" and "'undefined' is not a method" are different problems.
    for (const missing of [undefined, null, "", "  "]) {
      const f = checkVerificationMethod({ statement: "The API shall respond within 200 ms.", method: missing });
      assert.equal(f.length, 1, `${JSON.stringify(missing)} must be flagged`);
      assert.match(f[0].why, /states no verification method/i,
        `${JSON.stringify(missing)} must be reported as missing, not as an unknown name`);
    }
    assert.doesNotMatch(
      checkVerificationMethod({ statement: "x", method: "vibes" })[0].why,
      /states no verification method/i);
  });
});

describe("architecture-coverage percentage", () => {
  const req = (id) => ({ id, ref: id, kind: "requirement" });
  const addresses = (src, tgt) => ({ type_name: "Addresses", source_id: src, target_id: tgt });

  test("reports numerator and denominator, never a bare percentage", () => {
    // A bare percentage cannot be checked: 50% of two and 50% of two thousand are very
    // different facts and the reader cannot tell them apart.
    const c = architectureCoverage({
      artifacts: [req("r1"), req("r2")], links: [addresses("d1", "r1")] });
    assert.equal(c.covered, 1);
    assert.equal(c.total, 2);
    assert.equal(c.percent, 50);
  });

  test("a denominator of zero reports honestly, not 0% and not NaN", () => {
    const c = architectureCoverage({ artifacts: [], links: [] });
    assert.equal(c.total, 0);
    assert.equal(c.percent, null, "no requirements is not 0% coverage");
  });

  test("only INBOUND Addresses counts — an outbound one is the other direction", () => {
    const c = architectureCoverage({
      artifacts: [req("r1")], links: [addresses("r1", "d1")] });
    assert.equal(c.covered, 0);
  });

  test("a link of another type does not count as coverage", () => {
    const c = architectureCoverage({
      artifacts: [req("r1")], links: [{ type_name: "Relates", source_id: "d1", target_id: "r1" }] });
    assert.equal(c.covered, 0);
  });

  test("duplicate Addresses links to one requirement count it ONCE", () => {
    const c = architectureCoverage({
      artifacts: [req("r1")], links: [addresses("d1", "r1"), addresses("d2", "r1")] });
    assert.equal(c.covered, 1);
    assert.equal(c.percent, 100);
  });

  test("non-requirement artifacts are not in the denominator", () => {
    const c = architectureCoverage({
      artifacts: [req("r1"), { id: "d1", ref: "ADR-0001", kind: "architecture" }], links: [] });
    assert.equal(c.total, 1);
  });
});

describe("adviseStatement composes them, and NOTHING here blocks", () => {
  test("a statement failing every check returns findings, and no refusal", () => {
    const a = adviseStatement({ statement: "It is fast and easy and nice.", method: "vibes" });
    assert.ok(a.findings.length >= 2);
    assert.equal("ok" in a, false, "advisory output has no verdict — §4.3 reports, it never blocks");
  });

  test("every finding names which check produced it", () => {
    // A finding that does not say which rule produced it is one nobody can act on — the
    // same reason §4.4's rules have names.
    const a = adviseStatement({ statement: "The system is nice.", method: "vibes" });
    for (const f of a.findings) assert.ok(f.check, `${JSON.stringify(f)} has no check name`);
  });

  test("a clean statement produces no findings", () => {
    const a = adviseStatement({
      statement: "The system shall lock the account after 5 failed attempts.", method: "test" });
    assert.deepEqual(a.findings, []);
  });
});

// BLZ-337 — gaps found by adversarial mutation review. Each of these was written because
// deleting the behaviour it covers passed the ENTIRE 1,695-test suite silently.
describe("BLZ-337: gaps that the suite accepted silently", () => {
  test("a SINGLE-obligation sentence with two clauses is flagged (the CLAUSE_JOIN branch)", () => {
    // Every existing positive fixture had TWO shall/musts, so it fired the other branch and
    // the whole clause-join arm could be deleted with nothing failing — the exact "a filter
    // every fixture already satisfies" shape. One `shall`, two clauses.
    const f = checkSingularity("The system shall lock the account and will email the user.");
    assert.equal(f.length, 1, "one obligation word, two clauses — still two requirements");
    assert.equal(f[0].check, "singularity");
  });

  test("and the noun-phrase case still does NOT fire, with one obligation", () => {
    // The discriminating pair. Without this, 'flag every and' would satisfy the test above.
    assert.deepEqual(checkSingularity("The system shall record the first and last name."), []);
  });

  test("a quantitative threshold verified by DEMONSTRATION is flagged, not just by inspection", () => {
    const f = checkVerificationMethod({
      statement: "The API shall respond within 200 ms.", method: "demonstration" });
    assert.equal(f.length, 1);
    assert.match(f[0].why, /demonstration/i);
  });

  test("uncovered refs come back SORTED, with enough of them for order to mean anything", () => {
    // The only previous fixture had one element, so the sort was unprovable.
    const req = (id) => ({ id, ref: id, kind: "requirement" });
    const c = architectureCoverage({
      artifacts: [req("REQ-003"), req("REQ-001"), req("REQ-002")], links: [] });
    assert.deepEqual(c.uncovered, ["REQ-001", "REQ-002", "REQ-003"]);
  });
});
