// tests/model/deferred-defects.test.mjs — BLZ-338..343.
//
// Six defects reproduced during the v4 pre-merge review and deliberately deferred out of the
// merge round, because bundling unrelated fixes into a merge is how a merge stops being
// reviewable. Each test here was confirmed to FAIL against the merged code before its fix.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { artifactApi } from "../../scripts/model/artifact-api.mjs";
import { artifactStore } from "../../scripts/model/artifact-store.mjs";
import { checkLink } from "../../scripts/model/link-rules.mjs";
import { promotionPlan } from "../../scripts/model/field-promotion.mjs";
import { statusesFor, isTerminal, canTransition } from "../../scripts/model/workflows.mjs";
import { artifactDdl, revisionDdl } from "../../scripts/model/artifact-schema.mjs";
import { linkDdl } from "../../scripts/model/link-schema.mjs";
import { documentDdl } from "../../scripts/model/document-schema.mjs";
import { baselineDdl } from "../../scripts/model/baseline-schema.mjs";
import { fieldDdl } from "../../scripts/model/field-schema.mjs";
import { coverageDdl } from "../../scripts/model/coverage.mjs";
import { refClaimDdl } from "../../scripts/model/ref-claim-schema.mjs";

const LT = { id: "lt1", name: "Addresses", inverse_name: "Addressed by",
             source_kinds: "architecture", target_kinds: "requirement", min_card: 0, max_card: null };

function openSqlite() {
  const db = new DatabaseSync(":memory:");
  for (const d of [artifactDdl, revisionDdl, linkDdl, documentDdl, baselineDdl, fieldDdl,
                   coverageDdl, refClaimDdl]) db.exec(d("sqlite"));
  db.prepare(`INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds, min_card, max_card)
              VALUES ('lt1','BLZ','Addresses','Addressed by','architecture','requirement',0,NULL)`).run();
  return db;
}
const sqliteExec = (db) => ({
  run(sql, p = []) { return p.length ? db.prepare(sql).run(...p) : db.exec(sql); },
  all(sql, p = []) { return db.prepare(sql).all(...p); },
});
const freshState = () => ({ artifacts: [], tickets: [], links: [], linkTypes: [{ ...LT }] });

describe("BLZ-340: an unknown kind is REFUSED by name, never thrown", () => {
  test("createArtifact refuses a kind the artifact table's CHECK would reject", async () => {
    const api = artifactApi(freshState());
    const r = await api.createArtifact({ kind: "feature", title: "X", project_key: "BLZ" });
    assert.equal(r.ok, false, "must refuse, not throw 'no ref scheme for kind'");
    assert.match(r.error, /feature/);
    assert.match(r.error, /requirement/, "and must name what IS legal");
  });

  test("a missing kind is refused too, rather than reaching the ref allocator", async () => {
    const r = await artifactApi(freshState()).createArtifact({ title: "X", project_key: "BLZ" });
    assert.equal(r.ok, false);
  });

  test("both legal kinds still work", async () => {
    for (const kind of ["requirement", "architecture"]) {
      const r = await artifactApi(freshState()).createArtifact({ kind, title: "X", project_key: "BLZ" });
      assert.equal(r.ok, true, r.error);
    }
  });
});

