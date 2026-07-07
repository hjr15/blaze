// tests/model/workflows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOWS, DEFAULT_WORKFLOWS, mergeWorkflows, workflowDef, statusesFor, isTerminal, initialStatus,
  canTransition, resolutionForTerminal, RESOLUTIONS,
} from "../../scripts/model/workflows.mjs";

test("each type resolves to its workflow definition", () => {
  assert.deepEqual(statusesFor("task"), ["defined", "in-progress", "in-review", "done"]);
  assert.deepEqual(statusesFor("goal"), ["defined", "in-progress", "achieved"]);
  assert.deepEqual(statusesFor("risk"), ["identified", "mitigated", "accepted", "obsolete"]);
  assert.equal(initialStatus("task"), "defined");
  assert.equal(initialStatus("risk"), "identified");
});

test("terminal status detection per type", () => {
  assert.ok(isTerminal("task", "done"));
  assert.ok(!isTerminal("task", "in-review"));
  assert.ok(isTerminal("risk", "obsolete"));
  assert.ok(isTerminal("goal", "achieved"));
});

test("canTransition enforces adjacency and reopen", () => {
  assert.ok(canTransition("task", "defined", "in-progress"));
  assert.ok(canTransition("task", "in-review", "done"));
  assert.ok(!canTransition("task", "defined", "done"));        // no skipping
  assert.ok(!canTransition("task", "defined", "in-review"));   // no skipping
  assert.ok(canTransition("task", "done", "defined"));         // reopen from anywhere
  assert.ok(canTransition("risk", "identified", "accepted"));
  assert.ok(!canTransition("risk", "mitigated", "accepted"));  // only from identified
  assert.ok(canTransition("risk", "obsolete", "identified"));  // reopen
  assert.ok(!canTransition("task", "defined", "defined")); // no self-loop reopen
});

test("resolution post-function maps terminal statuses", () => {
  assert.equal(resolutionForTerminal("task", "done"), "done");
  assert.equal(resolutionForTerminal("goal", "achieved"), "done");
  assert.equal(resolutionForTerminal("risk", "obsolete"), "wont-do");
  assert.equal(resolutionForTerminal("risk", "mitigated"), "done");
  assert.equal(resolutionForTerminal("task", "in-progress"), null);  // non-terminal
  assert.deepEqual(RESOLUTIONS, ["done", "wont-do", "duplicate", "cannot-reproduce"]);
});

test("workflowDef throws on unknown type", () => {
  assert.throws(() => workflowDef("nope"), /unknown type/);
  assert.ok(WORKFLOWS.delivery && WORKFLOWS.goal && WORKFLOWS.risk);
});

test("DEFAULT_WORKFLOWS holds today's exact three definitions (regression anchor)", () => {
  assert.deepEqual(DEFAULT_WORKFLOWS, {
    delivery: {
      statuses: ["defined", "in-progress", "in-review", "done"],
      terminal: ["done"],
      transitions: [["defined", "in-progress"], ["in-progress", "in-review"], ["in-review", "done"]],
      reopenTo: "defined",
      resolutionOnTerminal: { done: "done" },
    },
    goal: {
      statuses: ["defined", "in-progress", "achieved"],
      terminal: ["achieved"],
      transitions: [["defined", "in-progress"], ["in-progress", "achieved"]],
      reopenTo: "defined",
      resolutionOnTerminal: { achieved: "done" },
    },
    risk: {
      statuses: ["identified", "mitigated", "accepted", "obsolete"],
      terminal: ["mitigated", "accepted", "obsolete"],
      transitions: [["identified", "mitigated"], ["identified", "accepted"], ["identified", "obsolete"]],
      reopenTo: "identified",
      resolutionOnTerminal: { mitigated: "done", accepted: "done", obsolete: "wont-do" },
    },
  });
});

test("with no ambient override, resolved WORKFLOWS == DEFAULT_WORKFLOWS (byte-identical default)", () => {
  assert.deepEqual(WORKFLOWS, DEFAULT_WORKFLOWS);
});

test("mergeWorkflows with null/non-object override returns a copy of defaults", () => {
  assert.deepEqual(mergeWorkflows(DEFAULT_WORKFLOWS, null), DEFAULT_WORKFLOWS);
  assert.deepEqual(mergeWorkflows(DEFAULT_WORKFLOWS, undefined), DEFAULT_WORKFLOWS);
  assert.deepEqual(mergeWorkflows(DEFAULT_WORKFLOWS, 42), DEFAULT_WORKFLOWS);
  assert.notEqual(mergeWorkflows(DEFAULT_WORKFLOWS, null), DEFAULT_WORKFLOWS);
});

test("mergeWorkflows adds a new workflow without touching the defaults", () => {
  const kanban = { statuses: ["todo", "doing", "done"], terminal: ["done"], transitions: [["todo", "doing"], ["doing", "done"]], reopenTo: "todo", resolutionOnTerminal: { done: "done" } };
  const merged = mergeWorkflows(DEFAULT_WORKFLOWS, { kanban });
  assert.deepEqual(merged.kanban, kanban);
  assert.ok(merged.delivery); // defaults preserved
  assert.equal(DEFAULT_WORKFLOWS.kanban, undefined); // defaults not mutated
});

test("mergeWorkflows replaces an existing workflow entry wholesale", () => {
  const merged = mergeWorkflows(DEFAULT_WORKFLOWS, { delivery: { statuses: ["open", "closed"], terminal: ["closed"], transitions: [["open", "closed"]], reopenTo: "open", resolutionOnTerminal: { closed: "done" } } });
  assert.deepEqual(merged.delivery.statuses, ["open", "closed"]);
  assert.deepEqual(DEFAULT_WORKFLOWS.delivery.statuses, ["defined", "in-progress", "in-review", "done"]); // intact
});
