// tests/live-view-gate.test.mjs — BLZ-724.
//
// `GET /api/live` honours `views.live` like `GET /view/live` does: a board that turns the
// Live view off (the feed is a local file, so a deployed db-mode board has none) answers 404
// rather than serving an empty feed that reads as "no activity".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../scripts/serve.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();

function fsBoard(views) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blz724-board-")));
  const projectsDir = join(root, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ projects: ["ENG"], schemaVersion: 2, ...(views ? { views } : {}) }));
  writeFileSync(join(projectsDir, "ENG", "project.json"),
    JSON.stringify({ key: "ENG", components: [], labels: [] }));
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-1-a.md"),
    ["---", "id: ENG-1", "title: A task", "type: task", "project: ENG",
     "priority: medium", "assignee: unassigned", "estimate: 30",
     "created: 2026-01-01", "updated: 2026-01-01", "links:", "---", "",
     "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  return { root, projectsDir };
}

async function withServer(board, fn) {
  const server = startServer({ port: 0, root: board.root, projectsDir: board.projectsDir });
  await new Promise((res) => server.once("listening", res));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

test("BLZ-724: /api/live is 404 when views.live is false", async () => {
  await withServer(fsBoard({ live: false }), async (base) => {
    const api = await fetch(`${base}/api/live`);
    assert.equal(api.status, 404, await api.text());
    const view = await fetch(`${base}/view/live`);
    assert.equal(view.status, 404, await view.text());
  });
});

test("BLZ-724: /api/live is 200 when views.live is true or absent", async () => {
  for (const views of [{ live: true }, undefined]) {
    await withServer(fsBoard(views), async (base) => {
      const r = await fetch(`${base}/api/live`);
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.ok(Array.isArray(body.groups), JSON.stringify(body));
    });
  }
});
