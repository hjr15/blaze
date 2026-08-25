// tests/model/schema-validate-on-load.test.mjs — BLZ-56.
//
// The engine ships a built-in schema and lets a board override types/workflows from
// blaze.config.json. Resolution is GUARDED on purpose, so a well-formed-JSON but
// wrong-shape override was silently accepted and the resolved schema could be
// internally inconsistent — `workflowDef` throwing at runtime, or validation quietly
// ceasing to fire. This adds the shape and referential-integrity checks, and a loud
// failure on the LOAD path.
//
// TWO PATHS, AND KEEPING THEM SEPARATE IS THE WHOLE DESIGN (BLZ-392, ADR-0002).
// `validateSchema` REPORTS and never throws — its production caller is `auditCorpus`,
// where a throw loses the entire hygiene report. `assertSchemaValid` is the load path,
// where failing loud is right. See tests/audit-malformed-linktypes.test.mjs, which
// exists to catch a regression in the first of those.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateSchema, assertSchemaValid, resolveSchema } from "../../scripts/model/schema-config.mjs";
import { DEFAULT_TYPES } from "../../scripts/model/schema.mjs";
import { DEFAULT_WORKFLOWS } from "../../scripts/model/workflows.mjs";

/** The built-in schema, plus whatever the test is overriding. */
const withTypes = (over) => ({ types: { ...DEFAULT_TYPES, ...over }, workflows: DEFAULT_WORKFLOWS });
const withWorkflows = (over) => ({ types: DEFAULT_TYPES, workflows: { ...DEFAULT_WORKFLOWS, ...over } });
const has = (errors, re) => errors.some((e) => re.test(e));

describe("BLZ-56: the built-in default must pass, or the check is unusable", () => {
  test("the shipped schema is valid", () => {
    assert.deepEqual(validateSchema({ types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS }), []);
  });

  test("resolveSchema of an empty config is valid — a board with no override is legal", () => {
    assert.deepEqual(validateSchema(resolveSchema({ config: null, project: null })), []);
  });

  test("assertSchemaValid does not throw on either", () => {
    assert.doesNotThrow(() => assertSchemaValid({ types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS }));
    assert.doesNotThrow(() => assertSchemaValid(resolveSchema({})));
  });
});

describe("BLZ-56: a type's shape", () => {
  test("level must be a number", () => {
    const e = validateSchema(withTypes({ spike: { level: "0", workflow: "delivery", parentTypes: [], required: [] } }));
    assert.ok(has(e, /type "spike".*level/i), e.join(" | "));
  });

  test("workflow must be a string", () => {
    const e = validateSchema(withTypes({ spike: { level: 0, workflow: 7, parentTypes: [], required: [] } }));
    assert.ok(has(e, /type "spike".*workflow/i), e.join(" | "));
  });

  test("parentTypes must be an array", () => {
    const e = validateSchema(withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: "feature", required: [] } }));
    assert.ok(has(e, /type "spike".*parentTypes/i), e.join(" | "));
  });

  test("parentTypes must name declared types", () => {
    const e = validateSchema(withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: ["nope"], required: [] } }));
    assert.ok(has(e, /type "spike".*parentTypes.*"nope"/i), e.join(" | "));
  });

  test("required must be an array of strings", () => {
    const e = validateSchema(withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: [], required: ["title", 3] } }));
    assert.ok(has(e, /type "spike".*required/i), e.join(" | "));
  });

  test("a type naming an undeclared workflow is still caught — the pre-existing check", () => {
    const e = validateSchema(withTypes({ spike: { level: 0, workflow: "ghost", parentTypes: [], required: [] } }));
    assert.ok(has(e, /type "spike".*undeclared workflow "ghost"/i), e.join(" | "));
  });
});

