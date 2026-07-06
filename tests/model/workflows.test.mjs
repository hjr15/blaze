// tests/model/workflows.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKFLOWS, workflowDef, statusesFor, isTerminal, initialStatus,
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
