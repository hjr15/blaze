// tests/model/coverage.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { evaluateCoverage, DEFAULT_COVERAGE_RULES, coverageDdl } from "../../scripts/model/coverage.mjs";

const RULE = { name: "every-requirement-addressed", subject_kind: "requirement",
               definition: { requires_link: "Addresses", direction: "inbound", min: 1 } };

describe("coverage evaluation", () => {
  test("a requirement with an inbound Addresses link satisfies the rule", () => {
    const artifacts = [{ id: "a1", ref: "REQ-001", kind: "requirement" }];
    const links = [{ type_name: "Addresses", source_id: "d1", target_id: "a1" }];
    assert.deepEqual(evaluateCoverage({ rule: RULE, artifacts, links }).violations, []);
  });

  test("a requirement with no such link VIOLATES, and the violation names the ref", () => {
    const artifacts = [{ id: "a1", ref: "REQ-014", kind: "requirement" }];
    const r = evaluateCoverage({ rule: RULE, artifacts, links: [] });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].ref, "REQ-014");
    assert.match(r.violations[0].why, /Addresses/);
  });

  test("a link of the WRONG TYPE does not satisfy the rule", () => {
    const artifacts = [{ id: "a1", ref: "REQ-014", kind: "requirement" }];
    const links = [{ type_name: "Relates", source_id: "x", target_id: "a1" }];
    assert.equal(evaluateCoverage({ rule: RULE, artifacts, links }).violations.length, 1);
  });

  test("direction matters — an OUTBOUND Addresses does not satisfy an inbound rule", () => {
    const artifacts = [{ id: "a1", ref: "REQ-014", kind: "requirement" }];
    const links = [{ type_name: "Addresses", source_id: "a1", target_id: "other" }];
    assert.equal(evaluateCoverage({ rule: RULE, artifacts, links }).violations.length, 1);
  });

  test("artifacts of another kind are not subject to the rule", () => {
    const artifacts = [{ id: "x1", ref: "ADR-0001", kind: "architecture" }];
    assert.deepEqual(evaluateCoverage({ rule: RULE, artifacts, links: [] }).violations, []);
  });

  test("EVERY violation is listed — never a count, never a truncated sample", () => {
    // A refusal saying only "coverage incomplete" is a defect: the person cannot act on it.
    const artifacts = Array.from({ length: 30 }, (_, i) =>
      ({ id: `a${i}`, ref: `REQ-${String(i + 1).padStart(3, "0")}`, kind: "requirement" }));
    const r = evaluateCoverage({ rule: RULE, artifacts, links: [] });
    assert.equal(r.violations.length, 30);
  });

  test("the shipped defaults are named, so a refusal can cite the rule that refused", () => {
    for (const r of DEFAULT_COVERAGE_RULES) {
      assert.ok(r.name && r.description, `${JSON.stringify(r)} needs a name and description`);
    }
  });

  const ORPHAN_ADR = { name: "no-orphan-architecture", subject_kind: "architecture",
                       definition: { requires_link: "Addresses", direction: "outbound", min: 1 } };

  test("an OUTBOUND rule counts the source end, not the target", () => {
    // The mirror of the inbound case. Without this, a mutation that ignores `direction`
    // and always counts target_id passes the whole suite.
    const artifacts = [{ id: "d1", ref: "ADR-0007", kind: "architecture" }];
    const links = [{ type_name: "Addresses", source_id: "d1", target_id: "r1" }];
    assert.deepEqual(evaluateCoverage({ rule: ORPHAN_ADR, artifacts, links }).violations, []);
  });

  test("an architecture item addressing nothing violates the outbound rule", () => {
    const artifacts = [{ id: "d1", ref: "ADR-0007", kind: "architecture" }];
    assert.equal(evaluateCoverage({ rule: ORPHAN_ADR, artifacts, links: [] }).violations.length, 1);
  });
});

