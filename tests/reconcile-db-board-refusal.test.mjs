// tests/reconcile-db-board-refusal.test.mjs — BLZ-723.
//
// A db-mode board moves tickets only by explicit `blaze move`. Reconcile derives moves from
// branches and PRs on file boards, so every door to it refuses there: the CLI (dry run
// included), the board server's preview, the page's button, and the supervisor's loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDb } from "../scripts/db-runner.mjs";
import { startServer } from "../scripts/serve.mjs";
import { pageHtml } from "../scripts/views/page.mjs";
import { createApp } from "../scripts/supervisor.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { DB_BOARD_RECONCILE_REFUSAL } from "../scripts/reconcile.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";

const RECONCILE = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "reconcile.mjs");
const NEEDLE = "moves tickets explicitly";

async function dbReady() {
  const roots = dbBoard();
  assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
  return roots;
}

async function withEnv(name, value, fn) {
  const before = process.env[name];
  process.env[name] = value;
  try { return await fn(); }
  finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
}

async function withDbServer(roots, fn) {
  return withEnv("BLAZE_WRITE_PORT", "db", async () => {
    const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
    await new Promise((res) => server.once("listening", res));
    try { return await fn(`http://127.0.0.1:${server.address().port}`); }
    finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
}

test("BLZ-723: the refusal text names the explicit-move rule", () => {
  assert.ok(DB_BOARD_RECONCILE_REFUSAL.includes(NEEDLE), DB_BOARD_RECONCILE_REFUSAL);
});

test("BLZ-723: blaze reconcile refuses on a db board, dry run included", async () => {
  const roots = await dbReady();
  for (const extra of [[], ["--apply"]]) {
    const r = spawnSync(process.execPath, [RECONCILE, ...extra], {
      encoding: "utf8", timeout: 30000,
      env: { ...process.env, BLAZE_ROOT: roots.dataRoot, BLAZE_PROJECTS_DIR: roots.projectsDir,
             BLAZE_WRITE_PORT: "db", BLAZE_READONLY: "" },
    });
    assert.equal(r.status, 1, `args ${JSON.stringify(extra)}: ${r.stdout}${r.stderr}`);
    assert.ok(r.stderr.includes(NEEDLE), r.stderr);
  }
});

test("BLZ-723: GET /api/reconcile-preview refuses on a db board", async () => {
  const roots = await dbReady();
  await withDbServer(roots, async (base) => {
    const r = await fetch(`${base}/api/reconcile-preview`);
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.ok(body.error.includes(NEEDLE), JSON.stringify(body));
    assert.deepEqual(body.changes, []);
  });
});

test("BLZ-723: the page hides the reconcile button on a db board, and keeps it on fs", async () => {
  const roots = await dbReady();
  await withDbServer(roots, async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /id="reconcileBtn"/);
  });
  const fsRoots = dbBoard();
  assert.match(pageHtml({ projectsDir: fsRoots.projectsDir }), /id="reconcileBtn"/);
});

test("BLZ-723: the supervisor's reconcile loop refuses on a db board", async () => {
  const roots = await dbReady();
  await withEnv("BLAZE_WRITE_PORT", "db", async () => {
    const app = createApp(loadConfig({ root: roots.dataRoot }), {
      root: roots.dataRoot,
      identity: { state: "absent", hasIdentity: false, store: null, close() {} },
    });
    const r = await app.runReconcile();
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.error.includes(NEEDLE), JSON.stringify(r));
  });
});
