// tests/model/write-port.test.mjs — BLZ-293.
//
// The reversible half of the cutover. Three claims are under test, and the first is
// the one that makes the other two safe to land:
//
//   1. THE DEFAULT IS UNCHANGED. With no flag set, a verb writes to the filesystem
//      exactly as it always has. Nothing about the live board moves.
//   2. The database adapter satisfies the same LOGICAL port, with no path anywhere.
//   3. Dual-write actually CATCHES a divergence — proven by injecting one, because a
//      comparison that cannot fail is not a comparison.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { fsReadStorage } from "../../scripts/model/read-storage.mjs";
import { memStorage } from "../../scripts/model/storage.mjs";
import { fsWritePort, dbWritePort, dualWritePort, selectWritePort, valueDiff,
         ticketValue, WRITE_PORT_ENV } from "../../scripts/model/write-port.mjs";

const PG = process.env.BLAZE_TEST_PG_URL ?? null;

const TICKET = () => ({
  project: "BLZ", status: "defined",
  frontmatter: {
    id: "BLZ-1", project: "BLZ", type: "task", title: "A task",
    priority: "medium", resolution: "", parent: "", assignee: "unassigned",
    estimate: 60, sprint: "", start: "", due: "",
    created: "2026-01-01", updated: "2026-01-01",
    links: [{ type: "Blocks", target: "BLZ-2" }],
  },
  body: "the body",
});

function sqliteExec() {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
  return {
    run(sql, p) { return /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) ? db.exec(sql) : db.prepare(sql).run(...p); },
    all(sql, p) { return db.prepare(sql).all(...p); },
    _db: db,
  };
}

describe("the default is the filesystem, and it is unchanged", () => {
  test("with no flag set, selectWritePort returns the fs port", () => {
    const port = selectWritePort({ projectsDir: "/nowhere", env: {} });
    assert.equal(port.name, "fs");
  });

  test("the fs port writes a real file at the path authority's location", () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-wp-"));
    const port = fsWritePort(dir);
    const { file } = port.write(TICKET());
    assert.ok(existsSync(file), "a real file must appear");
    assert.match(file, /BLZ\/defined\/BLZ-1-a-task\.md$/);
    assert.match(readFileSync(file, "utf8"), /title: A task/);
  });

  test("an existing ticket keeps its filename — edit has never renamed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-wp-"));
    const port = fsWritePort(dir);
    const { file } = port.write(TICKET());
    const t = TICKET();
    t.frontmatter.title = "Renamed entirely";
    const again = port.write({ ...t, currentFile: file });
    assert.equal(again.file, file, "the slug must not be recomputed from the new title");
  });

  test("move relocates by the path authority, never by arithmetic on the handle", () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-wp-"));
    const port = fsWritePort(dir);
    const { file } = port.write(TICKET());
    const t = { ...TICKET(), status: "in-progress", currentFile: file };
    const moved = port.move(t);
    assert.match(moved.file, /BLZ\/in-progress\/BLZ-1-a-task\.md$/);
    assert.equal(existsSync(file), false, "the old path must be gone");
    assert.ok(existsSync(moved.file));
  });

  test("the fs port honours an injected driver — it never reaches for node:fs directly", () => {
    const mem = memStorage();
    const port = fsWritePort("/nowhere", mem);
    const { file } = port.write(TICKET());
    assert.ok(mem.exists(file), "the write must land in the injected store");
    assert.equal(existsSync(file), false, "and NOT on disk");
  });

  test("an unrecognised flag is an error, not a silent fallback in either direction", () => {
    assert.throws(
      () => selectWritePort({ projectsDir: "/x", env: { [WRITE_PORT_ENV]: "postgres" } }),
      /is not a write port — expected 'fs', 'dual' or 'db'/);
    assert.throws(
      () => selectWritePort({ projectsDir: "/x", env: { [WRITE_PORT_ENV]: "db" } }),
      /needs a database/);
  });
});

describe("the database adapter satisfies the same logical port", () => {
  test("write then read round-trips the ticket's values", async () => {
    const port = dbWritePort(sqliteExec());
    await port.write(TICKET());
    const got = await port.read("BLZ-1");
    assert.equal(got.frontmatter.title, "A task");
    assert.equal(got.status, "defined");
    assert.deepEqual(got.frontmatter.links, [{ type: "Blocks", target: "BLZ-2" }]);
  });

  test("move changes status without any path existing anywhere", async () => {
    const port = dbWritePort(sqliteExec());
    await port.write(TICKET());
    const r = await port.move({ ...TICKET(), status: "in-progress", currentFile: "BLZ-1" });
    assert.equal(r.file, "BLZ-1", "an opaque handle, not a path");
    assert.equal((await port.read("BLZ-1")).status, "in-progress");
  });

  test("re-writing replaces links rather than accumulating them", async () => {
    const port = dbWritePort(sqliteExec());
    await port.write(TICKET());
    const t = TICKET();
    t.frontmatter.links = [{ type: "Relates", target: "BLZ-3" }];
    await port.write(t);
    assert.deepEqual((await port.read("BLZ-1")).frontmatter.links,
      [{ type: "Relates", target: "BLZ-3" }]);
  });

  test("an unknown dialect is refused", () => {
    assert.throws(() => dbWritePort(sqliteExec(), { dialect: "mysql" }), /unknown dialect/);
  });
});

