// tests/model/ref-claim.test.mjs — claimRef, the allocation path (BLZ-326).
//
// The defect, verified: existing artifacts REQ-001..003, withdraw REQ-003,
// nextRef({kind, existing: liveArtifactRefs}) hands REQ-003 straight back out. A ref
// is a citation — reusing one silently redirects every existing citation, and there is
// no recovery because renumbering is itself reuse. These tests pin the fix: the
// allocator reads the ref_claim LEDGER, never the live artifact table.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { artifactDdl } from "../../scripts/model/artifact-schema.mjs";
import { refClaimDdl } from "../../scripts/model/ref-claim-schema.mjs";
import { claimRef } from "../../scripts/model/ref-claim.mjs";

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
  db.exec(refClaimDdl("sqlite"));
  return db;
}

const insArtifact = (db, o) => db.prepare(
  `INSERT INTO artifact (id, project_key, kind, ref, title, statement, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?)`).run(
  o.id, o.project_key ?? "BLZ", o.kind ?? "requirement", o.ref, o.title ?? "T",
  null, o.status ?? "proposed", "2026-01-01", "2026-01-01");

describe("claimRef (SQLite)", () => {
  test("REGRESSION: withdrawing (deleting) an artifact does not free its ref", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    const r1 = await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    const r2 = await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    const r3 = await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    assert.deepEqual([r1, r2, r3], ["REQ-001", "REQ-002", "REQ-003"]);

    insArtifact(db, { id: "a1", ref: r1 });
    insArtifact(db, { id: "a2", ref: r2 });
    insArtifact(db, { id: "a3", ref: r3 });

    // Withdraw REQ-003: the artifact is gone from the live table entirely.
    db.exec("DELETE FROM artifact WHERE ref = 'REQ-003'");
    assert.equal(db.prepare("SELECT count(*) n FROM artifact").get().n, 2);

    // The bug: nextRef fed from live artifacts sees only REQ-001/002 and hands
    // REQ-003 straight back out. The fix: claimRef reads the ledger, which still has
    // all three, so the next ref must be REQ-004.
    const r4 = await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    assert.equal(r4, "REQ-004");
  });

  test("a claim is refused if its ref already exists in that project (PK collision)", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    await claimRef(exec, { project_key: "BLZ", kind: "requirement" });   // REQ-001
    assert.throws(
      () => db.prepare(
        `INSERT INTO ref_claim (project_key, kind, num, ref, claimed_at)
         VALUES ('BLZ','requirement',1,'REQ-001','2026-01-01')`).run(),
      /UNIQUE|constraint/i);
  });

  test("two projects allocate independently", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    // BLZ is up to REQ-002; a brand-new project must NOT be blocked by it.
    const first = await claimRef(exec, { project_key: "OBA", kind: "requirement" });
    assert.equal(first, "REQ-001");
    const blzThird = await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    assert.equal(blzThird, "REQ-003");
  });

  test("gaps survive: claims at 1, 2 and 7 exist → next is 8", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    for (const num of [1, 2, 7]) {
      db.prepare(
        `INSERT INTO ref_claim (project_key, kind, num, ref, claimed_at)
         VALUES ('BLZ','requirement',?,?,'2026-01-01')`)
        .run(num, `REQ-${String(num).padStart(3, "0")}`);
    }
    const next = await claimRef(exec, { project_key: "BLZ", kind: "requirement" });
    assert.equal(next, "REQ-008");
  });

  test("CONCURRENCY: two claimRef calls racing on the same project+kind never return the same ref", async () => {
    // Honest, not mocked: one real database connection, the real PRIMARY KEY, and the
    // real retry loop in claimRef. Promise.all starts BOTH calls before either awaits,
    // so both read the ledger's empty state before either has inserted — the second
    // one's INSERT must collide on the PK and retry against a freshly re-read ledger.
    const db = openSqlite();
    const exec = sqliteExec(db);
    const [a, b] = await Promise.all([
      claimRef(exec, { project_key: "BLZ", kind: "requirement" }),
      claimRef(exec, { project_key: "BLZ", kind: "requirement" }),
    ]);
    assert.notEqual(a, b, `both racing calls returned ${a} — a ref was double-issued`);
    assert.deepEqual([a, b].sort(), ["REQ-001", "REQ-002"]);
    // No dropped or duplicated row: exactly two claims landed.
    assert.equal(db.prepare("SELECT count(*) n FROM ref_claim").get().n, 2);
  });

  test("an unknown kind is refused before any query runs", async () => {
    const db = openSqlite();
    const exec = sqliteExec(db);
    await assert.rejects(
      () => claimRef(exec, { project_key: "BLZ", kind: "epic" }),
      /no ref scheme/);
  });
});