describe("BLZ-56: a workflow's shape and its referential integrity", () => {
  test("statuses must be a non-empty array", () => {
    const e = validateSchema(withWorkflows({ tiny: { statuses: [], terminal: [], transitions: [], reopenTo: "x" } }));
    assert.ok(has(e, /workflow "tiny".*statuses/i), e.join(" | "));
  });

  test("terminal must name declared statuses", () => {
    const e = validateSchema(withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["z"], transitions: [["a", "b"]], reopenTo: "a" } }));
    assert.ok(has(e, /workflow "tiny".*"z".*terminal/i), e.join(" | "));
  });

  test("transitions must be pairs of declared statuses", () => {
    const e = validateSchema(withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["b"], transitions: [["a", "zz"]], reopenTo: "a" } }));
    assert.ok(has(e, /workflow "tiny".*transition.*"zz"/i), e.join(" | "));
  });

  test("a transition that is not a pair is caught", () => {
    const e = validateSchema(withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["b"], transitions: [["a"]], reopenTo: "a" } }));
    assert.ok(has(e, /workflow "tiny".*transition/i), e.join(" | "));
  });

  test("reopenTo must be a declared status", () => {
    const e = validateSchema(withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["b"], transitions: [["a", "b"]], reopenTo: "gone" } }));
    assert.ok(has(e, /workflow "tiny".*reopenTo.*"gone"/i), e.join(" | "));
  });

  test("resolutionOnTerminal keys must be terminal statuses", () => {
    const e = validateSchema(withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["b"], transitions: [["a", "b"]], reopenTo: "a",
      resolutionOnTerminal: { a: "done" } } }));
    assert.ok(has(e, /workflow "tiny".*resolution onto "a".*terminal/i), e.join(" | "));
  });

  test("resolutionOnTerminal values must be known resolutions", () => {
    const e = validateSchema(withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["b"], transitions: [["a", "b"]], reopenTo: "a",
      resolutionOnTerminal: { b: "fictional" } } }));
    assert.ok(has(e, /workflow "tiny".*"fictional".*known resolution/i), e.join(" | "));
  });
});

describe("BLZ-56: the two paths stay separate — AC-4's decision, as code", () => {
  test("validateSchema REPORTS and never throws, whatever it is given", () => {
    // Its production caller is auditCorpus. A throw there loses the whole hygiene
    // report, which is the defect BLZ-392 closed and this ticket must not reopen.
    assert.doesNotThrow(() => validateSchema(withTypes({ spike: { level: "0", workflow: 7, parentTypes: "x", required: 9 } })));
    assert.doesNotThrow(() => validateSchema({}));
    assert.doesNotThrow(() => validateSchema({ types: null, workflows: null }));
    assert.doesNotThrow(() => validateSchema({ types: { x: null }, workflows: { y: null } }));
  });

  test("assertSchemaValid THROWS, and names every offending type, workflow and field", () => {
    const bad = withTypes({ spike: { level: "0", workflow: "ghost", parentTypes: ["nope"], required: [] } });
    assert.throws(() => assertSchemaValid(bad), (e) => {
      assert.match(e.message, /blaze\.config\.json/,
        "the operator has to be told WHICH file to fix");
      assert.match(e.message, /spike/);
      assert.match(e.message, /level/);
      assert.match(e.message, /ghost/);
      assert.match(e.message, /nope/);
      assert.doesNotMatch(e.message, /at assertSchemaValid|\bat Object\b/,
        "a stack trace is not an actionable error");
      return true;
    });
  });

  test("the error lists EVERY problem, not merely the first", () => {
    // A config with three faults must not need three runs to fix.
    const bad = withTypes({
      spike: { level: "0", workflow: "ghost", parentTypes: [], required: [] },
      chore: { level: 0, workflow: "delivery", parentTypes: ["nope"], required: [] },
    });
    let msg = "";
    try { assertSchemaValid(bad); } catch (e) { msg = e.message; }
    assert.match(msg, /spike/);
    assert.match(msg, /chore/);
  });
});
