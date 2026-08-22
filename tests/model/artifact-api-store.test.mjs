// tests/model/artifact-api-store.test.mjs — the API/DDL boundary test (BLZ-325).
//
// The structural hole the final review named: `artifact-api.mjs` was a façade over
// three in-memory arrays, never reconciled with the tables the other thirteen modules
// define. Every prior test asserted what the API RETURNED; nothing asserted what
// actually landed in a real table. This file is exactly that missing seam: create
// through the API, read back with a plain SELECT against the real schema, on both
// SQLite and Postgres.
//
// Its own schema: `node --test` runs files in parallel, and several other files in
// this suite already create tables named `artifact`/`link`/`baseline` on the shared
// Postgres `public` schema (I9 in the final review). A private schema avoids racing
// them without depending on test-runner concurrency settings.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { artifactApi } from "../../scripts/model/artifact-api.mjs";
import { artifactStore } from "../../scripts/model/artifact-store.mjs";
import { artifactDdl, revisionDdl } from "../../scripts/model/artifact-schema.mjs";
import { linkDdl } from "../../scripts/model/link-schema.mjs";
import { documentDdl } from "../../scripts/model/document-schema.mjs";
import { baselineDdl } from "../../scripts/model/baseline-schema.mjs";
import { fieldDdl } from "../../scripts/model/field-schema.mjs";
import { refClaimDdl } from "../../scripts/model/ref-claim-schema.mjs";
import { coverageDdl } from "../../scripts/model/coverage.mjs";

function sqliteExec(db) {
  return {
    run(sql, params = []) { return params.length ? db.prepare(sql).run(...params) : db.exec(sql); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
  };
}

function openSqlite() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(artifactDdl("sqlite"));
  db.exec(revisionDdl("sqlite"));
  db.exec(linkDdl("sqlite"));
  db.exec(documentDdl("sqlite"));
  db.exec(baselineDdl("sqlite"));
  db.exec(fieldDdl("sqlite"));
  db.exec(refClaimDdl("sqlite"));
  db.exec(coverageDdl("sqlite"));
  // Addresses is the only link type these tests exercise — seeded straight into the
  // real link_type table so `link`'s FK resolves.
  db.prepare(`INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds, min_card, max_card)
              VALUES ('lt1','BLZ','Addresses','Addressed by','architecture','requirement',0,NULL)`).run();
  return db;
}

/** The in-memory `state` artifactApi's pure decision functions read from. */
function baseState() {
  return {
    artifacts: [],
    tickets: [],
    links: [],
    linkTypes: [{ id: "lt1", name: "Addresses", inverse_name: "Addressed by",
      source_kinds: "architecture", target_kinds: "requirement", min_card: 0, max_card: null }],
  };
}