describe("BLZ-342: ref allocation and monotonicity are PROJECT-scoped", () => {
  test("project B's first requirement is REQ-001, not numbered off project A", async () => {
    // artifact is UNIQUE (project_key, ref) and claimRef is scoped to (project_key, kind),
    // so an unscoped monotonicity check disagreed with both halves of its own schema.
    const state = freshState();
    const api = artifactApi(state);
    for (let i = 0; i < 5; i++) {
      await api.createArtifact({ kind: "requirement", title: `A${i}`, project_key: "AAA" });
    }
    const b = await api.createArtifact({ kind: "requirement", title: "B", project_key: "BBB" });
    assert.equal(b.ok, true, b.error);
    assert.equal(b.artifact.ref, "REQ-001");
  });

  test("an explicit REQ-001 in a fresh project is ACCEPTED, not refused as non-advancing", async () => {
    const api = artifactApi(freshState());
    for (let i = 0; i < 5; i++) {
      await api.createArtifact({ kind: "requirement", title: `A${i}`, project_key: "AAA" });
    }
    const b = await api.createArtifact({ kind: "requirement", title: "B",
                                         project_key: "BBB", ref: "REQ-001" });
    assert.equal(b.ok, true, b.error);
  });

  test("but monotonicity still bites WITHIN a project", async () => {
    const api = artifactApi(freshState());
    await api.createArtifact({ kind: "requirement", title: "A", project_key: "AAA", ref: "REQ-005" });
    const dup = await api.createArtifact({ kind: "requirement", title: "B",
                                           project_key: "AAA", ref: "REQ-003" });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /monotonic|advance/i);
  });

  test("and the two kinds keep separate sequences within a project", async () => {
    const api = artifactApi(freshState());
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "AAA" });
    const a = await api.createArtifact({ kind: "architecture", title: "A", project_key: "AAA" });
    assert.equal(r.artifact.ref, "REQ-001");
    assert.equal(a.artifact.ref, "ADR-0001");
  });
});

describe("BLZ-343: min_card is enforced, and the PG ceiling counts real columns", () => {
  test("a link type with min_card 1 is not silently unenforced", () => {
    // Declared, defaulted and CHECKed in the DDL, and read by nothing: checkLink enforced
    // only max_card. A cardinality floor nobody enforces is a claim on the schema diagram.
    const lt = { ...LT, min_card: 1, max_card: 3 };
    const under = checkLink({ linkType: lt, sourceKind: "architecture",
                              targetKind: "requirement", existingCount: 0, finalCount: 0 });
    assert.equal(under.ok, false, "removing the last link below min_card must be refused");
    assert.match(under.error, /min|at least/i);
  });

  test("min_card 0 (the default) constrains nothing", () => {
    const v = checkLink({ linkType: { ...LT, min_card: 0 }, sourceKind: "architecture",
                          targetKind: "requirement", existingCount: 0, finalCount: 0 });
    assert.equal(v.ok, true, v.error);
  });

  test("creating a link that SATISFIES min_card is allowed", () => {
    const v = checkLink({ linkType: { ...LT, min_card: 1 }, sourceKind: "architecture",
                          targetKind: "requirement", existingCount: 0, finalCount: 1 });
    assert.equal(v.ok, true, v.error);
  });

  test("the Postgres column ceiling counts EVERY column, not just the cf_ subset", () => {
    // It tested `existingColumns.length >= 1590` while the caller passed only cf_ columns,
    // bounded by FILTERABLE_CAP at 200 — so the branch could never fire, and its message
    // described a count that excluded every base column.
    const plan = promotionPlan({
      field: { key: "x", data_type: "number", is_filterable: true, applies_to_kind: "requirement" },
      existingColumns: ["cf_a"], filterableCount: 1, engine: "postgres", tableColumnCount: 1599 });
    assert.equal(plan.ok, false, "1599 real columns must refuse before Postgres does at 1600");
    assert.match(plan.error, /1600|1599/);
  });

  test("a normal table is unaffected by the ceiling", () => {
    const plan = promotionPlan({
      field: { key: "x", data_type: "number", is_filterable: true, applies_to_kind: "requirement" },
      existingColumns: [], filterableCount: 0, engine: "postgres", tableColumnCount: 12 });
    assert.equal(plan.ok, true, plan.error);
  });
});

