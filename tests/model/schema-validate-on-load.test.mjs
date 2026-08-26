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
import { readFileSync } from "node:fs";
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

// =============================================================================
// Round 4 — the CLASSIFICATION itself is the contract, and it was unpinned.
//
// `collectSchemaProblems` tags every problem hard or soft, and that one boolean
// decides whether a board runs: `assertSchemaValid` throws on the hard entries and
// drops the soft ones. Flipping one word therefore changes what every non-exempt
// verb does, and an adversarial review found the flip was FREE for one tag —
// `soft()` → `hard()` on the non-array `source_kinds` note left the whole suite
// green. The tags below are pinned one per row, so a flip in either direction is a
// named red test rather than a silent behaviour change.
// =============================================================================

/** The hard messages `assertSchemaValid` would actually refuse on — [] when it does not
 *  throw. This is the load path's real answer, not a re-derivation of it. */
function refusedMessages(resolved) {
  try { assertSchemaValid(resolved); return []; } catch (e) {
    assert.equal(e.name, "SchemaOverrideError", `unexpected throw: ${e.stack}`);
    return e.errors;
  }
}

const NARROWED_REQUIREMENT = {
  statuses: ["proposed", "implemented"], terminal: ["implemented"],
  transitions: [["proposed", "implemented"]], reopenTo: "proposed",
};

/** One row per `hard()`/`soft()` call site in scripts/model/schema-config.mjs. Each
 *  `resolved` must make its own tag fire and `re` must match that message alone. */
const CLASSIFICATION = [
  // --- the type registry -----------------------------------------------------
  { name: "type maps to an undeclared workflow", hard: true,
    re: /^type "spike" maps to undeclared workflow "ghost"/,
    resolved: withTypes({ spike: { level: 0, workflow: "ghost", parentTypes: [], required: [] } }) },
  { name: "a type that is not an object", hard: true,
    re: /^type "spike" is not an object/,
    resolved: withTypes({ spike: 7 }) },
  { name: "level is not a number", hard: true,
    re: /^type "spike" has a level that is not a number/,
    resolved: withTypes({ spike: { level: "0", workflow: "delivery", parentTypes: [], required: [] } }) },
  { name: "workflow is not a name", hard: true,
    re: /^type "spike" has a workflow that is not a name/,
    resolved: withTypes({ spike: { level: 0, workflow: 7, parentTypes: [], required: [] } }) },
  { name: "parentTypes is not an array", hard: true,
    re: /^type "spike" has parentTypes that is not an array/,
    resolved: withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: "feature", required: [] } }) },
  { name: "parentTypes names an undeclared type", hard: true,
    re: /^type "spike" lists parentTypes "nope"/,
    resolved: withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: ["nope"], required: [] } }) },
  { name: "required is not an array", hard: true,
    re: /^type "spike" has required that is not an array/,
    resolved: withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: [], required: 9 } }) },
  { name: "a required entry is not a field name", hard: true,
    re: /^type "spike" has a required entry that is not a field name/,
    resolved: withTypes({ spike: { level: 0, workflow: "delivery", parentTypes: [], required: ["title", 3] } }) },
  // --- the workflow registry -------------------------------------------------
  { name: "a workflow that is not an object", hard: true,
    re: /^workflow "tiny" is not an object/,
    resolved: withWorkflows({ tiny: 7 }) },
  { name: "statuses is not a non-empty array", hard: true,
    re: /^workflow "tiny" has statuses that is not a non-empty array/,
    resolved: withWorkflows({ tiny: { statuses: [] } }) },
  { name: "terminal is not an array", hard: true,
    re: /^workflow "tiny" has terminal that is not an array/,
    resolved: withWorkflows({ tiny: { statuses: ["a"], terminal: 3 } }) },
  { name: "terminal names a status the workflow does not have", hard: true,
    re: /^workflow "tiny" marks "z" terminal/,
    resolved: withWorkflows({ tiny: { statuses: ["a"], terminal: ["z"] } }) },
  { name: "transitions is not an array", hard: true,
    re: /^workflow "tiny" has transitions that is not an array/,
    resolved: withWorkflows({ tiny: { statuses: ["a"], transitions: 3 } }) },
  { name: "a transition that is not a [from, to] pair", hard: true,
    re: /^workflow "tiny" has a transition that is not a \[from, to\] pair/,
    resolved: withWorkflows({ tiny: { statuses: ["a"], transitions: [["a"]] } }) },
  { name: "a transition naming a status the workflow does not have", hard: true,
    re: /^workflow "tiny" has a transition naming "zz"/,
    resolved: withWorkflows({ tiny: { statuses: ["a"], transitions: [["a", "zz"]] } }) },
  { name: "reopenTo is not a declared status", hard: true,
    re: /^workflow "tiny" sets reopenTo "gone"/,
    resolved: withWorkflows({ tiny: { statuses: ["a"], reopenTo: "gone" } }) },
  { name: "resolutionOnTerminal is not an object", hard: true,
    re: /^workflow "tiny" has resolutionOnTerminal that is not an object/,
    resolved: withWorkflows({ tiny: { statuses: ["a"], resolutionOnTerminal: 3 } }) },
  { name: "a resolution mapped onto a non-terminal status", hard: true,
    re: /^workflow "tiny" maps a resolution onto "a"/,
    resolved: withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["b"], resolutionOnTerminal: { a: "done" } } }) },
  { name: "a resolution the engine does not know", hard: true,
    re: /^workflow "tiny" maps "b" to resolution "fictional"/,
    resolved: withWorkflows({ tiny: {
      statuses: ["a", "b"], terminal: ["b"], resolutionOnTerminal: { b: "fictional" } } }) },
  // --- the advisories --------------------------------------------------------
  { name: "BLZ-361: a narrowed `requirement` workflow", hard: false,
    re: /^workflow "requirement" omits/,
    resolved: withWorkflows({ requirement: NARROWED_REQUIREMENT }) },
  { name: "BLZ-392: an endpoint side that is not an array", hard: false,
    re: /^link type "Precedes" has a source_kinds that is not an array/,
    resolved: { types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
      linkTypes: [{ name: "Precedes", source_kinds: "task", target_kinds: ["task"] }] } },
  { name: "BLZ-392: an endpoint kind naming no declared type", hard: false,
    re: /^link type "Precedes" names "ghosttype" in source_kinds/,
    resolved: { types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
      linkTypes: [{ name: "Precedes", source_kinds: ["ghosttype"], target_kinds: ["task"] }] } },
  { name: "BLZ-392: a blaze.config.json linkTypes block the merge ignored", hard: false,
    re: /^blaze\.config\.json: schema\.linkTypes\["Precedes"\] must be an object/,
    resolved: { types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
      config: { schema: { linkTypes: { Precedes: "not-an-object" } } } } },
  { name: "a per-project linkTypes block that reaches nothing", hard: false,
    re: /^project\.json: schema\.linkTypes does not reach the scheduler/,
    resolved: { types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
      project: { schema: { linkTypes: {} } } } },
];