describe("the API/DDL boundary (SQLite): what the API returns is what the database holds", () => {
  test("an artifact created through the API is readable from `artifact`, every NOT NULL column populated", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const store = artifactStore(exec, { dialect: "sqlite" });
    const api = artifactApi(baseState(), store);

    const r = await api.createArtifact({
      kind: "requirement", title: "Login must rate-limit", project_key: "BLZ",
    });
    assert.equal(r.ok, true, r.error);

    const row = db.prepare("SELECT * FROM artifact WHERE id = ?").get(r.artifact.id);
    assert.ok(row, "the artifact the API returned does not exist in the artifact table");
    for (const col of ["project_key", "kind", "ref", "title", "status", "created_at", "updated_at"]) {
      assert.notEqual(row[col], null, `artifact.${col} is NULL`);
      assert.notEqual(row[col], undefined, `artifact.${col} is undefined`);
    }
    assert.equal(row.project_key, "BLZ");
    assert.equal(row.ref, "REQ-001");
    assert.equal(row.title, "Login must rate-limit");

    // The ref was claimed through the ledger, not merely stamped onto the row —
    // ref_claim is the production caller this ticket wires up.
    const claim = db.prepare("SELECT * FROM ref_claim WHERE project_key = ? AND kind = ?")
      .get("BLZ", "requirement");
    assert.equal(claim.ref, "REQ-001");
  });

  test("a link created through the API is readable from `link`", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const store = artifactStore(exec, { dialect: "sqlite" });
    const api = artifactApi(baseState(), store);

    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
    assert.equal(req.ok, true, req.error);
    assert.equal(arch.ok, true, arch.error);

    const r = await api.createLink({
      typeName: "Addresses", sourceId: arch.artifact.id, targetId: req.artifact.id,
    });
    assert.equal(r.ok, true, r.error);

    const row = db.prepare("SELECT * FROM link WHERE id = ?").get(r.link.id);
    assert.ok(row, "the link the API returned does not exist in the link table");
    assert.equal(row.link_type_id, "lt1");
    assert.equal(row.source_id, arch.artifact.id);
    assert.equal(row.target_id, req.artifact.id);
  });

  test("a baseline created through the API has a project_key, no document_id, and every member carries a real revision_id", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const store = artifactStore(exec, { dialect: "sqlite" });
    const state = baseState();
    const api = artifactApi(state, store);

    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(req.ok, true, req.error);

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO document (id, project_key, title, kind, status, created_at, updated_at)
                VALUES ('d1','BLZ','Spec','requirements','draft',?,?)`).run(now, now);
    state.documents = [{ id: "d1", project_key: "BLZ", title: "Spec", kind: "requirements", status: "draft" }];
    state.artifactUsages = [{ document_id: "d1", artifact_id: req.artifact.id, ord: 1, depth: 0 }];
    // every-requirement-addressed / every-requirement-verified are DEFAULT_COVERAGE_RULES;
    // supply an empty rule set so the gate itself is not what is under test here.
    state.coverageRules = [];

    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, true, r.error);

    const cols = db.prepare("SELECT * FROM baseline WHERE id = ?").get(r.baseline.id);
    assert.ok(cols, "the baseline the API returned does not exist in the baseline table");
    assert.equal(cols.project_key, "BLZ");
    assert.ok(!("document_id" in cols), "a baseline row must not carry document_id");

    const members = db.prepare("SELECT * FROM baseline_member WHERE baseline_id = ?").all(r.baseline.id);
    assert.equal(members.length, 1);
    assert.equal(members[0].artifact_id, req.artifact.id);
    assert.ok(members[0].revision_id, "member has no revision_id");
    const rev = db.prepare("SELECT * FROM artifact_revision WHERE id = ?").get(members[0].revision_id);
    assert.ok(rev, "the pinned revision_id does not resolve to a real artifact_revision row");
    assert.equal(rev.artifact_id, req.artifact.id);
  });

  test("baselineDocument refuses when a member has no revision — never a NULL pin", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const store = artifactStore(exec, { dialect: "sqlite" });
    const state = baseState();
    const api = artifactApi(state, store);

    // Seeded directly, bypassing createArtifact — exactly how "an artifact with no
    // revision" arises.
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO artifact (id, project_key, kind, ref, title, status, created_at, updated_at)
                VALUES ('a1','BLZ','requirement','REQ-001','R','proposed',?,?)`).run(now, now);
    state.artifacts.push({ id: "a1", project_key: "BLZ", kind: "requirement", ref: "REQ-001", status: "proposed" });
    db.prepare(`INSERT INTO document (id, project_key, title, kind, status, created_at, updated_at)
                VALUES ('d1','BLZ','Spec','requirements','draft',?,?)`).run(now, now);
    state.documents = [{ id: "d1", project_key: "BLZ", title: "Spec", kind: "requirements", status: "draft" }];
    state.artifactUsages = [{ document_id: "d1", artifact_id: "a1", ord: 1, depth: 0 }];
    state.coverageRules = [];

    const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-001/);
    assert.match(r.error, /revision/);
    assert.equal(db.prepare("SELECT count(*) n FROM baseline").get().n, 0,
      "no baseline row must land when a member has no revision to pin");
  });

  test("defineField executes the ALTER TABLE promotionPlan returns", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const store = artifactStore(exec, { dialect: "sqlite" });
    const api = artifactApi(baseState(), store);

    const r = await api.defineField({
      id: "f1", project_key: "BLZ", key: "risk_score", label: "Risk score",
      data_type: "number", applies_to_kind: "requirement", is_filterable: true,
    });
    assert.equal(r.ok, true, r.error);
    assert.match(r.sql, /ALTER TABLE artifact ADD COLUMN cf_risk_score/);

    // The column genuinely exists — not merely a string the caller never ran.
    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    db.prepare("UPDATE artifact SET cf_risk_score = 7 WHERE id = ?").run(req.artifact.id);
    const row = db.prepare("SELECT cf_risk_score FROM artifact WHERE id = ?").get(req.artifact.id);
    assert.equal(row.cf_risk_score, 7);

    const fd = db.prepare("SELECT * FROM field_definition WHERE id = 'f1'").get();
    assert.ok(fd, "field_definition row was not persisted");
    assert.equal(fd.key, "risk_score");
  });

  test("transition persists status and updated_at to the real artifact row, and writes a revision", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const store = artifactStore(exec, { dialect: "sqlite" });
    const state = baseState();
    const api = artifactApi(state, store);

    const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(req.ok, true, req.error);

    const before = db.prepare("SELECT updated_at FROM artifact WHERE id = ?").get(req.artifact.id);
    // requirement:implemented is not a gated action (workflows.mjs), so this is an
    // ordinary, ungated status write.
    const t = await api.transition({ id: req.artifact.id, to: "implemented" });
    assert.equal(t.ok, true, t.error);

    const after = db.prepare("SELECT status, updated_at FROM artifact WHERE id = ?").get(req.artifact.id);
    assert.equal(after.status, "implemented");
    assert.ok(after.updated_at >= before.updated_at);

    const revs = db.prepare("SELECT * FROM artifact_revision WHERE artifact_id = ? ORDER BY at")
      .all(req.artifact.id);
    assert.equal(revs.length, 2, "createArtifact's revision plus transition's revision");
  });

  // --- discriminating regression: C3, proven through the API this time -------------
  test("REGRESSION: withdrawing the highest artifact does not free its ref, through the API", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const store = artifactStore(exec, { dialect: "sqlite" });
    const state = baseState();
    const api = artifactApi(state, store);

    const r1 = await api.createArtifact({ kind: "requirement", title: "R1", project_key: "BLZ" });
    const r2 = await api.createArtifact({ kind: "requirement", title: "R2", project_key: "BLZ" });
    assert.deepEqual([r1.artifact.ref, r2.artifact.ref], ["REQ-001", "REQ-002"]);

    // Withdraw: the artifact is gone from BOTH the in-memory state and the real table.
    state.artifacts = state.artifacts.filter((a) => a.id !== r2.artifact.id);
    db.prepare("DELETE FROM artifact WHERE id = ?").run(r2.artifact.id);
    assert.equal(db.prepare("SELECT count(*) n FROM artifact").get().n, 1);

    const r3 = await api.createArtifact({ kind: "requirement", title: "R3", project_key: "BLZ" });
    assert.equal(r3.ok, true, r3.error);
    assert.equal(r3.artifact.ref, "REQ-003", "REQ-002 must not be reissued");
  });
});

