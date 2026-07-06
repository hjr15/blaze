import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSchema } from "../../scripts/model/schema-config.mjs";
import { DEFAULT_TYPES } from "../../scripts/model/schema.mjs";
import { DEFAULT_WORKFLOWS } from "../../scripts/model/workflows.mjs";

test("resolveSchema with no config/project returns the defaults", () => {
  const { types, workflows } = resolveSchema();
  assert.deepEqual(types, DEFAULT_TYPES);
  assert.deepEqual(workflows, DEFAULT_WORKFLOWS);
});

test("resolveSchema applies a top-level config override", () => {
  const feature = { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title"] };
  const { types } = resolveSchema({ config: { schema: { types: { feature } } } });
  assert.deepEqual(types.feature, feature);
  assert.ok(types.epic); // defaults preserved
});

test("resolveSchema layers per-project over top-level (project wins)", () => {
  const config = { schema: { types: { epic: { level: 1, workflow: "delivery", parentTypes: ["goal"], required: ["title"] } } } };
  const project = { schema: { types: { epic: { level: 1, workflow: "kanban", parentTypes: ["goal"], required: ["title", "estimate"] } } } };
  const { types } = resolveSchema({ config, project });
  assert.equal(types.epic.workflow, "kanban");
  assert.deepEqual(types.epic.required, ["title", "estimate"]);
});

test("resolveSchema layers workflow overrides from both scopes", () => {
  const config = { schema: { workflows: { kanban: { statuses: ["todo", "done"], terminal: ["done"], transitions: [["todo", "done"]], reopenTo: "todo", resolutionOnTerminal: { done: "done" } } } } };
  const project = { schema: { workflows: { delivery: { statuses: ["open", "closed"], terminal: ["closed"], transitions: [["open", "closed"]], reopenTo: "open", resolutionOnTerminal: { closed: "done" } } } } };
  const { workflows } = resolveSchema({ config, project });
  assert.ok(workflows.kanban);                                  // added top-level
  assert.deepEqual(workflows.delivery.statuses, ["open", "closed"]); // replaced per-project
  assert.ok(workflows.goal);                                    // default preserved
});

test("resolveSchema tolerates a config/project without a schema block", () => {
  const { types, workflows } = resolveSchema({ config: { key: "X" }, project: { key: "ENG" } });
  assert.deepEqual(types, DEFAULT_TYPES);
  assert.deepEqual(workflows, DEFAULT_WORKFLOWS);
});