// --- schema ------------------------------------------------------------
//
// coverageDdl(name) follows the hierarchy-schema.mjs dialect pattern. Two defects
// already hit this plan in schema code (BLZ-314 fix round): a nullable column inside
// a composite PRIMARY KEY (uninsertable under STRICT and in Postgres), and
// `boolean NOT NULL DEFAULT 0` (Postgres rejects the untyped integer literal). These
// tests exist to prove coverage_rule does not repeat either.

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(coverageDdl("sqlite"));
  return db;
}
const ins = (db, o) => db.prepare(
  `INSERT INTO coverage_rule (id, project_key, name, description, subject_kind, definition, enabled)
   VALUES (?,?,?,?,?,?,?)`).run(
  o.id, o.project_key ?? "BLZ", o.name, o.description ?? "d",
  o.subject_kind ?? "requirement", o.definition ?? "{}", o.enabled ?? 1);

describe("coverage_rule schema (SQLite)", () => {
  test("a well-formed rule inserts, id as the sole primary key", () => {
    const db = open();
    ins(db, { id: "c1", name: "every-requirement-addressed" });
    assert.equal(db.prepare("SELECT count(*) n FROM coverage_rule").get().n, 1);
  });

  test("enabled defaults to true without an explicit value", () => {
    const db = open();
    db.prepare(
      `INSERT INTO coverage_rule (id, project_key, name, description, subject_kind, definition)
       VALUES (?,?,?,?,?,?)`
    ).run("c1", "BLZ", "every-requirement-addressed", "d", "requirement", "{}");
    assert.equal(db.prepare("SELECT enabled FROM coverage_rule WHERE id='c1'").get().enabled, 1);
  });

  test("the same rule name twice in one project is REFUSED", () => {
    const db = open();
    ins(db, { id: "c1", name: "dup" });
    assert.throws(() => ins(db, { id: "c2", name: "dup" }), /UNIQUE|constraint/i);
  });

  test("the same rule name in a different project is fine", () => {
    const db = open();
    ins(db, { id: "c1", name: "dup", project_key: "BLZ" });
    ins(db, { id: "c2", name: "dup", project_key: "OTH" });
    assert.equal(db.prepare("SELECT count(*) n FROM coverage_rule").get().n, 2);
  });

  test("an unknown subject_kind is REFUSED by the CHECK", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "c1", name: "x", subject_kind: "ticket" }), /CHECK|constraint/i);
  });
});

if (process.env.BLAZE_TEST_PG_URL) {
  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    try {
      await client.query("DROP TABLE IF EXISTS coverage_rule CASCADE");
    } catch (e) {
      // ignore
    }
    try {
      await client.query(coverageDdl("postgres"));
    } catch (e) {
      await client.end();
      throw e;
    }
    return client;
  }

  const insPg = async (db, o) => {
    await db.query(
      `INSERT INTO coverage_rule (id, project_key, name, description, subject_kind, definition, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [o.id, o.project_key ?? "BLZ", o.name, o.description ?? "d",
       o.subject_kind ?? "requirement", o.definition ?? "{}", o.enabled ?? true]
    );
  };

  describe("coverage_rule schema (Postgres)", () => {
    test("a well-formed rule inserts, id as the sole primary key", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "c1", name: "every-requirement-addressed" });
        const r = await db.query("SELECT count(*) n FROM coverage_rule");
        assert.equal(Number(r.rows[0].n), 1);
      } finally {
        await db.end();
      }
    });

    test("enabled defaults to true without an explicit value — the boolean-default defect", async () => {
      const db = await openPg();
      try {
        await db.query(
          `INSERT INTO coverage_rule (id, project_key, name, description, subject_kind, definition)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          ["c1", "BLZ", "every-requirement-addressed", "d", "requirement", "{}"]
        );
        const r = await db.query("SELECT enabled FROM coverage_rule WHERE id='c1'");
        assert.equal(r.rows[0].enabled, true);
      } finally {
        await db.end();
      }
    });

    test("the same rule name twice in one project is REFUSED", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "c1", name: "dup" });
        await assert.rejects(() => insPg(db, { id: "c2", name: "dup" }), /unique|constraint|duplicate/i);
      } finally {
        await db.end();
      }
    });

    test("an unknown subject_kind is REFUSED by the CHECK", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          () => insPg(db, { id: "c1", name: "x", subject_kind: "ticket" }),
          /check|constraint|new row/i
        );
      } finally {
        await db.end();
      }
    });
  });
}