// BLZ-327 — the same API/DDL seam for §4.4's coverage rule. The structural hole the
// final review named was that no test crossed this boundary: `defineCoverageRule`
// returning a well-shaped object proves nothing about whether a row landed in
// `coverage_rule`, and the two can be internally consistent and mutually contradictory.
describe("BLZ-327 (SQLite): a coverage rule defined through the API lands in coverage_rule", () => {
  const RULE = {
    project_key: "BLZ", name: "every-requirement-addressed-v2",
    description: "Every requirement is addressed by an architecture decision.",
    subject_kind: "requirement",
    definition: { requires_link: "Addresses", direction: "inbound", min: 2 },
  };

  test("the rule row is readable, every NOT NULL column populated, definition round-trips", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = baseState();
    state.coverageRules = [];
    const api = artifactApi(state, store);

    const r = await api.defineCoverageRule(RULE);
    assert.equal(r.ok, true, r.error);

    const row = db.prepare("SELECT * FROM coverage_rule WHERE id = ?").get(r.rule.id);
    assert.ok(row, "the rule the API returned does not exist in coverage_rule");
    for (const col of ["project_key", "name", "description", "subject_kind", "definition", "enabled"]) {
      assert.notEqual(row[col], null, `coverage_rule.${col} is NULL`);
      assert.notEqual(row[col], undefined, `coverage_rule.${col} is undefined`);
    }
    assert.equal(row.enabled, 1);
    // `min: 2` specifically: a definition serialised as "[object Object]" or "{}" still
    // satisfies a NOT NULL check, so the round-trip has to compare a real value that
    // the DEFAULT rules do not already carry.
    const back = await store.listCoverageRules({ project_key: "BLZ" });
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].definition, RULE.definition);
    assert.equal(back[0].enabled, true);
  });

  test("the §4.4 report is computed from artifacts that are REALLY in the database", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = baseState();
    state.coverageRules = [];
    const api = artifactApi(state, store);

    for (const title of ["R1", "R2", "R3"]) {
      const a = await api.createArtifact({ kind: "requirement", title, project_key: "BLZ" });
      assert.equal(a.ok, true, a.error);
    }
    assert.equal(db.prepare("SELECT count(*) n FROM artifact").get().n, 3);

    const r = await api.defineCoverageRule({ ...RULE, definition: { ...RULE.definition, min: 1 } });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.currentViolations.map((v) => v.ref).sort(),
      ["REQ-001", "REQ-002", "REQ-003"]);
  });

  test("disabling through the API updates the real `enabled` column, not just memory", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = baseState();
    state.coverageRules = [];
    const api = artifactApi(state, store);

    await api.defineCoverageRule(RULE);
    const off = await api.setCoverageRuleEnabled({ project_key: "BLZ", name: RULE.name, enabled: false });
    assert.equal(off.ok, true, off.error);
    assert.equal(db.prepare("SELECT enabled FROM coverage_rule WHERE name = ?").get(RULE.name).enabled, 0);

    const on = await api.setCoverageRuleEnabled({ project_key: "BLZ", name: RULE.name, enabled: true });
    assert.equal(on.ok, true, on.error);
    assert.equal(db.prepare("SELECT enabled FROM coverage_rule WHERE name = ?").get(RULE.name).enabled, 1);
  });

  test("the API refuses a duplicate BEFORE the UNIQUE constraint has to, and leaves one row", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = baseState();
    state.coverageRules = [];
    const api = artifactApi(state, store);

    await api.defineCoverageRule(RULE);
    const dup = await api.defineCoverageRule({ ...RULE, id: "other" });
    assert.equal(dup.ok, false);
    assert.match(dup.error, new RegExp(RULE.name));
    assert.equal(db.prepare("SELECT count(*) n FROM coverage_rule").get().n, 1);
  });
});

