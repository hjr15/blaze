// tests/model/schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TYPES, allTypes, isType, hierarchyLevel, workflowFor, requiredFields, canParent,
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
