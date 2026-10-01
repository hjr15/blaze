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
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { fsReadStorage } from "../../scripts/model/read-storage.mjs";
import { memStorage, fsStorage } from "../../scripts/model/storage.mjs";
import { scratchRegistry } from "../helpers/scratch.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "../helpers/pg-scratch.mjs";
import { fsWritePort, dbWritePort, dualWritePort, selectWritePort, valueDiff,
         ticketValue, WRITE_PORT_ENV, COLUMN_FIELDS,
         extraFields } from "../../scripts/model/write-port.mjs";

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

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
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-wp-")));
    const port = fsWritePort(dir);
    const { file } = port.write(TICKET());
    assert.ok(existsSync(file), "a real file must appear");
    assert.match(file, /BLZ\/defined\/BLZ-1-a-task\.md$/);
    assert.match(readFileSync(file, "utf8"), /title: A task/);
  });

  test("an existing ticket keeps its filename — edit has never renamed one", () => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-wp-")));
    const port = fsWritePort(dir);
    const { file } = port.write(TICKET());
    const t = TICKET();
    t.frontmatter.title = "Renamed entirely";
    const again = port.write({ ...t, currentFile: file });
    assert.equal(again.file, file, "the slug must not be recomputed from the new title");
  });

  test("move relocates by the path authority, never by arithmetic on the handle", () => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-wp-")));
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
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-dual-")));
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
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-dual-")));
    const shadow = dbWritePort(sqliteExec());
    // A shadow that quietly drops the body: the exact class of bug dual-write exists for.
    const lying = { ...shadow, write: (t) => shadow.write({ ...t, body: "" }) };
    const port = dualWritePort(fsWritePort(dir), lying);
    await port.write(TICKET(), ctx);
    assert.equal(port.divergences.length, 1);
    assert.deepEqual(port.divergences[0].fields, [{ field: "body", primary: "the body", shadow: "" }]);
  });

  test("a divergence does NOT fail the verb by default — the safety net is not the outage", async () => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-dual-")));
    const shadow = dbWritePort(sqliteExec());
    const lying = { ...shadow, write: (t) => shadow.write({ ...t, body: "" }) };
    const port = dualWritePort(fsWritePort(dir), lying);
    const r = await port.write(TICKET(), ctx);          // must SUCCEED
    assert.ok(existsSync(r.file), "the primary write must still land");
  });

  test("strict mode turns a divergence into a throw, for the pre-cutover soak", async () => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-dual-")));
    const shadow = dbWritePort(sqliteExec());
    const lying = { ...shadow, write: (t) => shadow.write({ ...t, body: "" }) };
    const port = dualWritePort(fsWritePort(dir), lying, { strict: true });
    await assert.rejects(port.write(TICKET(), ctx), /dual-write divergence on write BLZ-1/);
  });

  test("a shadow that THROWS never takes the primary down with it", async () => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-dual-")));
    const exploding = { name: "boom", write() { throw new Error("shadow is on fire"); },
                        move() { throw new Error("shadow is on fire"); },
                        read() { return null; }, close() {} };
    const port = dualWritePort(fsWritePort(dir), exploding);
    const r = await port.write(TICKET(), ctx);
    assert.ok(existsSync(r.file), "the primary must still write");
    assert.match(port.divergences[0].shadowError, /shadow is on fire/);
  });

  test("every divergence reaches the callback, not just the count", async () => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-dual-")));
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
      // BLZ-503: registered, like every other site in this file. This one runs ONLY with
      // BLAZE_TEST_PG_URL set, so no local run can observe it leaking and only CI could —
      // which is the case for BLZ-516's run-level gate, made by the gate itself.
      const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-dualpg-")));
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

describe("frontmatter that is not a column still round-trips (BLZ-295)", () => {
  // The soak found 926 of 2,561 tickets (36.2%) carrying at least one field the ticket
  // table had no column for. Eight got columns; everything else goes to extra_json,
  // because Blaze has always preserved frontmatter keys it does not recognise and
  // silently dropping one on write is the failure this whole exercise exists to stop.
  const RICH = () => ({
    project: "BLZ", status: "defined",
    frontmatter: {
      id: "BLZ-9", project: "BLZ", type: "risk", title: "A risk",
      priority: "high", assignee: "unassigned",
      created: "2026-01-01", updated: "2026-01-02", links: [],
      branch: "BLZ-9-thing", pr: "74", ref: "ADR-0021",
      category: "portability", verification: "demonstration", derived: "operator",
      likelihood: "medium", impact: "high",
      labels: ["zeta", "alpha"], components: ["engine", "blaze"],
      somethingNobodyPlannedFor: "kept", anotherOne: ["a", "b"],
    },
    body: "b",
  });

  test("all eight new columns survive a write/read cycle", async () => {
    const port = dbWritePort(sqliteExec());
    await port.write(RICH());
    const fm = (await port.read("BLZ-9")).frontmatter;
    for (const [k, v] of Object.entries({
      branch: "BLZ-9-thing", pr: "74", ref: "ADR-0021", category: "portability",
      verification: "demonstration", derived: "operator",
      likelihood: "medium", impact: "high",
    })) assert.equal(fm[k], v, `${k} must round-trip`);
  });

  test("an unrecognised key survives verbatim, including a nested value", async () => {
    const port = dbWritePort(sqliteExec());
    await port.write(RICH());
    const fm = (await port.read("BLZ-9")).frontmatter;
    assert.equal(fm.somethingNobodyPlannedFor, "kept");
    assert.deepEqual(fm.anotherOne, ["a", "b"]);
  });

  test("labels and components keep their AUTHORED order, not alphabetical", async () => {
    // Sorting them would re-emit 2,500 tickets with their taxonomy reshuffled at
    // cutover — not data loss, but a diff on every ticket for no reason.
    const port = dbWritePort(sqliteExec());
    await port.write(RICH());
    const fm = (await port.read("BLZ-9")).frontmatter;
    assert.deepEqual(fm.labels, ["zeta", "alpha"]);
    assert.deepEqual(fm.components, ["engine", "blaze"]);
  });

  test("a field WITH a column never also lands in extra_json", () => {
    // Stored twice, the second write wins — and which one that is depends on read
    // order, so the bug would be intermittent.
    const extra = extraFields(RICH().frontmatter);
    for (const k of Object.keys(extra)) {
      assert.ok(!COLUMN_FIELDS.has(k), `${k} has a column and must not be in extra_json`);
    }
    assert.deepEqual(Object.keys(extra).sort(), ["anotherOne", "somethingNobodyPlannedFor"]);
  });

  test("empty and absent values are not stored as present", () => {
    const extra = extraFields({ id: "X", blank: "", nothing: null, missing: undefined, none: [] });
    assert.deepEqual(extra, {}, "an empty value is an absence, not a value to preserve");
  });

  test("a corrupt extra_json degrades to empty rather than taking the read down", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec);
    await port.write(RICH());
    exec._db.prepare("UPDATE ticket SET extra_json = 'not json at all' WHERE id = 'BLZ-9'").run();
    const rec = await port.read("BLZ-9");
    assert.equal(rec.frontmatter.title, "A risk", "the rest of the ticket must still read");
    assert.equal(rec.frontmatter.somethingNobodyPlannedFor, undefined);
  });

  test("a schema DEFAULT the file does not state is a real difference, and is reported", async () => {
    // The ticket table declares `assignee NOT NULL DEFAULT 'unassigned'`, so a ticket
    // written without one comes back from the database WITH one while the file still
    // has none. That is not data loss — but it is not agreement either, and the
    // comparison must say so rather than quietly normalising it away. Every one of the
    // 2,562 live tickets carries an assignee, which is why the soak sees this zero
    // times; a hand-built ticket that omits it would surface here.
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-default-")));
    const port = dualWritePort(fsWritePort(dir), dbWritePort(sqliteExec()));
    const t = RICH();
    delete t.frontmatter.assignee;
    await port.write(t, { readStorage: fsReadStorage });
    assert.deepEqual(port.divergences[0].fields,
      [{ field: "frontmatter.assignee", primary: undefined, shadow: "unassigned" }]);
  });

  test("a full-fidelity write diverges on nothing against the filesystem", async () => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blaze-rich-")));
    const port = dualWritePort(fsWritePort(dir), dbWritePort(sqliteExec()), { strict: true });
    await port.write(RICH(), { readStorage: fsReadStorage });
    assert.deepEqual(port.divergences, []);
  });
});

