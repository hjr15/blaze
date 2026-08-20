// tests/model/projection.test.mjs — BLZ-287 / BLZ-288.
//
// The criterion under test: *"refresh_projection() reports every ticket a new config
// would orphan rather than failing opaquely."* Every test below is really one question —
// when the config and the data disagree, do you get a NUMBER and a LIST, or a stack
// trace naming one row?
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../../scripts/model/sqlite-schema.mjs";
import { projectionDdl, PROJECTION_TABLES } from "../../scripts/model/projection-schema.mjs";
import { refreshProjection, resolveProjection, projectionIsStale } from "../../scripts/model/projection.mjs";
import { configSeed } from "../../scripts/model/config-schema.mjs";

const PG = process.env.BLAZE_TEST_PG_URL ?? null;
const NOW = "2026-08-21T00:00:00.000Z";

function baseConfig() {
  return {
    ...configSeed(),
    project: [{ key: "BLZ", name: "Blaze", label_mode: "open", component_mode: "open" }],
    project_label: [{ project_key: "BLZ", name: "backend" },
                    { project_key: "BLZ", name: "retired-one", retired_at: "2026-01-01" }],
    project_component: [{ project_key: "BLZ", name: "engine" }],
  };
}

function openDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_PRAGMAS);
  db.exec(SQLITE_DDL);
  db.exec(projectionDdl("sqlite"));
  return db;
}

const execFor = (db) => ({
  run(sql, params) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return db.exec(sql);
    return db.prepare(sql).run(...params);
  },
  all(sql, params) { return db.prepare(sql).all(...params); },
});

function addTicket(db, { id, num, type = "task", status = "defined", priority = "medium",
                        resolution = null, parent_id = null, parent_type = null }) {
  db.prepare(`INSERT INTO ticket (id,project_key,num,type,status,title,priority,resolution,
                                  parent_id,parent_type,body,created_on,updated_on)
              VALUES (?,'BLZ',?,?,?,?,?,?,?,?,'','2026-01-01','2026-01-01')`)
    .run(id, num, type, status, `${id} title`, priority, resolution, parent_id, parent_type);
}

describe("resolveProjection — scope resolution, without a database", () => {
  test("board-wide config projects onto every project", () => {
    const p = resolveProjection(baseConfig());
    assert.ok(p.resolved_type.length > 0);
    assert.ok(p.resolved_type.every((r) => r.project_key === "BLZ"));
    assert.ok(p.resolved_type.some((r) => r.type === "task"));
  });

  test("a project-scoped row REPLACES the board-wide set, it does not merge with it", () => {
    const c = baseConfig();
    c.ticket_type = [...c.ticket_type,
      { scope: "BLZ", type: "widget", level: 0, workflow: "delivery", ord: 0 }];
    const p = resolveProjection(c);
    const types = p.resolved_type.map((r) => r.type);
    assert.deepEqual(types, ["widget"],
      "a project-scoped registry replaces the board-wide one wholesale");
  });

  test("statuses are flattened workflow -> type, so ticket->status is a two-column FK", () => {
    const p = resolveProjection(baseConfig());
    const taskStatuses = p.resolved_status.filter((r) => r.type === "task").map((r) => r.status);
    assert.deepEqual(taskStatuses, ["defined", "in-progress", "in-review", "done"]);
    const goalStatuses = p.resolved_status.filter((r) => r.type === "goal").map((r) => r.status);
    assert.deepEqual(goalStatuses, ["defined", "in-progress", "achieved"],
      "goal uses its own workflow, not delivery's");
  });

  test("a retired label is not projected — it stops being offered but is not deleted", () => {
    const p = resolveProjection(baseConfig());
    assert.deepEqual(p.resolved_label.map((r) => r.name), ["backend"]);
  });

  test("the reopen edge is flagged is_reopen so the graph view can distinguish it", () => {
    const p = resolveProjection(baseConfig());
    const e = p.resolved_transition.find((t) =>
      t.type === "task" && t.from_status === "done" && t.to_status === "defined");
    assert.ok(e, "the reopen edge must be projected");
    assert.equal(e.is_reopen, true);
  });
});

describe("refreshProjection — a config that fits reports nothing", () => {
  test("a faithful config orphans zero tickets and records its version", async () => {
    const db = openDb();
    addTicket(db, { id: "BLZ-1", num: 1 });
    addTicket(db, { id: "BLZ-2", num: 2, type: "feature", status: "in-progress" });
    const r = await refreshProjection(execFor(db), baseConfig(), { now: NOW, configVersion: 7 });
    assert.deepEqual(r.orphans, [], "a config that fits must report nothing");
    assert.equal(await projectionIsStale(execFor(db), 7), false);
    assert.equal(await projectionIsStale(execFor(db), 8), true, "a bumped config is stale");
  });

  test("every projection table is populated, not silently empty", async () => {
    const db = openDb();
    const r = await refreshProjection(execFor(db), baseConfig(), { now: NOW });
    for (const t of PROJECTION_TABLES) {
      assert.ok(r.counts[t] > 0, `${t} must be projected, got ${r.counts[t]}`);
    }
  });

  test("refreshing twice is idempotent — it rebuilds, it does not accumulate", async () => {
    const db = openDb();
    const a = await refreshProjection(execFor(db), baseConfig(), { now: NOW });
    const b = await refreshProjection(execFor(db), baseConfig(), { now: NOW });
    assert.deepEqual(a.counts, b.counts);
  });
});

