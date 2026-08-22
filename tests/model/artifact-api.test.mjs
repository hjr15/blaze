// tests/model/artifact-api.test.mjs
//
// ADR-0015 §4.5: enforcement lives BELOW HTTP, and is proven by exercising every rule
// through the API. CS-018 is the anti-pattern -- Polarion's own docs concede their
// suspect links "are implemented on the UI level only. They do not work for
// server-side use cases like imports or API calls." For agent-driven teams the API IS
// the primary interface, so a rule the API cannot see does not exist.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { artifactApi, denormaliseLinks } from "../../scripts/model/artifact-api.mjs";
import { ROUTE_SCOPES } from "../../scripts/model/serve-auth.mjs";

// task-13-brief.md's worked test file named this helper `api()` at module scope and
// then had every test call a second wrapper, `api2()`, that just returned `api()` --
// two names for one function, for no reason. Cleaned up to a single `makeApi()`
// called directly, per the task-13 contract note that flagged it as a minor issue.
function makeApi(overrides = {}) {
  const state = {
    artifacts: [{ id: "a1", ref: "REQ-001", kind: "requirement", status: "proposed" }],
    // Tickets are the OTHER half of the polymorphic model (C1): features and stories
    // are tickets, not artifacts, and `kind` for a ticket is its `type`. Empty by
    // default so existing artifact-only tests are unaffected.
    tickets: [],
    linkTypes: [
      { id: "lt1", name: "Addresses", inverse_name: "Addressed by",
        source_kinds: "architecture", target_kinds: "requirement", min_card: 0, max_card: null },
      { id: "lt2", name: "Supersedes", inverse_name: "Superseded by",
        source_kinds: "architecture", target_kinds: "architecture", min_card: 0, max_card: 1 },
    ],
    links: [],
    ...overrides,
  };
  return { api: artifactApi(state), state };
}

describe("every rule is enforced through the API, not above it", () => {
  test("a link with an illegal endpoint is refused BY THE API", async () => {
    const { api } = makeApi();
    const r = await api.createLink({ typeName: "Addresses", sourceId: "a1", targetId: "a1" });
    assert.equal(r.ok, false);
  });

  test("an undeclared link type is refused BY THE API — default deny", async () => {
    const { api } = makeApi();
    const r = await api.createLink({ typeName: "Whatever", sourceId: "x", targetId: "a1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown link type/i);
  });

  test("a gated transition is refused BY THE API", async () => {
    const { api } = makeApi();
    const r = await api.transition({ id: "a1", to: "verified" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Verifies/);
  });

  test("field promotion past the cap is refused BY THE API", async () => {
    const { api, state } = makeApi();
    state.fieldDefinitions = Array.from({ length: 200 }, (_, i) => (
      { key: `f${i}`, applies_to_kind: "requirement", is_filterable: true }));
    const r = await api.defineField({ key: "x", data_type: "number", is_filterable: true,
                                      applies_to_kind: "requirement" });
    assert.equal(r.ok, false);
    assert.match(r.error, /200/);
  });

  // C5: `defineField` used to read `field.filterableCount` straight off the request --
  // a caller-supplied number the API never verified against anything. Sending 0 made
  // the install-wide 200-field cap (the budget Task 13's admin-only ruling exists to
  // protect) never fire. The count must come from persisted state, never the request.
  test("a caller-supplied filterableCount is IGNORED — the cap is enforced from real state", async () => {
    const { api, state } = makeApi();
    state.fieldDefinitions = Array.from({ length: 200 }, (_, i) => (
      { key: `f${i}`, applies_to_kind: "requirement", is_filterable: true }));
    const r = await api.defineField({ key: "x", data_type: "number", is_filterable: true,
                                      applies_to_kind: "requirement", filterableCount: 0 });
    assert.equal(r.ok, false, "filterableCount: 0 from the caller must not bypass the real count");
    assert.match(r.error, /200/);
  });

  test("EVERY v4 route is classified in ROUTE_SCOPES — an unclassified route fails closed", () => {
    for (const r of ["POST /api/artifact", "POST /api/link", "POST /api/baseline",
                     "GET /api/matrix", "POST /api/field"]) {
      assert.ok(r in ROUTE_SCOPES, `${r} is not classified`);
    }
  });

  test("every mutating v4 route costs write or admin, and no GET does", () => {
    for (const [route, scope] of Object.entries(ROUTE_SCOPES)) {
      if (route.startsWith("POST ")) assert.notEqual(scope, "read", route);
      if (route.startsWith("GET ")) assert.equal(scope, "read", route);
    }
  });
});

describe("C1: link endpoints and gate subjects resolve across BOTH artifact and ticket", () => {
  // Implements/Verifies start at a feature or story -- a ticket, not an artifact.
  // Before resolveEndpoint, `find()` only ever searched state.artifacts, so a ticket
  // endpoint resolved to sourceKind "unknown" and every such link was refused,
  // regardless of how the link type declared its legal sources.
  test("Verifies can start at a ticket (feature) -- not just an artifact", async () => {
    const { api, state } = makeApi({
      tickets: [{ id: "f1", type: "feature", status: "defined" }],
      linkTypes: [{ id: "lt3", name: "Verifies", inverse_name: "Verified by",
        source_kinds: "story,feature", target_kinds: "requirement", min_card: 0, max_card: null }],
    });
    const r = await api.createLink({ typeName: "Verifies", sourceId: "f1", targetId: "a1" });
    assert.equal(r.ok, true, r.error);
    assert.equal(state.links.length, 1);
  });

  // The full chain the review found completely unreachable: no Verifies link could be
  // created (C1) -> requirement:verified could never pass (RQ-6) -> and since
  // every-requirement-verified is a DEFAULT coverage rule, document:baselined could
  // never pass either. This proves the chain now closes end to end through the API.
  test("end to end: a feature Verifies-links a requirement, which can then transition to verified", async () => {
    const { api, state } = makeApi({
      tickets: [{ id: "f1", type: "feature", status: "defined" }],
      linkTypes: [{ id: "lt3", name: "Verifies", inverse_name: "Verified by",
        source_kinds: "story,feature", target_kinds: "requirement", min_card: 0, max_card: null }],
    });

    const before = await api.transition({ id: "a1", to: "verified" });
    assert.equal(before.ok, false, "must not pass before the link exists");

    const link = await api.createLink({ typeName: "Verifies", sourceId: "f1", targetId: "a1" });
    assert.equal(link.ok, true, link.error);

    const after = await api.transition({ id: "a1", to: "verified" });
    assert.equal(after.ok, true, after.error);
    assert.equal(state.artifacts.find((a) => a.id === "a1").status, "verified");
  });
});

describe("the goal:achieved gap: children resolved via hierarchy_membership, not parent_id", () => {
  // goal:achieved was unreachable, not merely untested: no artifact can ever have kind
  // "goal" (goal is a ticket type), and the old children lookup filtered
  // state.artifacts by parent_id -- the column §3.3 built hierarchy_membership to
  // replace. Both gaps have to close together for this gate to be exercisable at all.
  function makeGoalApi() {
    return makeApi({
      tickets: [{ id: "g1", type: "goal", status: "in-progress" }],
      artifacts: [
        { id: "a1", ref: "REQ-001", kind: "requirement", status: "proposed" },
        { id: "a2", ref: "REQ-002", kind: "requirement", status: "proposed" },
      ],
      hierarchies: [{ id: "h1", project_key: "BLZ", name: "default", is_default: true }],
      hierarchyMemberships: [
        { id: "m1", hierarchy_id: "h1", item_id: "a1", parent_id: "g1", ord: 0 },
        { id: "m2", hierarchy_id: "h1", item_id: "a2", parent_id: "g1", ord: 1 },
      ],
    });
  }

  test("a goal cannot reach achieved while a child requirement is non-terminal", async () => {
    const { api } = makeGoalApi();
    const r = await api.transition({ id: "g1", to: "achieved" });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-001/);
    assert.match(r.error, /REQ-002/);
  });

  test("...and CAN once every child requirement is terminal", async () => {
    const { api, state } = makeGoalApi();
    // "implemented" is a terminal status for the requirement workflow, and
    // requirement:implemented is not a gated action, so this transition itself is
    // ungated and simply records the status.
    assert.equal((await api.transition({ id: "a1", to: "implemented" })).ok, true);
    assert.equal((await api.transition({ id: "a2", to: "implemented" })).ok, true);

    const r = await api.transition({ id: "g1", to: "achieved" });
    assert.equal(r.ok, true, r.error);
    assert.equal(state.tickets.find((t) => t.id === "g1").status, "achieved");
  });
});

describe("C4: RQ-4a's wording lint is wired into createArtifact, not just its own test", () => {
  test("a block-tier statement is refused, naming the phrase and why", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ",
      statement: "The system shall be user friendly." });
    assert.equal(r.ok, false);
    assert.match(r.error, /user friendly/);
  });

  test("the same statement succeeds once a reason is given, and the reason is recorded", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ",
      statement: "The system shall be user friendly.",
      reason: "client contract wording, verbatim" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.artifact.wording_override_reason, "client contract wording, verbatim");
  });

  test("a warn-tier statement succeeds WITH a warning, and is never refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ",
      statement: "The system shall never store plaintext passwords." });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0].phrase, /never/);
  });
});

