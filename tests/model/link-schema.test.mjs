// tests/model/link-schema.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { linkDdl, DEFAULT_LINK_TYPES } from "../../scripts/model/link-schema.mjs";

describe("the default link types encode the standards document's table", () => {
  test("all five trace links are present with the right endpoints", () => {
    const by = Object.fromEntries(DEFAULT_LINK_TYPES.map(t => [t.name, t]));
    assert.deepEqual(by.Implements.source_kinds, ["feature"]);
    assert.deepEqual(by.Implements.target_kinds, ["requirement"]);
    assert.deepEqual(by.Addresses.source_kinds, ["architecture"]);
    assert.deepEqual(by.Addresses.target_kinds, ["requirement"]);
    assert.deepEqual(by.Verifies.source_kinds.sort(), ["feature", "story"]);
    assert.deepEqual(by.Supersedes.source_kinds, ["architecture"]);
    assert.deepEqual(by.Supersedes.target_kinds, ["architecture"]);
    assert.deepEqual(by.Derives.source_kinds, ["requirement"]);
  });

  test("EVERY link type carries an inverse name", () => {
    // The matrix must read correctly in both directions without a second table.
    for (const t of DEFAULT_LINK_TYPES) {
      assert.ok(t.inverse_name && t.inverse_name !== t.name, `${t.name} has no distinct inverse`);
    }
  });

  test("both dialects declare the same columns", () => {
    const cols = (sql) => [...sql.matchAll(/^\s{2}([a-z_]+)\s+/gm)].map(m => m[1]);
    assert.deepEqual(cols(linkDdl("sqlite")).sort(), cols(linkDdl("postgres")).sort());
  });
});

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(linkDdl("sqlite"));
  return db;
}

const insLT = (db, o) => db.prepare(
  `INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds, min_card, max_card)
   VALUES (?,?,?,?,?,?,?,?)`
).run(
  o.id, o.project_key ?? "BLZ", o.name ?? "Addresses", o.inverse_name ?? "Addressed by",
  o.source_kinds ?? "architecture", o.target_kinds ?? "requirement", o.min_card ?? 0, o.max_card ?? null
);

const insL = (db, o) => db.prepare(
  `INSERT INTO link (id, link_type_id, source_id, target_id, created_at, created_by)
   VALUES (?,?,?,?,?,?)`
).run(
  o.id, o.link_type_id ?? "lt1", o.source_id, o.target_id, o.created_at ?? "2026-01-01T00:00:00Z",
  o.created_by ?? "unknown"
);