describe("BLZ-339: transition refuses a status the workflow does not declare", () => {
  test("`verified` IS a declared requirement status — the gate exists, so the status must", () => {
    // Spec §4.2, the standards doc RQ-6 and ADR-0017 all name `requirement -> verified` as a
    // gate, and the operator settled "ship both" on 2026-08-22. The workflow was what
    // disagreed: gates.mjs enumerated a transition to a status DEFAULT_WORKFLOWS did not have.
    assert.ok(statusesFor("requirement").includes("verified"));
    assert.equal(isTerminal("requirement", "verified"), true);
    assert.ok(canTransition("requirement", "proposed", "verified"));
    assert.ok(canTransition("requirement", "implemented", "verified"));
  });

  test("`implemented` stays terminal — this fix must not reclassify existing data", () => {
    // Making implemented non-terminal would flip every existing implemented requirement and
    // start refusing goal:achieved gates that pass today. Additive only.
    assert.equal(isTerminal("requirement", "implemented"), true);
  });

  test("an undeclared status is refused AS UNDECLARED, not as an illegal transition", async () => {
    // Asserting only ok===false and /banana/ proved nothing: with the declared-status branch
    // removed, "banana" falls through to canTransition, which also refuses and whose message
    // also contains "banana". The two are different problems — "that status does not exist"
    // versus "you cannot get there from here" — and only the message separates them.
    const state = freshState();
    const api = artifactApi(state);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const bad = await api.transition({ id: r.artifact.id, to: "banana" });
    assert.equal(bad.ok, false, "an undeclared status must not be written");
    assert.match(bad.error, /is not a declared requirement status/);
    assert.match(bad.error, /proposed, implemented, verified/, "and must list what IS declared");
    assert.equal(state.artifacts[0].status, "proposed", "and the record must be untouched");
  });

  test("an illegal TRANSITION between two declared statuses is refused", async () => {
    const state = freshState();
    const api = artifactApi(state);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    state.artifacts[0].status = "obsolete";
    const bad = await api.transition({ id: r.artifact.id, to: "implemented" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /cannot go from obsolete to implemented/,
      "a declared status reached illegally gets the OTHER message");
    assert.doesNotMatch(bad.error, /is not a declared/);
    assert.equal(state.artifacts[0].status, "obsolete");
  });

  test("a legal transition still works, and still passes through its gate", async () => {
    const state = freshState();
    const api = artifactApi(state);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const ok = await api.transition({ id: r.artifact.id, to: "implemented" });
    assert.equal(ok.ok, true, ok.error);

    // ...and the RQ-6 gate is still the thing that blocks `verified` without a Verifies link.
    const gated = await api.transition({ id: r.artifact.id, to: "verified" });
    assert.equal(gated.ok, false);
    assert.match(gated.error, /Verifies/);
  });
});

describe("BLZ-338: baselineDocument persists the document's status", () => {
  test("the document table records `baselined`, not just the in-memory record", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = freshState();
    const api = artifactApi(state, store);

    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    db.prepare(`INSERT INTO document (id, project_key, title, kind, status, created_at, updated_at)
                VALUES ('d1','BLZ','Spec','requirements','draft','t','t')`).run();
    state.documents = [{ id: "d1", project_key: "BLZ", title: "Spec", kind: "requirements", status: "draft" }];
    state.artifactUsages = [{ document_id: "d1", artifact_id: req.artifact.id, ord: 1, depth: 0 }];
    state.coverageRules = [];

    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, true, r.error);
    assert.equal(db.prepare("SELECT status FROM document WHERE id='d1'").get().status, "baselined",
      "a baseline over a document that has no record of being baselined is not a baseline");
  });
});