describe("BLZ-56: every hard/soft tag is pinned — a flip is a red test, not a silent change", () => {
  for (const { name, hard, re, resolved } of CLASSIFICATION) {
    test(`${name} is ${hard ? "HARD (the verb is refused)" : "SOFT (reported only)"}`, () => {
      const reported = validateSchema(resolved);
      const matched = reported.filter((m) => re.test(m));
      assert.equal(matched.length, 1,
        `the fixture must make this ONE tag fire, or the row measures nothing — `
        + `got ${matched.length} matches in: ${reported.join(" | ")}`);
      const refused = new Set(refusedMessages(resolved));
      assert.equal(refused.has(matched[0]), hard, hard
        ? `this is a MALFORMATION: the load path must refuse it, and ${matched[0]} was not in the refusal`
        : `this is an ADVISORY: \`blaze audit\` calls such a board ok=true, so refusing it `
          + `makes the preflight a wall on a board audit runs clean — ${matched[0]}`);
    });
  }

  test("the table covers every hard()/soft() call site in schema-config.mjs, by IDENTITY not count", () => {
    // A total can be preserved while the SET changes: convert one real `hard(` call site to
    // a direct `problems.push({ message, hard: true })` (which this scan cannot see, because
    // it looks for the literal token `hard(`) and add a brand-new, unclassified `hard(...)`
    // call elsewhere, and `hard`/`soft` totals are unchanged — the count-only version of this
    // test (its previous form) stayed green through exactly that bypass. So this instead
    // extracts each call site's own message-template text from the source and matches it,
    // by IDENTITY, against the concrete message each CLASSIFICATION row's fixture actually
    // produces — a bijection, not a tally.
    const src = readFileSync(new URL("../../scripts/model/schema-config.mjs", import.meta.url), "utf8");

    // MASK COMMENTS AND STRING BODIES BEFORE LOOKING FOR CALLS. The scan used to read raw
    // source, so any COMMENT or STRING that merely MENTIONED `hard(` minted a phantom call
    // site claimed by no CLASSIFICATION row — `// Prefer hard(m) for structural problems`
    // was enough to fail this test. That is a false red on a legitimate edit, and a guard
    // that punishes documenting the very convention it enforces will simply be deleted.
    //
    // `masked` is `src` with every comment body and every string/template literal BODY
    // replaced by spaces, LENGTH AND OFFSETS PRESERVED. Call sites are located in `masked`;
    // each site's argument text is then read out of the raw `src` at the same offset, so
    // masking costs the scan nothing. Interpolation code inside `${...}` stays live — a
    // `hard(...)` in there would be a real call.
    const maskCommentsAndStrings = (s) => {
      const out = s.split("");
      const blank = (from, to) => {
        for (let k = from; k < to && k < s.length; k += 1) if (out[k] !== "\n") out[k] = " ";
      };
      const quoted = (start) => {
        const q = s[start];
        let j = start + 1;
        while (j < s.length && s[j] !== q) j += (s[j] === "\\" ? 2 : 1);
        blank(start + 1, j);
        return j + 1;
      };
      const template = (start) => {
        let j = start + 1;
        while (j < s.length && s[j] !== "`") {
          if (s[j] === "\\") { blank(j, j + 2); j += 2; continue; }
          if (s[j] === "$" && s[j + 1] === "{") { j = code(j + 2, true); continue; }
          blank(j, j + 1); j += 1;
        }
        return j + 1;
      };
      function code(from, stopAtBrace) {
        let j = from;
        let depth = 0;
        while (j < s.length) {
          const c = s[j];
          if (stopAtBrace && c === "}" && depth === 0) return j + 1;
          if (c === "{") { depth += 1; j += 1; continue; }
          if (c === "}") { depth -= 1; j += 1; continue; }
          if (c === "/" && s[j + 1] === "/") {
            const nl = s.indexOf("\n", j);
            const end = nl === -1 ? s.length : nl;
            blank(j, end); j = end; continue;
          }
          if (c === "/" && s[j + 1] === "*") {
            const close = s.indexOf("*/", j + 2);
            const end = close === -1 ? s.length : close + 2;
            blank(j, end); j = end; continue;
          }
          if (c === '"' || c === "'") { j = quoted(j); continue; }
          if (c === "`") { j = template(j); continue; }
          j += 1;
        }
        return j;
      }
      code(0, false);
      return out.join("");
    };
    const masked = maskCommentsAndStrings(src);
    assert.equal(masked.length, src.length, "masking must preserve offsets");

    // Walk a `${...}` interpolation from its opening brace to its matching closing one,
    // treating a nested template literal or quoted string as an opaque, un-depth-counted
    // span — schema-config.mjs has exactly one such nesting (the `requirement`-workflow
    // "omits ..." message interpolates `missing.map(m => `"${m}"`).join(", ")`), and a
    // depth count that did not skip over it would close on the nested template's OWN `}`.
    const skipInterpolation = (s, at) => {
      let depth = 1;
      let j = at;
      while (j < s.length && depth > 0) {
        const c = s[j];
        if (c === "{") depth += 1;
        else if (c === "}") depth -= 1;
        else if (c === "`" || c === '"' || c === "'") {
          const q = c;
          j += 1;
          while (j < s.length && s[j] !== q) j += (s[j] === "\\" ? 2 : 1);
        }
        j += 1;
      }
      return j;
    };
    // ONE escape decoder, used by BOTH scanners. They used to disagree: `scanTemplate`
    // DROPPED `\X` entirely while `scanQuoted` appended the raw next character, so a `\n`
    // in a template vanished and a `\t` in a quoted string became the letter "t". Either
    // way the extracted text stopped matching the message the code actually produces, and
    // adding an escape to any existing message — a line break in a long finding, a tab in
    // a continuation — false-failed this test. Decode once, decode the same, both sides.
    const SIMPLE = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
    const decodeEscape = (s, at) => {           // `at` is the backslash
      const c = s[at + 1];
      if (c === "x") return { ch: String.fromCharCode(parseInt(s.slice(at + 2, at + 4), 16)), end: at + 4 };
      if (c === "u" && s[at + 2] === "{") {
        const close = s.indexOf("}", at + 3);
        return { ch: String.fromCodePoint(parseInt(s.slice(at + 3, close), 16)), end: close + 1 };
      }
      if (c === "u") return { ch: String.fromCharCode(parseInt(s.slice(at + 2, at + 6), 16)), end: at + 6 };
      if (c === "\n") return { ch: "", end: at + 2 };          // line continuation
      return { ch: Object.hasOwn(SIMPLE, c) ? SIMPLE[c] : c, end: at + 2 };
    };
    // Not "\0": a source-level `\0` now decodes to NUL, so the placeholder must be a
    // character no decoded message can contain. U+E000 is private-use.
    const HOLE = "\uE000";
    // A template literal's content, with every `${...}` replaced by a HOLE placeholder so it
    // can be compared to a concrete message with the interpolated values stripped out.
    const scanTemplate = (s, start) => {
      let i = start + 1;
      let out = "";
      while (i < s.length) {
        const c = s[i];
        if (c === "\\") { const d = decodeEscape(s, i); out += d.ch; i = d.end; continue; }
        if (c === "`") { i += 1; break; }
        if (c === "$" && s[i + 1] === "{") { i = skipInterpolation(s, i + 2); out += HOLE; continue; }
        out += c; i += 1;
      }
      return { content: out, end: i };
    };
    const scanQuoted = (s, start) => {
      const q = s[start];
      let i = start + 1;
      let out = "";
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") { const d = decodeEscape(s, i); out += d.ch; i = d.end; continue; }
        out += s[i]; i += 1;
      }
      return { content: out, end: i + 1 };
    };
    // `hard(`/`soft(`'s one argument is always a string literal, or several joined by `+` —
    // never a variable or a call — so walking string-literal tokens from the call, following
    // `+`, captures the whole message with no need to paren-balance the call itself.
    //
    // `\s*` before the paren, and an optional `?.`: `hard ("...")`, `hard\n("...")` and
    // `hard?.("...")` are all calls, and all three previously shipped an UNCLASSIFIED tag
    // fully green. 0c241b9's message claimed "the natural edit this test needs to catch is
    // a plain new `hard(`/`soft(` call, which it now does" — it did not, and it does now.
    //
    // THE RESIDUAL GAP IS LEXICAL, not merely aliasing: this finds a call only where the
    // literal token `hard`/`soft` stands immediately before the parenthesis. Any other
    // SPELLING escapes it — an alias (`const h = hard; h(msg)`), an indirect or computed
    // call (`tags["hard"](msg)`, `[hard][0](msg)`), a `.call`/`.apply`, a regex literal is
    // not masked either, and the original bypass this scan was built for, pushing straight
    // onto `problems` with `{ message, hard: true }`. Those are deliberate: they are not
    // edits anyone makes by accident, whereas every ordinary way of writing the call now
    // lands in the table.
    const callRe = /(?<![\w.$])(hard|soft)\s*(?:\?\.\s*)?\(/g;
    const sites = [];
    let m;
    while ((m = callRe.exec(masked))) {
      const tag = m[1];
      let pos = m.index + m[0].length;
      let literal = "";
      for (;;) {
        while (/\s/.test(src[pos])) pos += 1;
        if (src[pos] === "`") { const r = scanTemplate(src, pos); literal += r.content; pos = r.end; }
        else if (src[pos] === '"' || src[pos] === "'") { const r = scanQuoted(src, pos); literal += r.content; pos = r.end; }
        else break;
        while (/\s/.test(src[pos])) pos += 1;
        if (src[pos] === "+") { pos += 1; continue; }
        break;
      }
      sites.push({ tag, literal });
    }
    assert.ok(sites.filter((s) => s.tag === "hard").length > 10 && sites.filter((s) => s.tag === "soft").length > 2,
      `the scan is not working: found ${sites.length} sites`);

    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sitePattern = (site) => new RegExp(`^${site.literal.split(HOLE).map(escapeRe).join(".*")}$`, "s");

    // Every CLASSIFICATION row must trace to exactly one call site, and every call site must
    // be claimed by exactly one row — the bijection a count can't see. Recomputes each row's
    // concrete message rather than trusting `re` alone, so the row's own fixture is what
    // proves the link.
    const claimedBy = sites.map(() => []);
    for (const row of CLASSIFICATION) {
      const [message] = validateSchema(row.resolved).filter((msg) => row.re.test(msg));
      const matches = [];
      sites.forEach((site, i) => {
        if (site.tag === (row.hard ? "hard" : "soft") && sitePattern(site).test(message)) {
          matches.push(i);
          claimedBy[i].push(row.name);
        }
      });
      assert.equal(matches.length, 1,
        `"${row.name}" must trace to exactly one hard()/soft() call site in schema-config.mjs, `
        + `got ${matches.length} (message: ${JSON.stringify(message)})`);
    }
    claimedBy.forEach((rows, i) => {
      assert.equal(rows.length, 1,
        `call site #${i + 1} [${sites[i].tag}] "${sites[i].literal.split(HOLE).join("<x>")}" is claimed by `
        + `${rows.length} CLASSIFICATION rows (${rows.join(", ") || "none"}) — every call site needs `
        + "exactly one row, or a new tag ships unclassified");
    });
  });
});

