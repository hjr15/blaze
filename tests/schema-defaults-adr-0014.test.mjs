// tests/schema-defaults-adr-0014.test.mjs — BLZ-231.
//
// The shipped DEFAULT_TYPES predate the requirements-driven model (blaze-pm ADR-0014) and
// still describe the Jira-inherited hierarchy. Two consequences bit during the portfolio
// rollout:
//
//   1. `risk.parentTypes` was ["goal","epic"], so a risk could not attach to a requirement,
//      a decision or a feature — `blaze new` refused it at creation. The board's 38 risks
//      sitting only on goals and epics read as neglect; it was the only shape the engine
//      allowed.
//   2. `story`/`task`/`bug` could parent only an `epic`, so the first `epic → feature`
//      retype would have orphaned every child, silently, because `validateTicket` never
//      runs on `reindex`.
//
// A board could paper over both with a schema override — and every board would have to.
// These tests pin the shipped defaults to the model the engine documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TYPES } from "../scripts/model/schema.mjs";

/** ADR-0014's table. `epic` is retained as a legacy type with no legal parent. */
const ADR_0014 = {
  goal:         [],
  requirement:  ["goal"],
  architecture: ["requirement", "goal"],
  feature:      ["architecture", "requirement", "goal"],
  story:        ["requirement", "feature"],
  task:         ["feature", "story"],
  bug:          ["feature", "story"],
  risk:         ["goal", "requirement", "architecture", "feature"],
  subtask:      ["story", "task", "bug"],
};

for (const [type, parents] of Object.entries(ADR_0014)) {
  test(`${type} accepts exactly ADR-0014's parents by default`, () => {
    assert.ok(DEFAULT_TYPES[type], `${type} is not a shipped type`);
    assert.deepEqual([...DEFAULT_TYPES[type].parentTypes].sort(), [...parents].sort());
  });
}

test("a risk can attach to a requirement, a decision and a feature", () => {
  for (const p of ["requirement", "architecture", "feature"]) {
    assert.ok(DEFAULT_TYPES.risk.parentTypes.includes(p),
      `risk cannot be a child of ${p} — the defect BLZ-231 records`);
  }
});

test("a risk still keeps its required fields", () => {
  for (const f of ["title", "description", "likelihood", "impact"]) {
    assert.ok(DEFAULT_TYPES.risk.required.includes(f), `risk lost required field ${f}`);
  }
});

test("goal sits above requirement in the hierarchy", () => {
  assert.ok(DEFAULT_TYPES.goal.level > DEFAULT_TYPES.requirement.level,
    "goal must outrank requirement — it was level 2 against requirement's 3");
});

test("the new types ship with a workflow the engine declares", async () => {
  const { DEFAULT_WORKFLOWS } = await import("../scripts/model/workflows.mjs");
  for (const t of ["requirement", "architecture", "feature"]) {
    assert.ok(DEFAULT_WORKFLOWS[DEFAULT_TYPES[t].workflow],
      `${t} maps to undeclared workflow ${DEFAULT_TYPES[t].workflow}`);
  }
});

test("epic remains declared, so an existing board still loads, but cannot be created", () => {
  assert.ok(DEFAULT_TYPES.epic, "removing epic outright breaks every board that still has one");
  assert.deepEqual(DEFAULT_TYPES.epic.parentTypes, [],
    "epic must have no legal parent — that is what retires it without deleting it");
});
