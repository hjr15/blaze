// tests/model/schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TYPES, DEFAULT_TYPES, mergeTypes,
  allTypes, isType, hierarchyLevel, workflowFor, requiredFields, canParent,
} from "../../scripts/model/schema.mjs";

test("the requirements-driven types exist with correct hierarchy levels", () => {
  // BLZ-231: the shipped registry is ADR-0014's model, not the Jira-inherited one.
  // `epic` is retained (see the schema module) so an unmigrated board still loads.
  assert.deepEqual(allTypes().sort(),
    ["architecture","bug","epic","feature","goal","requirement","risk","story","subtask","task"]);
  assert.equal(hierarchyLevel("goal"), 4);
  assert.equal(hierarchyLevel("requirement"), 3);
  assert.equal(hierarchyLevel("architecture"), 2);
  assert.equal(hierarchyLevel("feature"), 1);
  assert.equal(hierarchyLevel("risk"), 1);
  assert.equal(hierarchyLevel("task"), 0);
  assert.equal(hierarchyLevel("subtask"), -1);
});

test("each type maps to its workflow", () => {
  assert.equal(workflowFor("goal"), "goal");
  assert.equal(workflowFor("risk"), "risk");
  assert.equal(workflowFor("requirement"), "requirement");
  assert.equal(workflowFor("architecture"), "architecture");
  assert.equal(workflowFor("feature"), "delivery");
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
  assert.ok(canParent("requirement", "goal"));
  assert.ok(canParent("architecture", "requirement"));
  assert.ok(canParent("feature", "requirement"));
  assert.ok(canParent("task", "feature"));
  assert.ok(canParent("subtask", "task"));
  assert.ok(!canParent("task", "goal"));   // a task hangs off delivery, not an outcome
  assert.ok(!canParent("goal", "feature")); // goal is top-level

  // A risk attaches at every altitude it can threaten — BLZ-231. Before the fix it
  // could only reach a goal or an epic, which is why every risk on the board sat there.
  for (const p of ["goal", "requirement", "architecture", "feature"]) {
    assert.ok(canParent("risk", p), `risk should attach to ${p}`);
  }

  // `epic` is retained so an unmigrated board loads, and unparentable so no new one appears.
  assert.deepEqual(DEFAULT_TYPES.epic.parentTypes, []);
  assert.ok(!canParent("epic", "goal"));
  assert.ok(!canParent("task", "epic"));
});

test("unknown types throw", () => {
  assert.equal(isType("nope"), false);
  assert.throws(() => hierarchyLevel("nope"), /unknown type/);
});

test("DEFAULT_TYPES holds today's exact registry (regression anchor)", () => {
  // BLZ-231. Moved deliberately from the Jira-inherited model to ADR-0014's. If this
  // anchor fails, the shipped model changed — decide whether that was intended before
  // editing it, and note that `epic` must stay present and unparentable.
  assert.deepEqual(DEFAULT_TYPES, {
    goal:         { level: 4,  workflow: "goal",         parentTypes: [],                                                  required: ["title", "description"] },
    requirement:  { level: 3,  workflow: "requirement",  parentTypes: ["goal"],                                            required: ["title", "description"] },
    architecture: { level: 2,  workflow: "architecture", parentTypes: ["requirement", "goal"],                             required: ["title", "description"] },
    feature:      { level: 1,  workflow: "delivery",     parentTypes: ["architecture", "requirement", "goal"],             required: ["title", "description"] },
    risk:         { level: 1,  workflow: "risk",         parentTypes: ["goal", "requirement", "architecture", "feature"],  required: ["title", "description", "likelihood", "impact"] },
    story:        { level: 0,  workflow: "delivery",     parentTypes: ["requirement", "feature"],                          required: ["title", "description", "estimate"] },
    task:         { level: 0,  workflow: "delivery",     parentTypes: ["feature", "story"],                                required: ["title", "description", "estimate"] },
    bug:          { level: 0,  workflow: "delivery",     parentTypes: ["feature", "story"],                                required: ["title", "description", "estimate"] },
    subtask:      { level: -1, workflow: "delivery",     parentTypes: ["story", "task", "bug"],                            required: ["title", "description"] },
    epic:         { level: 1,  workflow: "delivery",     parentTypes: [],                                                  required: ["title", "description"] },
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
  const spike = { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title", "description"] };
  const merged = mergeTypes(DEFAULT_TYPES, { spike });
  assert.deepEqual(merged.spike, spike);
  assert.ok(merged.feature); // defaults preserved
  assert.equal(DEFAULT_TYPES.spike, undefined); // defaults not mutated
});

test("mergeTypes cannot delete a shipped type — only replace or add", () => {
  // The property behind BLZ-231's retained `epic`: a spread merge has no delete, so a
  // board can never remove a type an earlier board wrote tickets under.
  const merged = mergeTypes(DEFAULT_TYPES, { epic: undefined });
  assert.ok("epic" in merged, "an override cannot remove a type from the registry");
});

test("mergeTypes replaces an existing type entry wholesale", () => {
  const merged = mergeTypes(DEFAULT_TYPES, { epic: { level: 1, workflow: "kanban", parentTypes: ["goal"], required: ["title"] } });
  assert.equal(merged.epic.workflow, "kanban");
  assert.deepEqual(merged.epic.required, ["title"]);
  assert.equal(DEFAULT_TYPES.epic.workflow, "delivery"); // defaults intact
});
