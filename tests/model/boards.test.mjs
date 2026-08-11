import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveBoards, columnForStatus } from "../../scripts/model/boards.mjs";
import { resolveSchema } from "../../scripts/model/schema-config.mjs";

const { types, workflows } = resolveSchema({});

test("default schema yields a board per workflow, in hierarchy order", () => {
  // BLZ-231: `requirement` and `architecture` ship with their own workflows, so each gets
  // its own board — which is the point of a type following its own workflow.
  assert.deepEqual(deriveBoards({ types, workflows }).map((b) => b.name),
    ["delivery", "requirement", "architecture", "risk"]);
});

test("delivery board columns: defined/in-progress/in-review + Done folding achieved", () => {
  const [main] = deriveBoards({ types, workflows });
  assert.deepEqual(main.columns.map((c) => c.key), ["defined", "in-progress", "in-review", "done"]);
  const done = main.columns.at(-1);
  assert.equal(done.label, "Done");
  assert.deepEqual(done.folds.sort(), ["achieved", "done"]);
  assert.ok(main.workflows.includes("goal"), "goal folds into the delivery board");
});

test("risk board is [identified | Mitigated] with Mitigated folding accepted/obsolete", () => {
  const risk = deriveBoards({ types, workflows }).find((b) => b.name === "risk");
  assert.deepEqual(risk.columns.map((c) => c.key), ["identified", "mitigated"]);
  assert.deepEqual(risk.columns.at(-1).folds.sort(), ["accepted", "mitigated", "obsolete"]);
});

test("columnForStatus maps a folded terminal to the terminal column", () => {
  const [main] = deriveBoards({ types, workflows });
  assert.equal(columnForStatus(main, "achieved").key, "done");
  assert.equal(columnForStatus(main, "in-review").key, "in-review");
  assert.equal(columnForStatus(main, "identified"), null);
});

test("single-workflow config renders exactly one board (upstream default)", () => {
  const boards = deriveBoards({
    types: { task: { level: 0, workflow: "delivery", parentTypes: [], required: [] } },
    workflows: { delivery: workflows.delivery },
  });
  assert.equal(boards.length, 1);
  assert.equal(boards[0].name, "delivery");
});
