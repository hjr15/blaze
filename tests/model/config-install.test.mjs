// tests/model/config-install.test.mjs — BLZ-377.
//
// `blaze_config` was a namespace nothing created. `configDdl` was exported and called only
// from its own test; `sqliteAttachConfig` had no caller outside tests, and the one test call
// always passed `:memory:`, so the on-disk case — the only case a real installation has —
// was never exercised at all. `view` could not exist until that changed, because BLZ-371
// established that its FKs to `project` and `view_type` cannot cross a SQLite database file.
//
// These tests cover the install path end to end, and deliberately do it on a REAL FILE
// rather than `:memory:`, because the second database file is the part that had no coverage.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { createDbSchemaSync, DB_SCHEMA_VERSION, MIN_DB_SCHEMA_VERSION }
  from "../../scripts/model/db-schema-version.mjs";
import { sqliteAttachConfig, configDbPathFor } from "../../scripts/model/config-schema.mjs";
import { VIEW_TYPES } from "../../scripts/model/view-schema.mjs";
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";

const execFor = (db) => ({
  run(sql, params = []) { return params.length ? db.prepare(sql).run(...params) : db.exec(sql); },
  all(sql, params = []) { return db.prepare(sql).all(...params); },
});

/** A database with the config namespace attached, the way an opener leaves it. */
function attached(configPath = ":memory:") {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS);
  db.exec(sqliteAttachConfig(configPath));
  return db;
}

const cfgTables = (db) => db
  .prepare("SELECT name FROM blaze_config.sqlite_master WHERE type='table' ORDER BY name")
  .all().map((r) => r.name);

describe("BLZ-377: the config namespace has a production install path", () => {
  test("the version is 4, and the floor rises with it", () => {
    // 3 was taken by BLZ-390 (STRICT on the seven SQLITE_DDL tables). Adding tables to an
    // already-shipped version retroactively is the silent schema change the stamp exists to
    // prevent, so this is 4 — the precedent versions 2 and 3 both set.
    assert.equal(DB_SCHEMA_VERSION, 4);
    assert.equal(MIN_DB_SCHEMA_VERSION, 4);
  });

  test("a fresh create installs the blaze_config tables", () => {
    const db = attached();
    createDbSchemaSync(execFor(db));
    const t = cfgTables(db);
    for (const name of ["board", "config_version", "project", "priority", "resolution",
                        "link_type", "workflow", "workflow_status", "ticket_type"]) {
      assert.ok(t.includes(name), `blaze_config.${name} was not created — got: ${t.join(", ")}`);
    }
  });

  test("a fresh create installs view and view_type beside their FK targets", () => {
    const t = cfgTables(attached2());
    assert.ok(t.includes("view"), `view missing — got: ${t.join(", ")}`);
    assert.ok(t.includes("view_type"), `view_type missing — got: ${t.join(", ")}`);
  });

  test("view_type is seeded from VIEW_TYPES, the code registry", () => {
    const db = attached2();
    const rows = db.prepare("SELECT name, label FROM blaze_config.view_type ORDER BY name").all();
    assert.equal(rows.length, VIEW_TYPES.length,
      `expected ${VIEW_TYPES.length} view types, got ${rows.length}`);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.label]));
    for (const { name, label } of VIEW_TYPES) {
      assert.equal(byName[name], label, `view_type ${name} should be labelled ${label}`);
    }
  });

  test("the config seed is applied, not just the DDL", () => {
    const db = attached2();
    const n = (t) => db.prepare(`SELECT count(*) AS c FROM blaze_config.${t}`).get().c;
    for (const t of ["priority", "resolution", "link_type", "workflow", "workflow_status", "ticket_type"]) {
      assert.ok(n(t) > 0, `blaze_config.${t} is empty — the seed did not run`);
    }
  });

  test("the seed completes SYNCHRONOUSLY, before createDbSchemaSync returns", () => {
    // seedConfigInTransaction is async: with node:sqlite's synchronous driver every await
    // defers to a microtask, so a create that used it would return with the tables empty and
    // fill them one tick later. Reading immediately, with no await anywhere, is what
    // distinguishes the sync twin from the async one — this test fails against the async one.
    const db = attached();
    createDbSchemaSync(execFor(db));
    const c = db.prepare("SELECT count(*) AS c FROM blaze_config.priority").get().c;
    assert.ok(c > 0, "priority was empty on the very next statement — the seed was deferred");
  });

  test("creating without the namespace attached is a NAMED refusal, not a raw SQL error", () => {
    // Silently attaching :memory: here would put a real installation's config in memory,
    // where it would vanish on close. Refusing is the house rule.
    const db = new DatabaseSync(":memory:");
    db.exec(SQLITE_PRAGMAS);
    assert.throws(() => createDbSchemaSync(execFor(db)), /blaze_config.*not attached|not attached.*blaze_config/i);
  });
});

