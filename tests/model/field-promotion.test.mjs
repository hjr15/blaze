// tests/model/field-promotion.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { promotionPlan, FILTERABLE_CAP, PG_COLUMN_CEILING } from "../../scripts/model/field-promotion.mjs";
import { artifactDdl } from "../../scripts/model/artifact-schema.mjs";

const f = (o = {}) => ({ key: "risk_score", data_type: "number", is_filterable: true,
                         applies_to_kind: "requirement", ...o });

describe("promotion", () => {
  test("a filterable field becomes a real typed column via ADD COLUMN", () => {
    const p = promotionPlan({ field: f(), existingColumns: [], filterableCount: 0, engine: "postgres" });
    assert.equal(p.ok, true);
    assert.match(p.sql, /ALTER TABLE artifact ADD COLUMN cf_risk_score/);
    assert.match(p.sql, /numeric|double precision/);
  });

  test("NEVER a STORED generated column — 2,002ms rewrite, impossible on SQLite", () => {
    const p = promotionPlan({ field: f(), existingColumns: [], filterableCount: 0, engine: "sqlite" });
    assert.doesNotMatch(p.sql, /GENERATED|STORED/i);
  });

  test("a non-filterable field is NOT promoted — it lives in the JSON tail", () => {
    const p = promotionPlan({ field: f({ is_filterable: false }), existingColumns: [],
                              filterableCount: 0, engine: "postgres" });
    assert.equal(p.ok, true);
    assert.equal(p.sql, null, "no DDL for an unpromoted field");
  });

  test("the 200-filterable cap is REFUSED with a named error, not a raw failure", () => {
    const p = promotionPlan({ field: f(), existingColumns: [], filterableCount: FILTERABLE_CAP,
                              engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /200/);
    assert.match(p.error, /filterable/i);
  });

  test("the Postgres 1,600-column ceiling is refused BEFORE ALTER TABLE fails raw", () => {
    const cols = Array.from({ length: PG_COLUMN_CEILING }, (_, i) => `cf_${i}`);
    const p = promotionPlan({ field: f(), existingColumns: cols, filterableCount: 5,
                              engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /1600|1,600/);
  });

  test("SQLite has no such ceiling, so the same field promotes there", () => {
    const cols = Array.from({ length: PG_COLUMN_CEILING }, (_, i) => `cf_${i}`);
    const p = promotionPlan({ field: f(), existingColumns: cols, filterableCount: 5,
                              engine: "sqlite" });
    assert.equal(p.ok, true);
  });

  test("a duplicate column is refused rather than emitting a failing ALTER", () => {
    const p = promotionPlan({ field: f(), existingColumns: ["cf_risk_score"],
                              filterableCount: 1, engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /already/i);
  });

  test("a field key that is not a safe identifier is refused — no SQL injection surface", () => {
    const p = promotionPlan({ field: f({ key: "oops\"; DROP TABLE artifact; --" }),
                              existingColumns: [], filterableCount: 0, engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /identifier/i);
  });
});

// --- executed ALTER TABLE -------------------------------------------------
//
// promotionPlan is a pure function that returns a SQL string; nothing in the unit
// tests above ever runs that string against a real engine. A plausible-looking
// string nobody executes is exactly the shape of bug this project keeps finding —
// so these tests actually create the `artifact` table and run the generated
// ALTER TABLE against it, for one field of each data type.

const FIELDS_BY_TYPE = [
  { key: "risk_score", data_type: "number" },
  { key: "owner_name", data_type: "text" },
  { key: "due_on", data_type: "date" },
  { key: "is_blocked", data_type: "boolean" },
  { key: "priority_tier", data_type: "enum" },
];

describe("promotionPlan SQL actually executes (SQLite)", () => {
  test("one promoted column of each data type can be added and written to", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(artifactDdl("sqlite"));
    let existingColumns = [];
    for (const type of FIELDS_BY_TYPE) {
      const field = { ...type, is_filterable: true, applies_to_kind: "requirement" };
      const p = promotionPlan({ field, existingColumns, filterableCount: 0, engine: "sqlite" });
      assert.equal(p.ok, true, `${type.data_type}: ${p.error}`);
      db.exec(p.sql);
      existingColumns = [...existingColumns, `cf_${type.key}`];
    }
    db.prepare(
      `INSERT INTO artifact (id, project_key, kind, ref, title, status, created_at, updated_at,
                              cf_risk_score, cf_owner_name, cf_due_on, cf_is_blocked, cf_priority_tier)
       VALUES ('a1','BLZ','requirement','REQ-001','t','open','2026-01-01','2026-01-01',
               7.5, 'alice', '2026-02-01', 1, 'high')`
    ).run();
    const row = db.prepare("SELECT * FROM artifact WHERE id = 'a1'").get();
    assert.equal(row.cf_risk_score, 7.5);
    assert.equal(row.cf_owner_name, "alice");
    assert.equal(row.cf_due_on, "2026-02-01");
    assert.equal(row.cf_is_blocked, 1);
    assert.equal(row.cf_priority_tier, "high");
  });
});

if (process.env.BLAZE_TEST_PG_URL) {
  describe("promotionPlan SQL actually executes (Postgres)", () => {
    test("one promoted column of each data type can be added and written to", async () => {
      // Isolated in its own schema: artifact-schema.test.mjs also creates/drops a
      // real "artifact" table on this same database, and node's test runner runs
      // test files in parallel by default — sharing the public schema's table name
      // races the two files against each other. A private schema avoids the race
      // without depending on test-runner concurrency settings.
      const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
      await client.connect();
      try {
        await client.query("CREATE SCHEMA IF NOT EXISTS field_promotion_test");
        await client.query("SET search_path TO field_promotion_test");
        await client.query("DROP TABLE IF EXISTS artifact CASCADE");
        await client.query(artifactDdl("postgres"));
        let existingColumns = [];
        for (const type of FIELDS_BY_TYPE) {
          const field = { ...type, is_filterable: true, applies_to_kind: "requirement" };
          const p = promotionPlan({ field, existingColumns, filterableCount: 0, engine: "postgres" });
          assert.equal(p.ok, true, `${type.data_type}: ${p.error}`);
          await client.query(p.sql);
          existingColumns = [...existingColumns, `cf_${type.key}`];
        }
        await client.query(
          `INSERT INTO artifact (id, project_key, kind, ref, title, status, created_at, updated_at,
                                  cf_risk_score, cf_owner_name, cf_due_on, cf_is_blocked, cf_priority_tier)
           VALUES ('a1','BLZ','requirement','REQ-001','t','open',now(),now(),
                   7.5, 'alice', '2026-02-01', true, 'high')`
        );
        const r = await client.query("SELECT * FROM artifact WHERE id = 'a1'");
        const row = r.rows[0];
        assert.equal(Number(row.cf_risk_score), 7.5);
        assert.equal(row.cf_owner_name, "alice");
        assert.equal(row.cf_is_blocked, true);
        assert.equal(row.cf_priority_tier, "high");
      } finally {
        await client.query("DROP SCHEMA IF EXISTS field_promotion_test CASCADE").catch(() => {});
        await client.end();
      }
    });
  });
}
