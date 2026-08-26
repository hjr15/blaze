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

  test("validateSchema survives being handed nothing at all", () => {
    // It is pure and public, and `auditCorpus` may call it with a config that parsed to
    // null. A throw here is the BLZ-392 regression by another route.
    for (const v of [null, undefined, 0, "", [], "nope"]) {
      assert.doesNotThrow(() => validateSchema(v), `threw on ${JSON.stringify(v)}`);
    }
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
    assert.ok(has(e, /type "spike" has a workflow that is not a name/i), e.join(" | "));
  });

  test("parentTypes must be an array, and a string is ONE error not seven", () => {
    // BLZ-392's documented failure mode, and this assertion had it: `for...of` iterates a
    // STRING PER CHARACTER, so without the array check `parentTypes: "feature"` produces
    // seven "not a declared type" errors — each of which also matched the loose regex this
    // test used, so dropping the real check killed nothing.
    const e = validateSchema(withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: "feature", required: [] } }));
    assert.ok(has(e, /type "spike" has parentTypes that is not an array/i), e.join(" | "));
    assert.equal(e.filter((x) => /"spike"/.test(x)).length, 1,
      `one clear error, not one per character: ${e.join(" | ")}`);
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
    assert.ok(has(e, /workflow "tiny" has statuses that is not a non-empty array/i), e.join(" | "));
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

// =============================================================================
// Round 3 — HARD vs SOFT. `assertSchemaValid` threw on everything `validateSchema`
// returned, and `validateSchema` deliberately returns a MIX: structural
// malformations AND advisories about configurations that are legal-but-inert or
// deliberately narrowed. So every advisory became fatal on the load path, and two
// boards that `blaze audit` calls ok=true could not run a single non-exempt verb.
//
// That is verbatim the class the previous review round refuted on this branch: a new
// check that is worse than the bug it replaces. The split is ONE list, tagged where
// each problem is collected — not a second function that would drift from the first.
// =============================================================================

/** The four SOFT classes, each on a board that is otherwise entirely well-formed. */
const SOFT_ONLY = {
  // BLZ-361: a deliberately narrowed `requirement` workflow. `validateSchema`'s own
  // comment calls this "legal when deliberate", and its message ends "Add them, or
  // drop the gate deliberately" — advice, not a malformation.
  requirementNarrowed: {
    types: DEFAULT_TYPES,
    workflows: { ...DEFAULT_WORKFLOWS, requirement: {
      statuses: ["proposed", "implemented", "rejected", "obsolete"],
      terminal: ["implemented", "rejected", "obsolete"],
      transitions: [["proposed", "implemented"]],
      reopenTo: "proposed",
      resolutionOnTerminal: { implemented: "done", rejected: "wont-do", obsolete: "wont-do" },
    } },
  },
  // The inertness note. docs/schema-customization.md calls a per-project linkTypes
  // block one that "resolves correctly but reaches nothing" — a note about where to
  // move a block, on a board that works.
  projectLinkTypesInert: {
    types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
    project: { schema: { linkTypes: { Precedes: { source_kinds: ["task"] } } } },
  },
  // BLZ-392: an endpoint kind naming no declared type. Audit files it SOFT, and its
  // over-firing is what bricked the previous round.
  endpointKindUndeclared: {
    types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
    linkTypes: [{ name: "Precedes", source_kinds: ["ghosttype"], target_kinds: ["task"] }],
  },
  // The `blaze.config.json:` override notes from `linkTypeOverrideErrors` — a block
  // that was IGNORED, leaving the shipped declaration in force. The board still runs.
  linkTypeOverrideIgnored: {
    types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
    config: { schema: { linkTypes: { Precedes: "not-an-object" } } },
  },
};

describe("BLZ-56: hard malformations refuse; soft advisories only report", () => {
  test("validateSchema's PUBLIC return shape is unchanged — an array of strings", () => {
    // `auditCorpus` puts these straight into `new Set(...)`, prints them as a finding's
    // `detail`, and compares them across layers with `has()`. If the tagging leaked out
    // of this function, every `schema-invalid` detail would render as [object Object] —
    // BLZ-392's defect returning by another route.
    const mixed = validateSchema({
      ...SOFT_ONLY.requirementNarrowed,
      types: { ...DEFAULT_TYPES, spike: { level: "0", workflow: "ghost", parentTypes: [], required: [] } },
      linkTypes: [{ name: "Precedes", source_kinds: ["ghosttype"], target_kinds: ["task"] }],
      project: { schema: { linkTypes: {} } },
    });
    assert.ok(Array.isArray(mixed), "still an array");
    assert.ok(mixed.length > 3, `expected hard AND soft entries, got ${mixed.length}`);
    for (const e of mixed) {
      assert.equal(typeof e, "string", `every entry is a human-readable string, got ${typeof e}: ${JSON.stringify(e)}`);
    }
    // And still never throws, on anything.
    for (const v of [null, undefined, 0, "", [], "nope", { types: { x: null }, workflows: { y: null } }]) {
      assert.doesNotThrow(() => validateSchema(v), `threw on ${JSON.stringify(v)}`);
    }
  });

  for (const [name, resolved] of Object.entries(SOFT_ONLY)) {
    test(`a board whose ONLY problem is soft (${name}) still REPORTS but is not refused`, () => {
      const reported = validateSchema(resolved);
      assert.ok(reported.length > 0,
        `${name} must still be reported — audit's report is what tells the operator: ${reported.join(" | ")}`);
      assert.doesNotThrow(() => assertSchemaValid(resolved),
        `${name} is advisory; refusing every non-exempt verb over it is a wall, not a gate`);
    });
  }

  test("a hard malformation alongside soft advisories still throws, listing the hard ones only", () => {
    const resolved = {
      ...SOFT_ONLY.requirementNarrowed,
      types: { ...DEFAULT_TYPES, spike: { level: "0", workflow: "ghost", parentTypes: ["nope"], required: [] } },
      linkTypes: [{ name: "Precedes", source_kinds: ["ghosttype"], target_kinds: ["task"] }],
    };
    let msg = "";
    try { assertSchemaValid(resolved); assert.fail("expected a refusal"); }
    catch (e) { assert.equal(e.name, "SchemaOverrideError"); msg = e.message; }
    assert.match(msg, /spike/, "the malformation must still be named");
    assert.match(msg, /level/);
    assert.match(msg, /ghost/);
    assert.match(msg, /nope/);
    assert.doesNotMatch(msg, /goal:achieved gate/,
      "a soft advisory in the refusal reads as a thing that must be fixed to proceed, and it is not");
    assert.doesNotMatch(msg, /ghosttype/,
      "the endpoint-kind finding is soft — audit files it soft and its over-firing bricked a board");
  });

  test("the partial type entry stays HARD — it is the trap the docs name", () => {
    // `mergeTypes` is a per-entry REPLACE, so `"task": { "workflow": "delivery" }` drops
    // level/parentTypes/required silently. This is the class BLZ-56 exists to catch.
    assert.throws(() => assertSchemaValid({
      types: { ...DEFAULT_TYPES, task: { workflow: "delivery" } }, workflows: DEFAULT_WORKFLOWS,
    }), /task/);
  });
});