// BLZ-328 — a refused write must leave the DATABASE untouched, not merely the in-memory
// arrays. The two can disagree: `state.artifacts.length === 0` says nothing about whether
// an INSERT already ran, and the ref_claim ledger is append-only, so a burned ref is a
// permanent hole in the sequence.
describe("BLZ-328 (SQLite): a field-validation refusal writes nothing to any table", () => {
  const defn = (o) => ({
    id: "fd1", project_key: "BLZ", key: "owner", label: "Owner", data_type: "text",
    applies_to_kind: "requirement", is_filterable: false, is_required: true,
    enum_values: null, min_value: null, max_value: null, ...o,
  });

  function wire(definitions) {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = baseState();
    state.fieldDefinitions = definitions;
    return { db, api: artifactApi(state, store), state };
  }

  test("no artifact row, no revision row, and no ref_claim row", async () => {
    const { db, api } = wire([defn({})]);
    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(r.ok, false);
    assert.match(r.error, /owner/);
    assert.equal(db.prepare("SELECT count(*) n FROM artifact").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM artifact_revision").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM ref_claim").get().n, 0,
      "a refused write must not burn a ref — the ledger is append-only");
  });

  test("and the next VALID write still gets REQ-001", async () => {
    const { db, api } = wire([defn({})]);
    await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    const ok = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                          fields: { owner: "ryan" } });
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.artifact.ref, "REQ-001");
    assert.equal(db.prepare("SELECT ref FROM artifact").get().ref, "REQ-001");
  });

  // The definitions the API validates against are the ones a REAL field_definition table
  // holds -- read back through the store, not a hand-built fixture that could disagree
  // with what defineField actually persists.
  test("the constraint that refuses is the one defineField really persisted", async () => {
    const db = openSqlite();
    const store = artifactStore(sqliteExec(db), { dialect: "sqlite" });
    const state = baseState();
    const api = artifactApi(state, store);

    const f = await api.defineField(defn({ is_required: true }));
    assert.equal(f.ok, true, f.error);
    const row = db.prepare("SELECT is_required FROM field_definition WHERE key = 'owner'").get();
    assert.equal(row.is_required, 1, "is_required must survive the round trip as 1, not NULL");

    const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
    assert.equal(r.ok, false);
    assert.match(r.error, /owner/);
  });
});

