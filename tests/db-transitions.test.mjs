// tests/db-transitions.test.mjs — BLZ-680 (spec §5.7): under BLAZE_WRITE_PORT=db the metrics
// view's status history comes from `ticket_transition`, and `blaze db load` (and the SQLite
// `blaze db init`) import the git-era history into it once. fs mode is unchanged: it still
// reads git, and `dbTransitions` answers `undefined` there so the page derives it as before.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { importTransitionsExec } from "../scripts/migrate/import-transitions.mjs";
import { DatabaseSync } from "node:sqlite";
import { SQLITE_DDL, SQLITE_PRAGMAS } from "../scripts/model/sqlite-schema.mjs";
import { sqliteExec } from "../scripts/model/write-port-resolve.mjs";
import { dbTransitions } from "../scripts/model/transitions-db.mjs";
import { openSqliteRead } from "../scripts/model/sqlite-storage.mjs";
import { shadowDbPath } from "../scripts/model/write-port-resolve.mjs";
import { postgresReader } from "../scripts/model/pg-storage.mjs";
import { runDb } from "../scripts/db-runner.mjs";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";
import { PG_SKIP, scratchPgDb, pgClient } from "./helpers/pg-scratch.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

/** dbBoard() as a git repo whose history moved ENG-1 defined → in-progress: one transition. */
function gitBoard() {
  const roots = dbBoard();
  git(roots.dataRoot, "init", "-q");
  git(roots.dataRoot, "config", "user.email", "t@t.t");
  git(roots.dataRoot, "config", "user.name", "t");
  git(roots.dataRoot, "add", "-A");
  git(roots.dataRoot, "commit", "-qm", "seed");
  mkdirSync(join(roots.projectsDir, "ENG", "in-progress"), { recursive: true });
  renameSync(join(roots.projectsDir, "ENG", "defined", "ENG-1-a.md"),
             join(roots.projectsDir, "ENG", "in-progress", "ENG-1-a.md"));
  git(roots.dataRoot, "add", "-A");
  git(roots.dataRoot, "commit", "-qm", "move");
  return roots;
}

describe("the pure parts", () => {
  test("importTransitionsExec: BLZ-281's rules through an exec — verbatim, backfill, the rest counted", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SQLITE_PRAGMAS); db.exec(SQLITE_DDL);
    db.prepare(`INSERT INTO ticket (id, project_key, num, type, status, title, created_on, updated_on)
                VALUES ('ENG-1','ENG',1,'task','done','t','2026-01-01','2026-01-01')`).run();
    const r = await importTransitionsExec(sqliteExec(db), { transitions: [
      { id: "ENG-1", from: "defined", to: "in-progress", ts: "2026-10-01T10:00:00+10:00" },
      { id: "ENG-9", from: "defined", to: "done", ts: "2026-10-01T11:00:00+10:00" },
      { id: "ENG-1", from: "in-progress", to: "done", ts: null },
    ] }, { knownIds: new Set(["ENG-1"]), dialect: "sqlite" });
    assert.deepEqual({ imported: r.imported, ...r.skipped, coveragePct: r.coveragePct },
                     { imported: 1, unknownTicket: 1, malformed: 1, coveragePct: 100 });
    assert.deepEqual({ ...db.prepare("SELECT at, actor, source, from_status, to_status FROM ticket_event").get() },
      { at: "2026-10-01T10:00:00+10:00", actor: "unknown", source: "git-backfill",
        from_status: "defined", to_status: "in-progress" });
    await assert.rejects(importTransitionsExec(sqliteExec(db), {}, { knownIds: new Set(), dialect: "mysql" }),
                         /unknown dialect "mysql"/);
  });

  test("dbTransitions answers only for db mode's metrics view", async () => {
    const rs = { listTransitions: async () => [{ id: "ENG-1" }] };
    assert.deepEqual(await dbTransitions(rs, "db", "metrics", "/p"), [{ id: "ENG-1" }]);
    assert.equal(await dbTransitions(rs, "db", "board", "/p"), undefined, "no other view pays for the query");
    assert.equal(await dbTransitions(rs, "fs", "metrics", "/p"), undefined, "fs keeps git");
    assert.equal(await dbTransitions(rs, "dual", "metrics", "/p"), undefined, "dual keeps git");
  });
});

