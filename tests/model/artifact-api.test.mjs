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
    const { api } = makeApi();
    const r = await api.defineField({ key: "x", data_type: "number", is_filterable: true,
                                      applies_to_kind: "requirement", filterableCount: 200 });
    assert.equal(r.ok, false);
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

describe("ref format and monotonicity are enforced at the API, not the database", () => {
  // Ref UNIQUENESS is a database constraint (must hold under concurrency). Ref FORMAT
  // and MONOTONICITY are enforced here, where the refusal can name the expected shape.
  test("a malformed ref is refused, naming the expected shape", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", ref: "NOTAREF" });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-nnn/);
  });

  test("a ref of the wrong kind is refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", ref: "ADR-0001" });
    assert.equal(r.ok, false);
    assert.match(r.error, /architecture ref/);
  });

  test("a ref that does not advance past the highest allocated one is refused", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", ref: "REQ-001" });
    assert.equal(r.ok, false);
    assert.match(r.error, /monotonically/);
  });

  test("a well-formed, advancing ref is accepted", async () => {
    const { api, state } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x", ref: "REQ-002" });
    assert.equal(r.ok, true);
    assert.equal(state.artifacts.length, 2);
  });

  test("omitting the ref allocates the next one", async () => {
    const { api } = makeApi();
    const r = await api.createArtifact({ kind: "requirement", title: "x" });
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
      documents: [{ id: "d1", title: "Spec", kind: "requirements", status: "draft" }],
      artifactUsages: [{ document_id: "d1", artifact_id: "a1", ord: 1, depth: 0 }],
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

  test("baselining succeeds once coverage is clean, and records the baseline", async () => {
    const { api, state } = makeDocApi();
    await api.createLink({ typeName: "Addresses", sourceId: "arch1", targetId: "a1" });
    // every-requirement-verified also applies to REQ-001 in DEFAULT_COVERAGE_RULES;
    // supply a Verifies-typed link type so both coverage rules the document is subject
    // to are satisfied.
    state.linkTypes.push({ id: "lt3", name: "Verifies", inverse_name: "Verified by",
      source_kinds: "architecture", target_kinds: "requirement", min_card: 0, max_card: null });
    await api.createLink({ typeName: "Verifies", sourceId: "arch1", targetId: "a1" });

    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, true);
    assert.equal(state.documents[0].status, "baselined");
    assert.equal(state.baselines.length, 1);
    assert.deepEqual(state.baselines[0].member_ids, ["a1"]);
  });
});
