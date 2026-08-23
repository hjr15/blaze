// tests/model/boundary-regressions.test.mjs — BLZ-335.
//
// Six defects found by a pre-merge review, ALL the same shape: the in-memory `state` and the
// real database disagree, or a value one engine writes is read back in a form the reader does
// not expect. This is the exact category the branch's post-mortem named — fourteen clean
// per-task reviews let five Criticals through because no test crossed the API/DDL boundary.
//
// Every test here was written to FAIL against the code as it stood, and each names the defect
// it pins so a future reader knows what it is protecting.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { artifactApi } from "../../scripts/model/artifact-api.mjs";
import { artifactStore } from "../../scripts/model/artifact-store.mjs";
import { staleLinks } from "../../scripts/model/staleness.mjs";
import { artifactDdl, revisionDdl } from "../../scripts/model/artifact-schema.mjs";
import { linkDdl } from "../../scripts/model/link-schema.mjs";
import { fieldDdl } from "../../scripts/model/field-schema.mjs";
import { coverageDdl } from "../../scripts/model/coverage.mjs";
import { refClaimDdl } from "../../scripts/model/ref-claim-schema.mjs";

const LT = { id: "lt1", name: "Addresses", inverse_name: "Addressed by",
             source_kinds: "architecture", target_kinds: "requirement", min_card: 0, max_card: null };

function openSqlite() {
  const db = new DatabaseSync(":memory:");
  for (const d of [artifactDdl, revisionDdl, linkDdl, fieldDdl, coverageDdl, refClaimDdl]) db.exec(d("sqlite"));
  db.prepare(`INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds, min_card, max_card)
              VALUES ('lt1','BLZ','Addresses','Addressed by','architecture','requirement',0,NULL)`).run();
  return db;
}
const sqliteExec = (db) => ({
  run(sql, p = []) { return p.length ? db.prepare(sql).run(...p) : db.exec(sql); },
  all(sql, p = []) { return db.prepare(sql).all(...p); },
});
const freshState = () => ({ artifacts: [], tickets: [], links: [], linkTypes: [{ ...LT }] });

describe("C1: the field budget and the duplicate-column guard read PERSISTED rows", () => {
  test("two API instances over ONE store agree with the field_definition table", async () => {
    // The cross-process case, which is every case in production: a second process has an
    // empty `state`. BLZ-329's claim was "counts PERSISTED definitions"; it counted memory.
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });

    const first = await artifactApi(freshState(), store).defineField({
      project_key: "AAA", key: "risk", data_type: "text",
      applies_to_kind: "requirement", is_filterable: true });
    assert.equal(first.ok, true, first.error);

    const rows = db.prepare("SELECT count(*) n FROM field_definition").get().n;
    const budget = await artifactApi(freshState(), store).fieldBudget();
    assert.equal(budget.artifact.used, rows,
      "the budget must agree with the table, not with whatever this process happens to remember");
  });

  test("a second project promoting an already-promoted key is REFUSED by name", async () => {
    // field_definition's UNIQUE (project_key, key, applies_to_kind) PERMITS two projects to
    // define `risk`; promotion maps both to one shared artifact.cf_risk. The DDL and the
    // promotion rule disagree, and the disagreement surfaced as a raw driver error.
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const f = (project_key) => ({ project_key, key: "risk", data_type: "text",
                                  applies_to_kind: "requirement", is_filterable: true });

    assert.equal((await artifactApi(freshState(), store).defineField(f("AAA"))).ok, true);
    const second = await artifactApi(freshState(), store).defineField(f("BBB"));
    assert.equal(second.ok, false, "must refuse, not throw a raw duplicate-column error");
    assert.match(second.error, /cf_risk|already/i);
    assert.match(second.error, /AAA|another project|shared/i,
      "and must explain that the column budget is shared across projects");
  });
});

describe("C2: a promoted value is readable where every reader looks for it", () => {
  test("create through the API, then FILTER through the API — no hand-built fixture between", async () => {
    // matrix-filter.test.mjs passed only because its fixtures hand-built { cf_risk: 7 }, a
    // shape createArtifact never produced. The value sat at artifact.promoted.cf_risk and
    // the filter returned zero rows for the one artifact that matched.
    const state = freshState();
    state.fieldDefinitions = [];
    const api = artifactApi(state);
    await api.defineField({ project_key: "BLZ", key: "risk", data_type: "text",
                            applies_to_kind: "requirement", is_filterable: true });
    const r = await api.createArtifact({ kind: "requirement", title: "R",
                                         project_key: "BLZ", fields: { risk: "high" } });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.artifact.cf_risk, "high",
      "the promoted value must live where the table holds it and every reader looks");

    const m = api.matrix({ rows: state.artifacts, cols: [],
                           rowFilter: { key: "risk", equals: "high" }, project_key: "BLZ" });
    assert.equal(m.rows.length, 1, "the one matching artifact must survive its own filter");
  });
});

