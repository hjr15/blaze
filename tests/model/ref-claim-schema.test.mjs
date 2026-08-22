// tests/model/ref-claim-schema.test.mjs — the ref_claim table itself: shape,
// uniqueness and append-only-ness, independent of the allocation logic in
// ref-claim.mjs (covered by tests/model/ref-claim.test.mjs).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { refClaimDdl } from "../../scripts/model/ref-claim-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(refClaimDdl("sqlite"));
  return db;
}
const ins = (db, o) => db.prepare(
  `INSERT INTO ref_claim (project_key, kind, num, ref, claimed_at) VALUES (?,?,?,?,?)`).run(
  o.project_key ?? "BLZ", o.kind ?? "requirement", o.num, o.ref, o.claimed_at ?? "2026-01-01");

describe("ref_claim (SQLite)", () => {
  test("accepts a well-formed claim", () => {
    const db = open();
    ins(db, { num: 1, ref: "REQ-001" });
    assert.equal(db.prepare("SELECT count(*) n FROM ref_claim").get().n, 1);
  });

  test("the same (project_key, kind, num) cannot be claimed twice — the PK IS the concurrency guard", () => {
    const db = open();
    ins(db, { num: 1, ref: "REQ-001" });
    assert.throws(() => ins(db, { num: 1, ref: "REQ-001-again" }), /UNIQUE|constraint/i);
  });

  test("a ref is unique WITHIN a project, and free across projects", () => {
    const db = open();
    ins(db, { num: 1, ref: "REQ-001", project_key: "BLZ" });
    ins(db, { num: 1, ref: "REQ-001", project_key: "OBA" });   // must be allowed
    // Same project, same ref string, a DIFFERENT num — the belt-and-braces UNIQUE
    // (project_key, ref), independent of the PK.
    assert.throws(() => ins(db, { num: 2, ref: "REQ-001", project_key: "BLZ" }),
      /UNIQUE|constraint/i);
  });

  test("an unknown kind is refused by the database, not by the caller", () => {
    const db = open();
    assert.throws(() => ins(db, { num: 1, ref: "EPIC-001", kind: "epic" }), /CHECK|constraint/i);
  });

  test("num must be positive", () => {
    const db = open();
    assert.throws(() => ins(db, { num: 0, ref: "REQ-000" }), /CHECK|constraint/i);
  });

  test("UPDATE is refused — the ledger is append-only", () => {
    const db = open();
    ins(db, { num: 1, ref: "REQ-001" });
    assert.throws(
      () => db.exec("UPDATE ref_claim SET ref = 'REQ-999' WHERE num = 1"),
      /append-only/i);
  });

  test("DELETE is refused — a claim is a tombstone, never freed", () => {
    // The property the whole ticket exists to protect: deleting a claim would let a
    // retired ref be reissued, reopening the exact hole this table closes.
    const db = open();
    ins(db, { num: 1, ref: "REQ-001" });
    assert.throws(
      () => db.exec("DELETE FROM ref_claim WHERE num = 1"),
      /append-only/i);
  });

  test("both dialects declare the same columns", () => {
    const cols = (sql) => [...sql.matchAll(/^\s{2}([a-z_]+)\s+/gm)].map(m => m[1]);
    assert.deepEqual(cols(refClaimDdl("sqlite")).sort(), cols(refClaimDdl("postgres")).sort());
  });
});

// --- Postgres ----------------------------------------------------------------------
//
// Isolated in its own schema: node's test runner runs test files in parallel by
// default, and another file on this branch (field-promotion.test.mjs / baseline.test.mjs)
// already raced on the shared `public` schema by creating same-named tables there.
if (process.env.BLAZE_TEST_PG_URL) {
  const SCHEMA = "ref_claim_schema_test";

  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query("DROP TABLE IF EXISTS ref_claim CASCADE");
    await client.query(refClaimDdl("postgres"));
    return client;
  }
  const insPg = (db, o) => db.query(
    `INSERT INTO ref_claim (project_key, kind, num, ref, claimed_at) VALUES ($1,$2,$3,$4,$5)`,
    [o.project_key ?? "BLZ", o.kind ?? "requirement", o.num, o.ref, o.claimed_at ?? "2026-01-01"]);

  describe("ref_claim (Postgres)", () => {
    test("accepts a well-formed claim", async () => {
      const db = await openPg();
      try {
        await insPg(db, { num: 1, ref: "REQ-001" });
        const r = await db.query("SELECT count(*) AS n FROM ref_claim");
        assert.equal(Number(r.rows[0].n), 1);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("the same (project_key, kind, num) cannot be claimed twice", async () => {
      const db = await openPg();
      try {
        await insPg(db, { num: 1, ref: "REQ-001" });
        await assert.rejects(
          () => insPg(db, { num: 1, ref: "REQ-001-again" }),
          /unique|constraint|duplicate/i);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("a ref is unique WITHIN a project, and free across projects", async () => {
      const db = await openPg();
      try {
        await insPg(db, { num: 1, ref: "REQ-001", project_key: "BLZ" });
        await insPg(db, { num: 1, ref: "REQ-001", project_key: "OBA" });   // allowed
        await assert.rejects(
          () => insPg(db, { num: 2, ref: "REQ-001", project_key: "BLZ" }),
          /unique|constraint|duplicate/i);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("an unknown kind is refused by the database, not by the caller", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          () => insPg(db, { num: 1, ref: "EPIC-001", kind: "epic" }),
          /check|constraint|new row/i);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("UPDATE is refused — the ledger is append-only", async () => {
      const db = await openPg();
      try {
        await insPg(db, { num: 1, ref: "REQ-001" });
        await assert.rejects(
          () => db.query("UPDATE ref_claim SET ref = 'REQ-999' WHERE num = 1"),
          /append-only/i);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("DELETE is refused — a claim is a tombstone, never freed", async () => {
      const db = await openPg();
      try {
        await insPg(db, { num: 1, ref: "REQ-001" });
        await assert.rejects(
          () => db.query("DELETE FROM ref_claim WHERE num = 1"),
          /append-only/i);
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });
  });
}
