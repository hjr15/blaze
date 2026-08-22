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