// --- Postgres ----------------------------------------------------------------------

if (process.env.BLAZE_TEST_PG_URL) {
  const SCHEMA = "artifact_api_store_test";

  function pgExec(client) {
    return {
      run: (sql, params = []) => client.query(sql, params.length ? params : undefined),
      all: async (sql, params = []) => (await client.query(sql, params.length ? params : undefined)).rows,
    };
  }

  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query("DROP TABLE IF EXISTS baseline_member CASCADE");
    await client.query("DROP TABLE IF EXISTS baseline CASCADE");
    await client.query("DROP TABLE IF EXISTS field_definition CASCADE");
    await client.query("DROP TABLE IF EXISTS link CASCADE");
    await client.query("DROP TABLE IF EXISTS link_type CASCADE");
    await client.query("DROP TABLE IF EXISTS artifact_usage CASCADE");
    await client.query("DROP TABLE IF EXISTS document CASCADE");
    await client.query("DROP TABLE IF EXISTS artifact_revision CASCADE");
    await client.query("DROP TABLE IF EXISTS artifact CASCADE");
    await client.query("DROP TABLE IF EXISTS ref_claim CASCADE");
    await client.query("DROP TABLE IF EXISTS coverage_rule CASCADE");
    await client.query(artifactDdl("postgres"));
    await client.query(revisionDdl("postgres"));
    await client.query(linkDdl("postgres"));
    await client.query(documentDdl("postgres"));
    await client.query(baselineDdl("postgres"));
    await client.query(fieldDdl("postgres"));
    await client.query(refClaimDdl("postgres"));
    await client.query(coverageDdl("postgres"));
    await client.query(
      `INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds, min_card, max_card)
       VALUES ('lt1','BLZ','Addresses','Addressed by','architecture','requirement',0,NULL)`);
    return client;
  }

  function baseStatePg() {
    return {
      artifacts: [], tickets: [], links: [],
      linkTypes: [{ id: "lt1", name: "Addresses", inverse_name: "Addressed by",
        source_kinds: "architecture", target_kinds: "requirement", min_card: 0, max_card: null }],
    };
  }

  describe("the API/DDL boundary (Postgres): what the API returns is what the database holds", () => {
    test("an artifact created through the API is readable from `artifact`, every NOT NULL column populated", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const api = artifactApi(baseStatePg(), store);

        const r = await api.createArtifact({ kind: "requirement", title: "Login must rate-limit", project_key: "BLZ" });
        assert.equal(r.ok, true, r.error);

        const { rows } = await db.query("SELECT * FROM artifact WHERE id = $1", [r.artifact.id]);
        assert.equal(rows.length, 1);
        const row = rows[0];
        for (const col of ["project_key", "kind", "ref", "title", "status", "created_at", "updated_at"]) {
          assert.notEqual(row[col], null, `artifact.${col} is NULL`);
        }
        assert.equal(row.ref, "REQ-001");
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("a link created through the API is readable from `link`", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const api = artifactApi(baseStatePg(), store);

        const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
        const arch = await api.createArtifact({ kind: "architecture", title: "A", project_key: "BLZ" });
        const r = await api.createLink({ typeName: "Addresses", sourceId: arch.artifact.id, targetId: req.artifact.id });
        assert.equal(r.ok, true, r.error);

        const { rows } = await db.query("SELECT * FROM link WHERE id = $1", [r.link.id]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source_id, arch.artifact.id);
        assert.equal(rows[0].target_id, req.artifact.id);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("a baseline created through the API has a project_key, no document_id, and every member carries a real revision_id", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const state = baseStatePg();
        const api = artifactApi(state, store);

        const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
        await db.query(
          `INSERT INTO document (id, project_key, title, kind, status, created_at, updated_at)
           VALUES ('d1','BLZ','Spec','requirements','draft', now(), now())`);
        state.documents = [{ id: "d1", project_key: "BLZ", title: "Spec", kind: "requirements", status: "draft" }];
        state.artifactUsages = [{ document_id: "d1", artifact_id: req.artifact.id, ord: 1, depth: 0 }];
        state.coverageRules = [];

        const r = await api.baselineDocument({ documentId: "d1", name: "v1" });
        assert.equal(r.ok, true, r.error);

        const { rows } = await db.query("SELECT * FROM baseline WHERE id = $1", [r.baseline.id]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].project_key, "BLZ");
        assert.ok(!("document_id" in rows[0]));

        const mem = await db.query("SELECT * FROM baseline_member WHERE baseline_id = $1", [r.baseline.id]);
        assert.equal(mem.rows.length, 1);
        assert.ok(mem.rows[0].revision_id);
        const rev = await db.query("SELECT * FROM artifact_revision WHERE id = $1", [mem.rows[0].revision_id]);
        assert.equal(rev.rows.length, 1);
        assert.equal(rev.rows[0].artifact_id, req.artifact.id);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("defineField executes the ALTER TABLE promotionPlan returns, using the store's dialect", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const api = artifactApi(baseStatePg(), store);

        const r = await api.defineField({
          id: "f1", project_key: "BLZ", key: "risk_score", label: "Risk score",
          data_type: "number", applies_to_kind: "requirement", is_filterable: true,
        });
        assert.equal(r.ok, true, r.error);
        assert.match(r.sql, /numeric/);

        const req = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
        await db.query("UPDATE artifact SET cf_risk_score = 7 WHERE id = $1", [req.artifact.id]);
        const { rows } = await db.query("SELECT cf_risk_score FROM artifact WHERE id = $1", [req.artifact.id]);
        assert.equal(Number(rows[0].cf_risk_score), 7);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("REGRESSION: withdrawing the highest artifact does not free its ref, through the API", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const state = baseStatePg();
        const api = artifactApi(state, store);

        const r1 = await api.createArtifact({ kind: "requirement", title: "R1", project_key: "BLZ" });
        const r2 = await api.createArtifact({ kind: "requirement", title: "R2", project_key: "BLZ" });
        assert.deepEqual([r1.artifact.ref, r2.artifact.ref], ["REQ-001", "REQ-002"]);

        state.artifacts = state.artifacts.filter((a) => a.id !== r2.artifact.id);
        await db.query("DELETE FROM artifact WHERE id = $1", [r2.artifact.id]);

        const r3 = await api.createArtifact({ kind: "requirement", title: "R3", project_key: "BLZ" });
        assert.equal(r3.ok, true, r3.error);
        assert.equal(r3.artifact.ref, "REQ-003", "REQ-002 must not be reissued");
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });
    // BLZ-327: the same seam on the engine that actually ships. `enabled` is a real
    // `boolean` here and an INTEGER in SQLite — the exact shape that made
    // `boolean NOT NULL DEFAULT 0` ship three separate times on this branch.
    test("a coverage rule defined through the API lands in coverage_rule, definition and enabled intact", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const state = baseStatePg();
        state.coverageRules = [];
        const api = artifactApi(state, store);

        const RULE = {
          project_key: "BLZ", name: "every-requirement-addressed-v2",
          description: "Every requirement is addressed by an architecture decision.",
          subject_kind: "requirement",
          definition: { requires_link: "Addresses", direction: "inbound", min: 2 },
        };
        const r = await api.defineCoverageRule(RULE);
        assert.equal(r.ok, true, r.error);

        const { rows } = await db.query("SELECT * FROM coverage_rule WHERE id = $1", [r.rule.id]);
        assert.equal(rows.length, 1);
        for (const col of ["project_key", "name", "description", "subject_kind", "definition", "enabled"]) {
          assert.notEqual(rows[0][col], null, `coverage_rule.${col} is NULL`);
        }
        assert.equal(rows[0].enabled, true, "enabled must be a real boolean true, not 1 or '1'");

        const back = await store.listCoverageRules({ project_key: "BLZ" });
        assert.deepEqual(back[0].definition, RULE.definition);
        assert.equal(back[0].enabled, true);

        const off = await api.setCoverageRuleEnabled({ project_key: "BLZ", name: RULE.name, enabled: false });
        assert.equal(off.ok, true, off.error);
        const after = await db.query("SELECT enabled FROM coverage_rule WHERE id = $1", [r.rule.id]);
        assert.equal(after.rows[0].enabled, false);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("the §4.4 report names every requirement really present in the artifact table", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const state = baseStatePg();
        state.coverageRules = [];
        const api = artifactApi(state, store);

        for (const title of ["R1", "R2", "R3"]) {
          const a = await api.createArtifact({ kind: "requirement", title, project_key: "BLZ" });
          assert.equal(a.ok, true, a.error);
        }
        const count = await db.query("SELECT count(*)::int n FROM artifact");
        assert.equal(count.rows[0].n, 3);

        const r = await api.defineCoverageRule({
          project_key: "BLZ", name: "addressed", description: "d", subject_kind: "requirement",
          definition: { requires_link: "Addresses", direction: "inbound", min: 1 },
        });
        assert.equal(r.ok, true, r.error);
        assert.deepEqual(r.currentViolations.map((v) => v.ref).sort(),
          ["REQ-001", "REQ-002", "REQ-003"]);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });
    // BLZ-328: the same refusal, against the engine that ships.
    test("a field-validation refusal writes nothing to artifact, artifact_revision or ref_claim", async () => {
      const db = await openPg();
      try {
        const store = artifactStore(pgExec(db), { dialect: "postgres" });
        const state = baseStatePg();
        const api = artifactApi(state, store);

        const f = await api.defineField({
          id: "fd1", project_key: "BLZ", key: "owner", label: "Owner", data_type: "text",
          applies_to_kind: "requirement", is_filterable: false, is_required: true,
        });
        assert.equal(f.ok, true, f.error);
        const def = await db.query("SELECT is_required FROM field_definition WHERE key = 'owner'");
        assert.equal(def.rows[0].is_required, true, "must be a real boolean true");

        const r = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ" });
        assert.equal(r.ok, false);
        assert.match(r.error, /owner/);
        for (const t of ["artifact", "artifact_revision", "ref_claim"]) {
          const { rows } = await db.query(`SELECT count(*)::int n FROM ${t}`);
          assert.equal(rows[0].n, 0, `${t} must be empty after a refused write`);
        }

        const ok = await api.createArtifact({ kind: "requirement", title: "R", project_key: "BLZ",
                                              fields: { owner: "ryan" } });
        assert.equal(ok.ok, true, ok.error);
        assert.equal(ok.artifact.ref, "REQ-001", "the refused write must not have consumed REQ-001");
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });
  });
} else {
  test.skip("Postgres boundary tests skipped — BLAZE_TEST_PG_URL is not set", () => {});
}
