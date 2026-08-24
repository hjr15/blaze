// tests/model/view-schema.test.mjs — the `view` / `view_type` tables (BLZ-371).
//
// The two partial unique indexes are the point of §3.2: a naive UNIQUE (project_key, slug)
// does NOT stop two installation rows sharing a slug, because NULL compares distinct under
// UNIQUE in both engines. The first test proves the trap is real before the rest prove the fix.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { viewDdl, VIEW_TYPES } from "../../scripts/model/view-schema.mjs";

// `view` lives in the blaze_config namespace, so its FKs to project/view_type are
// intra-database. In SQLite that namespace is an ATTACHed file; an in-memory attach
// reproduces it exactly.
function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec("ATTACH DATABASE ':memory:' AS blaze_config;");
  db.exec(`CREATE TABLE blaze_config.project (key TEXT PRIMARY KEY) STRICT;`);
  db.exec(`INSERT INTO blaze_config.project (key) VALUES ('BLZ'), ('OBA');`);
  db.exec(viewDdl("sqlite"));
  for (const t of VIEW_TYPES) {
    db.prepare(`INSERT INTO blaze_config.view_type (name, label) VALUES (?,?)`).run(t.name, t.label);
  }
  return db;
}

const ins = (db, o) => db.prepare(
  `INSERT INTO blaze_config.view (id, scope, project_key, type, name, slug, ord, is_builtin, enabled, config_json, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
).run(o.id, o.scope, o.project_key ?? null, o.type ?? "gantt", o.name ?? "V",
      o.slug, o.ord ?? 0, o.is_builtin ?? 0, o.enabled ?? 1, o.config_json ?? "{}",
      "2026-08-24", "2026-08-24");

describe("view (SQLite)", () => {
  test("the NULL-in-UNIQUE trap is real: a naive UNIQUE would accept two installation rows sharing a slug", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE v (project_key TEXT, slug TEXT, UNIQUE (project_key, slug)) STRICT;`);
    db.prepare(`INSERT INTO v VALUES (NULL,'gantt')`).run();
    db.prepare(`INSERT INTO v VALUES (NULL,'gantt')`).run();
    assert.equal(db.prepare("SELECT count(*) n FROM v").get().n, 2,
      "if this fails the trap has gone away and the partial index is no longer load-bearing");
  });

  test("the partial install index refuses two installation rows sharing a slug", () => {
    const db = open();
    ins(db, { id: "v1", scope: "installation", slug: "gantt" });
    assert.throws(() => ins(db, { id: "v2", scope: "installation", slug: "gantt" }), /UNIQUE/);
  });

  test("the partial project index refuses two rows sharing a slug within one project", () => {
    const db = open();
    ins(db, { id: "v1", scope: "project", project_key: "BLZ", slug: "gantt" });
    assert.throws(() => ins(db, { id: "v2", scope: "project", project_key: "BLZ", slug: "gantt" }), /UNIQUE/);
  });

  test("the same slug under two different projects is accepted", () => {
    const db = open();
    ins(db, { id: "v1", scope: "project", project_key: "BLZ", slug: "gantt" });
    ins(db, { id: "v2", scope: "project", project_key: "OBA", slug: "gantt" });
    assert.equal(db.prepare("SELECT count(*) n FROM blaze_config.view").get().n, 2);
  });

  test("an installation row carrying a project_key is refused by the CHECK", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "v1", scope: "installation", project_key: "BLZ", slug: "g" }), /CHECK/);
  });

  test("a project row with no project_key is refused by the CHECK", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "v1", scope: "project", project_key: null, slug: "g" }), /CHECK/);
  });

  test("an unknown scope is refused", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "v1", scope: "global", slug: "g" }), /CHECK/);
  });

  // This is the test that drove the namespace: the spec's own DDL wrote the FK as
  // `REFERENCES blaze_config.project (key)`, which SQLite rejects as a syntax error,
  // and the unqualified form resolves to a non-existent `main.project`.
  test("project_key naming a project that does not exist is refused by the FK", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "v1", scope: "project", project_key: "NOPE", slug: "g" }),
      /FOREIGN KEY/);
  });

  test("an unknown type is refused by the view_type FK", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "v1", scope: "installation", type: "nope", slug: "g" }),
      /FOREIGN KEY/);
  });

  test("config_json must be a JSON object", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "v1", scope: "installation", slug: "g", config_json: "[]" }), /CHECK/);
    assert.throws(() => ins(db, { id: "v2", scope: "installation", slug: "h", config_json: "nonsense" }), /CHECK/);
  });

  test("VIEW_TYPES seeds the six builtins, in VIEW_NAMES order", () => {
    assert.deepEqual(VIEW_TYPES.map((t) => t.name), ["board", "list", "live", "metrics", "map", "gantt"]);
  });
});

