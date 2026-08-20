// tests/model/config-schema.test.mjs — BLZ-286.
//
// Two things are being protected here, and they are different.
//
// 1. PARITY. The config namespace must be the same shape in both dialects, or the
//    "one adapter, two drivers" claim is false at the config layer even though it
//    holds at the data layer.
// 2. NO DRIFT. The seeded registries are derived from the engine's own exports. A
//    hand-written seed list would still be valid SQL when it went stale, so the test
//    has to compare against the registry rather than against a literal.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { configDdl, configSeed, configSeedSql, sqliteAttachConfig,
         seedConfigInTransaction } from "../../scripts/model/config-schema.mjs";
import { PRIORITIES, DEFAULT_TYPES } from "../../scripts/model/schema.mjs";
import { RESOLUTIONS, DEFAULT_WORKFLOWS } from "../../scripts/model/workflows.mjs";
import { LINK_TYPES } from "../../scripts/model/links.mjs";

const PG = process.env.BLAZE_TEST_PG_URL ?? null;

function openSqliteConfig({ seed = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(sqliteAttachConfig());
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(configDdl("sqlite"));
  // The deferred circular FK makes the seed consistent only at COMMIT — see the module
  // header. Applying it outside a transaction fails on the first `workflow` row.
  if (seed) {
    db.exec("BEGIN");
    for (const { sql, params } of configSeedSql("sqlite")) db.prepare(sql).run(...params);
    db.exec("COMMIT");
  }
  return db;
}

const TABLES = [
  "board", "config_version", "link_type", "priority", "project", "project_component",
  "project_label", "resolution", "ticket_type", "type_parent", "type_required_field",
  "workflow", "workflow_status", "workflow_transition",
];

describe("blaze_config — the DDL", () => {
  test("SQLite creates the whole namespace and the seed satisfies every constraint", () => {
    const db = openSqliteConfig();
    const got = db.prepare(
      "SELECT name FROM blaze_config.sqlite_master WHERE type='table' ORDER BY name").all()
      .map((r) => r.name);
    assert.deepEqual(got, TABLES);
  });

  test("an unknown dialect is refused by name, not silently defaulted", () => {
    assert.throws(() => configDdl("mysql"), /unknown dialect "mysql"/);
    assert.throws(() => configSeedSql("mysql"), /unknown dialect "mysql"/);
  });

  test("the board and config_version singletons cannot take a second row", () => {
    const db = openSqliteConfig();
    db.prepare("INSERT INTO blaze_config.config_version (id,version,bumped_at) VALUES (1,1,'x')").run();
    assert.throws(
      () => db.prepare("INSERT INTO blaze_config.config_version (id,version,bumped_at) VALUES (2,1,'x')").run(),
      /CHECK constraint failed/);
  });

  test("a project key that is not upper-case alphanumeric is rejected", () => {
    const db = openSqliteConfig();
    const ins = (key) => db.prepare(
      "INSERT INTO blaze_config.project (key,name,created_at,updated_at) VALUES (?,?,'x','x')").run(key, key);
    ins("BLZ");                                   // fine
    assert.throws(() => ins("blz"),      /CHECK constraint failed/, "lower-case");
    assert.throws(() => ins("BL-Z"),     /CHECK constraint failed/, "punctuation");
    assert.throws(() => ins("1BL"),      /CHECK constraint failed/, "leading digit");
  });

  test("resolution_on_terminal cannot be set on a non-terminal status", () => {
    const db = openSqliteConfig();
    assert.throws(() => db.prepare(
      `INSERT INTO blaze_config.workflow_status
         (scope,workflow,status,ord,is_terminal,resolution_on_terminal)
       VALUES ('*','delivery','bogus',99,0,'done')`).run(),
      /CHECK constraint failed/);
  });

  test("a workflow_status pointing at an unknown resolution is refused by the FK", () => {
    const db = openSqliteConfig();
    assert.throws(() => db.prepare(
      `INSERT INTO blaze_config.workflow_status
         (scope,workflow,status,ord,is_terminal,resolution_on_terminal)
       VALUES ('*','delivery','bogus',99,1,'not-a-resolution')`).run(),
      /FOREIGN KEY constraint failed/);
  });

  test("a transition cannot reference a status that does not exist", () => {
    const db = openSqliteConfig();
    assert.throws(() => db.prepare(
      `INSERT INTO blaze_config.workflow_transition (scope,workflow,from_status,to_status)
       VALUES ('*','delivery','defined','nowhere')`).run(),
      /FOREIGN KEY constraint failed/);
  });
});

describe("blaze_config — the seed is DERIVED, so it cannot drift", () => {
  test("priorities, resolutions and link types match the engine registries exactly", () => {
    const s = configSeed();
    assert.deepEqual(s.priority.map((r) => r.name), PRIORITIES);
    assert.deepEqual(s.resolution.map((r) => r.name), RESOLUTIONS);
    assert.deepEqual(new Set(s.link_type.map((r) => r.name)), LINK_TYPES);
  });

  test("every engine type is seeded with its level, workflow and required fields", () => {
    const s = configSeed();
    assert.deepEqual(new Set(s.ticket_type.map((r) => r.type)), new Set(Object.keys(DEFAULT_TYPES)));
    for (const [type, def] of Object.entries(DEFAULT_TYPES)) {
      const row = s.ticket_type.find((r) => r.type === type);
      assert.equal(row.level, def.level, `${type} level`);
      assert.equal(row.workflow, def.workflow, `${type} workflow`);
      assert.deepEqual(
        s.type_required_field.filter((r) => r.type === type).map((r) => r.field).sort(),
        [...(def.required ?? [])].sort(), `${type} required fields`);
    }
  });

  test("a type added to the registry appears in the seed without touching this module", () => {
    // The drift guard. If the seed were a literal list, this would silently not grow.
    const s = configSeed({ types: { ...DEFAULT_TYPES,
      widget: { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title"] } } });
    assert.ok(s.ticket_type.some((r) => r.type === "widget"), "new type must be seeded");
    assert.ok(s.type_parent.some((r) => r.child_type === "widget" && r.parent_type === "feature"));
    assert.ok(s.type_required_field.some((r) => r.type === "widget" && r.field === "title"));
  });

  test("epic is seeded with ZERO parent rows — retained and unparentable (BLZ-231)", () => {
    const s = configSeed();
    assert.ok(s.ticket_type.some((r) => r.type === "epic"), "epic must still exist");
    assert.deepEqual(s.type_parent.filter((r) => r.child_type === "epic"), [],
      "epic must have no legal parent — that is how it is retired without deleting it");
  });

  test("the implicit reopen edge is materialised as real rows", () => {
    const s = configSeed();
    // canTransition returns true for any `from -> reopenTo` today, with no row behind it.
    const done2defined = s.workflow_transition.some((t) =>
      t.workflow === "delivery" && t.from_status === "done" && t.to_status === "defined");
    assert.ok(done2defined, "done -> defined (the reopen edge) must be a row, not a special case");
    // ...and it must not duplicate an edge the workflow already declares.
    const seen = new Set();
    for (const t of s.workflow_transition) {
      const k = `${t.workflow}|${t.from_status}|${t.to_status}`;
      assert.ok(!seen.has(k), `duplicate transition ${k}`);
      seen.add(k);
    }
  });

  test("no transition is a self-edge, which the CHECK would reject at insert time", () => {
    for (const t of configSeed().workflow_transition) {
      assert.notEqual(t.from_status, t.to_status, `${t.workflow}: self-edge`);
    }
  });

  test("every seeded workflow's reopen_to is one of its own statuses", () => {
    const s = configSeed();
    for (const w of s.workflow) {
      const statuses = s.workflow_status.filter((r) => r.workflow === w.name).map((r) => r.status);
      assert.ok(statuses.includes(w.reopen_to),
        `${w.name}: reopen_to '${w.reopen_to}' is not one of ${statuses.join("/")}`);
    }
  });
});

describe("blaze_config — Postgres parity", { skip: PG ? false : "set BLAZE_TEST_PG_URL" }, () => {
  test("Postgres builds the identical namespace and takes the identical seed", async () => {
    const pg = (await import("pg")).default;
    const c = new pg.Client(PG);
    await c.connect();
    try {
      await c.query("DROP SCHEMA IF EXISTS blaze_config CASCADE");
      await c.query(configDdl("postgres"));
      await seedConfigInTransaction((sql, params) => c.query(sql, params), "postgres");

      const got = (await c.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='blaze_config' ORDER BY tablename"
      )).rows.map((r) => r.tablename);
      assert.deepEqual(got, TABLES, "the two dialects must build the same namespace");

      // The circular FK cannot be inline in Postgres — it needs the ALTER. Prove it landed.
      const fk = await c.query(
        "SELECT 1 FROM pg_constraint WHERE conname = 'workflow_reopen_to_fk'");
      assert.equal(fk.rowCount, 1, "the deferred circular FK must exist");

      // Same row counts as SQLite, from the same derived seed.
      const seed = configSeed();
      for (const table of Object.keys(seed)) {
        const n = (await c.query(`SELECT count(*)::int AS n FROM blaze_config.${table}`)).rows[0].n;
        assert.equal(n, seed[table].length, `${table} row count`);
      }

      // The project-key CHECK is a genuine dialect divergence: `~` here, GLOB in SQLite.
      // Both must reject the same input, or the constraint is not really one constraint.
      await assert.rejects(
        c.query("INSERT INTO blaze_config.project (key,name,created_at,updated_at) VALUES ('blz','x',now(),now())"),
        /violates check constraint/);
    } finally {
      await c.end();
    }
  });
});