// BLZ-667: db-mode id allocation. `allocate` advances project_counter by one upsert and
// returns the same { id, n } shape as ids.mjs's allocateId, so callers need no adapter.
describe("dbWritePort.allocate (BLZ-667)", () => {
  test("dbWritePort.allocate returns sequential numbers for one project", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec, { dialect: "sqlite" });
    const a = await port.allocate("BLZ");
    const b = await port.allocate("BLZ");
    assert.deepEqual([a.n, b.n], [1, 2]);
    assert.deepEqual([a.id, b.id], ["BLZ-1", "BLZ-2"]);
  });

  test("dbWritePort.allocate keeps separate projects independent", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec, { dialect: "sqlite" });
    const a = await port.allocate("BLZ");
    const b = await port.allocate("OBA");
    assert.equal(a.n, 1);
    assert.equal(b.n, 1); // OBA's own counter, not BLZ's
  });

  test("a rejected ticket insert burns its allocated number — accepted, per the design's own risk table", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec, { dialect: "sqlite" });
    const { id, n } = await port.allocate("BLZ");
    // An empty title genuinely rejects, via the schema's CHECK on title. Overridden
    // INSIDE frontmatter: write() reads frontmatter.id/.title, not top-level keys.
    const t1 = TICKET();
    await assert.rejects(() => port.write({ ...t1, frontmatter: { ...t1.frontmatter, id, title: "" } }));
    const { n: nextN } = await port.allocate("BLZ");
    // Allocation and the insert are two separately-committed operations, so the failed
    // attempt's number is NOT reused — a gap, and gaps are tolerated by design (ADR-0018).
    assert.equal(nextN, n + 1);
  });

  test("allocated id round-trips through dbWritePort's own num() parsing", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec, { dialect: "sqlite" });
    await port.allocate("BLZ");
    const { id } = await port.allocate("BLZ"); // BLZ-2, so the fixture's own BLZ-1 cannot mask a misplaced override
    const t = TICKET();
    await port.write({ ...t, frontmatter: { ...t.frontmatter, id } }); // must not throw "cannot derive num from id"
    // Read it back: merely not throwing does not prove the override took effect.
    const written = await port.read(id);
    assert.equal(written.frontmatter.id, id);
  });

  test("a mid-sequence failure in persist() leaves no partial ticket row", async () => {
    const exec = sqliteExec();
    const port = dbWritePort(exec, { dialect: "sqlite" });
    const { id } = await port.allocate("BLZ");
    // Duplicate labels violate ticket_label's PRIMARY KEY (ticket_id, label), AFTER the
    // ticket row itself has been upserted — the half-written state a transaction prevents.
    const t = TICKET();
    await assert.rejects(() => port.write({ ...t, frontmatter: { ...t.frontmatter, id, labels: ["a", "a"] } }));
    const rows = await exec.all("SELECT 1 AS hit FROM ticket WHERE id = ?", [id]);
    assert.equal(rows.length, 0, "a half-written ticket row survived a mid-sequence failure");
  });
});