// Postgres half (only when BLAZE_TEST_PG_URL is set). BLZ-354 §11.3 left this owed: the
// SQLite result was measured, the Postgres one was not, and this repo's own precedent is
// 32 conformance assertions that missed a Postgres date bug because not one compared a date.
if (process.env.BLAZE_TEST_PG_URL) {
  async function openPg() {
    const db = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS blaze_config CASCADE");
    await db.query("CREATE SCHEMA blaze_config");
    await db.query("CREATE TABLE blaze_config.project (key text PRIMARY KEY)");
    await db.query("INSERT INTO blaze_config.project (key) VALUES ('BLZ'), ('OBA')");
    await db.query(viewDdl("postgres"));
    for (const t of VIEW_TYPES) {
      await db.query("INSERT INTO blaze_config.view_type (name, label) VALUES ($1,$2)", [t.name, t.label]);
    }
    return db;
  }
  const insPg = (db, o) => db.query(
    `INSERT INTO blaze_config.view (id, scope, project_key, type, name, slug, ord, is_builtin, enabled, config_json, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())`,
    [o.id, o.scope, o.project_key ?? null, o.type ?? "gantt", o.name ?? "V", o.slug,
     o.ord ?? 0, o.is_builtin ?? false, o.enabled ?? true, o.config_json ?? "{}"]);

  describe("view (Postgres)", () => {
    test("the partial install index refuses two installation rows sharing a slug", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "v1", scope: "installation", slug: "gantt" });
        await assert.rejects(() => insPg(db, { id: "v2", scope: "installation", slug: "gantt" }),
          /duplicate key|unique/i);
      } finally { await db.end(); }
    });

    test("the same slug under two different projects is accepted", async () => {
      const db = await openPg();
      try {
        await insPg(db, { id: "v1", scope: "project", project_key: "BLZ", slug: "gantt" });
        await insPg(db, { id: "v2", scope: "project", project_key: "OBA", slug: "gantt" });
        const r = await db.query("SELECT count(*)::int n FROM blaze_config.view");
        assert.equal(r.rows[0].n, 2);
      } finally { await db.end(); }
    });

    test("the scope/project_key CHECK holds in both directions", async () => {
      const db = await openPg();
      try {
        await assert.rejects(() => insPg(db, { id: "v1", scope: "installation", project_key: "BLZ", slug: "g" }), /check/i);
        await assert.rejects(() => insPg(db, { id: "v2", scope: "project", project_key: null, slug: "h" }), /check/i);
      } finally { await db.end(); }
    });

    test("both foreign keys enforce", async () => {
      const db = await openPg();
      try {
        await assert.rejects(() => insPg(db, { id: "v1", scope: "project", project_key: "NOPE", slug: "g" }), /foreign key/i);
        await assert.rejects(() => insPg(db, { id: "v2", scope: "installation", type: "nope", slug: "h" }), /foreign key/i);
      } finally { await db.end(); }
    });

    test("config_json must be a JSON object", async () => {
      const db = await openPg();
      try {
        await assert.rejects(() => insPg(db, { id: "v1", scope: "installation", slug: "g", config_json: "[]" }), /check/i);
      } finally { await db.end(); }
    });
  });
}