describe("C3: the shipped default coverage rules are durable", () => {
  test("disabling a DEFAULT rule survives a restart", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const api = artifactApi(freshState(), store);

    const r = await api.setCoverageRuleEnabled({
      project_key: "BLZ", name: "every-requirement-addressed", enabled: false });
    assert.equal(r.ok, true, r.error);

    const row = db.prepare("SELECT enabled FROM coverage_rule WHERE name = ?")
      .get("every-requirement-addressed");
    assert.ok(row, "the default rule must exist as a row before it can be disabled");
    assert.equal(row.enabled, 0, "and the disable must be recorded, not silently update 0 rows");

    // A fresh process reads it back off: the whole point.
    const after = artifactApi(freshState(), store);
    assert.equal((await after.loadCoverageRules()).some(
      (c) => c.name === "every-requirement-addressed" && c.enabled === false), true);
  });
});

describe("C5: a promoted value round-trips create -> read -> filter (SQLite)", () => {
  for (const [data_type, value] of [["boolean", true], ["number", 7], ["date", "2026-01-01"]]) {
    test(`a promoted ${data_type} filters correctly after a real round trip`, async () => {
      const db = openSqlite();
      const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
      const state = freshState();
      state.fieldDefinitions = [];
      const api = artifactApi(state, store);
      await api.defineField({ project_key: "BLZ", key: "flag", data_type,
                              applies_to_kind: "requirement", is_filterable: true });
      const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                           fields: { flag: value } });
      assert.equal(r.ok, true, r.error);

      // Read back through the DATABASE, which is what a real reader does.
      const rows = db.prepare("SELECT * FROM artifact").all();
      const m = api.matrix({ rows, cols: [], rowFilter: { key: "flag", equals: value },
                             project_key: "BLZ" });
      assert.equal(m.rows.length, 1,
        `a ${data_type} written as ${JSON.stringify(value)} must still match itself after a round trip`);
    });
  }
});

describe("C6: staleness compares instants, not strings", () => {
  test("a Date reviewed AFTER the change is not stale — weekday order reverses the real order", () => {
    // Postgres timestamptz comes back from node-pg as a Date. String(date) is weekday-first,
    // and "Thu Jan 08" < "Wed Jan 07" alphabetically, so a link reviewed a day LATER than the
    // change was reported stale. Postgres-only, and invisible to every ISO-string test.
    const wed = new Date("2026-01-07T00:00:00Z");
    const thu = new Date("2026-01-08T00:00:00Z");
    assert.ok(String(thu) < String(wed), "sanity: the weekday strings really do sort backwards");
    assert.deepEqual(
      staleLinks({ links: [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: thu }],
                   revisions: [{ artifact_id: "a1", at: wed }] }), []);
  });

  test("the mirror case: a genuinely stale Date link IS reported", () => {
    const wed = new Date("2026-01-07T00:00:00Z");
    const thu = new Date("2026-01-08T00:00:00Z");
    assert.equal(
      staleLinks({ links: [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: wed }],
                   revisions: [{ artifact_id: "a1", at: thu }] }).length, 1);
  });

  test("the LATEST revision still wins when the weekday order disagrees", () => {
    const wed = new Date("2026-01-07T00:00:00Z");
    const thu = new Date("2026-01-08T00:00:00Z");
    assert.equal(
      staleLinks({ links: [{ id: "l1", source_id: "a1", target_id: "a2",
                             reviewed_at: new Date("2026-01-07T12:00:00Z") }],
                   revisions: [{ artifact_id: "a1", at: wed }, { artifact_id: "a1", at: thu }] }).length,
      1, "the Thu revision must not lose max() to the Wed one");
  });

  test("ISO strings keep working — the fix must not break the SQLite shape", () => {
    assert.deepEqual(
      staleLinks({ links: [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-03-01" }],
                   revisions: [{ artifact_id: "a1", at: "2026-02-01" }] }), []);
  });
});