describe("BLZ-56: the endpoint-kind finding is SOFT, and cli.mjs's preflight depends on it", () => {
  test("an undeclared endpoint kind never reaches the load path's refusal", () => {
    // READ THIS BEFORE MAKING IT HARD. `collectSchemaProblems` judges endpoint kinds
    // against `known = endpointTypes ?? types`, and `endpointTypes` is the union of every
    // type declared anywhere — which only `auditCorpus` supplies. The preflight in
    // scripts/cli.mjs does NOT, deliberately (see its comment): while this finding is
    // soft, `assertSchemaValid` filters it out and the union cannot change any load-path
    // decision. Re-tag it hard and the preflight will refuse every board whose top-level
    // `Precedes` names a type only one project declares — the BLZ-392 false positive,
    // reintroduced on the load path. Making it hard means restoring the `endpointTypes`
    // union in cli.mjs's preflight in the same change.
    const resolved = { types: DEFAULT_TYPES, workflows: DEFAULT_WORKFLOWS,
      linkTypes: [{ name: "Precedes", source_kinds: ["ghosttype"], target_kinds: ["task"] }] };
    assert.ok(validateSchema(resolved).some((m) => /ghosttype/.test(m)), "it must still be REPORTED");
    assert.doesNotThrow(() => assertSchemaValid(resolved),
      "the load path must not refuse it — and cli.mjs's preflight omits `endpointTypes` because of that");
    // And the same, judged against the narrower registry the preflight actually passes.
    assert.doesNotThrow(() => assertSchemaValid({ ...resolved, endpointTypes: null }));
  });
});