// BLZ-671 I-1: a stale counter must not hand out a number that already has a ticket row —
// import --allocate-ids would upsert over it. Rows at n+1 and n+2 with the counter at n:
// allocate skips both and returns n+3.
async function assertAllocateSkipsTaken(exec, dialect) {
  const port = dbWritePort(exec, { dialect });
  await port.allocate("BLZ"); // counter at n = 1
  for (const id of ["BLZ-2", "BLZ-3"]) {
    const t = TICKET();
    await port.write({ ...t, frontmatter: { ...t.frontmatter, id, title: `taken ${id}` } });
  }
  const got = await port.allocate("BLZ");
  assert.deepEqual(got, { id: "BLZ-4", n: 4 });
  assert.equal((await port.read("BLZ-2")).frontmatter.title, "taken BLZ-2");
  assert.equal((await port.read("BLZ-3")).frontmatter.title, "taken BLZ-3");
}

test("dbWritePort.allocate skips numbers that already have a ticket row (sqlite)", async () => {
  await assertAllocateSkipsTaken(sqliteExec(), "sqlite");
});

test("dbWritePort.allocate skips numbers that already have a ticket row (postgres)", PG_SKIP, async () => {
  const db = await scratchPgDb("allocskip");
  const client = await pgClient(db.url);
  try {
    const { createDbSchema } = await import("../../scripts/model/db-schema-version.mjs");
    const { pgExec } = await import("../../scripts/model/write-port-resolve.mjs");
    await createDbSchema(pgExec(client), { dialect: "postgres" });
    await assertAllocateSkipsTaken(pgExec(client), "postgres");
  } finally { await client.end(); await db.drop(); }
});

