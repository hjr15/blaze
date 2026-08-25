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
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { createDbSchemaSync, DB_SCHEMA_VERSION, MIN_DB_SCHEMA_VERSION }
  from "../../scripts/model/db-schema-version.mjs";
import { sqliteAttachConfig, configDbPathFor } from "../../scripts/model/config-schema.mjs";
import { VIEW_TYPES } from "../../scripts/model/view-schema.mjs";
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";
import * as configSchema from "../../scripts/model/config-schema.mjs";
import * as viewSchema from "../../scripts/model/view-schema.mjs";

/** Static imports, addressed by path so the idempotency tests read naturally. */
const MODULES = {
  "../../scripts/model/config-schema.mjs": configSchema,
  "../../scripts/model/view-schema.mjs": viewSchema,
};

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

    // `new URL().pathname`, not a regex over the whole string. The regex form rewrote the FIRST
    // `/…` that reached a `?` or the end, so `postgres://u:p@host:5432` — no database component,
    // which pg accepts and defaults — became `postgres://blz377_install_123`, destroying the
    // credentials and the host. A `?` in a password broke it too. `view-schema.test.mjs` already
    // does it this way.
    const dbUrl = new URL(PG);
    dbUrl.pathname = `/${dbName}`;
    const c = new pg.Client(dbUrl.toString());
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

      // THE REGRESSION TEST FOR THE DEFECT THAT WEDGED CI (BLZ-377).
      //
      // `blaze_config` is a Postgres SCHEMA, so it outlives the `public` tables the create
      // guard inspects. A second create therefore re-ran the whole config DDL against a
      // namespace that already existed, and the one statement without `IF NOT EXISTS` — the
      // circular FK, because Postgres has no such syntax — failed with
      // `constraint "workflow_reopen_to_fk" for relation "workflow" already exists`. The seeds
      // then collided on their primary keys.
      //
      // Nothing asserted this. It surfaced only as an emergent collision between two unrelated
      // test FILES on a cold server, and it surfaced as a HANG rather than a failure, because
      // the conformance suite leaks its client when the open throws. On a warm server it does
      // not reproduce at all, which is why every local run was green while CI sat wedged for
      // 59 minutes. This is the assertion that should have existed.
      await c.query("DROP TABLE IF EXISTS ticket CASCADE");
      await c.query("DROP TABLE IF EXISTS blaze_meta CASCADE");
      const again = await c.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'blaze_config'");
      assert.ok(again.rows[0].n > 0, "the namespace should have survived dropping the data tables");
      await assert.doesNotReject(
        () => createDbSchema(exec, { dialect: "postgres" }),
        "a second create over a surviving blaze_config threw — the install is not idempotent, "
        + "which is what hung the CI gate");
      const dup = await c.query(
        "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'workflow_reopen_to_fk'");
      assert.equal(dup.rows[0].n, 1, "the circular FK was duplicated");
      const reseeded = await c.query("SELECT count(*)::int AS n FROM blaze_config.view_type");
      assert.equal(reseeded.rows[0].n, VIEW_TYPES.length,
        "the re-run duplicated or dropped view_type rows");

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

describe("BLZ-377: the config install is idempotent, because the namespace outlives the data", () => {
  // THE DEFECT THIS EXISTS FOR, and it took the CI gate down rather than failing a test.
  //
  // `blaze_config` is a Postgres SCHEMA, not a table, so it survives when the `public` tables
  // are dropped — and the create guard only inspects those. A second create therefore re-ran
  // the whole config DDL against a namespace that already existed. Every statement tolerated
  // that except one: `ALTER TABLE ... ADD CONSTRAINT workflow_reopen_to_fk` had no
  // `IF NOT EXISTS` (Postgres has none), so it failed with `constraint ... already exists`.
  // The seeds then collided on their primary keys.
  //
  // It was invisible locally because a WARM server already has the namespace, so the second
  // create never runs. CI provisions a FRESH Postgres every run, which is the cold path — the
  // gate hung there for 59 minutes and could not even be cancelled.

  test("the SQLite seed can be applied twice without collapsing", () => {
    const db = attached();
    createDbSchemaSync(execFor(db));
    const before = db.prepare("SELECT count(*) AS c FROM blaze_config.view_type").get().c;
    // Re-apply exactly what a second create would.
    const { configSeedSql } = require0("../../scripts/model/config-schema.mjs");
    const { viewTypeSeedSql } = require0("../../scripts/model/view-schema.mjs");
    // BOTH seeds. Covering only the config half left the view_type mutation alive — the seed
    // that actually caused `UNIQUE constraint failed: view_type.name` under `blaze db init`.
    assert.doesNotThrow(() => {
      db.exec("BEGIN");
      for (const { sql, params } of configSeedSql("sqlite")) db.prepare(sql).run(...params);
      for (const { sql, params } of viewTypeSeedSql("sqlite")) db.prepare(sql).run(...params);
      db.exec("COMMIT");
    }, "re-applying a seed threw — the install is not idempotent");
    assert.equal(db.prepare("SELECT count(*) AS c FROM blaze_config.view_type").get().c, before,
      "re-applying the seed duplicated rows");
  });

  test("the SQLite DDL can be applied twice", () => {
    const db = attached();
    createDbSchemaSync(execFor(db));
    const { configDdl } = require0("../../scripts/model/config-schema.mjs");
    const { viewDdl } = require0("../../scripts/model/view-schema.mjs");
    assert.doesNotThrow(() => { db.exec(configDdl("sqlite")); db.exec(viewDdl("sqlite")); },
      "re-applying the config DDL threw");
  });
});

