// tests/model/schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TYPES, DEFAULT_TYPES, mergeTypes,
  allTypes, isType, hierarchyLevel, workflowFor, requiredFields, canParent,
} from "../../scripts/model/schema.mjs";

test("the 7 Jira types exist with correct hierarchy levels", () => {
  assert.deepEqual(allTypes().sort(), ["bug","epic","goal","risk","story","subtask","task"]);
  assert.equal(hierarchyLevel("goal"), 2);
  assert.equal(hierarchyLevel("epic"), 1);
  assert.equal(hierarchyLevel("risk"), 1);
  assert.equal(hierarchyLevel("task"), 0);
  assert.equal(hierarchyLevel("subtask"), -1);
});

test("each type maps to its workflow", () => {
  assert.equal(workflowFor("goal"), "goal");
  assert.equal(workflowFor("risk"), "risk");
  assert.equal(workflowFor("epic"), "delivery");
  assert.equal(workflowFor("task"), "delivery");
});

test("required fields include risk likelihood/impact and leaf estimate", () => {
  assert.ok(requiredFields("risk").includes("likelihood"));
  assert.ok(requiredFields("risk").includes("impact"));
  assert.ok(requiredFields("task").includes("estimate"));
  assert.ok(!requiredFields("goal").includes("estimate"));
});

test("canParent enforces the hierarchy", () => {
  assert.ok(canParent("epic", "goal"));
  assert.ok(canParent("task", "epic"));
  assert.ok(canParent("risk", "goal"));
  assert.ok(canParent("subtask", "task"));
  assert.ok(!canParent("task", "goal"));   // task must hang off an epic
  assert.ok(!canParent("goal", "epic"));   // goal is top-level
});

test("unknown types throw", () => {
  assert.equal(isType("nope"), false);
  assert.throws(() => hierarchyLevel("nope"), /unknown type/);
});

test("DEFAULT_TYPES holds today's exact registry (regression anchor)", () => {
  assert.deepEqual(DEFAULT_TYPES, {
    goal:    { level: 2,  workflow: "goal",     parentTypes: [],                       required: ["title", "description"] },
    epic:    { level: 1,  workflow: "delivery", parentTypes: ["goal"],                 required: ["title", "description"] },
    risk:    { level: 1,  workflow: "risk",     parentTypes: ["goal", "epic"],         required: ["title", "description", "likelihood", "impact"] },
    story:   { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
    task:    { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
    bug:     { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
    subtask: { level: -1, workflow: "delivery", parentTypes: ["story", "task", "bug"], required: ["title", "description"] },
  });
});

test("with no ambient override, resolved TYPES == DEFAULT_TYPES (byte-identical default)", () => {
  assert.deepEqual(TYPES, DEFAULT_TYPES);
});

test("mergeTypes with null/undefined/non-object override returns a copy of defaults", () => {
  assert.deepEqual(mergeTypes(DEFAULT_TYPES, null), DEFAULT_TYPES);
  assert.deepEqual(mergeTypes(DEFAULT_TYPES, undefined), DEFAULT_TYPES);
  assert.deepEqual(mergeTypes(DEFAULT_TYPES, "nope"), DEFAULT_TYPES);
  assert.notEqual(mergeTypes(DEFAULT_TYPES, null), DEFAULT_TYPES); // fresh object, not the same ref
});

test("mergeTypes adds a new type without touching the defaults", () => {
  const feature = { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title", "description"] };
  const merged = mergeTypes(DEFAULT_TYPES, { feature });
  assert.deepEqual(merged.feature, feature);
  assert.ok(merged.epic); // defaults preserved
  assert.equal(DEFAULT_TYPES.feature, undefined); // defaults not mutated
});

test("mergeTypes replaces an existing type entry wholesale", () => {
  const merged = mergeTypes(DEFAULT_TYPES, { epic: { level: 1, workflow: "kanban", parentTypes: ["goal"], required: ["title"] } });
  assert.equal(merged.epic.workflow, "kanban");
  assert.deepEqual(merged.epic.required, ["title"]);
  assert.equal(DEFAULT_TYPES.epic.workflow, "delivery"); // defaults intact
});