describe("BLZ-377: the config namespace on a real file, which nothing exercised", () => {
  test("configDbPathFor puts config.db beside the database it belongs to", () => {
    assert.equal(configDbPathFor("/x/.blaze/blaze.db"), join("/x/.blaze", "config.db"));
    assert.equal(configDbPathFor(":memory:"), ":memory:",
      "an in-memory database must not be given an on-disk config file");
  });

  test("openSqliteRead with create writes a real config.db and view is usable through it", () => {
    const dir = mkdtempSync(join(tmpdir(), "blz377-"));
    try {
      const main = join(dir, "blaze.db");
      const store = openSqliteRead(main, { create: true });
      assert.ok(existsSync(join(dir, "config.db")),
        "no config.db was created beside blaze.db — the namespace is still in memory");
      const names = store.db
        .prepare("SELECT name FROM blaze_config.sqlite_master WHERE type='table'")
        .all().map((r) => r.name);
      assert.ok(names.includes("view"), `view not present in the attached file — got: ${names.join(", ")}`);
      assert.equal(
        store.db.prepare("SELECT count(*) AS c FROM blaze_config.view_type").get().c,
        VIEW_TYPES.length, "view_type was not seeded in the on-disk namespace");
      store.close?.();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the view FKs enforce across the two files — the whole reason view lives here", () => {
    const dir = mkdtempSync(join(tmpdir(), "blz377-"));
    try {
      const store = openSqliteRead(join(dir, "blaze.db"), { create: true });
      const ins = (id, scope, pk, type, slug) => store.db.prepare(
        "INSERT INTO blaze_config.view (id,scope,project_key,type,name,slug,created_at,updated_at)"
        + " VALUES (?,?,?,?,?,?,'t','t')").run(id, scope, pk, type, slug, slug);
      // A valid row first, so the refusals below cannot be vacuous.
      ins("v1", "installation", null, "board", "a");
      assert.throws(() => ins("v2", "installation", null, "nope", "b"), /FOREIGN KEY/,
        "view.type accepted a type with no view_type row");
      assert.throws(() => ins("v3", "project", "NOPE", "board", "c"), /FOREIGN KEY/,
        "view.project_key accepted a project that does not exist — the FK is not crossing correctly");
      assert.throws(() => ins("v4", "installation", null, "board", "a"), /UNIQUE/,
        "two installation views shared a slug — the partial unique index is not doing its job");
      store.close?.();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const PG = process.env.BLAZE_TEST_PG_URL;

describe("BLZ-377: Postgres installs the same namespace through the same create",
  { skip: PG ? false : "set BLAZE_TEST_PG_URL" }, () => {
  test("createDbSchema installs blaze_config, view and a seeded view_type", async () => {
    const pg = (await import("pg")).default;
    // A DEDICATED DATABASE, not a schema. `configDdl("postgres")` hardcodes the schema name
    // `blaze_config`, so two tests that both build it cannot be isolated by search_path the
    // way this suite isolates its other Postgres tests — and `npm test` runs files
    // concurrently against one server. Dropping the public tables in a shared database would
    // pull the rug from under whichever driver-conformance test happened to be mid-run.
    const dbName = `blz377_install_${process.pid}`;
    const admin = new pg.Client(PG);
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const c = new pg.Client(PG.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`));
    await c.connect();
    try {
      const exec = {
        run: (sql, params = []) => c.query(sql, params.length ? params : undefined),
        all: async (sql, params = []) => (await c.query(sql, params.length ? params : undefined)).rows,
      };
      const { createDbSchema } = await import("../../scripts/model/db-schema-version.mjs");
      await createDbSchema(exec, { dialect: "postgres" });

      const got = (await c.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='blaze_config' ORDER BY tablename"
      )).rows.map((r) => r.tablename);
      assert.ok(got.includes("view"), `view missing — got: ${got.join(", ")}`);
      assert.ok(got.includes("view_type"), `view_type missing — got: ${got.join(", ")}`);
      assert.ok(got.includes("board") && got.includes("project"),
        "the config tables themselves are missing — configDdl did not run");

      const n = (await c.query("SELECT count(*)::int AS n FROM blaze_config.view_type")).rows[0].n;
      assert.equal(n, VIEW_TYPES.length, "view_type was not seeded on Postgres");
      const seeded = (await c.query("SELECT count(*)::int AS n FROM blaze_config.priority")).rows[0].n;
      assert.ok(seeded > 0, "the config seed did not run on Postgres");

      // The version stamp and the namespace must land in the SAME create, or a database can
      // exist that is stamped 4 without the tables version 4 is defined by.
      const v = (await c.query("SELECT value FROM blaze_meta WHERE key='schema_version'")).rows[0].value;
      assert.equal(Number(v), 4);

      // Both partial indexes: the whole point of BLZ-371's design, and Postgres-specific
      // syntax for them was one of the two traps this ticket had to avoid.
      const idx = (await c.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname='blaze_config' AND indexname LIKE 'view_slug%'"
      )).rows.map((r) => r.indexname).sort();
      assert.deepEqual(idx, ["view_slug_install", "view_slug_project"]);
    } finally {
      await c.end();
      const cleanup = new pg.Client(PG);
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await cleanup.end();
    }
  });
});

/** A created database with the namespace attached — the common setup for the tests above. */
function attached2() {
  const db = attached();
  createDbSchemaSync(execFor(db));
  return db;
}
