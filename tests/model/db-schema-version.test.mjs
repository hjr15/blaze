// tests/model/db-schema-version.test.mjs — BLZ-297.
//
// The defect: `openSqliteRead` exec'd the DDL on every open, and every statement is
// `CREATE TABLE IF NOT EXISTS`. Against a database written by an EARLIER engine the
// creates are skipped, the missing columns are never added, and nothing says so —
// reproduced before the fix as:
//
//     open() SUCCEEDED against the old schema
//     ref column present after open? false
//     getTicket: returned a ticket
//
// Blaze's CONFIG schema has been guarded since ADR-0002. Its DATABASE schema was not
// guarded at all. These tests are that asymmetry, closed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";
import { judgeDbSchema, readSchemaFactsSync, createDbSchemaSync, metaDdl,
         DB_SCHEMA_VERSION, MIN_DB_SCHEMA_VERSION } from "../../scripts/model/db-schema-version.mjs";

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "blaze-ver-")), "b.db");

/** A database as an OLDER engine would have left it: real schema, no stamp. */
function staleDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SQLITE_PRAGMAS);
  db.exec(SQLITE_DDL.replace(
    /  branch       TEXT,[\s\S]*?  extra_json   TEXT NOT NULL DEFAULT '\{\}',\n/, ""));
  db.prepare(`INSERT INTO ticket (id,project_key,num,type,status,title,body,created_on,updated_on)
              VALUES ('BLZ-1','BLZ',1,'task','defined','t','','2026-01-01','2026-01-01')`).run();
  db.close();
  return path;
}

describe("judgeDbSchema — the policy, with no database in sight", () => {
  test("nothing at all is 'empty', and safe to create", () => {
    assert.deepEqual(judgeDbSchema({ hasTicket: false, hasMeta: false }),
      { ok: true, error: null, state: "empty", version: null });
  });

  test("tables with NO stamp are refused rather than guessed at", () => {
    const r = judgeDbSchema({ hasTicket: true, hasMeta: false });
    assert.equal(r.ok, false);
    assert.equal(r.state, "unstamped");
    assert.match(r.error, /no Blaze schema stamp/);
    assert.match(r.error, /Refusing to use it rather than guessing/);
  });

  test("a stamp this engine cannot read yet says UPGRADE, not migrate", () => {
    const r = judgeDbSchema({ hasTicket: true, hasMeta: true, version: 99 });
    assert.equal(r.state, "newer");
    assert.match(r.error, /upgrade the engine/);
  });

  test("a stamp below the floor says MIGRATE, not upgrade", () => {
    // Injectable bounds, so the branch stays testable while MIN === CURRENT === 1 —
    // the same reason schema-version.mjs makes its bounds injectable.
    const r = judgeDbSchema({ hasTicket: true, hasMeta: true, version: 1, min: 2, current: 3 });
    assert.equal(r.state, "older");
    // BLZ-374 replaced 'blaze db migrate' — a command that has never existed — with the one
    // that does. This assertion was the pre-existing half and was missed when the message
    // and its sibling test were updated together.
    assert.match(r.error, /blaze db init --force/);
  });

  test("a garbage stamp is treated as unstamped, not as version NaN", () => {
    for (const version of [null, undefined, 0, -1, 1.5, "x"]) {
      assert.equal(judgeDbSchema({ hasTicket: true, hasMeta: true, version }).state,
        "unstamped", `version ${JSON.stringify(version)}`);
    }
  });

  test("meta present but ticket absent is still not empty", () => {
    // A half-created database must not look like a fresh one, or `create` would run
    // DDL over it and CREATE TABLE IF NOT EXISTS would call that success.
    assert.notEqual(judgeDbSchema({ hasTicket: false, hasMeta: true, version: 1 }).state, "empty");
  });
});

describe("opening a database that this engine cannot read", () => {
  test("THE DEFECT: a stale database is refused, where it used to open silently", () => {
    const path = staleDb(tmpDb());
    assert.throws(() => openSqliteRead(path), /no Blaze schema stamp/);
  });

  test("...and `create: true` does NOT override it", () => {
    // Creating over an existing schema is exactly how a half-migrated database is
    // produced, and IF NOT EXISTS makes that look like success.
    const path = staleDb(tmpDb());
    assert.throws(() => openSqliteRead(path, { create: true }), /no Blaze schema stamp/);
  });

  test("an empty database is refused unless creation is asked for", () => {
    assert.throws(() => openSqliteRead(tmpDb()), /Create one explicitly/);
  });

  test("create: true stamps the version, and reopening then works", () => {
    const path = tmpDb();
    const a = openSqliteRead(path, { create: true });
    assert.equal(a.db.prepare("SELECT value FROM blaze_meta WHERE key='schema_version'").get().value,
      String(DB_SCHEMA_VERSION));
    a.close?.();
    const b = openSqliteRead(path);          // no create — must be accepted on its stamp
    assert.equal(b.name, "sqlite");
    b.close?.();
  });

  test("a newer stamp refuses on reopen", () => {
    const path = tmpDb();
    const a = openSqliteRead(path, { create: true });
    a.db.prepare("UPDATE blaze_meta SET value = '99' WHERE key='schema_version'").run();
    a.close?.();
    assert.throws(() => openSqliteRead(path), /newer than this engine supports/);
  });
});

