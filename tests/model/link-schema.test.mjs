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

  test("lag_minutes is an integer in BOTH dialects, not just present in both", () => {
    // The guard above compares column NAMES only, so an INTEGER -> text divergence passes it.
    // lag_minutes is arithmetic the scheduler adds to a finish time; a text column would
    // concatenate instead and the error would surface as a wrong date, not a type error.
    for (const d of ["sqlite", "postgres"]) {
      assert.match(linkDdl(d), /lag_minutes\s+(INTEGER|integer)\s+NOT NULL DEFAULT 0/,
        `${d} must declare lag_minutes as an integer`);
    }
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

    test("lag_minutes round-trips through Postgres, including a negative lead", async () => {
      const db = await openPg();
      try {
        await db.query(`INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds)

                        VALUES ('lt1','BLZ','Precedes','Follows','task','task')`);
        await db.query(`INSERT INTO link (id, link_type_id, source_id, target_id, created_at)

                        VALUES ('l1','lt1','BLZ-1','BLZ-2', now())`);
        const d = await db.query("SELECT lag_minutes FROM link WHERE id='l1'");
        assert.equal(d.rows[0].lag_minutes, 0, "the zero default must hold in Postgres too");
        await db.query(`INSERT INTO link (id, link_type_id, source_id, target_id, created_at, lag_minutes)

                        VALUES ('l2','lt1','BLZ-3','BLZ-4', now(), -120)`);
        const n = await db.query("SELECT lag_minutes FROM link WHERE id='l2'");
        assert.equal(n.rows[0].lag_minutes, -120, "a negative lag is a lead and no CHECK forbids it");
        await assert.rejects(() => db.query("UPDATE link SET lag_minutes = NULL WHERE id='l1'"), /null/i);
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

// --- ADR-0022: the Precedes/Follows scheduling edge (BLZ-373) -----------------
// `Blocks` cannot carry the direction a scheduler needs: 248 of 392 live edges sit in 124
// mutual pairs, because frontmatter has no way to write the inverse. So the kernel adds a
// NEW type rather than enforcing `Blocks`, which is why ADR-0001 survives untouched.
describe("Precedes / Follows (ADR-0022)", () => {
  const precedes = () => DEFAULT_LINK_TYPES.find((t) => t.name === "Precedes");

  test("Precedes exists, with Follows as its inverse", () => {
    const p = precedes();
    assert.ok(p, "DEFAULT_LINK_TYPES must carry Precedes");
    assert.equal(p.inverse_name, "Follows");
  });

  test("both endpoints are the five kinds ADR-0022 names — a risk or a goal is refused", () => {
    const p = precedes();
    // NOT "the delivery kinds": there are six delivery-workflow types and `epic` is the
    // sixth, so this list is narrower than gantt.mjs's isDelivery().
    //
    // BLZ-378 CLOSED under BLZ-388, and the answer is that the narrowness is deliberate. An
    // epic is a container whose dates are a roll-up OF the finished schedule rather than a CPM
    // input (BLZ-360 §8.3), so it is chart-only by design. That roll-up is spec 4's and is not
    // built, so an epic currently has no derived dates at all. schedule.mjs now takes its NODE set from
    // this same list, so there is no longer a second definition for it to disagree with.
    const adrKinds = ["bug", "feature", "story", "subtask", "task"];
    assert.deepEqual([...p.source_kinds].sort(), adrKinds);
    assert.deepEqual([...p.target_kinds].sort(), adrKinds);
    // 58 of the 392 live Blocks edges are refused by exactly this rule, 36 of them
    // risk<->feature. A risk does not belong in a delivery critical path.
    assert.ok(!p.source_kinds.includes("risk") && !p.target_kinds.includes("risk"));
    assert.ok(!p.source_kinds.includes("goal") && !p.target_kinds.includes("goal"));
  });

  test("Precedes is unbounded — a ticket may precede many", () => {
    const p = precedes();
    assert.equal(p.min_card, 0);
    assert.equal(p.max_card, null);
  });

  test("lag_minutes exists on link, NOT NULL, defaulting to 0", () => {
    const db = open();
    db.prepare(`INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds)
                VALUES ('lt1','BLZ','Precedes','Follows','task','task')`).run();
    db.prepare(`INSERT INTO link (id, link_type_id, source_id, target_id, created_at)
                VALUES ('l1','lt1','BLZ-1','BLZ-2','2026-08-24')`).run();
    assert.equal(db.prepare("SELECT lag_minutes m FROM link WHERE id='l1'").get().m, 0,
      "a zero default is what makes this column free for every non-scheduling link type");
    assert.throws(() => db.prepare("UPDATE link SET lag_minutes = NULL WHERE id='l1'").run(), /NOT NULL/);
  });

  test("lag_minutes carries a negative lead as well as a positive lag", () => {
    const db = open();
    db.prepare(`INSERT INTO link_type (id, project_key, name, inverse_name, source_kinds, target_kinds)
                VALUES ('lt1','BLZ','Precedes','Follows','task','task')`).run();
    db.prepare(`INSERT INTO link (id, link_type_id, source_id, target_id, created_at, lag_minutes)
                VALUES ('l1','lt1','BLZ-1','BLZ-2','2026-08-24',-120)`).run();
    assert.equal(db.prepare("SELECT lag_minutes m FROM link WHERE id='l1'").get().m, -120,
      "no CHECK constrains the sign: a lead is a negative lag and the spec declares none");
  });

  // ADR-0022 is explicit that this touches ONE of the two tables called link_type. The
  // frontmatter path seeds from links.mjs's bare Set and would refuse a Precedes until that
  // is extended too — which is why §5.5's import-deps is an operator tool and not a lint.
  test("the frontmatter LINK_TYPES deliberately does NOT yet carry Precedes", async () => {
    const { LINK_TYPES } = await import("../../scripts/model/links.mjs");
    assert.ok(!LINK_TYPES.has("Precedes"),
      "if this fails, the frontmatter path now accepts Precedes and ADR-0022 §5.3's asymmetry is gone");
    assert.ok(LINK_TYPES.has("Blocks"), "Blocks stays, advisory and untouched — ADR-0001");
  });
});