describe("link (SQLite)", () => {
  test("both tables create cleanly and accept a well-formed row each", () => {
    const db = open();
    insLT(db, { id: "lt1" });
    insL(db, { id: "l1", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" });
    assert.equal(db.prepare("SELECT count(*) n FROM link_type").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM link").get().n, 1);
  });

  test("source_id = target_id is REFUSED by the CHECK", () => {
    const db = open();
    insLT(db, { id: "lt1" });
    assert.throws(
      () => insL(db, { id: "l1", link_type_id: "lt1", source_id: "same", target_id: "same" }),
      /CHECK|constraint/i
    );
  });

  test("the same edge (link_type_id, source_id, target_id) twice is REFUSED", () => {
    const db = open();
    insLT(db, { id: "lt1" });
    insL(db, { id: "l1", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" });
    assert.throws(
      () => insL(db, { id: "l2", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" }),
      /UNIQUE|constraint/i
    );
  });

  test("a duplicate link type name within one project is REFUSED, but free across projects", () => {
    const db = open();
    insLT(db, { id: "lt1", project_key: "BLZ", name: "Addresses" });
    assert.throws(
      () => insLT(db, { id: "lt2", project_key: "BLZ", name: "Addresses" }),
      /UNIQUE|constraint/i
    );
    insLT(db, { id: "lt3", project_key: "OBA", name: "Addresses" }); // must be allowed
    assert.equal(db.prepare("SELECT count(*) n FROM link_type").get().n, 2);
  });

  test("max_card < min_card is REFUSED, but a NULL max_card (unbounded) is accepted", () => {
    const db = open();
    assert.throws(
      () => insLT(db, { id: "lt1", min_card: 5, max_card: 1 }),
      /CHECK|constraint/i
    );
    insLT(db, { id: "lt2", min_card: 0, max_card: null }); // unbounded — every default link type uses this
    assert.equal(db.prepare("SELECT count(*) n FROM link_type").get().n, 1);
  });

  test("deleting a link type that still has links is REFUSED (ON DELETE RESTRICT)", () => {
    const db = open();
    insLT(db, { id: "lt1" });
    insL(db, { id: "l1", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" });
    assert.throws(
      () => db.exec(`DELETE FROM link_type WHERE id = 'lt1'`),
      /FOREIGN KEY|constraint/i
    );
  });
});

// Postgres tests (only run if BLAZE_TEST_PG_URL is set)
if (process.env.BLAZE_TEST_PG_URL) {
  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    try {
      await client.query("DROP TABLE IF EXISTS link CASCADE");
      await client.query("DROP TABLE IF EXISTS link_type CASCADE");
    } catch (e) {
      // ignore
    }
    try {
      await client.query(linkDdl("postgres"));
    } catch (e) {
      await client.end();   // don't leak the connection — an open socket stalls the runner
      throw e;
    }
    return client;
  }

  const insLTPg = async (db, o) => {
    await db.query(
      `INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds, min_card, max_card)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [o.id, o.project_key ?? "BLZ", o.name ?? "Addresses", o.inverse_name ?? "Addressed by",
       o.source_kinds ?? "architecture", o.target_kinds ?? "requirement", o.min_card ?? 0, o.max_card ?? null]
    );
  };

  const insLPg = async (db, o) => {
    await db.query(
      `INSERT INTO link (id, link_type_id, source_id, target_id, created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [o.id, o.link_type_id ?? "lt1", o.source_id, o.target_id, o.created_at ?? "2026-01-01T00:00:00Z",
       o.created_by ?? "unknown"]
    );
  };

  describe("link (Postgres)", () => {
    test("both tables create cleanly and accept a well-formed row each", async () => {
      const db = await openPg();
      try {
        await insLTPg(db, { id: "lt1" });
        await insLPg(db, { id: "l1", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" });
        const lt = await db.query("SELECT count(*) n FROM link_type");
        const l = await db.query("SELECT count(*) n FROM link");
        assert.equal(Number(lt.rows[0].n), 1);
        assert.equal(Number(l.rows[0].n), 1);
      } finally {
        await db.end();
      }
    });

    test("source_id = target_id is REFUSED by the CHECK", async () => {
      const db = await openPg();
      try {
        await insLTPg(db, { id: "lt1" });
        await assert.rejects(
          async () => insLPg(db, { id: "l1", link_type_id: "lt1", source_id: "same", target_id: "same" }),
          /check|constraint|new row/i
        );
      } finally {
        await db.end();
      }
    });

    test("the same edge (link_type_id, source_id, target_id) twice is REFUSED", async () => {
      const db = await openPg();
      try {
        await insLTPg(db, { id: "lt1" });
        await insLPg(db, { id: "l1", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" });
        await assert.rejects(
          async () => insLPg(db, { id: "l2", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" }),
          /unique|constraint|duplicate/i
        );
      } finally {
        await db.end();
      }
    });

    test("a duplicate link type name within one project is REFUSED, but free across projects", async () => {
      const db = await openPg();
      try {
        await insLTPg(db, { id: "lt1", project_key: "BLZ", name: "Addresses" });
        await assert.rejects(
          async () => insLTPg(db, { id: "lt2", project_key: "BLZ", name: "Addresses" }),
          /unique|constraint|duplicate/i
        );
        await insLTPg(db, { id: "lt3", project_key: "OBA", name: "Addresses" }); // must be allowed
        const r = await db.query("SELECT count(*) n FROM link_type");
        assert.equal(Number(r.rows[0].n), 2);
      } finally {
        await db.end();
      }
    });

    test("max_card < min_card is REFUSED, but a NULL max_card (unbounded) is accepted", async () => {
      const db = await openPg();
      try {
        await assert.rejects(
          async () => insLTPg(db, { id: "lt1", min_card: 5, max_card: 1 }),
          /check|constraint|new row/i
        );
        await insLTPg(db, { id: "lt2", min_card: 0, max_card: null }); // unbounded
        const r = await db.query("SELECT count(*) n FROM link_type");
        assert.equal(Number(r.rows[0].n), 1);
      } finally {
        await db.end();
      }
    });

    test("deleting a link type that still has links is REFUSED (ON DELETE RESTRICT)", async () => {
      const db = await openPg();
      try {
        await insLTPg(db, { id: "lt1" });
        await insLPg(db, { id: "l1", link_type_id: "lt1", source_id: "arch-1", target_id: "req-1" });
        await assert.rejects(
          async () => db.query(`DELETE FROM link_type WHERE id = 'lt1'`),
          /foreign key|constraint|violates/i
        );
      } finally {
        await db.end();
      }
    });
  });
}