describe("createDbSchemaSync", () => {
  const execFor = (db) => ({
    run(sql, params = []) { return params.length ? db.prepare(sql).run(...params) : db.exec(sql); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
  });

  test("creates and stamps an empty database", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SQLITE_PRAGMAS);
    const r = createDbSchemaSync(execFor(db));
    assert.equal(r.version, DB_SCHEMA_VERSION);
    assert.equal(readSchemaFactsSync(execFor(db)).version, DB_SCHEMA_VERSION);
  });

  test("refuses a database that already holds a Blaze schema", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SQLITE_PRAGMAS);
    createDbSchemaSync(execFor(db));
    assert.throws(() => createDbSchemaSync(execFor(db)), /already holds a Blaze schema/);
  });

  test("an unknown dialect is refused by metaDdl", () => {
    assert.throws(() => metaDdl("mysql"), /unknown dialect "mysql"/);
  });
});

// --- ADR-0022: DB schema version 2 (BLZ-374) ---------------------------------
// Version 2 is the installation event the scheduler cannot be built without: Precedes lives
// in the v4 `link` table and version 1 installs no v4 table at all.
describe("DB schema version 2", () => {
  // Same minimal exec the file's other create tests use.
  const execFor = (db) => ({
    run(sql, params = []) { return params.length ? db.prepare(sql).run(...params) : db.exec(sql); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
  });
  const fresh = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SQLITE_PRAGMAS);
    createDbSchemaSync(execFor(db));
    return db;
  };
  const tables = (db) =>
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);

  test("the stamp is 3", () => {
    // 2 -> 3 under BLZ-390, when the seven v3 tables gained STRICT.
    assert.equal(DB_SCHEMA_VERSION, 3);
    const v = fresh().prepare("SELECT value FROM blaze_meta WHERE key='schema_version'").get().value;
    assert.equal(v, "3");
  });

  test("a fresh create installs the v4 link tables — this is what Precedes needs", () => {
    const t = tables(fresh());
    assert.ok(t.includes("link_type"), "link_type must ship in version 2");
    assert.ok(t.includes("link"), "link must ship in version 2");
  });

  test("a fresh create installs the hierarchy tables — hierarchy-rollup reads hierarchy_membership", () => {
    const t = tables(fresh());
    assert.ok(t.includes("hierarchy"));
    assert.ok(t.includes("hierarchy_membership"));
  });

  // BLZ-360 §6.4 lists viewDdl among version 2's installs and BLZ-354 §6.2 says it "ships in
  // version 2". Measured while implementing: it CANNOT, because `view` lives in the
  // `blaze_config` namespace (BLZ-371 — its FKs cannot cross a SQLite database file) and
  // **nothing in scripts/ ever installs `blaze_config`**. `configDdl` is exported and called
  // only from its own test. So the cost of adding `view` here is not "one DDL", as spec 1
  // reasoned, but a whole namespace with no install path. Deferred to BLZ-377, which installs
  // blaze_config and viewDdl together. Nothing in the scheduler reads `view`.
  test("view is deliberately NOT in version 2 — it needs a blaze_config nothing installs", () => {
    const db = fresh();
    // `view` can only ever exist in the ATTACHed blaze_config namespace, so reading
    // sqlite_master (which is `main`) could never see it — an earlier version of this test
    // promised to invert when BLZ-377 lands and would have stayed green instead. Ask every
    // attached database, and assert blaze_config is not attached at all, which is the
    // actual precondition BLZ-377 changes.
    const dbs = db.prepare("PRAGMA database_list").all().map((r) => r.name);
    assert.deepEqual(dbs, ["main"],
      "if blaze_config is attached here, BLZ-377 landed and this test should invert");
    assert.ok(!tables(db).includes("view"));
    assert.ok(!tables(db).includes("view_type"));
  });

  test("the five scheduling columns are on ticket after a fresh create", () => {
    const cols = fresh().prepare("SELECT name FROM pragma_table_info('ticket')").all().map((r) => r.name);
    for (const c of ["constraint_start_no_earlier_than", "deadline", "float_minutes", "is_critical", "schedule_run_id"]) {
      assert.ok(cols.includes(c), `missing ${c}`);
    }
  });

  // A version-1 database has no link table and none of the five columns, so a version-2
  // engine that accepted it would fail later with a raw SQL error — the exact failure this
  // module exists to replace with a named refusal. The floor therefore rises with the
  // version. That is safe because the shadow database is DERIVED: it lives under .blaze/,
  // `blaze db init` rebuilds it from the filesystem corpus, and the fs write port is the
  // default, so a stranded v1 shadow is deleted and recreated rather than migrated.
  test("the floor rises to 3 — an older database is refused, not half-opened", () => {
    // 2 -> 3 under BLZ-390. A v2 shadow's tables are NOT STRICT, so accepting one would silently
    // drop the guarantee the version exists to add.
    assert.equal(MIN_DB_SCHEMA_VERSION, 3);
    assert.equal(judgeDbSchema({ hasTicket: true, hasMeta: true, version: 2 }).ok, false,
      "a v2 shadow must be refused too, not just v1");
    const st = judgeDbSchema({ hasTicket: true, hasMeta: true, version: 1 });
    assert.equal(st.ok, false);
    assert.equal(st.state, "older");
    // Names the command that EXISTS. `blaze db migrate` does not — db-runner declares only
    // init and status — and this branch was unreachable while MIN was 1, so nothing caught it.
    assert.match(st.error, /blaze db init --force/);
    assert.doesNotMatch(st.error, /blaze db migrate/);
  });

  test("a version-1 ENGINE opening this database still gets the upgrade refusal", () => {
    // current/min are properties of the SINGLE argument, not a second one — passing them
    // separately is silently ignored and the assertion then tests the defaults.
    const st = judgeDbSchema({ hasTicket: true, hasMeta: true, version: 2, current: 1, min: 1 });
    assert.equal(st.ok, false);
    assert.equal(st.state, "newer");
    assert.match(st.error, /upgrade/i);
  });
});