describe("BLZ-341: a failed store write leaves memory and database in step", () => {
  test("a duplicate link is not left in state.links after the INSERT is rejected", async () => {
    // link is UNIQUE (link_type_id, source_id, target_id). The record was pushed to state
    // BEFORE the await, so a constraint violation left a phantom link inflating the
    // existingCount that max_card is checked against.
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = freshState();
    const api = artifactApi(state, store);
    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });

    const first = await api.createLink({ typeName: "Addresses",
                                         sourceId: arch.artifact.id, targetId: req.artifact.id });
    assert.equal(first.ok, true, first.error);

    const dup = await api.createLink({ typeName: "Addresses",
                                       sourceId: arch.artifact.id, targetId: req.artifact.id });
    assert.equal(dup.ok, false, "the duplicate must be refused, not thrown");
    assert.equal(state.links.length, 1, "and must leave no phantom behind in memory");
    assert.equal(db.prepare("SELECT count(*) n FROM link").get().n, 1);
  });

  test("a rejected artifact INSERT leaves no phantom artifact or revision in memory", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = freshState();
    const api = artifactApi(state, store);
    await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ", ref: "REQ-007" });
    // Force a UNIQUE (project_key, ref) collision by inserting the same ref behind the API.
    db.prepare(`INSERT INTO artifact (id, project_key, kind, ref, title, status, created_at, updated_at)
                VALUES ('x','BLZ','requirement','REQ-009','T','proposed','t','t')`).run();
    const clash = await api.createArtifact({ kind: "requirement", title: "R2",
                                             project_key: "BLZ", ref: "REQ-009" });
    assert.equal(clash.ok, false, "the collision must surface as a refusal");
    assert.equal(state.artifacts.length, 1, "no phantom artifact in memory");
    assert.equal((state.artifactRevisions ?? []).length, 1, "and no phantom revision");
  });
});

describe("BLZ-343: removeLink is the caller min_card was missing", () => {
  function wire(min_card) {
    const db = openSqlite();
    if (min_card) db.prepare("UPDATE link_type SET min_card = ? WHERE id = 'lt1'").run(min_card);
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = freshState();
    state.linkTypes[0].min_card = min_card;
    return { db, api: artifactApi(state, store), state };
  }

  test("removing the last link under min_card 1 is REFUSED, in the database too", async () => {
    const { db, api } = wire(1);
    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
    const l = await api.createLink({ typeName: "Addresses",
                                     sourceId: arch.artifact.id, targetId: req.artifact.id });
    assert.equal(l.ok, true, l.error);

    const r = await api.removeLink({ id: l.link.id });
    assert.equal(r.ok, false);
    assert.match(r.error, /at least 1/);
    assert.equal(db.prepare("SELECT count(*) n FROM link").get().n, 1,
      "a refused removal must not delete the row");
  });

  test("with min_card 0 the same removal succeeds, and the row really goes", async () => {
    const { db, api } = wire(0);
    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
    const l = await api.createLink({ typeName: "Addresses",
                                     sourceId: arch.artifact.id, targetId: req.artifact.id });
    const r = await api.removeLink({ id: l.link.id });
    assert.equal(r.ok, true, r.error);
    assert.equal(db.prepare("SELECT count(*) n FROM link").get().n, 0);
  });

  test("under min_card 1, removing one of TWO is allowed — the floor is a floor, not a freeze", async () => {
    const { db, api, state } = wire(1);
    const r1 = await api.createArtifact({ kind: "requirement", title: "R1", project_key: "BLZ" });
    const r2 = await api.createArtifact({ kind: "requirement", title: "R2", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
    const a = await api.createLink({ typeName: "Addresses", sourceId: arch.artifact.id, targetId: r1.artifact.id });
    const b = await api.createLink({ typeName: "Addresses", sourceId: arch.artifact.id, targetId: r2.artifact.id });
    assert.equal(b.ok, true, b.error);

    const rm = await api.removeLink({ id: a.link.id });
    assert.equal(rm.ok, true, rm.error);
    assert.equal(state.links.length, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM link").get().n, 1);
  });

  test("removing an unknown link is refused by name", async () => {
    const { api } = wire(0);
    const r = await api.removeLink({ id: "nope" });
    assert.equal(r.ok, false);
    assert.match(r.error, /nope/);
  });

  test("countColumns reports the artifact table's REAL width, not the cf_ subset", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const n = await store.countColumns("artifact");
    assert.ok(n >= 11, `artifact has ${n} columns — the base columns must be counted`);
  });

  test("countColumns refuses an unsafe table name rather than interpolating it", async () => {
    const store = artifactStore(sqliteExec(openSqlite()), { dialect: "sqlite" });
    await assert.rejects(() => store.countColumns("artifact; DROP TABLE artifact; --"),
      /unsafe table name/);
  });
});