// --- Postgres ------------------------------------------------------------------------
//
// Its own schema: node's test runner runs test files in parallel, and another file on
// this branch already raced by creating tables in the shared `public` schema.
if (process.env.BLAZE_TEST_PG_URL) {
  const SCHEMA = "ref_claim_alloc_test";

  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await client.query("DROP TABLE IF EXISTS ref_claim CASCADE");
    await client.query("DROP TABLE IF EXISTS artifact CASCADE");
    await client.query(artifactDdl("postgres"));
    await client.query(refClaimDdl("postgres"));
    return client;
  }
  function pgExec(client) {
    return {
      run: (sql, params = []) => client.query(sql, params.length ? params : undefined),
      all: async (sql, params = []) => (await client.query(sql, params.length ? params : undefined)).rows,
    };
  }
  const insArtifactPg = (db, o) => db.query(
    `INSERT INTO artifact (id, project_key, kind, ref, title, statement, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())`,
    [o.id, o.project_key ?? "BLZ", o.kind ?? "requirement", o.ref, o.title ?? "T", null, o.status ?? "proposed"]);

  describe("claimRef (Postgres)", () => {
    test("REGRESSION: withdrawing (deleting) an artifact does not free its ref", async () => {
      const db = await openPg();
      const exec = pgExec(db);
      try {
        const r1 = await claimRef(exec, { dialect: "postgres", project_key: "BLZ", kind: "requirement" });
        const r2 = await claimRef(exec, { dialect: "postgres", project_key: "BLZ", kind: "requirement" });
        const r3 = await claimRef(exec, { dialect: "postgres", project_key: "BLZ", kind: "requirement" });
        assert.deepEqual([r1, r2, r3], ["REQ-001", "REQ-002", "REQ-003"]);

        await insArtifactPg(db, { id: "a1", ref: r1 });
        await insArtifactPg(db, { id: "a2", ref: r2 });
        await insArtifactPg(db, { id: "a3", ref: r3 });
        await db.query("DELETE FROM artifact WHERE ref = 'REQ-003'");

        const r4 = await claimRef(exec, { dialect: "postgres", project_key: "BLZ", kind: "requirement" });
        assert.equal(r4, "REQ-004");
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("two projects allocate independently", async () => {
      const db = await openPg();
      const exec = pgExec(db);
      try {
        await claimRef(exec, { dialect: "postgres", project_key: "BLZ", kind: "requirement" });
        await claimRef(exec, { dialect: "postgres", project_key: "BLZ", kind: "requirement" });
        const first = await claimRef(exec, { dialect: "postgres", project_key: "OBA", kind: "requirement" });
        assert.equal(first, "REQ-001");
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("gaps survive: claims at 1, 2 and 7 exist → next is 8", async () => {
      const db = await openPg();
      try {
        for (const num of [1, 2, 7]) {
          await db.query(
            `INSERT INTO ref_claim (project_key, kind, num, ref, claimed_at)
             VALUES ('BLZ','requirement',$1,$2, now())`,
            [num, `REQ-${String(num).padStart(3, "0")}`]);
        }
        const next = await claimRef(pgExec(db), { dialect: "postgres", project_key: "BLZ", kind: "requirement" });
        assert.equal(next, "REQ-008");
      } finally {
        await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await db.end();
      }
    });

    test("CONCURRENCY: two REAL connections racing on the same project+kind never return the same ref", async () => {
      // The strongest form of this test: two independent pg.Client connections, real
      // network round-trips, separate server-side backends — not merely two logical
      // callers sharing one connection. If a naive read-max-then-insert allocator were
      // used instead of claimRef's PK-collision-and-retry loop, this is exactly the
      // scenario that yields a duplicate ref.
      const dbA = await openPg();
      const dbB = new pg.Client(process.env.BLAZE_TEST_PG_URL);
      await dbB.connect();
      await dbB.query(`SET search_path TO ${SCHEMA}`);
      try {
        const [a, b] = await Promise.all([
          claimRef(pgExec(dbA), { dialect: "postgres", project_key: "BLZ", kind: "requirement" }),
          claimRef(pgExec(dbB), { dialect: "postgres", project_key: "BLZ", kind: "requirement" }),
        ]);
        assert.notEqual(a, b, `both racing connections returned ${a} — a ref was double-issued`);
        assert.deepEqual([a, b].sort(), ["REQ-001", "REQ-002"]);
        const r = await dbA.query("SELECT count(*) AS n FROM ref_claim");
        assert.equal(Number(r.rows[0].n), 2);
      } finally {
        await dbB.end();
        await dbA.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await dbA.end();
      }
    });
  });
}
