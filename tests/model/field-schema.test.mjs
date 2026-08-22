// tests/model/field-schema.test.mjs
//
// field_definition follows the coverage.mjs / hierarchy-schema.mjs dialect pattern.
// Two defects already hit this plan in schema code (BLZ-314 fix round) and these
// tests exist to prove field_definition does not repeat either: a nullable column
// inside a composite PRIMARY KEY (uninsertable under STRICT SQLite and in Postgres —
// field_definition keys on the surrogate `id` alone), and `boolean NOT NULL DEFAULT 0`
// (Postgres rejects the untyped integer literal — is_filterable/is_required use the
// `false_` dialect token).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { fieldDdl, DATA_TYPES } from "../../scripts/model/field-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(fieldDdl("sqlite"));
  return db;
}
const ins = (db, o) => db.prepare(
  `INSERT INTO field_definition
     (id, project_key, key, label, data_type, applies_to_kind, is_filterable, is_required, enum_values)
   VALUES (?,?,?,?,?,?,?,?,?)`).run(
  o.id, o.project_key ?? "BLZ", o.key, o.label ?? "Label", o.data_type ?? "text",
  o.applies_to_kind ?? "requirement", o.is_filterable ?? 0, o.is_required ?? 0,
  o.enum_values ?? null);

describe("field_definition schema (SQLite)", () => {
  test("a well-formed field definition inserts, id as the sole primary key", () => {
    const db = open();
    ins(db, { id: "f1", key: "risk_score" });
    assert.equal(db.prepare("SELECT count(*) n FROM field_definition").get().n, 1);
  });

  test("is_filterable and is_required default to false without an explicit value", () => {
    const db = open();
    db.prepare(
      `INSERT INTO field_definition (id, project_key, key, label, data_type, applies_to_kind)
       VALUES (?,?,?,?,?,?)`
    ).run("f1", "BLZ", "risk_score", "Risk score", "number", "requirement");
    const row = db.prepare("SELECT is_filterable, is_required FROM field_definition WHERE id='f1'").get();
    assert.equal(row.is_filterable, 0);
    assert.equal(row.is_required, 0);
  });

  test("the same key twice for one project + applies_to_kind is REFUSED", () => {
    const db = open();
    ins(db, { id: "f1", key: "risk_score" });
    assert.throws(() => ins(db, { id: "f2", key: "risk_score" }), /UNIQUE|constraint/i);
  });

  test("the same key on a different applies_to_kind is fine", () => {
    const db = open();
    ins(db, { id: "f1", key: "risk_score", applies_to_kind: "requirement" });
    ins(db, { id: "f2", key: "risk_score", applies_to_kind: "architecture" });
    assert.equal(db.prepare("SELECT count(*) n FROM field_definition").get().n, 2);
  });

  test("an unknown data_type is REFUSED by the CHECK", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "f1", key: "x", data_type: "unknown_type" }), /CHECK|constraint/i);
  });

  test("data_type 'enum' without enum_values is REFUSED by the CHECK", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "f1", key: "x", data_type: "enum" }), /CHECK|constraint/i);
  });

  test("data_type 'enum' with enum_values is fine", () => {
    const db = open();
    ins(db, { id: "f1", key: "x", data_type: "enum", enum_values: "low,medium,high" });
    assert.equal(db.prepare("SELECT count(*) n FROM field_definition").get().n, 1);
  });

  test("every declared DATA_TYPE is accepted by the CHECK", () => {
    const db = open();
    DATA_TYPES.forEach((t, i) => {
      ins(db, { id: `f${i}`, key: `k${i}`, data_type: t, enum_values: t === "enum" ? "a,b" : null });
    });
    assert.equal(db.prepare("SELECT count(*) n FROM field_definition").get().n, DATA_TYPES.length);
  });
});

if (process.env.BLAZE_TEST_PG_URL) {
  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    try {
      await client.query("DROP TABLE IF EXISTS field_definition CASCADE");
    } catch (e) {
      // ignore
    }
    try {
      await client.query(fieldDdl("postgres"));
    } catch (e) {
      await client.end();
      throw e;
    }
    return client;
  }

  const insPg = async (db, o) => {
    await db.query(
      `INSERT INTO field_definition
         (id, project_key, key, label, data_type, applies_to_kind, is_filterable, is_required, enum_values)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [o.id, o.project_key ?? "BLZ", o.key, o.label ?? "Label", o.data_type ?? "text",
       o.applies_to_kind ?? "requirement", o.is_filterable ?? false, o.is_required ?? false,
       o.enum_values ?? null]
    );
  };

  describe("field_definition schema (Postgres)", () => {
    test("a well-formed field definition inserts, id as the sole primary key", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "f1", key: "risk_score" });
        const r = await db.query("SELECT count(*) n FROM field_definition");
        assert.equal(Number(r.rows[0].n), 1);
      } finally {
        await db.end();
      }
    });

    test("is_filterable/is_required default to false — the boolean-default defect", async () => {
      const db = await openPg();
      try {
        await db.query(
          `INSERT INTO field_definition (id, project_key, key, label, data_type, applies_to_kind)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          ["f1", "BLZ", "risk_score", "Risk score", "number", "requirement"]
        );
        const r = await db.query("SELECT is_filterable, is_required FROM field_definition WHERE id='f1'");
        assert.equal(r.rows[0].is_filterable, false);
        assert.equal(r.rows[0].is_required, false);
      } finally {
        await db.end();
      }
    });

    test("the same key twice for one project + applies_to_kind is REFUSED", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "f1", key: "risk_score" });
        await assert.rejects(() => insPg(db, { id: "f2", key: "risk_score" }), /unique|constraint|duplicate/i);
      } finally {
        await db.end();
      }
    });

    test("an unknown data_type is REFUSED by the CHECK", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          () => insPg(db, { id: "f1", key: "x", data_type: "unknown_type" }),
          /check|constraint|new row/i
        );
      } finally {
        await db.end();
      }
    });

    test("data_type 'enum' without enum_values is REFUSED by the CHECK", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          () => insPg(db, { id: "f1", key: "x", data_type: "enum" }),
          /check|constraint|new row/i
        );
      } finally {
        await db.end();
      }
    });
  });
}
