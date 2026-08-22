// tests/model/hierarchy-schema.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { hierarchyDdl } from "../../scripts/model/hierarchy-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(hierarchyDdl("sqlite"));
  return db;
}

const insH = (db, o) => db.prepare(
  `INSERT INTO hierarchy (id, project_key, name, is_default) VALUES (?,?,?,?)`
).run(o.id, o.project_key ?? "BLZ", o.name ?? "delivery", o.is_default ?? 0);

const insM = (db, o) => db.prepare(
  `INSERT INTO hierarchy_membership (id, hierarchy_id, item_id, parent_id, ord) VALUES (?,?,?,?,?)`
).run(o.id, o.hierarchy_id ?? "h1", o.item_id, o.parent_id ?? null, o.ord ?? 0);

describe("hierarchy (SQLite)", () => {
  test("a root row inserts successfully (parent_id NULL)", () => {
    const db = open();
    insH(db, { id: "h1" });
    insM(db, { id: "m1", item_id: "root", parent_id: null });
    assert.equal(db.prepare("SELECT count(*) n FROM hierarchy_membership").get().n, 1);
  });

  test("an item may have two parents in one hierarchy", () => {
    const db = open();
    insH(db, { id: "h1" });
    insM(db, { id: "m1", item_id: "root", parent_id: null });
    insM(db, { id: "m2", item_id: "a", parent_id: "root" });
    insM(db, { id: "m3", item_id: "b", parent_id: "root" });
    insM(db, { id: "m4", item_id: "shared", parent_id: "a" });
    insM(db, { id: "m5", item_id: "shared", parent_id: "b" });
    assert.equal(
      db.prepare("SELECT count(*) n FROM hierarchy_membership WHERE item_id = 'shared'").get().n,
      2
    );
  });

  test("the same edge twice is REFUSED", () => {
    const db = open();
    insH(db, { id: "h1" });
    insM(db, { id: "m1", item_id: "root", parent_id: null });
    insM(db, { id: "m2", item_id: "shared", parent_id: "root" });
    assert.throws(
      () => insM(db, { id: "m3", item_id: "shared", parent_id: "root" }),
      /UNIQUE|constraint/i
    );
  });

  test("the same item registered as a root twice is REFUSED", () => {
    const db = open();
    insH(db, { id: "h1" });
    insM(db, { id: "m1", item_id: "root", parent_id: null });
    assert.throws(
      () => insM(db, { id: "m2", item_id: "root", parent_id: null }),
      /UNIQUE|constraint/i
    );
  });

  test("item_id = parent_id is REFUSED by the CHECK", () => {
    const db = open();
    insH(db, { id: "h1" });
    assert.throws(
      () => insM(db, { id: "m1", item_id: "a", parent_id: "a" }),
      /CHECK|constraint/i
    );
  });

  test("deleting a hierarchy cascades to its memberships, others survive", () => {
    const db = open();
    insH(db, { id: "h1", name: "delivery" });
    insH(db, { id: "h2", name: "safety" });
    insM(db, { id: "m1", hierarchy_id: "h1", item_id: "root", parent_id: null });
    insM(db, { id: "m2", hierarchy_id: "h2", item_id: "root", parent_id: null });
    db.exec(`DELETE FROM hierarchy WHERE id = 'h1'`);
    assert.equal(db.prepare("SELECT count(*) n FROM hierarchy_membership WHERE hierarchy_id = 'h1'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM hierarchy_membership WHERE hierarchy_id = 'h2'").get().n, 1);
  });
});

