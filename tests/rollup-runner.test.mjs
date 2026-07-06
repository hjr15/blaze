import { test } from "node:test";
import assert from "node:assert/strict";
import { rollupLines } from "../scripts/rollup-runner.mjs";
import { rollUp } from "../scripts/model/rollup.mjs";

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