describe("BLZ-325: createArtifact refuses a row the real schema could not hold", () => {
  // artifactDdl: project_key and title are both NOT NULL, and title also carries
  // CHECK (length(trim(title)) > 0). Refused here, with a named reason, rather than
  // surfacing as a raw NOT NULL / CHECK constraint violation from the database.
  test("a missing project_key is refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error, /project_key/);
  });

  test("a missing title is refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", project_key: "BLZ" });
    assert.equal(r.ok, false);
    assert.match(r.error, /title/);
  });

  test("a blank (whitespace-only) title is refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "   ", project_key: "BLZ" });
    assert.equal(r.ok, false);
    assert.match(r.error, /title/);
  });

  test("a well-formed artifact carries project_key, created_at and updated_at", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.artifact.project_key, "BLZ");
    assert.ok(r.artifact.created_at);
    assert.ok(r.artifact.updated_at);
  });
});

describe("ref format and monotonicity are enforced at the API, not the database", () => {
  // Ref UNIQUENESS is a database constraint (must hold under concurrency). Ref FORMAT
  // and MONOTONICITY are enforced here, where the refusal can name the expected shape.
  test("a malformed ref is refused, naming the expected shape", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ", ref: "NOTAREF" });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-nnn/);
  });

  test("a ref of the wrong kind is refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ", ref: "ADR-0001" });
    assert.equal(r.ok, false);
    assert.match(r.error, /architecture ref/);
  });

  test("a ref that does not advance past the highest allocated one is refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ", ref: "REQ-001" });
    assert.equal(r.ok, false);
    assert.match(r.error, /monotonically/);
  });

  test("a well-formed, advancing ref is accepted", async () => {
    const { api, state } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ", ref: "REQ-002" });
    assert.equal(r.ok, true);
    assert.equal(state.artifacts.length, 2);
  });

  test("omitting the ref allocates the next one", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", project_key: "BLZ" });
    assert.equal(r.ok, true);
    assert.equal(r.artifact.ref, "REQ-002");
  });
});