// Postgres tests (only run if BLAZE_TEST_PG_URL is set)
if (process.env.BLAZE_TEST_PG_URL) {
  async function openPg() {
    const client = new pg.Client(process.env.BLAZE_TEST_PG_URL);
    await client.connect();
    try {
      await client.query("DROP TABLE IF EXISTS hierarchy_membership CASCADE");
      await client.query("DROP TABLE IF EXISTS hierarchy CASCADE");
    } catch (e) {
      // ignore
    }
    try {
      await client.query(hierarchyDdl("postgres"));
    } catch (e) {
      await client.end();   // don't leak the connection — an open socket stalls the runner
      throw e;
    }
    return client;
  }

  const insHPg = async (db, o) => {
    await db.query(
      `INSERT INTO hierarchy (id, project_key, name, is_default) VALUES ($1,$2,$3,$4)`,
      [o.id, o.project_key ?? "BLZ", o.name ?? "delivery", o.is_default ?? false]
    );
  };

  const insMPg = async (db, o) => {
    await db.query(
      `INSERT INTO hierarchy_membership (id, hierarchy_id, item_id, parent_id, ord) VALUES ($1,$2,$3,$4,$5)`,
      [o.id, o.hierarchy_id ?? "h1", o.item_id, o.parent_id ?? null, o.ord ?? 0]
    );
  };

  describe("hierarchy (Postgres)", () => {
    test("a root row inserts successfully (parent_id NULL)", async () => {
      const db = await openPg();
      try {
        await insHPg(db, { id: "h1" });
        await insMPg(db, { id: "m1", item_id: "root", parent_id: null });
        const r = await db.query("SELECT count(*) n FROM hierarchy_membership");
        assert.equal(Number(r.rows[0].n), 1);
      } finally {
        await db.end();
      }
    });

    test("an item may have two parents in one hierarchy", async () => {
      const db = await openPg();
      try {
        await insHPg(db, { id: "h1" });
        await insMPg(db, { id: "m1", item_id: "root", parent_id: null });
        await insMPg(db, { id: "m2", item_id: "a", parent_id: "root" });
        await insMPg(db, { id: "m3", item_id: "b", parent_id: "root" });
        await insMPg(db, { id: "m4", item_id: "shared", parent_id: "a" });
        await insMPg(db, { id: "m5", item_id: "shared", parent_id: "b" });
        const r = await db.query("SELECT count(*) n FROM hierarchy_membership WHERE item_id = 'shared'");
        assert.equal(Number(r.rows[0].n), 2);
      } finally {
        await db.end();
      }
    });

    test("the same edge twice is REFUSED", async () => {
      const db = await openPg();
      try {
        await insHPg(db, { id: "h1" });
        await insMPg(db, { id: "m1", item_id: "root", parent_id: null });
        await insMPg(db, { id: "m2", item_id: "shared", parent_id: "root" });
        await assert.rejects(
          async () => insMPg(db, { id: "m3", item_id: "shared", parent_id: "root" }),
          /unique|constraint|duplicate/i
        );
      } finally {
        await db.end();
      }
    });

    test("the same item registered as a root twice is REFUSED", async () => {
      const db = await openPg();
      try {
        await insHPg(db, { id: "h1" });
        await insMPg(db, { id: "m1", item_id: "root", parent_id: null });
        await assert.rejects(
          async () => insMPg(db, { id: "m2", item_id: "root", parent_id: null }),
          /unique|constraint|duplicate/i
        );
      } finally {
        await db.end();
      }
    });

    test("item_id = parent_id is REFUSED by the CHECK", async () => {
      const db = await openPg();
      try {
        await insHPg(db, { id: "h1" });
        await assert.rejects(
          async () => insMPg(db, { id: "m1", item_id: "a", parent_id: "a" }),
          /check|constraint|new row/i
        );
      } finally {
        await db.end();
      }
    });

    test("deleting a hierarchy cascades to its memberships, others survive", async () => {
      const db = await openPg();
      try {
        await insHPg(db, { id: "h1", name: "delivery" });
        await insHPg(db, { id: "h2", name: "safety" });
        await insMPg(db, { id: "m1", hierarchy_id: "h1", item_id: "root", parent_id: null });
        await insMPg(db, { id: "m2", hierarchy_id: "h2", item_id: "root", parent_id: null });
        await db.query(`DELETE FROM hierarchy WHERE id = 'h1'`);
        const r1 = await db.query("SELECT count(*) n FROM hierarchy_membership WHERE hierarchy_id = 'h1'");
        const r2 = await db.query("SELECT count(*) n FROM hierarchy_membership WHERE hierarchy_id = 'h2'");
        assert.equal(Number(r1.rows[0].n), 0);
        assert.equal(Number(r2.rows[0].n), 1);
      } finally {
        await db.end();
      }
    });
  });
}
