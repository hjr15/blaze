// tests/model/scheduling-columns.test.mjs — ADR-0022's five ticket columns (BLZ-372).
//
// Two inputs the operator writes (constraint_start_no_earlier_than, deadline) and three the
// scheduler writes (float_minutes, is_critical, schedule_run_id). start_date and due_date
// keep their names deliberately: what changes is who may write them, not what they are called.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { SQLITE_DDL } from "../../scripts/model/sqlite-schema.mjs";
import { PG_DDL } from "../../scripts/model/pg-schema.mjs";

const NEW = ["constraint_start_no_earlier_than", "deadline", "float_minutes", "is_critical", "schedule_run_id"];

describe("scheduling columns (SQLite)", () => {
  const open = () => { const db = new DatabaseSync(":memory:"); db.exec(SQLITE_DDL); return db; };
  // project_key, num, type, status, title, created_on and updated_on are all NOT NULL with
  // no default; a partial insert fails on `ticket.num` rather than on anything under test.
  const insTicket = (db) => db.prepare(
    `INSERT INTO ticket (id, project_key, num, type, status, title, created_on, updated_on)
     VALUES ('BLZ-1','BLZ',1,'task','defined','t','2026-08-24','2026-08-24')`).run();

  test("all five columns exist on ticket", () => {
    const cols = open().prepare("SELECT name FROM pragma_table_info('ticket')").all().map((r) => r.name);
    for (const c of NEW) assert.ok(cols.includes(c), `missing column ${c}`);
  });

  test("start_date and due_date are NOT renamed — every existing reader keeps working", () => {
    const cols = open().prepare("SELECT name FROM pragma_table_info('ticket')").all().map((r) => r.name);
    assert.ok(cols.includes("start_date") && cols.includes("due_date"));
  });

  test("none of the five is a generated column — ADR-0018 measured STORED at 2,002 ms on PG and it is impossible here", () => {
    const rows = open().prepare("SELECT name, hidden FROM pragma_table_xinfo('ticket')").all();
    // hidden: 0 normal, 1 hidden, 2 VIRTUAL generated, 3 STORED generated
    for (const c of NEW) {
      const r = rows.find((x) => x.name === c);
      assert.equal(r.hidden, 0, `${c} must be a plain column, got hidden=${r.hidden}`);
    }
  });

  // BLZ-360 §6.4 and §10 both say "STRICT stays on every SQLite table that holds them" /
  // "STRICT retained". Measured: ZERO of the seven tables in SQLITE_DDL is STRICT — the only
  // occurrence of the word in that file is `ON DELETE RESTRICT`. The claim describes the v4
  // schema modules (link, hierarchy, view all take ` STRICT` from sql-dialect's `tbl`), not
  // the v3 core. This test pins the ACTUAL state so the discrepancy cannot be discovered
  // twice. BLZ-376 carried the spec correction and is closed; whether the v3 tables should
  // MOVE to STRICT is BLZ-390, which measured the blocker — 0 of 21,372 live rows violate,
  // and `projection_meta.config_version` is declared `bigint`, not a STRICT-legal type.
  test("the v3 ticket table is NOT STRICT — pinned so the spec's claim is not mistaken for fact", () => {
    const db = open();
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='ticket'").get().sql;
    assert.doesNotMatch(sql, /\)\s*STRICT\s*$/i,
      "if ticket becomes STRICT, BLZ-360 §6.4's claim becomes true and this test should be inverted");
  });

  test("is_critical is 0/1 and defaults to 0", () => {
    const db = open();
    insTicket(db);
    assert.equal(db.prepare("SELECT is_critical c FROM ticket WHERE id='BLZ-1'").get().c, 0);
    assert.throws(() => db.prepare("UPDATE ticket SET is_critical = 2 WHERE id='BLZ-1'").run(), /CHECK/);
  });

  test("is_critical and deadline are indexed — that is what makes them filterable", () => {
    const idx = open().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ticket'").all().map((r) => r.name);
    assert.ok(idx.includes("ticket_critical_idx"), "is_critical must be indexed");
    assert.ok(idx.includes("ticket_deadline_idx"), "deadline must be indexed");
  });

  test("the derived columns accept what the scheduler writes", () => {
    const db = open();
    insTicket(db);
    db.prepare(`UPDATE ticket SET constraint_start_no_earlier_than='2026-09-01', deadline='2026-10-20',
                float_minutes=0, is_critical=1, schedule_run_id='run-1' WHERE id='BLZ-1'`).run();
    const r = db.prepare("SELECT * FROM ticket WHERE id='BLZ-1'").get();
    assert.equal(r.deadline, "2026-10-20");
    assert.equal(r.float_minutes, 0);
    assert.equal(r.is_critical, 1);
    assert.equal(r.schedule_run_id, "run-1");
  });
});

if (process.env.BLAZE_TEST_PG_URL) {
  describe("scheduling columns (Postgres)", () => {
    // A PRIVATE schema, not `public`. `node --test` runs files CONCURRENTLY against one
    // Postgres, so an earlier version of this helper that did `DROP SCHEMA public CASCADE`
    // deleted other suites' tables mid-run and hung the whole suite. Isolate, never truncate
    // shared ground.
    const SCHEMA = "blz372_scheduling_cols";
    async function open() {
      const db = new pg.Client(process.env.BLAZE_TEST_PG_URL);
      await db.connect();
      await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await db.query(`CREATE SCHEMA ${SCHEMA}`);
      await db.query(`SET search_path TO ${SCHEMA}`);
      await db.query(PG_DDL);
      return db;
    }
    async function close(db) {
      try { await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`); } finally { await db.end(); }
    }

    test("all five columns exist, and the two dates are `date` not text", async () => {
      const db = await open();
      try {
        const r = await db.query(
          `SELECT column_name, data_type, is_generated FROM information_schema.columns
           WHERE table_schema=$2 AND table_name='ticket' AND column_name = ANY($1)`, [NEW, SCHEMA]);
        const by = Object.fromEntries(r.rows.map((x) => [x.column_name, x]));
        for (const c of NEW) assert.ok(by[c], `missing column ${c}`);
        assert.equal(by.constraint_start_no_earlier_than.data_type, "date");
        assert.equal(by.deadline.data_type, "date");
        assert.equal(by.is_critical.data_type, "boolean");
        // NEVER a generated column — the whole reason ADR-0018 rejected STORED.
        for (const c of NEW) assert.equal(by[c].is_generated, "NEVER", `${c} must not be generated`);
      } finally { await close(db); }
    });

    test("is_critical and deadline are indexed", async () => {
      const db = await open();
      try {
        const r = await db.query(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='ticket'`, [SCHEMA]);
        const names = r.rows.map((x) => x.indexname);
        assert.ok(names.includes("ticket_critical_idx"));
        assert.ok(names.includes("ticket_deadline_idx"));
      } finally { await close(db); }
    });
  });
}
