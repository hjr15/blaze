import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rollupLines } from "../scripts/rollup-runner.mjs";
import { rollUp } from "../scripts/model/rollup.mjs";

const runner = fileURLToPath(new URL("../scripts/rollup-runner.mjs", import.meta.url));

function idx(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return { rows, get: (id) => byId.get(id) };
}

const TREE = idx([
  { id: "OBA-1", project: "OBA", type: "goal", parent: null, title: "Ship v1", estimate: 0, worklog_minutes: 0 },
  { id: "OBA-2", project: "OBA", type: "epic", parent: "OBA-1", title: "Gateway", estimate: 0, worklog_minutes: 0 },
  { id: "OBA-3", project: "OBA", type: "task", parent: "OBA-2", title: "Timeout", estimate: 60, worklog_minutes: 30 },
  { id: "OBA-4", project: "OBA", type: "story", parent: "OBA-2", title: "Retry", estimate: 30, worklog_minutes: 0 },
]);

test("rollupLines for a specific id shows own + rolled and a child breakdown", () => {
  const lines = rollupLines(TREE, rollUp(TREE), "OBA-1").join("\n");
  assert.match(lines, /OBA-1/);
  assert.match(lines, /rolled/i);
  assert.match(lines, /1h 30m/);          // 90m rolled estimate
  assert.match(lines, /OBA-2/);           // direct child listed
});

test("rollupLines with no id lists goals and epics with rolled totals", () => {
  const lines = rollupLines(TREE, rollUp(TREE), null).join("\n");
  assert.match(lines, /OBA-1/);           // goal
  assert.match(lines, /OBA-2/);           // epic
  assert.doesNotMatch(lines, /OBA-3/);    // leaf task NOT listed in the summary
  assert.match(lines, /1h 30m/);          // rolled estimate shown
});

test("rollupLines reports a clear message for an unknown id", () => {
  const lines = rollupLines(TREE, rollUp(TREE), "OBA-999").join("\n");
  assert.match(lines, /not found/i);
});

test("blaze rollup fails loud on a board stamped newer than the engine", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-rollup-ver-"));
  mkdirSync(join(root, "projects", "OBA", "todo"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "todo", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: goal\nproject: OBA\n---\nbody\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "OBA", projects: ["OBA"], schemaVersion: 99 }));
  const r = spawnSync(process.execPath, [runner], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze rollup failed: blaze: board schemaVersion 99/);
  assert.doesNotMatch(r.stdout, /OBA-1/, "must not have computed/printed a roll-up against the wrong type registry");
  rmSync(root, { recursive: true, force: true });
});

test("blaze rollup works normally on a board stamped with the current schema version", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-rollup-ver-ok-"));
  mkdirSync(join(root, "projects", "OBA", "todo"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "todo", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: goal\nproject: OBA\n---\nbody\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "OBA", projects: ["OBA"], schemaVersion: 1 }));
  const r = spawnSync(process.execPath, [runner], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OBA-1/);
  rmSync(root, { recursive: true, force: true });
});