describe("C10: a newly created link is not stale", () => {
  test("creating a link does not immediately mark its source suspect", async () => {
    // link-schema.mjs says the defect being fixed was "EVERY link whose source had any
    // revision reported stale ... an indicator that is on for everything is off". Adding the
    // column did not fix it: createArtifact always writes a revision and createLink never set
    // reviewed_at, so the indicator was still on for everything.
    const state = freshState();
    const api = artifactApi(state);
    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
    const l = await api.createLink({ typeName: "Addresses",
                                     sourceId: arch.artifact.id, targetId: req.artifact.id });
    assert.equal(l.ok, true, l.error);
    assert.deepEqual(api.artifactHealth({ project_key: "BLZ" }).summary.stale, []);
  });

  test("but a change AFTER the link is created DOES make it stale", async () => {
    // The discriminating half: seeding reviewed_at must not disable the indicator entirely.
    const state = freshState();
    const api = artifactApi(state);
    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
    await api.createLink({ typeName: "Addresses", sourceId: arch.artifact.id, targetId: req.artifact.id });
    await new Promise((r) => setTimeout(r, 2));
    // NOT `accepted`: architecture:accepted is a GATE requiring Context/Decision/Consequences,
    // so it would refuse, write no revision, and this test would pass for the wrong reason.
    const t = await api.transition({ id: arch.artifact.id, to: "proposed" });
    assert.equal(t.ok, true, t.error);
    assert.deepEqual(api.artifactHealth({ project_key: "BLZ" }).summary.stale, ["ADR-0001"]);
  });

  test("the seeded reviewed_at lands in the REAL column, not just memory", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = freshState();
    const api = artifactApi(state, store);
    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
    const l = await api.createLink({ typeName: "Addresses",
                                     sourceId: arch.artifact.id, targetId: req.artifact.id });
    assert.notEqual(db.prepare("SELECT reviewed_at FROM link WHERE id = ?").get(l.link.id).reviewed_at,
      null, "a link created now has been 'reviewed' as of now — never-reviewed means something else");
  });
});

describe("BLZ-336: goal:achieved resolves the hierarchy of its OWN project", () => {
  // The child must be a REQUIREMENT: per RQ-7 the goal:achieved gate blocks on non-terminal
  // requirement children specifically, not on any child. A story child would make this test
  // pass for the wrong reason — the gate would ignore it even with the hierarchy resolved
  // correctly, and the test would prove nothing about the defect.
  const twoProjects = () => ({
    artifacts: [{ id: "rB", ref: "REQ-001", kind: "requirement", status: "proposed", project_key: "B" }],
    links: [], linkTypes: [{ ...LT }],
    tickets: [
      // in-progress, not defined: the goal workflow is defined -> in-progress -> achieved,
      // and BLZ-339 now enforces transitions. A goal being closed is in-progress by then.
      { id: "gB", type: "goal", status: "in-progress", project_key: "B" },
      { id: "gA", type: "goal", status: "in-progress", project_key: "A" },
    ],
    // Project A's default hierarchy comes FIRST, which is what made the unscoped
    // `.find(h => h.is_default)` pick the wrong one.
    hierarchies: [{ id: "hA", project_key: "A", is_default: true },
                  { id: "hB", project_key: "B", is_default: true }],
    hierarchyMemberships: [{ hierarchy_id: "hB", parent_id: "gB", item_id: "rB" }],
  });

  test("a goal with a NON-TERMINAL child in its own project is REFUSED", async () => {
    const api = artifactApi(twoProjects());
    const r = await api.transition({ id: "gB", to: "achieved" });
    assert.equal(r.ok, false, "the gate must not approve past another project's empty hierarchy");
    assert.match(r.error, /REQ-001/, "and must name the child that blocked it");
  });

  test("the same goal passes once its child IS terminal — the gate still works", async () => {
    const state = twoProjects();
    // BLZ-353/R48: was "implemented". That is still terminal for the requirement's own
    // lifecycle, but no longer SATISFIES a goal, so it would now fail here for a reason
    // that has nothing to do with what this test is about (hierarchy scoping). "verified"
    // is the satisfying status and keeps the test measuring the thing it was written for.
    state.artifacts.find((a) => a.id === "rB").status = "verified";
    const r = await artifactApi(state).transition({ id: "gB", to: "achieved" });
    assert.equal(r.ok, true, r.error);
  });

  test("a project with NO default hierarchy still passes vacuously, per the recorded residual", async () => {
    // The accepted residual is that a goal with no hierarchy members vacuously passes. That
    // stays true — the fix is about finding the RIGHT hierarchy, not about inventing children.
    const state = twoProjects();
    state.hierarchies = [{ id: "hA", project_key: "A", is_default: true }];
    const r = await artifactApi(state).transition({ id: "gB", to: "achieved" });
    assert.equal(r.ok, true, r.error);
  });
});
