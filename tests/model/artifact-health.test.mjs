// tests/model/artifact-health.test.mjs — BLZ-330, spec §5's per-artifact indicators.
//
// "Alongside it, per artifact: orphan / missing-downstream / stale-since-change, all
// computed." Only part existed: buildMatrix returned `untraced` for matrix rows only, and
// staleness.mjs computed staleLinks with NO CONSUMER — a module nothing imported. Per §4.5
// a computation unreachable through the API is a rule that does not exist.
//
// DIRECTION, stated once because getting it backwards inverts every indicator: a link runs
// source -> target where the SOURCE realises the TARGET (architecture Addresses
// requirement; feature Implements requirement). So an artifact's downstream realisation
// arrives INBOUND — the same direction `every-requirement-addressed` uses
// (direction: inbound) and the same thing buildMatrix.untraced measures.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { artifactHealth } from "../../scripts/model/artifact-health.mjs";

const A = (id, ref, kind = "requirement", project_key = "BLZ") => ({ id, ref, kind, project_key });
const L = (id, source_id, target_id, o = {}) =>
  ({ id, source_id, target_id, type_name: "Addresses", reviewed_at: null, ...o });

const run = (o) => artifactHealth({ project_key: "BLZ", ...o });

describe("orphan and missing-downstream are DISTINCT indicators", () => {
  test("no links at all in either direction is an orphan", () => {
    const h = run({ artifacts: [A("a1", "REQ-001")], links: [] });
    assert.equal(h.artifacts[0].orphan, true);
    assert.equal(h.artifacts[0].inbound, 0);
    assert.equal(h.artifacts[0].outbound, 0);
  });

  test("ONLY OUTBOUND links: not an orphan, but missing downstream", () => {
    // The discriminating case. Collapsing the two indicators into one makes this
    // artifact report identically to a fully-disconnected one, and the person cannot
    // tell "nothing knows about this" from "nothing realises this".
    const h = run({ artifacts: [A("d1", "ADR-0001", "architecture")],
                    links: [L("l1", "d1", "r-elsewhere")] });
    assert.equal(h.artifacts[0].orphan, false);
    assert.equal(h.artifacts[0].missingDownstream, true);
    assert.equal(h.artifacts[0].outbound, 1);
  });

  test("ONLY INBOUND links: neither orphan nor missing downstream — it IS realised", () => {
    const h = run({ artifacts: [A("a1", "REQ-001")], links: [L("l1", "d-elsewhere", "a1")] });
    assert.equal(h.artifacts[0].orphan, false);
    assert.equal(h.artifacts[0].missingDownstream, false);
    assert.equal(h.artifacts[0].inbound, 1);
  });

  test("an ORPHAN is also missing downstream — the indicators nest, they do not exclude", () => {
    const h = run({ artifacts: [A("a1", "REQ-001")], links: [] });
    assert.equal(h.artifacts[0].orphan, true);
    assert.equal(h.artifacts[0].missingDownstream, true);
  });

  test("links between OTHER artifacts do not count as this artifact's", () => {
    const h = run({ artifacts: [A("a1", "REQ-001")], links: [L("l1", "x", "y")] });
    assert.equal(h.artifacts[0].orphan, true);
  });
});

