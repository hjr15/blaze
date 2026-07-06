// tests/migrate/normalize.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIssue, adfToText } from "../../scripts/migrate/normalize.mjs";

const RAW = {
  key: "OBA-373",
  fields: {
    summary: "Gateway timeout",
    description: "## Context\nflaky\n## Acceptance Criteria\n- [ ] retries",
    issuetype: { name: "Task" },
    project: { key: "OBA" },
    status: { name: "Done" },
    resolution: { name: "Done" },
    priority: { name: "High" },
    assignee: { displayName: "ryan" },
    labels: ["deferred:launch"],
    components: [{ name: "gateway" }],
    parent: { key: "OBA-360" },
    timeoriginalestimate: 5400, // 90m
    worklog: { worklogs: [
      { started: "2026-06-28T10:00:00.000+0000", timeSpentSeconds: 3600, author: { displayName: "ryan" }, comment: "pairing" },
    ] },
    issuelinks: [
      { type: { name: "Blocks", outward: "blocks" }, outwardIssue: { key: "OBA-374" } },
      { type: { name: "Relates", inward: "relates to" }, inwardIssue: { key: "OBA-300" } },
    ],
    created: "2026-06-01T09:00:00.000+0000",
    updated: "2026-06-28T12:00:00.000+0000",
  },
};

test("normalizeIssue maps standard fields", () => {
  const n = normalizeIssue(RAW);
  assert.equal(n.key, "OBA-373");
  assert.equal(n.project, "OBA");
  assert.equal(n.type, "Task");
  assert.equal(n.summary, "Gateway timeout");
  assert.equal(n.status, "Done");
  assert.equal(n.resolution, "Done");
  assert.equal(n.priority, "High");
  assert.equal(n.assignee, "ryan");
  assert.deepEqual(n.labels, ["deferred:launch"]);
  assert.deepEqual(n.components, ["gateway"]);
  assert.equal(n.parent, "OBA-360");
  assert.equal(n.estimateSeconds, 5400);
  assert.equal(n.created, "2026-06-01");
  assert.equal(n.updated, "2026-06-28");
});

test("normalizeIssue maps worklog (seconds + date + author + note)", () => {
  const n = normalizeIssue(RAW);
  assert.equal(n.worklog.length, 1);
  assert.deepEqual(n.worklog[0], { date: "2026-06-28", seconds: 3600, author: "ryan", note: "pairing" });
});

test("normalizeIssue maps links by exact Name, picking the OTHER key", () => {
  const n = normalizeIssue(RAW);
  assert.deepEqual(n.links, [
    { type: "Blocks", target: "OBA-374" },
    { type: "Relates", target: "OBA-300" },
  ]);
});

test("normalizeIssue reads Risk custom fields via the field-id map", () => {
  const raw = { key: "OBA-9", fields: { summary: "Risk", issuetype: { name: "Risk" }, project: { key: "OBA" },
    status: { name: "Identified" }, customfield_10040: { value: "High" }, customfield_10004: { value: "Significant" } } };
  const n = normalizeIssue(raw);
  assert.equal(n.likelihood, "High");
  assert.equal(n.impact, "Significant");
});

test("normalizeIssue tolerates missing optionals (null, not throw)", () => {
  const n = normalizeIssue({ key: "INF-1", fields: { summary: "x", issuetype: { name: "Task" },
    project: { key: "INF" }, status: { name: "Defined" } } });
  assert.equal(n.resolution, null);
  assert.equal(n.parent, null);
  assert.equal(n.estimateSeconds, null);
  assert.deepEqual(n.worklog, []);
  assert.deepEqual(n.links, []);
  assert.equal(n.assignee, null);
});

test("adfToText flattens an ADF doc and passes strings through", () => {
  assert.equal(adfToText("plain"), "plain");
  assert.equal(adfToText(null), "");
  const adf = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
  ] };
  assert.match(adfToText(adf), /hello world/);
});

// R2 — statusCategory field
test("normalizeIssue includes statusCategory from status.statusCategory.key", () => {
  const raw = {
    key: "OBA-42", fields: {
      summary: "Done item", issuetype: { name: "Task" }, project: { key: "OBA" },
      status: { name: "Achieved", statusCategory: { key: "done" } },
    },
  };
  const n = normalizeIssue(raw);
  assert.equal(n.statusCategory, "done");
});

test("normalizeIssue statusCategory is null when absent", () => {
  const n = normalizeIssue({ key: "INF-1", fields: { summary: "x", issuetype: { name: "Task" },
    project: { key: "INF" }, status: { name: "Defined" } } });
  assert.equal(n.statusCategory, null);
});

test("normalizeIssue collapses newlines in a worklog note to a single line", () => {
  const n = normalizeIssue({ key: "OBA-1", fields: { summary: "x", issuetype: { name: "Task" },
    project: { key: "OBA" }, status: { name: "Done" },
    worklog: { worklogs: [{ started: "2026-06-01T10:00:00.000+0000", timeSpentSeconds: 60,
      author: { displayName: "ryan" }, comment: "line one\nline two\n" }] } } });
  assert.equal(n.worklog[0].note, "line one line two");
  assert.equal(/\n/.test(n.worklog[0].note), false);
});
