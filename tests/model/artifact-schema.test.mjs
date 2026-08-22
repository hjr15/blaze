// tests/model/artifact-schema.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { artifactDdl, ARTIFACT_KINDS } from "../../scripts/model/artifact-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(artifactDdl("sqlite"));
  return db;
}
const ins = (db, o) => db.prepare(
  `INSERT INTO artifact (id, project_key, kind, ref, title, statement, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?)`).run(
  o.id, o.project_key ?? "BLZ", o.kind ?? "requirement", o.ref, o.title ?? "T",
  o.statement ?? null, o.status ?? "proposed", "2026-01-01", "2026-01-01");

// Postgres test helpers
async function openPg() {
  const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
  await client.connect();

  // Drop table if it exists to start fresh
  try {
    await client.query("DROP TABLE IF EXISTS artifact CASCADE");
  } catch (e) {
    // ignore
  }

  // Create schema
  await client.query(artifactDdl("postgres"));
  return client;
}

const insPg = async (db, o) => {
  await db.query(
    `INSERT INTO artifact (id, project_key, kind, ref, title, statement, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      o.id,
      o.project_key ?? "BLZ",
      o.kind ?? "requirement",
      o.ref,
      o.title ?? "T",
      o.statement ?? null,
      o.status ?? "proposed",
      "2026-01-01",
      "2026-01-01"
    ]
  );
};

describe("artifact (SQLite)", () => {
  test("accepts a well-formed requirement", () => {
    const db = open();
    ins(db, { id: "a1", ref: "REQ-001" });
    assert.equal(db.prepare("SELECT count(*) n FROM artifact").get().n, 1);
  });

  test("a ref is unique WITHIN a project, and free across projects", () => {
    const db = open();
    ins(db, { id: "a1", ref: "REQ-001", project_key: "BLZ" });
    ins(db, { id: "a2", ref: "REQ-001", project_key: "OBA" });   // must be allowed
    assert.throws(() => ins(db, { id: "a3", ref: "REQ-001", project_key: "BLZ" }),
      /UNIQUE|constraint/i);
  });

  test("an unknown kind is refused by the database, not by the caller", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "a1", ref: "REQ-001", kind: "epic" }), /CHECK|constraint/i);
  });

  test("an empty title is refused — portable form, not btrim", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "a1", ref: "REQ-001", title: "   " }), /CHECK|constraint/i);
  });

  test("both dialects declare the same columns", () => {
    const cols = (sql) => [...sql.matchAll(/^\s{2}([a-z_]+)\s+/gm)].map(m => m[1]);
    assert.deepEqual(cols(artifactDdl("sqlite")).sort(), cols(artifactDdl("postgres")).sort());
  });

  test("ARTIFACT_KINDS and the CHECK constraint cannot drift apart", () => {
    // A hand-written CHECK stays valid SQL when it goes stale. Derive it.
    for (const k of ARTIFACT_KINDS) assert.match(artifactDdl("sqlite"), new RegExp(`'${k}'`));
  });
});

// Postgres tests (only run if BLAZE_TEST_PG_URL is set)
if (process.env.BLAZE_TEST_PG_URL) {
  describe("artifact (Postgres)", () => {
    test("accepts a well-formed requirement", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "a1", ref: "REQ-001" });
        const result = await db.query("SELECT count(*) as n FROM artifact");
        assert.equal(Number(result.rows[0].n), 1);
      } finally {
        await db.end();
      }
    });

    test("a ref is unique WITHIN a project, and free across projects", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "a1", ref: "REQ-001", project_key: "BLZ" });
        await insPg(db, { id: "a2", ref: "REQ-001", project_key: "OBA" });   // must be allowed
        await assert.rejects(
          async () => insPg(db, { id: "a3", ref: "REQ-001", project_key: "BLZ" }),
          /UNIQUE|constraint|duplicate/i
        );
      } finally {
        await db.end();
      }
    });

    test("an unknown kind is refused by the database, not by the caller", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          async () => insPg(db, { id: "a1", ref: "REQ-001", kind: "epic" }),
          /CHECK|constraint|new row/i
        );
      } finally {
        await db.end();
      }
    });

    test("an empty title is refused — portable form, not btrim", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          async () => insPg(db, { id: "a1", ref: "REQ-001", title: "   " }),
          /CHECK|constraint|new row/i
        );
      } finally {
        await db.end();
      }
    });
  });
}