describe("the denormalising join: link rows are stored link_type_id-keyed, enforced by name", () => {
  test("a stored link carries link_type_id, not type_name — the join happens on read", async () => {
    const { api, state } = makeApi();
    const r = await api.createLink({ typeName: "Addresses", sourceId: "a1", targetId: "a1" });
    // a1 is a requirement, and Addresses only starts at architecture, so this specific
    // call is refused -- swap in a legal pair to prove the storage shape instead.
    assert.equal(r.ok, false);

    state.artifacts.push({ id: "arch1", ref: "ADR-0001", kind: "architecture", status: "proposed" });
    const r2 = await api.createLink({ typeName: "Addresses", sourceId: "arch1", targetId: "a1" });
    assert.equal(r2.ok, true);
    assert.equal(state.links.length, 1);
    assert.equal(state.links[0].link_type_id, "lt1");
    assert.equal(state.links[0].type_name, undefined, "raw storage is link_type_id-keyed, not name-keyed");

    const joined = denormaliseLinks({ links: state.links, linkTypes: state.linkTypes });
    assert.equal(joined[0].type_name, "Addresses");
  });

  test("cardinality is enforced against the DENORMALISED count, across the join", async () => {
    const { api, state } = makeApi();
    state.artifacts.push(
      { id: "arch1", ref: "ADR-0001", kind: "architecture", status: "proposed" },
      { id: "arch2", ref: "ADR-0002", kind: "architecture", status: "proposed" });
    const first = await api.createLink({ typeName: "Supersedes", sourceId: "arch1", targetId: "arch2" });
    assert.equal(first.ok, true);

    state.artifacts.push({ id: "arch3", ref: "ADR-0003", kind: "architecture", status: "proposed" });
    // Supersedes has max_card: 1 from this source. The API must count the existing
    // link by joining link_type_id back to its name, not by re-reading a type_name
    // field that was never stored.
    const second = await api.createLink({ typeName: "Supersedes", sourceId: "arch1", targetId: "arch3" });
    assert.equal(second.ok, false);
    assert.match(second.error, /at most 1/);
  });
});

describe("document:baselined composes evaluateCoverage into checkGate, in the API", () => {
  // gates.mjs deliberately does not import evaluateCoverage -- three of the four gates
  // have nothing to do with coverage, so document:baselined receives its violations
  // pre-computed on context.coverageViolations. The composition belongs here.
  function makeDocApi() {
    const { api, state } = makeApi({
      artifacts: [
        { id: "a1", ref: "REQ-001", kind: "requirement", status: "proposed" },
        { id: "arch1", ref: "ADR-0001", kind: "architecture", status: "proposed" },
      ],
      // A feature ticket, so the "baselining succeeds" test below can satisfy
      // every-requirement-verified with a REAL Verifies link (source: story|feature —
      // a ticket, not an artifact). Previously this test redefined Verifies as
      // architecture-sourced to route around C1; restored to the true shape.
      tickets: [{ id: "f1", type: "feature", status: "defined" }],
      // project_key: baselineDocument (§3.6) derives the baseline's own project_key
      // from the document's, so the document must carry one — it is NOT NULL in
      // documentDdl regardless.
      documents: [{ id: "d1", project_key: "BLZ", title: "Spec", kind: "requirements", status: "draft" }],
      artifactUsages: [{ document_id: "d1", artifact_id: "a1", ord: 1, depth: 0 }],
      // A revision for a1, the one member document usages reference. Seeded directly
      // here (rather than only via createArtifact) because these artifacts are also
      // seeded directly — a fixture stands in for "this artifact already existed
      // before this test", and baselineDocument now requires a real revision to pin.
      artifactRevisions: [
        { id: "rev-a1-1", artifact_id: "a1", at: "2026-01-01T00:00:00.000Z",
          actor: "seed", snapshot: "{}" },
      ],
    });
    return { api, state };
  }

  test("baselining is refused when a member requirement lacks coverage", async () => {
    const { api } = makeDocApi();
    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-001/);
    assert.match(r.error, /Addresses/);
  });

  // BLZ-325: a member with no revision recorded must refuse the baseline BEFORE it is
  // ever created, naming the ref — never a NULL pin, per §3.6/§3.7. Coverage is
  // satisfied first here, specifically so the failure under test is the revision
  // check, not the (already-covered) coverage gate.
  test("baselining is refused when a member artifact has no revision recorded", async () => {
    const { api, state } = makeDocApi();
    state.artifactRevisions.length = 0;   // a1 now has no revision to pin
    await api.createLink({ typeName: "Addresses", sourceId: "arch1", targetId: "a1" });
    state.linkTypes.push({ id: "lt3", name: "Verifies", inverse_name: "Verified by",
      source_kinds: "story,feature", target_kinds: "requirement", min_card: 0, max_card: null });
    await api.createLink({ typeName: "Verifies", sourceId: "f1", targetId: "a1" });

    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-001/);
    assert.match(r.error, /revision/);
    assert.equal((state.baselines ?? []).length, 0, "no baseline must be recorded on refusal");
  });

  test("baselining succeeds once coverage is clean, and records the baseline", async () => {
    const { api, state } = makeDocApi();
    await api.createLink({ typeName: "Addresses", sourceId: "arch1", targetId: "a1" });
    // every-requirement-verified also applies to REQ-001 in DEFAULT_COVERAGE_RULES;
    // supply the REAL Verifies definition (source: story|feature) and satisfy it from
    // the feature ticket, proving the link-schema.mjs shape actually works through the
    // API rather than a shape the test invented to get around C1.
    state.linkTypes.push({ id: "lt3", name: "Verifies", inverse_name: "Verified by",
      source_kinds: "story,feature", target_kinds: "requirement", min_card: 0, max_card: null });
    const verifies = await api.createLink({ typeName: "Verifies", sourceId: "f1", targetId: "a1" });
    assert.equal(verifies.ok, true, verifies.error);

    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, true, r.error);
    assert.equal(state.documents[0].status, "baselined");
    assert.equal(state.baselines.length, 1);
    // §3.6: project-scoped, not per-document — no document_id, no member_ids array on
    // the baseline itself; membership lives in baseline_member, pinned to a revision.
    assert.equal(state.baselines[0].project_key, "BLZ");
    assert.equal("document_id" in state.baselines[0], false);
    assert.equal("member_ids" in state.baselines[0], false);
    assert.deepEqual(
      state.baselineMembers.map((m) => ({ artifact_id: m.artifact_id, revision_id: m.revision_id })),
      [{ artifact_id: "a1", revision_id: "rev-a1-1" }]);
  });
});

