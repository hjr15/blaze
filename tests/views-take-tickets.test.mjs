// tests/views-take-tickets.test.mjs — BLZ-670.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardModel, liveModel } from "../scripts/views/data.mjs";
import { panelHtml } from "../scripts/views/panel-content.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const rec = { frontmatter: { id: "ENG-1", title: "Only in the db", type: "task", project: "ENG", links: [] },
              body: "db body", project: "ENG", status: "in-progress", file: "ENG-1" };
const board = () => { const r = scratch(mkdtempSync(join(tmpdir(), "blz670-views-")));
  writeFileSync(join(r, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 })); return r; };

test("boardModel renders supplied tickets", () => {
  const m = boardModel(join(board(), "projects"), { tickets: [rec], flat: true });
  assert.equal(m.index.get("ENG-1").status, "in-progress");
});

test("panelHtml renders the supplied record and never opens row.file (an id in db mode)", () => {
  assert.match(panelHtml(join(board(), "projects"), "ENG-1", { tickets: [rec] }), /db body/);
});

test("liveModel uses the supplied feed and tickets", () => {
  const r = board();
  const feed = { text: JSON.stringify({ ts: new Date().toISOString(), key: "ENG-1", branch: "ENG-1-x", tool: "Edit", cwd: "/" }) + "\n", unreadable: null };
  const m = liveModel(r, join(r, "projects"), { tickets: [rec], feed });
  assert.equal(m.groups[0].key, "ENG-1");
  assert.equal(m.groups[0].column, "in-progress");   // groupByTicket's field (activity.mjs:39)
});