describe("stale-since-change gets its first production caller", () => {
  const REVISIONS = [{ artifact_id: "d1", at: "2026-02-01T00:00:00.000Z" }];

  test("a link out of a changed artifact, never reviewed, is stale", () => {
    const h = run({
      artifacts: [A("d1", "ADR-0001", "architecture")],
      links: [L("l1", "d1", "a1")],
      revisions: REVISIONS,
    });
    assert.equal(h.artifacts[0].staleSinceChange.length, 1);
    assert.equal(h.artifacts[0].staleSinceChange[0].linkId, "l1");
    assert.equal(h.artifacts[0].staleSinceChange[0].changedAt, "2026-02-01T00:00:00.000Z");
  });

  test("REVIEWING the link clears it — the indicator is not on for everything", () => {
    // Without link.reviewed_at as a real column, reviewed_at is always null and EVERY
    // link with a revised source reports stale. An indicator that is on for everything
    // is off.
    const h = run({
      artifacts: [A("d1", "ADR-0001", "architecture")],
      links: [L("l1", "d1", "a1", { reviewed_at: "2026-03-01T00:00:00.000Z" })],
      revisions: REVISIONS,
    });
    assert.deepEqual(h.artifacts[0].staleSinceChange, []);
  });

  test("a review BEFORE the change does not clear it", () => {
    const h = run({
      artifacts: [A("d1", "ADR-0001", "architecture")],
      links: [L("l1", "d1", "a1", { reviewed_at: "2026-01-01T00:00:00.000Z" })],
      revisions: REVISIONS,
    });
    assert.equal(h.artifacts[0].staleSinceChange.length, 1);
  });

  test("staleness is attributed to the artifact that CHANGED, not the one pointed at", () => {
    // A mutation keying this by target_id makes the wrong artifact look suspect, and the
    // person re-reviews the wrong thing.
    const h = run({
      artifacts: [A("d1", "ADR-0001", "architecture"), A("a1", "REQ-001")],
      links: [L("l1", "d1", "a1")],
      revisions: REVISIONS,
    });
    const byRef = Object.fromEntries(h.artifacts.map((a) => [a.ref, a]));
    assert.equal(byRef["ADR-0001"].staleSinceChange.length, 1);
    assert.equal(byRef["REQ-001"].staleSinceChange.length, 0);
  });

  test("an artifact with no revision is never stale", () => {
    const h = run({ artifacts: [A("d1", "ADR-0001", "architecture")],
                    links: [L("l1", "d1", "a1")], revisions: [] });
    assert.deepEqual(h.artifacts[0].staleSinceChange, []);
  });
});

describe("scoping and the house rule that untraced work is legal", () => {
  test("another project's artifacts are not reported", () => {
    const h = run({ artifacts: [A("a1", "REQ-001"), A("z1", "REQ-900", "requirement", "OTHER")],
                    links: [] });
    assert.deepEqual(h.artifacts.map((a) => a.ref), ["REQ-001"]);
  });

  test("the report COUNTS and NAMES — it never refuses and never invents a link", () => {
    // "Untraced work is legal and counted. Inventing a requirement to close a gap makes
    // the matrix a lie." The summary is the counting half.
    const h = run({
      artifacts: [A("a1", "REQ-001"), A("a2", "REQ-002"), A("a3", "REQ-003")],
      links: [L("l1", "d1", "a3")],
    });
    assert.deepEqual(h.summary.orphans, ["REQ-001", "REQ-002"]);
    assert.deepEqual(h.summary.missingDownstream, ["REQ-001", "REQ-002"]);
    assert.equal(h.summary.counted, 3, "every artifact is counted, including the covered one");
    assert.equal(h.ok, undefined, "health is a REPORT, not a verdict — nothing here refuses");
  });

  test("EVERY affected artifact is named, never a count alone or a truncated sample", () => {
    const artifacts = Array.from({ length: 30 }, (_, i) =>
      A(`a${i}`, `REQ-${String(i + 1).padStart(3, "0")}`));
    const h = run({ artifacts, links: [] });
    assert.equal(h.summary.orphans.length, 30);
  });

  test("summary.stale names the artifacts that changed, ordered by ref", () => {
    const h = run({
      artifacts: [A("d2", "ADR-0002", "architecture"), A("d1", "ADR-0001", "architecture")],
      links: [L("l1", "d1", "x"), L("l2", "d2", "y")],
      revisions: [{ artifact_id: "d1", at: "2026-02-01" }, { artifact_id: "d2", at: "2026-02-01" }],
    });
    assert.deepEqual(h.summary.stale, ["ADR-0001", "ADR-0002"]);
  });
});

// BLZ-337 — both null-project forgiveness clauses were unreachable: every fixture stamped
// project_key. They exist so the pure-decision fixtures that predate project scoping keep
// working, which means they need a fixture that actually omits it.
describe("BLZ-337: artifacts without a project_key are still reported", () => {
  test("an artifact with NO project_key is included in a project-scoped report", () => {
    const h = artifactHealth({ project_key: "BLZ",
      artifacts: [{ id: "a1", ref: "REQ-001", kind: "requirement" }], links: [] });
    assert.deepEqual(h.artifacts.map((a) => a.ref), ["REQ-001"]);
  });

  test("and asking with NO project_key reports every artifact, whatever its project", () => {
    const h = artifactHealth({
      artifacts: [{ id: "a1", ref: "REQ-001", kind: "requirement", project_key: "BLZ" },
                  { id: "z1", ref: "REQ-900", kind: "requirement", project_key: "OTHER" }],
      links: [] });
    assert.equal(h.summary.counted, 2);
  });
})