// BLZ-327 — spec §4.4: "Applying a rule to existing data MUST report every current
// violation. Jama's silent grandfathering (CS-013) is exactly the drift the operator
// named. Retroactive *blocking* is not required; retroactive **reporting** is
// mandatory."
//
// The final review's I4: there was no rule-creation path at all. `coverage()` is a
// standing read, which is a DIFFERENT obligation -- the spec requires the report at the
// moment of applying, so the person adding the rule sees what they have just made
// non-compliant. A standing endpoint they may never open is exactly CS-013.
describe("BLZ-327 (§4.4): applying a coverage rule reports every current violation", () => {
  const RULE = {
    project_key: "BLZ", name: "every-requirement-addressed-v2",
    description: "Every requirement is addressed by an architecture decision.",
    subject_kind: "requirement",
    definition: { requires_link: "Addresses", direction: "inbound", min: 1 },
  };

  // Artifacts that already existed BEFORE the rule did -- the whole point of §4.4.
  function makeRuleApi(count = 3) {
    return makeApi({
      artifacts: Array.from({ length: count }, (_, i) => ({
        id: `a${i + 1}`, ref: `REQ-${String(i + 1).padStart(3, "0")}`,
        kind: "requirement", status: "proposed", project_key: "BLZ",
      })),
      coverageRules: [],
    });
  }

  test("defining a rule over pre-existing violating data reports every violation, by ref", async () => {
    const { api } = makeRuleApi(3);
    const r = await api.defineCoverageRule(RULE);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.currentViolations.length, 3,
      "a rule applied to three uncovered requirements must report three violations");
    assert.deepEqual(r.currentViolations.map((v) => v.ref).sort(),
      ["REQ-001", "REQ-002", "REQ-003"]);
    assert.match(r.currentViolations[0].why, /Addresses/);
  });

  test("EVERY violation is reported — never a count, never a truncated sample", async () => {
    const { api } = makeRuleApi(30);
    const r = await api.defineCoverageRule(RULE);
    assert.equal(r.currentViolations.length, 30);
  });

  test("creation SUCCEEDS despite violations — reporting is mandatory, blocking is not", async () => {
    const { api, state } = makeRuleApi(3);
    const r = await api.defineCoverageRule(RULE);
    assert.equal(r.ok, true, r.error);
    assert.ok(state.coverageRules.some((c) => c.name === RULE.name),
      "the rule must be persisted even though existing data violates it");
    assert.ok(api.coverage().some((c) => c.rule === RULE.name),
      "and must be visible to the standing coverage read");
  });

  test("an already-compliant corpus reports no violations", async () => {
    const { api, state } = makeRuleApi(1);
    state.artifacts.push({ id: "arch1", ref: "ADR-0001", kind: "architecture",
                           status: "proposed", project_key: "BLZ" });
    const link = await api.createLink({ typeName: "Addresses", sourceId: "arch1", targetId: "a1" });
    assert.equal(link.ok, true, link.error);
    const r = await api.defineCoverageRule(RULE);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.currentViolations, []);
  });

  // Without this, a rule scoped to one project silently reports another project's
  // artifacts as violations -- and the person applying it acts on a lie.
  test("a project-scoped rule does not report ANOTHER project's artifacts", async () => {
    const { api, state } = makeRuleApi(1);
    state.artifacts.push({ id: "z1", ref: "REQ-900", kind: "requirement",
                           status: "proposed", project_key: "OTHER" });
    const r = await api.defineCoverageRule(RULE);
    assert.deepEqual(r.currentViolations.map((v) => v.ref), ["REQ-001"]);
  });

  describe("the rule is validated before it is persisted, and each refusal names what was wrong", () => {
    const cases = [
      ["a missing project_key", { project_key: undefined }, /project_key/],
      ["an empty name", { name: "  " }, /name/],
      ["an empty description", { description: "" }, /description/],
      ["an unknown subject_kind", { subject_kind: "ticket" }, /subject_kind|ticket/],
      ["an UNDECLARED link type", { definition: { requires_link: "Verifies", direction: "inbound", min: 1 } }, /Verifies|link type/],
      ["a bogus direction", { definition: { requires_link: "Addresses", direction: "sideways", min: 1 } }, /direction|sideways/],
      ["min below 1", { definition: { requires_link: "Addresses", direction: "inbound", min: 0 } }, /min/],
      ["a non-integer min", { definition: { requires_link: "Addresses", direction: "inbound", min: 1.5 } }, /min/],
      ["a missing definition", { definition: undefined }, /definition/],
    ];
    for (const [label, override, pattern] of cases) {
      test(`${label} is REFUSED`, async () => {
        const { api, state } = makeRuleApi(1);
        const r = await api.defineCoverageRule({ ...RULE, ...override });
        assert.equal(r.ok, false, `${label} was accepted`);
        assert.match(r.error, pattern);
        assert.equal(state.coverageRules.length, 0, "nothing may be persisted on refusal");
      });
    }
  });

  test("a duplicate (project_key, name) is refused BY THE API, naming the rule", async () => {
    const { api } = makeRuleApi(1);
    await api.defineCoverageRule(RULE);
    const r = await api.defineCoverageRule({ ...RULE, description: "different text" });
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(RULE.name));
  });

  test("the same name in a DIFFERENT project is fine", async () => {
    const { api } = makeRuleApi(1);
    await api.defineCoverageRule(RULE);
    const r = await api.defineCoverageRule({ ...RULE, project_key: "OTHER" });
    assert.equal(r.ok, true, r.error);
  });

  // A rule introduced disabled and switched on later is the same act of application,
  // and carries the same reporting obligation -- otherwise §4.4 is trivially routed
  // around by defining every rule disabled.
  describe("enabling a disabled rule is an act of application too", () => {
    test("enabling reports the current violations", async () => {
      const { api } = makeRuleApi(3);
      const created = await api.defineCoverageRule({ ...RULE, enabled: false });
      assert.equal(created.ok, true, created.error);
      const r = await api.setCoverageRuleEnabled({ project_key: "BLZ", name: RULE.name, enabled: true });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.currentViolations.length, 3);
    });

    test("DISABLING reports nothing — there is no obligation to report on withdrawal", async () => {
      const { api } = makeRuleApi(3);
      await api.defineCoverageRule(RULE);
      const r = await api.setCoverageRuleEnabled({ project_key: "BLZ", name: RULE.name, enabled: false });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.currentViolations, null);
    });

    test("an unknown rule is refused, naming it", async () => {
      const { api } = makeRuleApi(1);
      const r = await api.setCoverageRuleEnabled({ project_key: "BLZ", name: "no-such-rule", enabled: true });
      assert.equal(r.ok, false);
      assert.match(r.error, /no-such-rule/);
    });
  });

  test("a DISABLED rule is not evaluated by the standing coverage read", async () => {
    const { api } = makeRuleApi(3);
    await api.defineCoverageRule({ ...RULE, enabled: false });
    assert.equal(api.coverage().some((c) => c.rule === RULE.name), false,
      "a disabled rule must not appear in coverage()");
  });

  test("a DISABLED rule does not refuse a baseline", async () => {
    const { api, state } = makeApi({
      artifacts: [{ id: "a1", ref: "REQ-001", kind: "requirement", status: "proposed",
                    project_key: "BLZ" }],
      documents: [{ id: "d1", project_key: "BLZ", title: "Spec", kind: "requirements", status: "draft" }],
      artifactUsages: [{ document_id: "d1", artifact_id: "a1", ord: 1, depth: 0 }],
      artifactRevisions: [{ id: "rev1", artifact_id: "a1", at: "2026-01-01T00:00:00.000Z",
                            actor: "seed", snapshot: "{}" }],
      coverageRules: [],
    });
    await api.defineCoverageRule({ ...RULE, enabled: false });
    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, true, r.error);
    assert.equal(state.baselines.length, 1);
  });

  // The shipped defaults are the rules in force when nobody has defined any. Defining
  // one must not silently drop them -- that would make the FIRST rule anyone adds turn
  // three standing rules off.
  test("defining the first rule does not silently drop DEFAULT_COVERAGE_RULES", async () => {
    const { api } = makeApi({
      artifacts: [{ id: "a1", ref: "REQ-001", kind: "requirement", status: "proposed",
                    project_key: "BLZ" }],
    });
    const before = api.coverage().map((c) => c.rule);
    assert.ok(before.includes("every-requirement-addressed"), "sanity: defaults are in force");
    await api.defineCoverageRule(RULE);
    const after = api.coverage().map((c) => c.rule);
    for (const name of before) assert.ok(after.includes(name), `${name} was dropped`);
    assert.ok(after.includes(RULE.name));
  });
});

