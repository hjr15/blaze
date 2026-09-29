// tests/serve-db-mode.test.mjs — BLZ-670.
//
// The board SERVER under BLAZE_WRITE_PORT=db. Every route resolves its reader per request
// (as the write port already was, BLZ-301), so a browser sees what the database holds, and a
// write stages by mode rather than trying to commit an id handle as a file. Each test starts
// its own board and server, so none depends on another's order.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runDb } from "../scripts/db-runner.mjs";
import { startServer, CSRF } from "../scripts/serve.mjs";
import { dbBoard, QUIET } from "./helpers/db-board.mjs";

async function withDbServer(fn) {
  const roots = dbBoard();
  assert.equal(0, await runDb(["init"], { ...QUIET, roots }));
  const before = process.env.BLAZE_WRITE_PORT;
  process.env.BLAZE_WRITE_PORT = "db";
  const server = startServer({ port: 0, root: roots.dataRoot, projectsDir: roots.projectsDir });
  await new Promise((res) => server.once("listening", res));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, roots });
  } finally {
    server.close();
    if (before === undefined) delete process.env.BLAZE_WRITE_PORT;
    else process.env.BLAZE_WRITE_PORT = before;
  }
}

const move = (base, id, to) => fetch(`${base}/api/move`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-blaze-csrf": CSRF },
  body: JSON.stringify({ id, to }),
});

describe("blaze board under BLAZE_WRITE_PORT=db", () => {
  test("POST /api/move returns 200", async () => {
    await withDbServer(async ({ base }) => {
      const r = await move(base, "ENG-1", "in-progress");
      assert.equal(r.status, 200, JSON.stringify(await r.json().catch(() => ({}))));
    });
  });

  // The panel renders no status for the ticket itself (only for its children), so the proof
  // it read the DATABASE is the `updated` the move stamped: the file still says 2026-01-01.
  test("after a move, GET /api/panel shows the database's record", async () => {
    await withDbServer(async ({ base }) => {
      const m = await move(base, "ENG-1", "in-progress");
      assert.equal(m.status, 200, JSON.stringify(await m.json().catch(() => ({}))));
      const r = await fetch(`${base}/api/panel?id=ENG-1`);
      const body = await r.text();
      assert.equal(r.status, 200, body);
      const today = new Date().toISOString().slice(0, 10);
      assert.match(body, new RegExp(`<th>updated</th><td>${today}</td>`));
      assert.doesNotMatch(body, /<th>updated<\/th><td>2026-01-01<\/td>/);
    });
  });

  test("GET /api/live returns 200", async () => {
    await withDbServer(async ({ base }) => {
      const r = await fetch(`${base}/api/live`);
      assert.equal(r.status, 200, await r.text());
    });
  });

  test("GET / returns 200 and renders ENG-1", async () => {
    await withDbServer(async ({ base }) => {
      const r = await fetch(`${base}/`);
      const body = await r.text();
      assert.equal(r.status, 200, body.slice(0, 500));
      assert.match(body, /ENG-1/);
    });
  });

  test("GET /api/hash changes across a move", async () => {
    await withDbServer(async ({ base }) => {
      const h1 = await (await fetch(`${base}/api/hash`)).text();
      const m = await move(base, "ENG-1", "in-progress");
      assert.equal(m.status, 200, JSON.stringify(await m.json().catch(() => ({}))));
      const h2 = await (await fetch(`${base}/api/hash`)).text();
      assert.notEqual(h1, h2);
    });
  });

  test("GET / with the database missing is a 503 naming `blaze db init`", async () => {
    await withDbServer(async ({ base, roots }) => {
      rmSync(join(roots.dataRoot, ".blaze", "blaze.db"));
      const r = await fetch(`${base}/`);
      const body = await r.text();
      assert.equal(r.status, 503, body.slice(0, 500));
      assert.match(body, /blaze db init/);
    });
  });
});
