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
         DB_SCHEMA_VERSION } from "../../scripts/model/db-schema-version.mjs";

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
    assert.match(r.error, /blaze db migrate/);
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