describe("value identity ignores what is not a value", () => {
  test("link ORDER is not a difference", () => {
    const a = ticketValue({ frontmatter: { id: "X", links: [{ type: "Blocks", target: "B" }, { type: "Relates", target: "A" }] }, body: "b" });
    const b = ticketValue({ frontmatter: { id: "X", links: [{ type: "Relates", target: "A" }, { type: "Blocks", target: "B" }] }, body: "b" });
    assert.deepEqual(valueDiff(a, b), []);
  });

  test("empty string and absent are the same absence", () => {
    const a = ticketValue({ frontmatter: { id: "X", parent: "" }, body: "b" });
    const b = ticketValue({ frontmatter: { id: "X" }, body: "b" });
    assert.deepEqual(valueDiff(a, b), []);
  });

  test("a real value difference IS reported", () => {
    const a = ticketValue({ frontmatter: { id: "X", title: "one" }, body: "b" });
    const b = ticketValue({ frontmatter: { id: "X", title: "two" }, body: "b" });
    assert.deepEqual(valueDiff(a, b), [{ field: "frontmatter.title", primary: "one", shadow: "two" }]);
  });
});

describe("dual-write proves the two agree, and CATCHES it when they do not", () => {
  const ctx = { readStorage: fsReadStorage };

  function dual(opts = {}) {
    const dir = mkdtempSync(join(tmpdir(), "blaze-dual-"));
    const primary = fsWritePort(dir);
    const shadow = dbWritePort(sqliteExec());
    return { port: dualWritePort(primary, shadow, opts), dir, shadow };
  }

  test("a faithful write diverges on nothing", async () => {
    const { port } = dual();
    await port.write(TICKET(), ctx);
    assert.deepEqual(port.divergences, []);
  });

  test("a move agrees on both sides", async () => {
    const { port } = dual();
    const r = await port.write(TICKET(), ctx);
    await port.move({ ...TICKET(), status: "in-progress", currentFile: r.file }, ctx);
    assert.deepEqual(port.divergences, []);
  });

  test("an injected divergence IS caught — the comparison is not decorative", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-dual-"));
    const shadow = dbWritePort(sqliteExec());
    // A shadow that quietly drops the body: the exact class of bug dual-write exists for.
    const lying = { ...shadow, write: (t) => shadow.write({ ...t, body: "" }) };
    const port = dualWritePort(fsWritePort(dir), lying);
    await port.write(TICKET(), ctx);
    assert.equal(port.divergences.length, 1);
    assert.deepEqual(port.divergences[0].fields, [{ field: "body", primary: "the body", shadow: "" }]);
  });

  test("a divergence does NOT fail the verb by default — the safety net is not the outage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-dual-"));
    const shadow = dbWritePort(sqliteExec());
    const lying = { ...shadow, write: (t) => shadow.write({ ...t, body: "" }) };
    const port = dualWritePort(fsWritePort(dir), lying);
    const r = await port.write(TICKET(), ctx);          // must SUCCEED
    assert.ok(existsSync(r.file), "the primary write must still land");
  });

  test("strict mode turns a divergence into a throw, for the pre-cutover soak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-dual-"));
    const shadow = dbWritePort(sqliteExec());
    const lying = { ...shadow, write: (t) => shadow.write({ ...t, body: "" }) };
    const port = dualWritePort(fsWritePort(dir), lying, { strict: true });
    await assert.rejects(port.write(TICKET(), ctx), /dual-write divergence on write BLZ-1/);
  });

  test("a shadow that THROWS never takes the primary down with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-dual-"));
    const exploding = { name: "boom", write() { throw new Error("shadow is on fire"); },
                        move() { throw new Error("shadow is on fire"); },
                        read() { return null; }, close() {} };
    const port = dualWritePort(fsWritePort(dir), exploding);
    const r = await port.write(TICKET(), ctx);
    assert.ok(existsSync(r.file), "the primary must still write");
    assert.match(port.divergences[0].shadowError, /shadow is on fire/);
  });

  test("every divergence reaches the callback, not just the count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blaze-dual-"));
    const shadow = dbWritePort(sqliteExec());
    const lying = { ...shadow, write: (t) => shadow.write({ ...t, body: "" }) };
    const seen = [];
    const port = dualWritePort(fsWritePort(dir), lying, { onDivergence: (d) => seen.push(d) });
    await port.write(TICKET(), ctx);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, "write");
    assert.equal(seen[0].id, "BLZ-1");
  });
});

describe("dual-write against Postgres", { skip: PG ? false : "set BLAZE_TEST_PG_URL" }, () => {
  test("the filesystem and a real Postgres agree on a write and a move", async () => {
    const { PG_DDL } = await import("../../scripts/model/pg-schema.mjs");
    const pgmod = (await import("pg")).default;
    const c = new pgmod.Client(PG);
    await c.connect();
    try {
      await c.query("DROP SCHEMA IF EXISTS blaze_wp_test CASCADE");
      await c.query("CREATE SCHEMA blaze_wp_test");
      await c.query("SET search_path TO blaze_wp_test");
      await c.query(PG_DDL);
      const exec = {
        async run(sql, p) { return c.query(sql, p); },
        async all(sql, p) { return (await c.query(sql, p)).rows; },
      };
      const dir = mkdtempSync(join(tmpdir(), "blaze-dualpg-"));
      const port = dualWritePort(fsWritePort(dir), dbWritePort(exec, { dialect: "postgres" }),
                                 { strict: true });   // strict: any divergence fails the test
      const ctx = { readStorage: fsReadStorage };
      const r = await port.write(TICKET(), ctx);
      await port.move({ ...TICKET(), status: "in-progress", currentFile: r.file }, ctx);
      assert.deepEqual(port.divergences, []);
    } finally {
      await c.query("DROP SCHEMA IF EXISTS blaze_wp_test CASCADE").catch(() => {});
      await c.end();
    }
  });
});
