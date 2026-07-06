// tests/migrate/map.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapType, mapPriority, mapResolution, mapStatus, mapIssue } from "../../scripts/migrate/map.mjs";

const DONE_TASK = {
  key: "OBA-373", project: "OBA", type: "Task", summary: "Gateway timeout",
  description: "## Context\nflaky\n## Acceptance Criteria\n- [ ] retries",
  status: "Done", resolution: "Done", priority: "High", assignee: "ryan",
  labels: ["deferred:launch"], components: ["gateway"], parent: "OBA-360",
  estimateSeconds: 5400, worklog: [{ date: "2026-06-28", seconds: 3600, author: "ryan", note: "pairing" }],
  links: [{ type: "Blocks", target: "OBA-374" }], likelihood: null, impact: null,
  created: "2026-06-01", updated: "2026-06-28",
};

test("mapType / mapPriority / mapResolution tables", () => {
  assert.equal(mapType("Sub-task"), "subtask");
  assert.equal(mapType("Goal"), "goal");
  assert.equal(mapPriority("Highest"), "highest");
  assert.equal(mapPriority(undefined), "medium");
  assert.equal(mapResolution("Won't Do"), "wont-do");
  assert.equal(mapResolution(null), null);
});

test("mapStatus maps within a workflow and parks unmapped", () => {
  assert.deepEqual(mapStatus("task", "In Review"), { status: "in-review", unmapped: false });
  assert.deepEqual(mapStatus("goal", "Achieved"), { status: "achieved", unmapped: false });
  const u = mapStatus("task", "Backlog");           // legacy/non-standard
  assert.equal(u.unmapped, true);
  assert.equal(u.status, "defined");                // parked in the type's initial status
});

test("mapIssue builds a Done task ticket with rounding + AC preserved", () => {
  const { frontmatter: fm, body, status, warnings } = mapIssue(DONE_TASK);
  assert.equal(fm.id, "OBA-373");
  assert.equal(fm.type, "task");
  assert.equal(fm.project, "OBA");
  assert.equal(fm.priority, "high");
  assert.equal(fm.resolution, "done");
  assert.equal(fm.parent, "OBA-360");
  assert.equal(fm.estimate, 90);                    // 5400s → 90m (already 5m-aligned)
  assert.equal(fm.worklog[0].minutes, 60);          // 3600s → 60m
  assert.deepEqual(fm.links, [{ type: "Blocks", target: "OBA-374" }]);
  assert.equal(status, "done");
  assert.match(body, /## Acceptance Criteria/);
  assert.deepEqual(warnings, []);                   // a Done task with an estimate validates
});

test("mapIssue: in-flight item → resolution null and its mapped status", () => {
  const { frontmatter: fm, status } = mapIssue({ ...DONE_TASK, status: "In Progress", resolution: null });
  assert.equal(fm.resolution, null);
  assert.equal(status, "in-progress");
});

test("mapIssue: ledger proposedParent/proposedStatus override the issue's own", () => {
  const { frontmatter: fm, status } = mapIssue(DONE_TASK, { proposedParent: "OBA-999", proposedStatus: "in-review" });
  assert.equal(fm.parent, "OBA-999");
  assert.equal(status, "in-review");
});

test("mapIssue: a Risk carries likelihood/impact; a non-risk omits them", () => {
  const risk = mapIssue({ ...DONE_TASK, key: "OBA-9", type: "Risk", status: "Identified", resolution: null,
    likelihood: "High", impact: "Significant", estimateSeconds: null });
  assert.equal(risk.frontmatter.type, "risk");
  assert.equal(risk.frontmatter.likelihood, "high");
  assert.equal(risk.frontmatter.impact, "significant");
  assert.equal("likelihood" in mapIssue(DONE_TASK).frontmatter, false);
});

test("mapIssue: a leaf missing an estimate is warned, not blocked", () => {
  const { frontmatter: fm, warnings } = mapIssue({ ...DONE_TASK, estimateSeconds: null });
  assert.equal(fm.estimate, null);
  assert.ok(warnings.some((w) => /estimate/.test(w)));
});

test("mapIssue: zero-second worklog entry is skipped with a warning, not thrown", () => {
  const norm = {
    ...DONE_TASK,
    worklog: [
      { date: "2026-06-27", seconds: 0 },              // zero — must be skipped
      { date: "2026-06-28", seconds: 3600, note: "pairing" }, // valid — must be kept
    ],
  };
  // Must not throw:
  const { frontmatter: fm, warnings } = mapIssue(norm);
  // Valid entry is preserved:
  assert.equal(fm.worklog.length, 1);
  assert.equal(fm.worklog[0].minutes, 60);
  assert.equal(fm.worklog[0].note, "pairing");
  // Zero entry is omitted and a warning was recorded:
  assert.ok(warnings.some((w) => /zero.negative worklog/i.test(w) || /skipped zero/i.test(w)));
});

// R2 — statusCategory fallback
test("mapStatus: statusCategory fallback resolves unknown status via category (no warning)", () => {
  // "Achieved" is not in the delivery STATUS_MAP but category "done" → terminal
  assert.deepEqual(mapStatus("task", "Achieved", "done"), { status: "done", unmapped: false });
  // "Backlog" not in any map, category "new" → initial status
  assert.deepEqual(mapStatus("task", "Backlog", "new"), { status: "defined", unmapped: false });
  // goal: "Achieved" not in delivery, but in goal workflow via category "done" → "achieved"
  assert.deepEqual(mapStatus("goal", "Achieved", "done"), { status: "achieved", unmapped: false });
});

test("mapStatus: existing 2-arg calls still work (name hits take priority)", () => {
  // No regression on current name-hit path
  assert.deepEqual(mapStatus("task", "In Review"), { status: "in-review", unmapped: false });
  assert.deepEqual(mapStatus("goal", "Achieved"), { status: "achieved", unmapped: false });
  // No category → unmapped still
  const u = mapStatus("task", "Backlog");
  assert.equal(u.unmapped, true);
  assert.equal(u.status, "defined");
});

// R3 — impact/likelihood value mapping
test("mapIssue: Risk with compound impact/likelihood values are mapped by leading word", () => {
  const risk = mapIssue({
    ...DONE_TASK, key: "OBA-99", type: "Risk", status: "Identified", resolution: null,
    likelihood: "High", impact: "Significant / Large", estimateSeconds: null,
  });
  assert.equal(risk.frontmatter.impact, "significant");
  assert.equal(risk.frontmatter.likelihood, "high");
});

test("mapIssue: existing Risk test with plain values still maps correctly (leading word handles both)", () => {
  const risk = mapIssue({ ...DONE_TASK, key: "OBA-9", type: "Risk", status: "Identified", resolution: null,
    likelihood: "High", impact: "Significant", estimateSeconds: null });
  assert.equal(risk.frontmatter.likelihood, "high");
  assert.equal(risk.frontmatter.impact, "significant");
});
