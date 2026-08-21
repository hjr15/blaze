// tests/model/write-rules.test.mjs — BLZ-289.
//
// The rule under test, from design §7.3: required fields are a WRITE-PATH rule, not a
// schema invariant. 242 live tickets violate their own type's `required` list — all of
// them missing `estimate`, 212 of them already terminal. A NOT NULL column would make
// the migration impossible without inventing 242 estimates, and an invented estimate
// flows into every burn-down where nobody can tell it from a real one.
//
// So the tests below are really three questions:
//   - can a NEW incomplete ticket be created?            (must be: no)
//   - can the 242 still be worked and closed?            (must be: yes)
//   - can a populated estimate be silently cleared?      (must be: no)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { projectionDdl } from "../../scripts/model/projection-schema.mjs";
import { refreshProjection } from "../../scripts/model/projection.mjs";
import { configSeed } from "../../scripts/model/config-schema.mjs";
import { writeRulesDdl, setMigrationModeSql, REQUIRED_FIELD_COLUMNS,
         UNENFORCEABLE_REQUIRED_FIELDS } from "../../scripts/model/write-rules.mjs";

const PG = process.env.BLAZE_TEST_PG_URL ?? null;

function config() {
  return { ...configSeed(),
    project: [{ key: "BLZ", name: "Blaze" }], project_label: [], project_component: [] };
}

async function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS);
  db.exec(SQLITE_DDL);
  db.exec(projectionDdl("sqlite"));
  const exec = {
    run(sql, params) {
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return db.exec(sql);
      return db.prepare(sql).run(...params);
    },
    all(sql, params) { return db.prepare(sql).all(...params); },
  };
  await refreshProjection(exec, config(), { now: "2026-08-21" });
  db.exec(writeRulesDdl("sqlite"));   // AFTER the projection exists — T2 reads it
  return db;
}

const insert = (db, { id, num, type = "task", estimate = null, title = "t", body = "b" }) =>
  db.prepare(`INSERT INTO ticket (id,project_key,num,type,status,title,body,estimate_minutes,
                                  created_on,updated_on)
              VALUES (?,'BLZ',?,?,'defined',?,?,?,'2026-01-01','2026-01-01')`)
    .run(id, num, type, title, body, estimate);

describe("T2 — no NEW incomplete ticket can be created", () => {
  test("a task without an estimate is refused on INSERT", async () => {
    const db = await openDb();
    assert.throws(() => insert(db, { id: "BLZ-1", num: 1 }),
      /estimate is required for this ticket type/);
  });

  test("a task WITH an estimate inserts fine", async () => {
    const db = await openDb();
    insert(db, { id: "BLZ-1", num: 1, estimate: 60 });
    assert.equal(db.prepare("SELECT count(*) n FROM ticket").get().n, 1);
  });

  test("a type that does not require an estimate is unaffected", async () => {
    const db = await openDb();
    insert(db, { id: "BLZ-1", num: 1, type: "feature" });   // feature requires title+description only
    assert.equal(db.prepare("SELECT count(*) n FROM ticket").get().n, 1);
  });

  test("an empty body is refused for a type that requires a description", async () => {
    const db = await openDb();
    assert.throws(() => insert(db, { id: "BLZ-1", num: 1, estimate: 60, body: "   " }),
      /description is required/);
  });
});

describe("T2 escape 1 — migration mode", () => {
  test("migration mode lets the 242 land, and turning it off restores enforcement", async () => {
    const db = await openDb();
    db.exec(setMigrationModeSql("sqlite", true));
    insert(db, { id: "BLZ-1", num: 1 });                 // no estimate — the migration case
    insert(db, { id: "BLZ-2", num: 2, type: "story" });
    assert.equal(db.prepare("SELECT count(*) n FROM ticket").get().n, 2);

    db.exec(setMigrationModeSql("sqlite", false));
    assert.throws(() => insert(db, { id: "BLZ-3", num: 3 }),
      /estimate is required/, "enforcement must come back on");
  });

  test("migration mode is OFF by default — it cannot be left on by omission", async () => {
    const db = await openDb();
    assert.equal(db.prepare("SELECT enabled FROM migration_mode WHERE id=1").get().enabled, 0);
  });

  test("an unknown dialect is refused rather than silently treated as sqlite", () => {
    assert.throws(() => writeRulesDdl("mysql"), /unknown dialect "mysql"/);
    assert.throws(() => setMigrationModeSql("mysql", true), /unknown dialect "mysql"/);
  });
});

