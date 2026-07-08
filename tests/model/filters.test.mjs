import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalStatuses, activeStatuses, statusFilter } from "../../scripts/model/filters.mjs";

// A minimal two-workflow fixture: a delivery flow and a risk flow, each with
// its own terminal statuses. The helpers must be schema-driven — no hardcoded
// status names — so an upstream user with a different schema still gets sane
// presets.
const WF = {
  delivery: { statuses: ["defined", "in-progress", "in-review", "done"], terminal: ["done"] },
  risk: { statuses: ["identified", "mitigated"], terminal: ["mitigated"] },
};
const ALL = ["defined", "in-progress", "in-review", "done", "identified", "mitigated"];

test("terminalStatuses is the union of every workflow's terminal set", () => {
  assert.deepEqual([...terminalStatuses(WF)].sort(), ["done", "mitigated"]);
});

test("activeStatuses is every status that is not terminal in any workflow", () => {
  assert.deepEqual(activeStatuses(ALL, WF), ["defined", "in-progress", "in-review", "identified"]);
});

test("statusFilter('all' | '' | unknown) means show everything (null)", () => {
  assert.equal(statusFilter("all", ALL, WF), null);
  assert.equal(statusFilter("", ALL, WF), null);
  assert.equal(statusFilter("bogus", ALL, WF), null);
});

test("statusFilter('active') resolves to the active-status set", () => {
  assert.deepEqual([...statusFilter("active", ALL, WF)].sort(),
    ["defined", "identified", "in-progress", "in-review"]);
});

test("statusFilter('<status>') resolves to just that status (case-insensitive)", () => {
  assert.deepEqual([...statusFilter("in-progress", ALL, WF)], ["in-progress"]);
  assert.deepEqual([...statusFilter("IN-PROGRESS", ALL, WF)], ["in-progress"]);
});