describe("refreshProjection — a config that does NOT fit REPORTS, it does not throw", () => {
  test("a removed type names every ticket that used it", async () => {
    const db = openDb();
    addTicket(db, { id: "BLZ-1", num: 1, type: "task" });
    addTicket(db, { id: "BLZ-2", num: 2, type: "task" });
    addTicket(db, { id: "BLZ-3", num: 3, type: "feature" });

    const c = baseConfig();
    c.ticket_type = c.ticket_type.filter((t) => t.type !== "task");   // the "restored" config

    const r = await refreshProjection(execFor(db), c, { now: NOW });
    const byKind = r.orphans.filter((o) => o.kind === "unknown-type");
    assert.deepEqual(byKind.map((o) => o.ticket), ["BLZ-1", "BLZ-2"],
      "BOTH tickets must be named — a count of one would be the FK-error behaviour");
    assert.equal(byKind[0].value, "task");
    assert.match(byKind[0].detail, /not in the restored config/);
  });

  test("a status dropped from a workflow names the tickets sitting in it", async () => {
    const db = openDb();
    addTicket(db, { id: "BLZ-1", num: 1, status: "in-review" });
    addTicket(db, { id: "BLZ-2", num: 2, status: "defined" });

    const c = baseConfig();
    c.workflow_status = c.workflow_status.filter(
      (s) => !(s.workflow === "delivery" && s.status === "in-review"));
    c.workflow_transition = c.workflow_transition.filter(
      (t) => t.from_status !== "in-review" && t.to_status !== "in-review");

    const r = await refreshProjection(execFor(db), c, { now: NOW });
    const o = r.orphans.filter((x) => x.kind === "unknown-status");
    assert.deepEqual(o.map((x) => x.ticket), ["BLZ-1"]);
    assert.equal(o[0].value, "in-review");
  });

  test("a removed priority, resolution and link type are each reported", async () => {
    const db = openDb();
    addTicket(db, { id: "BLZ-1", num: 1, priority: "urgent" });
    addTicket(db, { id: "BLZ-2", num: 2, status: "done", resolution: "wont-do" });
    addTicket(db, { id: "BLZ-3", num: 3 });
    db.prepare("INSERT INTO ticket_link (src_id, link_type, target_id) VALUES ('BLZ-3','Blocks','BLZ-1')").run();

    const c = baseConfig();
    c.priority   = c.priority.filter((p) => p.name !== "urgent");
    c.resolution = c.resolution.filter((r) => r.name !== "wont-do");
    c.link_type  = c.link_type.filter((l) => l.name !== "Blocks");

    const r = await refreshProjection(execFor(db), c, { now: NOW });
    const kinds = Object.fromEntries(r.orphans.map((o) => [o.kind, o]));
    assert.equal(kinds["unknown-priority"].ticket, "BLZ-1");
    assert.equal(kinds["unknown-resolution"].ticket, "BLZ-2");
    assert.equal(kinds["unknown-link-type"].ticket, "BLZ-3");
    assert.equal(kinds["unknown-link-type"].value, "Blocks");
  });

  test("a parent pair that stops being legal is reported against the child", async () => {
    const db = openDb();
    addTicket(db, { id: "BLZ-1", num: 1, type: "feature" });
    addTicket(db, { id: "BLZ-2", num: 2, type: "task", parent_id: "BLZ-1", parent_type: "feature" });

    const c = baseConfig();
    c.type_parent = c.type_parent.filter(
      (p) => !(p.child_type === "task" && p.parent_type === "feature"));

    const r = await refreshProjection(execFor(db), c, { now: NOW });
    const o = r.orphans.filter((x) => x.kind === "illegal-parent-type");
    assert.deepEqual(o.map((x) => x.ticket), ["BLZ-2"], "reported against the CHILD");
  });

  test("a soft-deleted ticket is not reported — it is not work anyone must reconcile", async () => {
    const db = openDb();
    addTicket(db, { id: "BLZ-1", num: 1, type: "task" });
    db.prepare("UPDATE ticket SET deleted_at = '2026-01-02' WHERE id = 'BLZ-1'").run();

    const c = baseConfig();
    c.ticket_type = c.ticket_type.filter((t) => t.type !== "task");

    const r = await refreshProjection(execFor(db), c, { now: NOW });
    assert.deepEqual(r.orphans, []);
  });

  test("the projection is still REBUILT when it orphans tickets — reporting is not refusing", async () => {
    const db = openDb();
    addTicket(db, { id: "BLZ-1", num: 1, type: "task" });
    const c = baseConfig();
    c.ticket_type = c.ticket_type.filter((t) => t.type !== "task");

    const r = await refreshProjection(execFor(db), c, { now: NOW, configVersion: 3 });
    assert.ok(r.orphans.length > 0);
    const live = db.prepare("SELECT type FROM resolved_type WHERE type='task'").all();
    assert.deepEqual(live, [], "the new config IS live — the report describes what it costs");
    assert.equal(await projectionIsStale(execFor(db), 3), false);
  });

  test("scale: 200 orphaned tickets are ALL reported, not truncated", async () => {
    const db = openDb();
    for (let i = 1; i <= 200; i++) addTicket(db, { id: `BLZ-${i}`, num: i, type: "task" });
    const c = baseConfig();
    c.ticket_type = c.ticket_type.filter((t) => t.type !== "task");
    const r = await refreshProjection(execFor(db), c, { now: NOW });
    assert.equal(r.orphans.filter((o) => o.kind === "unknown-type").length, 200);
  });
});