// BLZ-328 — §4.1's third write-time block, proven THROUGH THE API per §4.5. `is_required`,
// `enum_values`, `min_value` and `max_value` had been columns nothing read since BLZ-321.
describe("BLZ-328 (§4.1): required, enum, type and range are enforced BY THE API", () => {
  function makeFieldApi(definitions) {
    return makeApi({
      artifacts: [],
      fieldDefinitions: definitions,
    });
  }
  const defn = (o) => ({
    project_key: "BLZ", applies_to_kind: "requirement", data_type: "text",
    is_required: false, enum_values: null, min_value: null, max_value: null, ...o,
  });

  test("a missing required field refuses createArtifact, naming the field", async () => {
    const { api } = makeFieldApi([defn({ key: "owner", is_required: true })]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(r.ok, false);
    assert.match(r.error, /owner/);
  });

  test("supplying it succeeds", async () => {
    const { api } = makeFieldApi([defn({ key: "owner", is_required: true })]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                         fields: { owner: "ryan" } });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.artifact.fields, { owner: "ryan" });
  });

  test("an out-of-enum value is refused BY THE API and the legal values come back", async () => {
    const { api } = makeFieldApi([defn({ key: "sev", data_type: "enum", enum_values: "low,high" })]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                         fields: { sev: "nope" } });
    assert.equal(r.ok, false);
    assert.match(r.error, /low/);
    assert.match(r.error, /high/);
  });

  test("an out-of-range number is refused BY THE API", async () => {
    const { api } = makeFieldApi([defn({ key: "score", data_type: "number", min_value: "1", max_value: "5" })]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                         fields: { score: 9 } });
    assert.equal(r.ok, false);
    assert.match(r.error, /range/);
  });

  test("EVERY violation comes back in one refusal, not just the first", async () => {
    const { api } = makeFieldApi([
      defn({ key: "owner", is_required: true }),
      defn({ key: "sev", data_type: "enum", enum_values: "low,high" }),
      defn({ key: "score", data_type: "number", min_value: "1", max_value: "5" }),
    ]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                         fields: { sev: "nope", score: 99 } });
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 3);
    assert.deepEqual(r.violations.map((v) => v.key).sort(), ["owner", "score", "sev"]);
  });

  // A refused write that has already burned a ref leaves a permanent hole in the
  // sequence -- and the ledger (BLZ-326) is append-only, so it can never be reclaimed.
  test("a refused write records NOTHING — no artifact, no revision, no ref consumed", async () => {
    const { api, state } = makeFieldApi([defn({ key: "owner", is_required: true })]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(r.ok, false);
    assert.equal(state.artifacts.length, 0);
    assert.equal((state.artifactRevisions ?? []).length, 0);

    const ok = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                          fields: { owner: "ryan" } });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.artifact.ref, "REQ-001", "the refused write must not have consumed REQ-001");
  });

  test("a field defined for ARCHITECTURE does not constrain a requirement write", async () => {
    const { api } = makeFieldApi([
      defn({ key: "owner", is_required: true, applies_to_kind: "architecture" })]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(r.ok, true, r.error);
  });

  test("a field defined for ANOTHER project does not constrain this one", async () => {
    const { api } = makeFieldApi([defn({ key: "owner", is_required: true, project_key: "OTHER" })]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(r.ok, true, r.error);
  });

  test("with no field definitions at all, createArtifact is unchanged", async () => {
    const { api } = makeFieldApi([]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(r.ok, true, r.error);
  });

  // Order matters: the ref is allocated AFTER validation, and the wording lint is a
  // separate block. A field violation must not be masked by, or mask, the lint.
  test("a field violation and a wording-lint block are both reachable", async () => {
    const { api } = makeFieldApi([defn({ key: "owner", is_required: true })]);
    const both = await api.createArtifact({
      kind: "requirement", title: "R", project_key: "BLZ",
      statement: "The system shall be user-friendly and etc." });
    assert.equal(both.ok, false);
    assert.match(both.error, /owner/, "the field block runs first and names the field");

    const lintOnly = await api.createArtifact({
      kind: "requirement", title: "R", project_key: "BLZ", fields: { owner: "ryan" },
      statement: "The system shall be user-friendly and etc." });
    assert.equal(lintOnly.ok, false, "and the lint is still reachable once fields are valid");
    assert.match(lintOnly.error, /wording lint/);
  });
});

// BLZ-329 — §3.4: the cap "must be surfaced CONTINUOUSLY, never sprung (CS-008)".
describe("BLZ-329 (§3.4): the field budget is surfaced through the API, not only on refusal", () => {
  const fd = (o) => ({ project_key: "BLZ", applies_to_kind: "requirement",
                       is_filterable: true, data_type: "text", key: "k", ...o });

  test("a SUCCESSFUL defineField returns the post-promotion budget", async () => {
    const { api } = makeApi({ fieldDefinitions: [] });
    const r = await api.defineField(fd({ key: "risk", data_type: "number" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.budget.artifact.used, 1, "the budget must include the promotion that just happened");
    assert.equal(r.budget.artifact.remaining, 199);
  });

  test("the standing read is available without defining anything", async () => {
    const { api } = makeApi({ fieldDefinitions: [fd({ key: "a" }), fd({ key: "b" })] });
    assert.equal((await api.fieldBudget()).artifact.used, 2);
  });

  test("the count comes from PERSISTED state, never from the request (the C5 defect)", async () => {
    const { api } = makeApi({
      fieldDefinitions: Array.from({ length: 40 }, (_, i) => fd({ key: `k${i}` })) });
    // A caller insisting the budget is empty must not be believed.
    const r = await api.defineField(fd({ key: "sneaky", filterableCount: 0, existingColumns: [] }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.budget.artifact.used, 41);
  });

  test("asked as a project, the budget shows what OTHER projects have spent", async () => {
    const { api } = makeApi({ fieldDefinitions: [
      fd({ key: "a", project_key: "BLZ" }),
      fd({ key: "b", project_key: "OTHER" }),
      fd({ key: "c", project_key: "OTHER" }),
    ]});
    const b = await api.fieldBudget({ project_key: "BLZ" });
    assert.equal(b.artifact.yours, 1);
    assert.equal(b.artifact.others, 2);
    assert.deepEqual(b.artifact.byProject[0], { project_key: "OTHER", used: 2 });
  });

  test("the refusal path still fires, and the budget it reports agrees with the read", async () => {
    const { api, state } = makeApi({
      fieldDefinitions: Array.from({ length: 200 }, (_, i) => fd({ key: `k${i}` })) });
    assert.equal((await api.fieldBudget()).artifact.exhausted, true);
    const r = await api.defineField(fd({ key: "onemore" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /200/);
    assert.equal(state.fieldDefinitions.length, 200, "a refused promotion must not be recorded");
  });

  test("`warn` fires before the cap, so approaching it is visible while there is headroom", async () => {
    const { api } = makeApi({
      fieldDefinitions: Array.from({ length: 160 }, (_, i) => fd({ key: `k${i}` })) });
    const b = await api.fieldBudget();
    assert.equal(b.artifact.warn, true);
    assert.equal(b.artifact.exhausted, false);
    assert.ok(b.artifact.remaining > 0);
  });
});

// BLZ-330 — §5's per-artifact indicators, reachable THROUGH THE API. staleness.mjs had
// computed staleLinks since BLZ-313 with no consumer at all; per §4.5 a computation the
// API cannot reach is a rule that does not exist.
describe("BLZ-330 (§5): orphan / missing-downstream / stale-since-change through the API", () => {
  function makeHealthApi() {
    return makeApi({
      artifacts: [
        { id: "a1", ref: "REQ-001", kind: "requirement", status: "proposed", project_key: "BLZ" },
        { id: "a2", ref: "REQ-002", kind: "requirement", status: "proposed", project_key: "BLZ" },
        { id: "d1", ref: "ADR-0001", kind: "architecture", status: "proposed", project_key: "BLZ" },
      ],
    });
  }

  test("an untouched project reports every artifact as an orphan, by ref", () => {
    const { api } = makeHealthApi();
    const h = api.artifactHealth({ project_key: "BLZ" });
    assert.deepEqual(h.summary.orphans, ["ADR-0001", "REQ-001", "REQ-002"]);
    assert.equal(h.summary.counted, 3);
  });

  test("a link created through the API changes both ends' indicators", async () => {
    const { api } = makeHealthApi();
    const r = await api.createLink({ typeName: "Addresses", sourceId: "d1", targetId: "a1" });
    assert.equal(r.ok, true, r.error);

    const byRef = Object.fromEntries(
      api.artifactHealth({ project_key: "BLZ" }).artifacts.map((a) => [a.ref, a]));
    // The requirement is now realised: not an orphan, not missing downstream.
    assert.equal(byRef["REQ-001"].missingDownstream, false);
    // The architecture item points at something, so it is not disconnected — but nothing
    // realises IT, so it is still missing downstream. The two indicators must differ here.
    assert.equal(byRef["ADR-0001"].orphan, false);
    assert.equal(byRef["ADR-0001"].missingDownstream, true);
    // And the untouched one is unchanged.
    assert.equal(byRef["REQ-002"].orphan, true);
  });

  test("the denormalised join is used — health sees links by the same route checkLink does", async () => {
    // state.links rows are link_type_id-keyed; artifactHealth must receive the joined
    // shape, not raw rows, or every indicator silently reads zero links.
    const { api } = makeHealthApi();
    await api.createLink({ typeName: "Addresses", sourceId: "d1", targetId: "a1" });
    const h = api.artifactHealth({ project_key: "BLZ" });
    assert.equal(h.artifacts.find((a) => a.ref === "REQ-001").inbound, 1);
  });

  test("changing an artifact makes its outbound links stale, and reviewLink clears them", async () => {
    const { api, state } = makeHealthApi();
    const link = await api.createLink({ typeName: "Addresses", sourceId: "d1", targetId: "a1" });
    assert.equal(link.ok, true, link.error);
    // d1 changes: transition writes a revision (§3.7), which is what staleness compares.
    // BLZ-335 (C10): the link is seeded reviewed at creation, so it is NOT stale yet. Roll
    // the review behind the change to exercise the indicator.
    assert.deepEqual(api.artifactHealth({ project_key: "BLZ" }).summary.stale, []);
    await api.reviewLink({ id: link.link.id, reviewedAt: "1999-01-01T00:00:00.000Z" });
    await api.transition({ id: "d1", to: "proposed" });

    let h = api.artifactHealth({ project_key: "BLZ" });
    assert.deepEqual(h.summary.stale, ["ADR-0001"], "the artifact that CHANGED is the stale one");

    const rev = await api.reviewLink({ id: link.link.id });
    assert.equal(rev.ok, true, rev.error);
    h = api.artifactHealth({ project_key: "BLZ" });
    assert.deepEqual(h.summary.stale, [], "a reviewed link stops being stale");
  });

  test("reviewLink refuses an unknown link, naming it", async () => {
    const { api } = makeHealthApi();
    const r = await api.reviewLink({ id: "nope" });
    assert.equal(r.ok, false);
    assert.match(r.error, /nope/);
  });

  test("health is a REPORT — it never refuses and never invents a link", () => {
    const { api, state } = makeHealthApi();
    const before = state.links.length;
    const h = api.artifactHealth({ project_key: "BLZ" });
    assert.equal(state.links.length, before, "reading health must not create links");
    assert.equal("ok" in h, false, "a report has no verdict");
  });

  test("another project's artifacts are not reported", () => {
    const { api, state } = makeHealthApi();
    state.artifacts.push({ id: "z1", ref: "REQ-900", kind: "requirement", project_key: "OTHER" });
    const h = api.artifactHealth({ project_key: "BLZ" });
    assert.equal(h.summary.counted, 3);
  });
});

// BLZ-334 — §5: "Filterable by custom field on BOTH axes."
describe("BLZ-334 (§5): the matrix filters each axis independently", () => {
  const R = (ref, o = {}) => ({ id: ref, ref, kind: "requirement", project_key: "BLZ", ...o });
  const D = (ref, o = {}) => ({ id: ref, ref, kind: "architecture", project_key: "BLZ", ...o });
  const DEFS = [
    { project_key: "BLZ", applies_to_kind: "requirement", key: "risk",
      data_type: "number", is_filterable: true },
    { project_key: "BLZ", applies_to_kind: "architecture", key: "layer",
      data_type: "text", is_filterable: false },
  ];
  const ROWS = [R("REQ-001", { cf_risk: 9 }), R("REQ-002", { cf_risk: 1 })];
  const COLS = [D("ADR-0001", { custom_fields: { layer: "data" } }),
                D("ADR-0002", { custom_fields: { layer: "ui" } })];

  function makeMatrixApi() {
    const { api, state } = makeApi({
      artifacts: [...ROWS, ...COLS],
      fieldDefinitions: DEFS,
    });
    return { api, state };
  }
  const linkAll = async (api) => {
    for (const d of COLS) for (const r of ROWS) {
      await api.createLink({ typeName: "Addresses", sourceId: d.id, targetId: r.id });
    }
  };

  test("no filters behaves exactly as before — both axes complete", async () => {
    const { api } = makeMatrixApi();
    await linkAll(api);
    const m = api.matrix({ rows: ROWS, cols: COLS });
    assert.deepEqual(m.rows.map((r) => r.ref), ["REQ-001", "REQ-002"]);
    assert.deepEqual(m.cols.map((c) => c.ref), ["ADR-0001", "ADR-0002"]);
  });

  test("a ROW filter leaves the COLUMN axis complete", async () => {
    const { api } = makeMatrixApi();
    await linkAll(api);
    const m = api.matrix({ rows: ROWS, cols: COLS, rowFilter: { key: "risk", equals: 9 } });
    assert.deepEqual(m.rows.map((r) => r.ref), ["REQ-001"]);
    assert.deepEqual(m.cols.map((c) => c.ref), ["ADR-0001", "ADR-0002"],
      "filtering rows must not touch the column axis");
  });

  test("a COLUMN filter leaves the ROW axis complete — the other half nobody implements", async () => {
    const { api } = makeMatrixApi();
    await linkAll(api);
    const m = api.matrix({ rows: ROWS, cols: COLS, colFilter: { key: "layer", equals: "ui" } });
    assert.deepEqual(m.cols.map((c) => c.ref), ["ADR-0002"]);
    assert.deepEqual(m.rows.map((r) => r.ref), ["REQ-001", "REQ-002"]);
  });

  test("both axes filter at once, independently", async () => {
    const { api } = makeMatrixApi();
    await linkAll(api);
    const m = api.matrix({ rows: ROWS, cols: COLS,
      rowFilter: { key: "risk", equals: 9 }, colFilter: { key: "layer", equals: "ui" } });
    assert.deepEqual(m.rows.map((r) => r.ref), ["REQ-001"]);
    assert.deepEqual(m.cols.map((c) => c.ref), ["ADR-0002"]);
  });

  test("no cell survives for a filtered-out COLUMN", async () => {
    const { api } = makeMatrixApi();
    await linkAll(api);
    const m = api.matrix({ rows: ROWS, cols: COLS, colFilter: { key: "layer", equals: "ui" } });
    for (const cells of Object.values(m.cells)) {
      assert.deepEqual(Object.keys(cells), ["ADR-0002"],
        "a cell keyed to a filtered-out column is a link to something not on the axis");
    }
  });

  test("`untraced` describes the FILTERED rows, not the unfiltered ones", async () => {
    // Otherwise the count describes a matrix nobody is looking at: filter to one covered
    // requirement and still be told two are untraced.
    const { api } = makeMatrixApi();
    // Only REQ-002 gets a link, so unfiltered `untraced` is [REQ-001].
    await api.createLink({ typeName: "Addresses", sourceId: "ADR-0001", targetId: "REQ-002" });
    assert.deepEqual(api.matrix({ rows: ROWS, cols: COLS }).untraced, ["REQ-001"]);
    // Filter to REQ-002 alone: it IS traced, so nothing is untraced.
    const m = api.matrix({ rows: ROWS, cols: COLS, rowFilter: { key: "risk", equals: 1 } });
    assert.deepEqual(m.untraced, []);
  });

  test("an unknown ROW field key is refused, naming the axis and the key", () => {
    const { api } = makeMatrixApi();
    const m = api.matrix({ rows: ROWS, cols: COLS, rowFilter: { key: "nope", equals: 1 } });
    assert.equal(m.ok, false);
    assert.match(m.error, /row filter/);
    assert.match(m.error, /nope/);
  });

  test("an unknown COLUMN field key is refused too, and says which axis", () => {
    const { api } = makeMatrixApi();
    const m = api.matrix({ rows: ROWS, cols: COLS, colFilter: { key: "nope", equals: 1 } });
    assert.equal(m.ok, false);
    assert.match(m.error, /column filter/);
  });

  test("a field defined for the ROW kind is unknown to a COLUMN filter", () => {
    // `risk` exists, but only for requirements. Accepting it on the architecture axis
    // would match nothing and report an empty column set as a real result.
    const { api } = makeMatrixApi();
    const m = api.matrix({ rows: ROWS, cols: COLS, colFilter: { key: "risk", equals: 9 } });
    assert.equal(m.ok, false);
    assert.match(m.error, /column filter/);
  });
});

// BLZ-333 — §4.3: "Reported, NEVER BLOCKING." The tier split is load-bearing: blurring
// §4.1 and §4.3 is how a governance tool becomes something teams route around.
describe("BLZ-333 (§4.3): advisory findings are surfaced by the API and never block", () => {
  test("an artifact failing every advisory check STILL CREATES", async () => {
    const { api, state } = makeApi({ artifacts: [] });
    const r = await api.createArtifact({
      kind: "requirement", title: "R", project_key: "BLZ",
      statement: "The system is a web app.", verification_method: "vibes" });
    assert.equal(r.ok, true, r.error);
    assert.equal(state.artifacts.length, 1, "an advisory must never prevent the write");
    assert.ok(r.advisories.length >= 2, "and the findings must come back on the response");
  });

  test("every advisory finding names the check that produced it", async () => {
    const { api } = makeApi({ artifacts: [] });
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
      statement: "The system is a web app.", verification_method: "vibes" });
    for (const f of r.advisories) assert.ok(f.check, `${JSON.stringify(f)} has no check name`);
  });

  test("a clean statement returns an empty advisory list, not a missing key", async () => {
    const { api } = makeApi({ artifacts: [] });
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
      statement: "The system shall lock the account after 5 failed attempts.",
      verification_method: "test" });
    assert.deepEqual(r.advisories, []);
  });

  test("advisory and the §4.1 BLOCK are different tiers, and both are reachable", async () => {
    // The load-bearing distinction. A wording-lint block refuses; an advisory does not.
    const { api } = makeApi({ artifacts: [] });
    const blocked = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
      statement: "The system shall be user-friendly." });
    assert.equal(blocked.ok, false, "§4.1 blocks");

    const advised = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
      statement: "The system is a web app." });
    assert.equal(advised.ok, true, "§4.3 does not");
    assert.ok(advised.advisories.length > 0);
  });

  test("the project advisory reports architecture coverage with its numerator and denominator", async () => {
    const { api } = makeApi({
      artifacts: [
        { id: "r1", ref: "REQ-001", kind: "requirement", project_key: "BLZ", statement: "The system shall x." },
        { id: "r2", ref: "REQ-002", kind: "requirement", project_key: "BLZ", statement: "The system shall y." },
        { id: "d1", ref: "ADR-0001", kind: "architecture", project_key: "BLZ" },
      ],
    });
    await api.createLink({ typeName: "Addresses", sourceId: "d1", targetId: "r1" });
    const a = api.advisory({ project_key: "BLZ" });
    assert.equal(a.architectureCoverage.covered, 1);
    assert.equal(a.architectureCoverage.total, 2);
    assert.equal(a.architectureCoverage.percent, 50);
    assert.deepEqual(a.architectureCoverage.uncovered, ["REQ-002"],
      "and names which requirements are uncovered, not just how many");
  });

  test("a project with no requirements reports percent null, never 0% and never NaN", () => {
    const { api } = makeApi({ artifacts: [] });
    assert.equal(api.advisory({ project_key: "BLZ" }).architectureCoverage.percent, null);
  });

  test("the project advisory lists only statements that have findings", () => {
    const { api } = makeApi({
      artifacts: [
        { id: "r1", ref: "REQ-001", kind: "requirement", project_key: "BLZ",
          statement: "The system shall lock the account.", verification_method: "test" },
        { id: "r2", ref: "REQ-002", kind: "requirement", project_key: "BLZ",
          statement: "The system is nice.", verification_method: "test" },
      ],
    });
    const a = api.advisory({ project_key: "BLZ" });
    assert.deepEqual(a.statements.map((s) => s.ref), ["REQ-002"]);
  });
});