// =============================================================================
// Round 4 — `validateSchema`'s documented ORDER.
// Its doc comment promises the problems come back "in the order the problems were
// found", `auditCorpus` prints them in that order, and appending `.reverse()` to the
// return left the whole suite green.
// =============================================================================

describe("BLZ-56: validateSchema returns problems in the order they were found", () => {
  /** One problem from each stage of `collectSchemaProblems`, in source order. */
  const MIXED = {
    types: { ...DEFAULT_TYPES, spike: { level: "0", workflow: "delivery", parentTypes: [], required: [] } },
    workflows: { ...DEFAULT_WORKFLOWS, requirement: NARROWED_REQUIREMENT, zzz: { statuses: [] } },
    linkTypes: [{ name: "Precedes", source_kinds: ["ghosttype"], target_kinds: ["task"] }],
    config: { schema: { linkTypes: { Precedes: "not-an-object" } } },
    project: { schema: { linkTypes: {} } },
  };
  const STAGES = [
    /^type "spike" has a level/,
    /^workflow "zzz" has statuses/,
    /^workflow "requirement" omits/,
    /^link type "Precedes" names "ghosttype"/,
    /^blaze\.config\.json: schema\.linkTypes/,
    /^project\.json: schema\.linkTypes/,
  ];

  test("the stages come back in source order, not reversed or regrouped", () => {
    const out = validateSchema(MIXED);
    const at = STAGES.map((re) => {
      const i = out.findIndex((m) => re.test(m));
      assert.notEqual(i, -1, `${re} never fired, so the order is measured against nothing: ${out.join(" | ")}`);
      return i;
    });
    assert.deepEqual(at, [...at].sort((a, b) => a - b),
      `the problems must arrive in the order they were found — got positions ${at.join(", ")} `
      + `for the stages in source order. \`auditCorpus\` prints them in this order.`);
  });

  test("and the hard subset keeps that order inside the refusal", () => {
    // The load path renders `errors` as the body of one message; a reordering there
    // would print a board's problems in an order its own audit report contradicts.
    const reported = validateSchema(MIXED);
    const refused = refusedMessages(MIXED);
    assert.ok(refused.length >= 2, `expected several hard problems, got ${refused.length}`);
    const positions = refused.map((m) => reported.indexOf(m));
    assert.ok(positions.every((p) => p !== -1), "every refused message must also be reported");
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b),
      "the refusal lists the hard problems in the order validateSchema reports them");
  });
});