describe("refreshProjection — failure leaves the old projection intact", () => {
  test("a mid-rebuild failure rolls back rather than leaving a half-built projection", async () => {
    const db = openDb();
    await refreshProjection(execFor(db), baseConfig(), { now: NOW, configVersion: 1 });
    const before = db.prepare("SELECT count(*) AS n FROM resolved_type").get().n;

    const exec = execFor(db);
    let calls = 0;
    const flaky = {
      all: exec.all,
      run(sql, params) {
        if (sql.startsWith("INSERT INTO resolved_type ") && ++calls === 2) {
          throw new Error("simulated mid-rebuild failure");
        }
        return exec.run(sql, params);
      },
    };
    await assert.rejects(
      refreshProjection(flaky, baseConfig(), { now: NOW, configVersion: 2 }),
      /simulated mid-rebuild failure/);

    assert.equal(db.prepare("SELECT count(*) AS n FROM resolved_type").get().n, before,
      "a half-built projection looks current and is not — it must roll back");
    assert.equal(await projectionIsStale(exec, 1), false, "the OLD version must still stand");
  });

  test("an unknown dialect is refused rather than silently treated as sqlite", async () => {
    const db = openDb();
    await assert.rejects(
      refreshProjection(execFor(db), baseConfig(), { dialect: "mysql" }),
      /unknown dialect "mysql"/);
  });
});

describe("refreshProjection — Postgres parity", { skip: PG ? false : "set BLAZE_TEST_PG_URL" }, () => {
  test("the same config projects the same rows and reports the same orphans", async () => {
    const { PG_DDL } = await import("../../scripts/model/pg-schema.mjs");
    const pgmod = (await import("pg")).default;
    const c = new pgmod.Client(PG);
    await c.connect();
    try {
      // A DEDICATED schema, not `public`. Dropping `public` here would delete the
      // conformance suite's tables too; that is survivable today only because the gate
      // runs in-band (--test-concurrency=1), which is a coupling no test should rely on.
      await c.query("DROP SCHEMA IF EXISTS blaze_projection_test CASCADE");
      await c.query("CREATE SCHEMA blaze_projection_test");
      await c.query("SET search_path TO blaze_projection_test");
      await c.query(PG_DDL);
      await c.query(projectionDdl("postgres"));
      await c.query(`INSERT INTO ticket (id,project_key,num,type,status,title,body,created_on,updated_on)
                     VALUES ('BLZ-1','BLZ',1,'task','defined','t','', '2026-01-01','2026-01-01')`);

      const exec = {
        async run(sql, params) { return c.query(sql, params); },
        async all(sql, params) { return (await c.query(sql, params)).rows; },
      };

      const clean = await refreshProjection(exec, baseConfig(), { dialect: "postgres", now: NOW });
      assert.deepEqual(clean.orphans, [], "a config that fits orphans nothing in Postgres too");

      const broken = baseConfig();
      broken.ticket_type = broken.ticket_type.filter((t) => t.type !== "task");
      const r = await refreshProjection(exec, broken, { dialect: "postgres", now: NOW });
      assert.deepEqual(r.orphans.map((o) => [o.kind, o.ticket]), [["unknown-type", "BLZ-1"]],
        "the SAME orphan, reported the SAME way, on the other driver");
    } finally {
      await c.query("DROP SCHEMA IF EXISTS blaze_projection_test CASCADE").catch(() => {});
      await c.end();
    }
  });
});