// BLZ-667 Task 5: fsWritePort.allocate is an injected seam, `title` passed at CALL time —
// resolveWritePort builds the port before the ticket's title is known.
test("fsWritePort.allocate calls the injected function with project and title", async () => {
  const calls = [];
  const fakeAllocate = async (project, { title }) => { calls.push([project, title]); return { id: `${project}-9`, n: 9, claimFile: "/tmp/fake-claim" }; };
  const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage, { allocate: fakeAllocate });
  const result = await port.allocate("BLZ", { title: "A test ticket" });
  assert.deepEqual(calls, [["BLZ", "A test ticket"]]);
  assert.deepEqual(result, { id: "BLZ-9", n: 9, claimFile: "/tmp/fake-claim" });
});

test("fsWritePort.allocate with no injected function refuses clearly, not silently", async () => {
  const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage);
  await assert.rejects(() => port.allocate("BLZ", { title: "x" }), /no allocate function was injected/);
});

// BLZ-667 Task 6: dualWritePort.allocate delegates to the primary only — "the primary
// decides every outcome" applies to allocation exactly as it does to write/move/exists.
test("dualWritePort.allocate delegates to the primary only, forwarding title", async () => {
  let shadowCalled = false;
  const primary = { name: "fs", allocate: async (p, { title }) => ({ id: `${p}-1`, n: 1, title }) };
  const shadow = { name: "db", allocate: async () => { shadowCalled = true; return { id: "X-99", n: 99 }; } };
  const port = dualWritePort(primary, shadow);
  const result = await port.allocate("BLZ", { title: "A test ticket" });
  assert.deepEqual(result, { id: "BLZ-1", n: 1, title: "A test ticket" });
  assert.equal(shadowCalled, false);
});

// BLZ-667 Task 7: `allocate()` proven identical across both write dialects. One assertion
// function, run against a real SQLite driver and (when BLAZE_TEST_PG_URL is set) a real
// Postgres server — the same behaviour, not just the same code path.
async function assertAllocateSequential(exec, dialect, key) {
  const port = dbWritePort(exec, { dialect });
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await port.allocate(key));
  assert.deepEqual(results.map((r) => r.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((r) => r.id), [1, 2, 3, 4, 5].map((n) => `${key}-${n}`));
}

test("dbWritePort.allocate is sequential on sqlite", async () => {
  await assertAllocateSequential(sqliteExec(), "sqlite", "SEQ");
});

test("dbWritePort.allocate is sequential on postgres", { skip: PG ? false : "set BLAZE_TEST_PG_URL" }, async () => {
  // Real schema setup, per this repo's own established pattern (tests/model/config-install
  // .test.mjs's "BLZ-377: Postgres installs the same namespace" test): a DEDICATED database
  // per test run, not a shared one — schema creation itself collides if two runs race it
  // against one database.
  const pg = (await import("pg")).default;
  const { createDbSchema } = await import("../../scripts/model/db-schema-version.mjs");
  const { pgExec } = await import("../../scripts/model/write-port-resolve.mjs");
  const dbName = `blz_allocate_seq_${process.pid}`;
  const admin = new pg.Client(PG);
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const dbUrl = new URL(PG);
  dbUrl.pathname = `/${dbName}`;
  const client = new pg.Client(dbUrl.toString());
  await client.connect();
  try {
    await createDbSchema(pgExec(client), { dialect: "postgres" });
    const key = `SQ${randomUUID().slice(0, 6).toUpperCase()}`;
    await assertAllocateSequential(pgExec(client), "postgres", key);
  } finally {
    await client.end(); // runs even if an assertion above throws
    const cleanup = new pg.Client(PG);
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await cleanup.end();
  }
});

// BLZ-672: `created_on`/`updated_on` are NOT NULL; an imported row may carry neither.
describe("dbWritePort stamps a MISSING date (BLZ-672)", () => {
  const undated = () => {
    const t = TICKET();
    const { created, updated, ...fm } = t.frontmatter;
    void created; void updated;
    return { ...t, frontmatter: fm };
  };

  test("no created/updated → both are the injected today", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite", today: () => "2026-09-30" });
    await port.write(undated());
    const r = await port.read("BLZ-1");
    assert.equal(r.frontmatter.created, "2026-09-30");
    assert.equal(r.frontmatter.updated, "2026-09-30");
  });

  test("created only → updated follows created, not today", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite", today: () => "2026-09-30" });
    const t = undated();
    await port.write({ ...t, frontmatter: { ...t.frontmatter, created: "2026-02-02" } });
    const r = await port.read("BLZ-1");
    assert.equal(r.frontmatter.created, "2026-02-02");
    assert.equal(r.frontmatter.updated, "2026-02-02");
  });

  test("present dates are written verbatim — the clock is never consulted", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite",
      today: () => { throw new Error("the clock must not be read when both dates are present"); } });
    await port.write(TICKET());
    const r = await port.read("BLZ-1");
    assert.equal(r.frontmatter.created, "2026-01-01");
    assert.equal(r.frontmatter.updated, "2026-01-01");
  });
});