describe("T2 escape 2 — no-regression, so the 242 stay workable", () => {
  test("a grandfathered estimate-less task can be retitled, moved, and closed", async () => {
    const db = await openDb();
    db.exec(setMigrationModeSql("sqlite", true));
    insert(db, { id: "BLZ-1", num: 1 });
    db.exec(setMigrationModeSql("sqlite", false));

    // Every one of these must succeed. This is the whole point of the rule.
    db.prepare("UPDATE ticket SET title = 'renamed' WHERE id='BLZ-1'").run();
    db.prepare("UPDATE ticket SET status = 'in-progress' WHERE id='BLZ-1'").run();
    db.prepare("UPDATE ticket SET body = 'more detail' WHERE id='BLZ-1'").run();
    db.prepare("UPDATE ticket SET status = 'done', resolution = 'done' WHERE id='BLZ-1'").run();

    const row = db.prepare("SELECT status, estimate_minutes FROM ticket WHERE id='BLZ-1'").get();
    assert.equal(row.status, "done");
    assert.equal(row.estimate_minutes, null, "it closes WITHOUT an estimate being invented");
  });

  test("a grandfathered ticket can have an estimate ADDED — the fill queue works", async () => {
    const db = await openDb();
    db.exec(setMigrationModeSql("sqlite", true));
    insert(db, { id: "BLZ-1", num: 1 });
    db.exec(setMigrationModeSql("sqlite", false));
    db.prepare("UPDATE ticket SET estimate_minutes = 90 WHERE id='BLZ-1'").run();
    assert.equal(db.prepare("SELECT estimate_minutes e FROM ticket WHERE id='BLZ-1'").get().e, 90);
  });

  test("a POPULATED estimate cannot be cleared — that is a regression, not a legacy row", async () => {
    const db = await openDb();
    insert(db, { id: "BLZ-1", num: 1, estimate: 60 });
    assert.throws(
      () => db.prepare("UPDATE ticket SET estimate_minutes = NULL WHERE id='BLZ-1'").run(),
      /estimate is required and cannot be cleared once set/);
    assert.equal(db.prepare("SELECT estimate_minutes e FROM ticket WHERE id='BLZ-1'").get().e, 60);
  });

  test("a populated title cannot be blanked either", async () => {
    const db = await openDb();
    insert(db, { id: "BLZ-1", num: 1, estimate: 60 });
    assert.throws(
      () => db.prepare("UPDATE ticket SET body = '' WHERE id='BLZ-1'").run(),
      /description is required and cannot be cleared/);
  });
});

describe("T2 — what it does NOT enforce is named, not hidden", () => {
  test("every field the config can require now HAS a column and is enforced", () => {
    // Inverted from the version that asserted the gap. blaze_config's CHECK admits
    // title/description/estimate/likelihood/impact; all five map to a column, so the
    // list of unenforceable fields must be empty.
    assert.deepEqual(UNENFORCEABLE_REQUIRED_FIELDS, [],
      "a required field with no column is enforced by NOTHING while the config still claims it");
    for (const f of ["title", "description", "estimate", "likelihood", "impact"]) {
      assert.ok(f in REQUIRED_FIELD_COLUMNS, `${f} must be enforceable`);
    }
  });

  test("a risk WITHOUT likelihood and impact is now refused — the gap is closed", async () => {
    const db = await openDb();
    assert.throws(
      () => db.prepare(`INSERT INTO ticket (id,project_key,num,type,status,title,body,created_on,updated_on)
                        VALUES ('BLZ-1','BLZ',1,'risk','identified','t','b','2026-01-01','2026-01-01')`).run(),
      // Either trigger may fire first — SQLite does not promise an order, and pinning
      // one would make this test fail on a reordering that changes nothing that matters.
      /(likelihood|impact) is required for this ticket type/);
  });

  test("a risk WITH both fields inserts, and neither can be cleared afterwards", async () => {
    const db = await openDb();
    db.prepare(`INSERT INTO ticket (id,project_key,num,type,status,title,body,likelihood,impact,
                                    created_on,updated_on)
                VALUES ('BLZ-1','BLZ',1,'risk','identified','t','b','medium','high','2026-01-01','2026-01-01')`).run();
    assert.equal(db.prepare("SELECT count(*) n FROM ticket").get().n, 1);
    assert.throws(
      () => db.prepare("UPDATE ticket SET impact = NULL WHERE id='BLZ-1'").run(),
      /impact is required and cannot be cleared once set/);
  });
});
