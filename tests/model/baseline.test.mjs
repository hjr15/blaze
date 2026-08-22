// tests/model/baseline.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { artifactDdl, revisionDdl } from "../../scripts/model/artifact-schema.mjs";
import { baselineDdl } from "../../scripts/model/baseline-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(artifactDdl("sqlite"));
  db.exec(revisionDdl("sqlite"));
  db.exec(baselineDdl("sqlite"));
  db.exec(`INSERT INTO artifact (id, project_key, kind, ref, title, statement, body, status, created_at, updated_at) VALUES ('a1','BLZ','requirement','REQ-001','T',NULL,NULL,'proposed','t','t');`);
  db.exec(`INSERT INTO artifact_revision VALUES ('rev1','a1','2026-01-01','me','{}');`);
  db.exec(`INSERT INTO baseline VALUES ('b1','BLZ','Release 1.0','2026-02-01','me',NULL);`);
  return db;
}

describe("baselines", () => {
  test("a baseline is scoped to a PROJECT, not a document", () => {
    // DOORS baselined per module, then had to invent baseline SETS to fix the problem
    // that created. The fix is evidence of the mistake (CS-019).
    const db = open();
    const cols = db.prepare("SELECT * FROM baseline").all()[0];
    assert.ok("project_key" in cols);
    assert.ok(!("document_id" in cols), "a baseline must not be per-document");
  });

  test("a member pins a specific REVISION, not the live artifact", () => {
    const db = open();
    db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
    const row = db.prepare("SELECT revision_id FROM baseline_member").get();
    assert.equal(row.revision_id, "rev1");
  });

  test("an artifact cannot appear twice in one baseline", () => {
    const db = open();
    db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
    assert.throws(() => db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')"),
      /UNIQUE|constraint/i);
  });

  test("a baseline cannot pin a revision that does not exist", () => {
    const db = open();
    assert.throws(() => db.exec("INSERT INTO baseline_member VALUES ('b1','a1','nope')"),
      /FOREIGN KEY|constraint/i);
  });

  test("deleting an artifact that a baseline pins is REFUSED", () => {
    // A baseline is a historical record. Deleting out from under it would silently
    // rewrite history, which is the opposite of what a baseline is for.
    const db = open();
    db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
    assert.throws(() => db.exec("DELETE FROM artifact WHERE id='a1'"),
      /FOREIGN KEY|constraint/i);
  });
});

// --- Postgres --------------------------------------------------------------
//
// Isolated in its own schema: several other test files in this suite also create
// a real "artifact" table on this same database, and node's test runner runs test
// files in parallel by default — sharing the public schema's table name races the
// files against each other (field-promotion.test.mjs hit exactly this). A private
// schema avoids the race without depending on test-runner concurrency settings.

if (process.env.BLAZE_TEST_PG_URL) {
  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    await client.query("CREATE SCHEMA IF NOT EXISTS baseline_test");
    await client.query("SET search_path TO baseline_test");
    await client.query("DROP TABLE IF EXISTS baseline_member CASCADE");
    await client.query("DROP TABLE IF EXISTS baseline CASCADE");
    await client.query("DROP TABLE IF EXISTS artifact_revision CASCADE");
    await client.query("DROP TABLE IF EXISTS artifact CASCADE");
    await client.query(artifactDdl("postgres"));
    await client.query(revisionDdl("postgres"));
    await client.query(baselineDdl("postgres"));
    await client.query(
      `INSERT INTO artifact (id, project_key, kind, ref, title, statement, body, status, created_at, updated_at) VALUES ('a1','BLZ','requirement','REQ-001','T',NULL,NULL,'proposed',now(),now())`);
    await client.query(
      `INSERT INTO artifact_revision VALUES ('rev1','a1',now(),'me','{}')`);
    await client.query(
      `INSERT INTO baseline VALUES ('b1','BLZ','Release 1.0',now(),'me',NULL)`);
    return client;
  }

  describe("baselines (Postgres)", () => {
    test("a baseline is scoped to a PROJECT, not a document", async () => {
      const db = await openPg();
      try {
        const r = await db.query("SELECT * FROM baseline LIMIT 1");
        const cols = r.rows[0];
        assert.ok("project_key" in cols);
        assert.ok(!("document_id" in cols), "a baseline must not be per-document");
      } finally {
        await db.query("DROP SCHEMA IF EXISTS baseline_test CASCADE").catch(() => {});
        await db.end();
      }
    });

    test("a member pins a specific REVISION, not the live artifact", async () => {
      const db = await openPg();
      try {
        await db.query("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
        const r = await db.query("SELECT revision_id FROM baseline_member");
        assert.equal(r.rows[0].revision_id, "rev1");
      } finally {
        await db.query("DROP SCHEMA IF EXISTS baseline_test CASCADE").catch(() => {});
        await db.end();
      }
    });

    test("an artifact cannot appear twice in one baseline", async () => {
      const db = await openPg();
      try {
        await db.query("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
        await assert.rejects(
          () => db.query("INSERT INTO baseline_member VALUES ('b1','a1','rev1')"),
          /unique|constraint|duplicate/i);
      } finally {
        await db.query("DROP SCHEMA IF EXISTS baseline_test CASCADE").catch(() => {});
        await db.end();
      }
    });

    test("a baseline cannot pin a revision that does not exist", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          () => db.query("INSERT INTO baseline_member VALUES ('b1','a1','nope')"),
          /foreign key|constraint/i);
      } finally {
        await db.query("DROP SCHEMA IF EXISTS baseline_test CASCADE").catch(() => {});
        await db.end();
      }
    });

    test("deleting an artifact that a baseline pins is REFUSED", async () => {
      const db = await openPg();
      try {
        await db.query("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
        await assert.rejects(
          () => db.query("DELETE FROM artifact WHERE id='a1'"),
          /foreign key|constraint/i);
      } finally {
        await db.query("DROP SCHEMA IF EXISTS baseline_test CASCADE").catch(() => {});
        await db.end();
      }
    });
  });
}