// BLZ-671: `reserve(id)` — "this explicit id is now taken". Import's `BLZ-900` row never goes
// through `allocate`, so without it a later db-mode `new` hands 900 out again.
describe("reserve (BLZ-671)", () => {
  test("dbWritePort.reserve raises the counter to the id's number, so the next allocate follows it", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite" });
    await port.allocate("BLZ");                              // BLZ-1
    assert.deepEqual(await port.reserve("BLZ-900", { title: "x" }), {});
    assert.equal((await port.allocate("BLZ")).id, "BLZ-901");
  });

  test("dbWritePort.reserve never lowers the counter", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite" });
    for (let i = 0; i < 5; i++) await port.allocate("BLZ");  // counter at 5
    await port.reserve("BLZ-2");
    assert.equal((await port.allocate("BLZ")).id, "BLZ-6");
  });

  test("dbWritePort.reserve refuses an id that already has a row — the write after it would overwrite", async () => {
    const port = dbWritePort(sqliteExec(), { dialect: "sqlite" });
    await port.write(TICKET());                              // BLZ-1, e.g. a concurrent db-mode `new`
    await assert.rejects(port.reserve("BLZ-1", { title: "x" }), /BLZ-1 already exists in the database/);
  });

  test("fsWritePort.reserve calls the injected function with id and options", async () => {
    const calls = [];
    const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage,
      { reserve: async (id, opts) => { calls.push([id, opts]); return { claimFile: "/tmp/fake" }; } });
    assert.deepEqual(await port.reserve("BLZ-9", { project: "BLZ", title: "t" }), { claimFile: "/tmp/fake" });
    assert.deepEqual(calls, [["BLZ-9", { project: "BLZ", title: "t" }]]);
  });

  test("fsWritePort.reserve with no injected function refuses clearly, not silently", async () => {
    const port = fsWritePort("/tmp/does-not-matter/projects", fsStorage, fsReadStorage);
    await assert.rejects(() => port.reserve("BLZ-9", { title: "x" }), /no reserve function was injected/);
  });

  test("dualWritePort.reserve delegates to the primary only", async () => {
    let shadowCalled = false;
    const primary = { name: "fs", reserve: async (id, o) => ({ claimFile: `/c/${id}/${o.title}` }) };
    const shadow = { name: "db", reserve: async () => { shadowCalled = true; return {}; } };
    assert.deepEqual(await dualWritePort(primary, shadow).reserve("BLZ-9", { title: "t" }), { claimFile: "/c/BLZ-9/t" });
    assert.equal(shadowCalled, false);
  });
});

// BLZ-673: the store fingerprint the db groomer compares across an agent run. Every port write
// appends a ticket_event row, so its last id moves; nothing else here is allowed to move it.
async function assertFingerprint(exec, dialect) {
  const port = dbWritePort(exec, { dialect });
  assert.deepEqual(await port.storeFingerprint(), { dialect, lastEventId: 0 });
  await port.write(TICKET());
  const a = await port.storeFingerprint();
  assert.ok(a.lastEventId > 0, JSON.stringify(a));
  await port.read("BLZ-1");
  await port.exists({ frontmatter: { id: "BLZ-1" } });
  assert.deepEqual(await port.storeFingerprint(), a, "reads do not move it");
  await port.write({ ...TICKET(), body: "edited" });
  assert.ok((await port.storeFingerprint()).lastEventId > a.lastEventId, "a second write moves it");
}

test("dbWritePort.storeFingerprint moves on writes and only on writes (sqlite)", async () => {
  await assertFingerprint(sqliteExec(), "sqlite");
});

test("dbWritePort.storeFingerprint moves on writes and only on writes (postgres)", PG_SKIP, async () => {
  const db = await scratchPgDb("fingerprint");
  const client = await pgClient(db.url);
  try {
    const { createDbSchema } = await import("../../scripts/model/db-schema-version.mjs");
    const { pgExec } = await import("../../scripts/model/write-port-resolve.mjs");
    await createDbSchema(pgExec(client), { dialect: "postgres" });
    await assertFingerprint(pgExec(client), "postgres");
  } finally { await client.end(); await db.drop(); }
});