test("SQLite `blaze db init` imports the git history, and the shadow reader returns it", async () => {
  const roots = gitBoard();
  assert.equal(await runDb(["init"], { ...QUIET, roots }), 0);
  const r = openSqliteRead(shadowDbPath(roots.dataRoot));
  try {
    const got = r.listTransitions(null);
    assert.equal(got.length, 1);
    assert.deepEqual({ ...got[0], ts: "*" }, { id: "ENG-1", from: "defined", to: "in-progress", ts: "*" });
    assert.match(got[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  } finally { r.close(); }
});

/** The metrics view's cumulative-flow series, as the server rendered it. */
async function cfdSeries(base) {
  const r = await fetch(`${base}/view/metrics`);
  assert.equal(r.status, 200);
  const m = /id="cfd-series">([\s\S]*?)<\/script>/.exec((await r.json()).html);
  assert.ok(m, "the metrics view carries its series");
  return JSON.parse(m[1]);
}

/** The same series from the PAGE route's first render (`GET /?view=metrics`). */
async function pageSeries(base) {
  const r = await fetch(`${base}/?view=metrics`);
  assert.equal(r.status, 200);
  const m = /id="cfd-series">([\s\S]*?)<\/script>/.exec(await r.text());
  assert.ok(m, "the page's metrics view carries its series");
  return JSON.parse(m[1]);
}

async function withDbBoard(fn) {
  const roots = dbBoard();               // NOT a git repo: git has no history to offer here
  assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = "db";
  try { await fn(roots); }
  finally {
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
    else process.env.BLAZE_WRITE_PORT = before;
  }
}

for (const [name, boot] of [
  ["blaze board", (roots) => startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir })],
  ["blaze start", (roots) => {
    const app = createApp(loadConfig({ root: roots.dataRoot }), { root: roots.dataRoot });
    app.server.listen(0, "127.0.0.1");
    return app.server;
  }],
]) {
  test(`${name} under db: a move made through the port shows in the metrics history`, async () => {
    await withDbBoard(async (roots) => {
      const server = boot(roots);
      if (!server.listening) await new Promise((res) => server.once("listening", res));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        assert.deepEqual(await cfdSeries(base), [], "no history yet: nothing has moved");
        assert.deepEqual(await pageSeries(base), []);
        if (name === "blaze board") {
          const m = await fetch(`${base}/api/move`, { method: "POST",
            headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
            body: JSON.stringify({ id: "ENG-1", to: "in-progress" }) });
          assert.equal(m.status, 200, await m.text());
        } else {
          // The supervisor serves no /api/move; write the event the port would have written.
          const r = openSqliteRead(shadowDbPath(roots.dataRoot));
          try {
            r.appendEvent(null, { ticket_id: "ENG-1", kind: "transition", from_status: "defined",
                                  to_status: "in-progress", source: "cli" });
          } finally { r.close(); }
        }
        // Before BLZ-680 this stayed [] — the page asked git, and this board has no git history.
        assert.ok((await cfdSeries(base)).length > 0, "the database's transition reached the view");
        assert.ok((await pageSeries(base)).length > 0, "…and the page route's first render");
      } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    });
  });
}

test("Postgres `blaze db load` imports the git history as transition events", PG_SKIP, async () => {
  const db = await scratchPgDb("transitions");
  try {
    const roots = gitBoard();
    const pgIo = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                   openPostgresClient: (c) => pgClient(c) };
    assert.equal(await runDb(["init"], { ...QUIET, roots, ...pgIo }), 0);
    const out = [];
    const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
    assert.equal(await runDb(["load"], { ...io, roots, ...pgIo }), 0, out.join("\n"));
    assert.match(out.join("\n"), /transitions\s+1\s+\(from git history; 1 tickets, 100% covered\)/);
    const c = await pgClient(db.url);
    try {
      const got = await postgresReader(c).listTransitions(null);
      assert.equal(got.length, 1);
      assert.deepEqual([got[0].id, got[0].from, got[0].to], ["ENG-1", "defined", "in-progress"]);
      const ev = (await c.query("SELECT actor, source FROM ticket_event")).rows;
      assert.deepEqual(ev, [{ actor: "unknown", source: "git-backfill" }]);
    } finally { await c.end(); }
  } finally { await db.drop(); }
});

test("a load from a tree with no git history SAYS so — 0 is not reported as 'no moves'", PG_SKIP, async () => {
  const db = await scratchPgDb("nogit");
  try {
    const roots = dbBoard();
    const pgIo = { resolveDbConfig: () => ({ driver: "postgres", connection: db.url }),
                   openPostgresClient: (c) => pgClient(c) };
    assert.equal(await runDb(["init"], { ...QUIET, roots, ...pgIo }), 0);
    const out = [];
    const io = { log: (s) => out.push(String(s)), err: (s) => out.push(String(s)), env: {} };
    assert.equal(await runDb(["load"], { ...io, roots, ...pgIo }), 0, out.join("\n"));
    assert.match(out.join("\n"), /⚠ transitions {2}0 — no git history at .*, so none was imported/);
  } finally { await db.drop(); }
});