describe("BLZ-377: a read never CREATES the config namespace", () => {
  test("a missing config.db beside an existing database is a named refusal", () => {
    // ATTACH creates the file if absent, which on a read path is both a write side effect and a
    // disguise: `blaze db status` reported a healthy v4 while every `blaze_config.view` query
    // failed with "no such table", because the stamp lives in the OTHER file.
    const dir = mkdtempSync(join(tmpdir(), "blz377-ro-"));
    try {
      const main = join(dir, "blaze.db");
      openSqliteRead(main, { create: true }).close?.();
      rmSync(join(dir, "config.db"), { force: true });
      assert.throws(() => openSqliteRead(main, { create: false }),
        /config namespace is missing/,
        "a board with no config namespace opened as if it were healthy");
      assert.ok(!existsSync(join(dir, "config.db")),
        "the refused read CREATED the file it was refusing over");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** `import` is static; these two tests need the modules by value inside the assertion. */
function require0(rel) { return MODULES[rel]; }

describe("BLZ-377: init rebuilds both files, and never wedges trying", () => {
  const board = () => {
    const root = mkdtempSync(join(tmpdir(), "blz377-init-"));
    mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
    writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "ENG", projects: ["ENG"] }));
    writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-x.md"),
      ["---", "id: ENG-1", 'title: "x"', "type: task", "project: ENG", "status: defined",
       "estimate: 480", "---", ""].join("\n"));
    return root;
  };
  const init = (root, ...args) => spawnSync(process.execPath,
    [fileURLToPath(new URL("../../scripts/db-runner.mjs", import.meta.url)), "init", ...args],
    { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

  test("a stale config.db is REBUILT, not reused, even without --force", () => {
    // A config.db from an older engine would otherwise be silently reused: its tables are all
    // CREATE TABLE IF NOT EXISTS, so a column added since would never appear, and the stamp
    // that would catch it lives in blaze_meta — in the other file, just recreated. That is the
    // silent-stale-schema defect BLZ-297 exists to prevent.
    const root = board();
    try {
      assert.equal(init(root).status, 0, "first init failed");
      const cfg = join(root, ".blaze", "config.db");
      writeFileSync(cfg, "not a database at all");
      rmSync(join(root, ".blaze", "blaze.db"), { force: true });
      const r = init(root);
      assert.equal(r.status, 0, `init did not recover from a stale config.db:\n${r.stderr}`);
      assert.ok(statSync(cfg).size > 1000, "config.db was reused rather than rebuilt");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a config.db that is a DIRECTORY does not throw an uncaught error", () => {
    // `rmSync(..., { force: true })` is not recursive, so this threw EISDIR — AFTER blaze.db had
    // been deleted, leaving no shadow, no message, and the same throw on every retry.
    const root = board();
    try {
      assert.equal(init(root).status, 0);
      rmSync(join(root, ".blaze", "config.db"), { force: true });
      mkdirSync(join(root, ".blaze", "config.db", "sub"), { recursive: true });
      const r = init(root, "--force");
      assert.doesNotMatch(r.stderr ?? "", /SystemError|EISDIR|^\s+at /m,
        `an uncaught error escaped:\n${r.stderr}`);
      assert.ok(r.status === 0 || /cannot remove/.test(r.stderr),
        `neither a clean rebuild nor a named refusal:\n${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-377: a present-but-EMPTY namespace is refused like a missing one", () => {
  test("a 0-byte config.db does not read as a healthy board", () => {
    // existsSync cannot tell a truncated namespace from a real one, so `blaze db status`
    // reported a healthy v4 while every blaze_config.view query failed with "no such table".
    const dir = mkdtempSync(join(tmpdir(), "blz377-zero-"));
    try {
      const main = join(dir, "blaze.db");
      openSqliteRead(main, { create: true }).close?.();
      writeFileSync(join(dir, "config.db"), "");
      assert.throws(() => openSqliteRead(main, { create: false }), /namespace .* is empty|no Blaze tables/,
        "a truncated config.db opened as if the board were healthy");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
