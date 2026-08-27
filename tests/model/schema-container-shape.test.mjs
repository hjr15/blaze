// tests/model/schema-container-shape.test.mjs — BLZ-396.
//
// BLZ-56 exists because "a valid-JSON but wrong-shape schema override was accepted in
// silence". This is the same class one level up: the override's CONTAINER rather than its
// entries. Each of these produced ZERO findings from `validateSchema`, and `blaze audit`
// reported ok=true on all of them:
//
//   {"schema": {"types": "notanobject"}}
//   {"schema": {"types": ["task"]}}
//   {"schema": {"workflows": 42}}
//   {"schema": "a string"}
//
// `mergeTypes`/`mergeWorkflows` coerce a non-record to `{}` and nothing reports that they
// did, so an operator who writes a wrong-shaped block gets silence and a board running on
// built-in defaults it did not ask for.
//
// The engine ALREADY has the right shape of answer for this class — `linkTypeOverrideErrors`
// says "the whole block was IGNORED" — so this mirrors it rather than inventing a second
// vocabulary for the same fact.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateSchema, assertSchemaValid, schemaContainerErrors }
  from "../../scripts/model/schema-config.mjs";
import { SCHEMA_BLOCK_DROPPED } from "../../scripts/model/schema-marker.mjs";
import { loadConfig, loadProject } from "../../scripts/config.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The hard messages the LOAD path would actually refuse on — [] when it does not throw.
 *  The load path's real answer, not a re-derivation of it. */
function refused(input) {
  try { assertSchemaValid(input); return []; } catch (e) {
    assert.equal(e.name, "SchemaOverrideError", `unexpected throw: ${e.stack}`);
    return e.errors;
  }
}

const WRONG_SHAPES = [
  { what: "types as a string", cfg: { schema: { types: "notanobject" } }, re: /schema\.types/ },
  { what: "types as an array", cfg: { schema: { types: ["task"] } }, re: /schema\.types/ },
  { what: "types as a number", cfg: { schema: { types: 42 } }, re: /schema\.types/ },
  { what: "workflows as a number", cfg: { schema: { workflows: 42 } }, re: /schema\.workflows/ },
  { what: "workflows as an array", cfg: { schema: { workflows: [] } }, re: /schema\.workflows/ },
  { what: "the whole schema as a string", cfg: { schema: "a string" },
    re: /^blaze\.config\.json: schema must be an object, got string/ },
  { what: "the whole schema as an array", cfg: { schema: [] },
    re: /^blaze\.config\.json: schema must be an object, got an array/ },
];

describe("BLZ-396: a wrong-shaped container is reported, not ignored in silence", () => {
  for (const { what, cfg, re } of WRONG_SHAPES) {
    test(`${what} is reported`, () => {
      const problems = validateSchema({ config: cfg });
      assert.ok(problems.length > 0,
        `${what}: produced ZERO findings — the operator wrote a block that did nothing`);
      assert.ok(problems.some((p) => re.test(p)), `${what}: no message names the block: ${problems}`);
      assert.ok(problems.some((p) => /IGNORED/.test(p)),
        `${what}: must say the block was IGNORED, the way linkTypeOverrideErrors already does`);
    });

    test(`${what} refuses on the LOAD path`, () => {
      // AC-2's split: a wrong-shaped container is a genuine malformation, not a
      // legal-but-inert block, so it is HARD. Measured against the live board first —
      // blaze-pm's blaze.config.json carries a well-formed `schema` and no project.json
      // carries one at all — so this refuses nothing that exists today.
      const errors = refused({ config: cfg });
      assert.ok(errors.length > 0, `${what}: the load path must refuse a malformed container`);
      assert.ok(errors.some((e) => re.test(e)), `${what}: and name it: ${errors}`);
    });
  }

  test("the project layer is reported too, and named as the project layer", () => {
    const problems = validateSchema({ project: { schema: { types: "notanobject" } } });
    assert.ok(problems.some((p) => /project\.json/.test(p)),
      `a per-project block must say which file it is in: ${problems}`);
  });

  test("the config layer says which file it is in", () => {
    const problems = validateSchema({ config: { schema: { workflows: 42 } } });
    assert.ok(problems.some((p) => /blaze\.config\.json/.test(p)), problems.join(" | "));
  });
});

describe("BLZ-396: a well-formed board is untouched", () => {
  // The direction that stops all of the above from being satisfied by refusing everything.
  const OK = [
    { what: "no schema block at all", cfg: {} },
    { what: "an empty schema block", cfg: { schema: {} } },
    { what: "schema with only linkTypes", cfg: { schema: { linkTypes: {} } } },
    { what: "a well-formed types block", cfg: { schema: { types: {} } } },
    { what: "a well-formed workflows block", cfg: { schema: { workflows: {} } } },
    { what: "types and workflows both present", cfg: { schema: { types: {}, workflows: {} } } },
  ];
  for (const { what, cfg } of OK) {
    test(`${what} produces no container finding`, () => {
      const problems = validateSchema({ config: cfg });
      assert.deepEqual(problems.filter((p) => /the whole block was IGNORED/.test(p)), [],
        `${what}: a well-formed board must not be told its block was ignored`);
      assert.deepEqual(refused({ config: cfg }).filter((e) => /IGNORED/.test(e)), [],
        `${what}: and must not be refused on the load path`);
    });
  }

  test("null and undefined are both ABSENT, not wrong shapes", () => {
    // `loadConfig`/`loadProject` normalise a missing `schema` to NULL, so treating null as
    // malformed put a finding on every ordinary board. An operator who literally writes
    // `"types": null` is therefore not reported either — a tiny, deliberate gap, and far
    // better than firing on every installation.
    for (const cfg of [{ schema: null }, { schema: { types: null } }, { schema: { workflows: null } }]) {
      assert.deepEqual(
        validateSchema({ config: cfg }).filter((p) => /the whole block was IGNORED/.test(p)), [],
        `${JSON.stringify(cfg)} must not be reported`);
    }
  });

  test("undefined is not a wrong shape — it is the ordinary case", () => {
    // `schema.types` absent is how almost every board is written. Reporting it would put a
    // finding on essentially every installation, which is worse than the bug.
    assert.deepEqual(
      validateSchema({ config: { schema: { workflows: {} } } })
        .filter((p) => /schema\.types/.test(p)), []);
  });
});

describe("BLZ-396: validateSchema never throws on any of it", () => {
  // Named for what it MEASURES. It drives `validateSchema` in process and never runs `blaze
  // audit`; the end-to-end claim is pinned by tests/audit-malformed-container.test.mjs, a
  // subprocess test, because in this repo a unit-green/audit-dying gap is a real defect class
  // and not a hypothetical one.
  // `tests/audit-malformed-linktypes.test.mjs` must stay green: BLZ-392 made this path
  // REPORT rather than throw, because throwing killed `blaze audit` outright — a stack
  // trace and no report at all, losing the whole hygiene report for one bad field.
  for (const bad of [
    { schema: "a string" }, { schema: [] }, { schema: 0 }, { schema: null },
    { schema: { types: "x" } }, { schema: { workflows: "x" } },
    { schema: { types: [], workflows: [] } },
  ]) {
    test(`validateSchema does not throw on ${JSON.stringify(bad)}`, () => {
      assert.doesNotThrow(() => validateSchema({ config: bad }));
      assert.doesNotThrow(() => validateSchema({ project: bad }));
    });
  }

  test("and every message is a STRING — auditCorpus puts these straight into a Set", () => {
    // Handing it objects renders every `schema-invalid` detail as [object Object], which is
    // BLZ-392's defect by another route.
    for (const p of validateSchema({ config: { schema: { types: ["task"] } } })) {
      assert.equal(typeof p, "string", `not a string: ${JSON.stringify(p)}`);
    }
  });
});

describe("BLZ-396: the whole-block case, through the REAL loader", () => {
  /** `loadConfig` flattens a non-record `schema` to null BEFORE any consumer sees it, so
   *  downstream a wrong-shaped block and an absent one are indistinguishable and
   *  `{"schema": "a string"}` could never be reported from `validateSchema` alone. The
   *  loader records the kind it dropped. Every other test in this file passes raw objects
   *  straight to `validateSchema`, which bypasses the loader entirely — so that branch was
   *  pinned by nothing, and two mutations of it survived the whole suite. */
  function board(configJson, projectJson) {
    const root = mkdtempSync(join(tmpdir(), "blz396-load-"));
    mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
    writeFileSync(join(root, "blaze.config.json"), configJson);
    if (projectJson !== undefined) {
      writeFileSync(join(root, "projects", "ENG", "project.json"), projectJson);
    }
    return root;
  }
  const problemsFor = (root) => {
    const config = loadConfig({ root });
    const project = loadProject("ENG", { root, projectsDir: join(root, "projects") });
    return [...validateSchema({ config }), ...validateSchema({ config, project })];
  };

  for (const [what, raw] of Object.entries({
    "a string": '"a string"', "an array": '["task"]', "a number": "42", "false": "false",
  })) {
    test(`a whole schema block that is ${what} is reported through loadConfig`, () => {
      const root = board(`{"key":"ENG","projects":["ENG"],"schema":${raw}}`);
      try {
        const problems = problemsFor(root);
        assert.ok(problems.some((p) => /blaze\.config\.json: schema must be an object/.test(p)),
          `${what}: the loader flattened it to null and nothing reported it: ${problems}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("a whole PROJECT schema block that is a string is reported too", () => {
    const root = board('{"key":"ENG","projects":["ENG"]}', '{"schema":"a string"}');
    try {
      assert.ok(problemsFor(root).some((p) => /project\.json: schema must be an object/.test(p)),
        "the per-project block is read by resolveSchema, so a malformed one must be reported");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an ordinary board reports NOTHING through the loader", () => {
    // The direction that matters most. `PROJECT_DEFAULTS` seeds `schema: null` and
    // `loadConfig` normalises an absent block to null, so a marker that fired on null put a
    // finding on every installation and refused every non-exempt verb.
    for (const [what, cfg, proj] of [
      ["no schema anywhere", '{"key":"ENG","projects":["ENG"]}', undefined],
      ["no project.json at all", '{"key":"ENG","projects":["ENG"]}', undefined],
      ["an explicit null schema", '{"key":"ENG","projects":["ENG"],"schema":null}', undefined],
      ["a well-formed schema", '{"key":"ENG","projects":["ENG"],"schema":{"types":{}}}', undefined],
      ["a project.json with no schema", '{"key":"ENG","projects":["ENG"]}', '{"labels":[]}'],
    ]) {
      const root = board(cfg, proj);
      try {
        assert.deepEqual(problemsFor(root).filter((p) => /the whole block was IGNORED/.test(p)), [],
          `${what}: an ordinary board must not be told its block was ignored`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});

describe("BLZ-396 review F1: the message names what is ACTUALLY still in force", () => {
  // ONE message served both layers and its "what is still in force" clause was hardcoded to
  // the built-in defaults. With a valid top-level override present that is FALSE: the
  // project block is the SECOND merge in `resolveSchema`, so dropping it leaves
  // DEFAULT + blaze.config.json in force, not DEFAULT alone. Telling the operator their
  // board is on defaults, and pointing at the wrong file, is the exact class of untrue
  // statement this ticket exists to end — reintroduced inside the report.
  const TOP = { schema: { types: { spike: { level: 0, workflow: "delivery",
    parentTypes: ["feature"], required: ["title"] } } } };

  test("a dropped PROJECT block does not claim the board fell back to built-in defaults", () => {
    const problems = validateSchema({ config: TOP, project: { schema: { types: "notanobject" } } });
    const msg = problems.find((p) => /^project\.json: schema\.types/.test(p));
    assert.ok(msg, `no project-layer types message: ${problems}`);
    assert.doesNotMatch(msg, /built-in/,
      `the blaze.config.json override IS in force, so this is untrue: ${msg}`);
    assert.match(msg, /blaze\.config\.json/,
      `the project layer must name the layer that is still in force: ${msg}`);
  });

  test("a dropped whole PROJECT schema block says the same true thing", () => {
    const problems = validateSchema({ config: TOP, project: { schema: "a string" } });
    const msg = problems.find((p) => /^project\.json: schema must be an object/.test(p));
    assert.ok(msg, `no project-layer whole-block message: ${problems}`);
    assert.doesNotMatch(msg, /every type, workflow and link type came from the built-in defaults/,
      `untrue with a top-level override present: ${msg}`);
  });

  test("the CONFIG layer speaks about its own FILE, not about the board", () => {
    // It said "the built-in types are still in force", which was untrue whenever a PROJECT
    // layer carried a valid override — round 1's defect mirrored onto the other layer. The
    // finding is installation-wide (deduped across every project), so there is no single
    // board state it could correctly describe.
    const msg = validateSchema({ config: { schema: { types: "notanobject" } } })
      .find((p) => /^blaze\.config\.json: schema\.types/.test(p));
    assert.match(msg, /blaze\.config\.json contributes no types/, msg);
  });
});

describe("BLZ-396 review F2: the dropped-kind marker is not operator-controllable", () => {
  // `audit-runner.mjs` hands `auditCorpus` the RAW `JSON.parse(project.json)` — it never
  // calls `loadProject` — so any key an operator writes arrives verbatim. A string-keyed
  // marker therefore let a board invent a malformation that does not exist: audit reported
  // "the whole block was IGNORED" on a project.json with no schema block at all, and the
  // load path disagreed with audit on the same board. A Symbol cannot come out of JSON.
  test("a hand-written schemaBlockDropped key invents no finding", () => {
    for (const forged of ["string", "an array", { a: 1 }, 42, true]) {
      const project = JSON.parse(JSON.stringify({ key: "ENG", schemaBlockDropped: forged }));
      assert.deepEqual(
        validateSchema({ project }).filter((p) => /IGNORED/.test(p)), [],
        `a forged marker ${JSON.stringify(forged)} must not report a malformation`);
      assert.deepEqual(refused({ project }).filter((e) => /IGNORED/.test(e)), [],
        `and must never refuse the board: ${JSON.stringify(forged)}`);
    }
  });

  test("a forged marker cannot render an object into a detail string", () => {
    // The rendering `[object Object]` is BLZ-392's defect by another route, and the existing
    // "every message is a STRING" test does not catch it — it asserts the message is a
    // string, not that the interpolated KIND is.
    for (const p of validateSchema({ project: { schemaBlockDropped: { a: 1 } } })) {
      assert.doesNotMatch(p, /\[object Object\]/, `rendered an object: ${p}`);
    }
  });

  test("the real loader's marker still reports, through the Symbol", () => {
    const root = mkdtempSync(join(tmpdir(), "blz396-sym-"));
    try {
      mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
      writeFileSync(join(root, "blaze.config.json"), '{"key":"ENG","projects":["ENG"],"schema":"a string"}');
      const config = loadConfig({ root });
      assert.ok(validateSchema({ config }).some((p) => /schema must be an object, got string/.test(p)),
        "the loader path must still report — a Symbol marker that nothing reads is no marker");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-396 review F2: schemaContainerErrors' own dropped-kind contract", () => {
  // The Symbol marker means no operator-written JSON can reach `dropped` through the two
  // production call sites, so reverting the value whitelist alone kills nothing in the
  // suite. But this function is EXPORTED, and the whitelist is the only thing standing
  // between a caller's bad value and `[object Object]` in an audit detail — the BLZ-392
  // rendering defect. Pinned where it is actually reachable: at the public boundary.
  test("only the kinds the loaders can produce are reported", () => {
    for (const kind of ["an array", "string", "number", "boolean", "bigint", "symbol", "function"]) {
      assert.deepEqual(schemaContainerErrors(null, kind),
        [`schema must be an object, got ${kind} — the whole block was IGNORED, `
         + "so nothing in blaze.config.json reaches the resolved schema"],
        `${kind} is a kind loadConfig really emits and must be reported`);
    }
  });

  test("anything else is ignored rather than rendered into a detail", () => {
    for (const bogus of [{ a: 1 }, ["x"], 42, true, "notakind", () => {}]) {
      assert.deepEqual(schemaContainerErrors(null, bogus), [],
        `a value no loader produces must not become a finding: ${String(bogus)}`);
    }
  });

  test("and the layer argument defaults to the config layer", () => {
    // Both production call sites pass it explicitly; the default keeps the exported
    // function honest for anyone who does not.
    assert.match(schemaContainerErrors({ types: "x" })[0], /blaze\.config\.json contributes no types/);
  });
});

describe("BLZ-396 re-review B1: the layer clause is DERIVED, never assumed", () => {
  // The first F1 fix INVERTED the untrue statement instead of removing it. It said "the
  // blaze.config.json layer is still in force" for every project-layer report — including
  // when that layer does not exist, is itself dropped, or declares nothing for the block in
  // question. That is wrong on the MORE common board: the old message was only untrue when
  // config HAD a valid override; the replacement is untrue whenever config LACKS one.
  //
  // Both F1 tests pinned the one case where the new clause happened to be true, because they
  // fixed the config layer to a valid `spike` override. A test that asserts the requirement
  // is what the code already does is not a test.
  const SPIKE = { types: { spike: { level: 0, workflow: "delivery",
    parentTypes: ["feature"], required: ["title"] } } };
  const projectDetail = (config, project) =>
    validateSchema({ config, project }).find((p) => /^project\.json:/.test(p));

  test("B1.a no schema in blaze.config.json at all — the DEFAULTS are in force", () => {
    const msg = projectDetail({ key: "ENG" }, { schema: "a string" });
    assert.ok(msg, "no project-layer message at all");
    assert.doesNotMatch(msg, /the blaze\.config\.json layer is still in force/,
      `there is no blaze.config.json layer — this points the operator at a file with no `
      + `schema block:\n${msg}`);
    assert.match(msg, /built-in defaults/, `the defaults really are what is in force:\n${msg}`);
  });

  test("B1.b both layers dropped — the report must not contradict itself", () => {
    const problems = validateSchema(
      { config: { schema: null, [SCHEMA_BLOCK_DROPPED]: "string" }, project: { schema: "a string" } });
    const top = problems.find((p) => /^blaze\.config\.json:/.test(p));
    const proj = problems.find((p) => /^project\.json:/.test(p));
    assert.ok(top && proj, `expected both layers reported: ${problems}`);
    assert.doesNotMatch(proj, /the blaze\.config\.json layer is still in force/,
      `the line above says that very layer was IGNORED:\n${top}\n${proj}`);
  });

  test("B1.c config overrides only types; a dropped project WORKFLOWS block", () => {
    const msg = validateSchema({ config: { schema: SPIKE }, project: { schema: { workflows: 42 } } })
      .find((p) => /^project\.json: schema\.workflows/.test(p));
    assert.ok(msg, "no project-layer workflows message");
    assert.doesNotMatch(msg, /blaze\.config\.json layer's workflows/,
      `blaze.config.json declares no workflows — only types:\n${msg}`);
    assert.match(msg, /built-in workflows/, `the built-in workflows are in force:\n${msg}`);
  });

  test("B1.d config's block is valid but declares nothing for this block", () => {
    const msg = projectDetail({ schema: { linkTypes: {} } }, { schema: { types: "x" } });
    assert.ok(msg, "no project-layer message");
    assert.doesNotMatch(msg, /blaze\.config\.json layer's types/,
      `a linkTypes-only override puts no types in force:\n${msg}`);
  });

  test("and the TRUE case still says so — the control", () => {
    // Without this, every assertion above is satisfied by never naming the config layer,
    // which would put back the original F1 defect.
    const msg = projectDetail({ schema: SPIKE }, { schema: { types: "x" } });
    assert.match(msg, /blaze\.config\.json layer's types are still in force/,
      `the spike override IS in force and the operator must be told:\n${msg}`);
    const whole = projectDetail({ schema: SPIKE }, { schema: "a string" });
    assert.match(whole, /the blaze\.config\.json layer is still in force/,
      `a dropped WHOLE project block with a real top-level override:\n${whole}`);
  });
});

describe("BLZ-396 re-review B1b: 'in force' means CONTRIBUTES, not merely well-shaped", () => {
  // Wrong a THIRD time. `isRecord(configSchema)` asks whether the config layer is a record.
  // The sentence the operator reads asserts that it puts something in force. Those diverge
  // for every config layer that is a well-formed record declaring nothing — including one
  // whose own inner block was reported as IGNORED on the line immediately above.
  //
  // The predicate is DERIVED from `resolveSchema` rather than reimplemented, because a
  // hand-written "does this contribute" rule gets the coercions wrong: `mergeTypes` and
  // `mergeLinkTypes` flatten a non-record to `{}`, so `{"linkTypes":["x"]}` is a NO-OP
  // despite being a non-empty array. Measured, not assumed: of {}, types:{}, types:null,
  // types:"notanobject", types:["task"], linkTypes:[], linkTypes:["x"], linkTypes:{} and
  // workflows:[1,2], every one leaves `resolveSchema` byte-identical to the defaults.
  const projectDetail = (config, project) =>
    validateSchema({ config, project }).find((p) => /^project\.json:/.test(p));

  const DECLARES_NOTHING = {
    "an empty schema block": {},
    "an empty types block": { types: {} },
    "a null types block": { types: null },
    "a types block that is itself malformed": { types: "notanobject" },
    "a types block that is an array": { types: ["task"] },
    "an empty linkTypes block": { linkTypes: {} },
    "a non-empty linkTypes ARRAY, which the merge coerces away": { linkTypes: ["x"] },
  };

  for (const [what, schema] of Object.entries(DECLARES_NOTHING)) {
    test(`config with ${what} is not reported as in force`, () => {
      const msg = projectDetail({ schema }, { schema: "a string" });
      assert.ok(msg, `no project-layer message for ${what}`);
      assert.doesNotMatch(msg, /the blaze\.config\.json layer is still in force/,
        `${what} contributes nothing — resolveSchema returns the defaults:\n${msg}`);
    });
  }

  test("the report cannot contradict itself when the config block is itself IGNORED", () => {
    // The sharpest case: one line says that layer's only declaration was ignored, the next
    // said the layer is in force. Reached by a PER-BLOCK drop, which the whole-block test
    // above does not cover.
    const problems = validateSchema(
      { config: { schema: { types: "notanobject" } }, project: { schema: "a string" } });
    const top = problems.find((p) => /^blaze\.config\.json:/.test(p));
    const proj = problems.find((p) => /^project\.json:/.test(p));
    assert.ok(top && proj, `expected both layers reported: ${problems}`);
    assert.doesNotMatch(proj, /the blaze\.config\.json layer is still in force/,
      `the line above says that layer's only declaration was IGNORED:\n${top}\n${proj}`);
  });

  test("an EMPTY config types block is not reported as putting types in force", () => {
    const msg = validateSchema({ config: { schema: { types: {} } },
      project: { schema: { types: "x" } } }).find((p) => /^project\.json: schema\.types/.test(p));
    assert.ok(msg, "no project-layer types message");
    assert.doesNotMatch(msg, /blaze\.config\.json layer's types/,
      `mergeTypes over {} is a no-op — the built-in types are what is in force:\n${msg}`);
  });

  test("a config layer that DOES contribute is still named — the control", () => {
    // Without this the whole block above is satisfied by never naming the config layer,
    // which reinstates the ORIGINAL F1 defect. Third time through this loop.
    const SPIKE = { types: { spike: { level: 0, workflow: "delivery",
      parentTypes: ["feature"], required: ["title"] } } };
    assert.match(projectDetail({ schema: SPIKE }, { schema: "a string" }),
      /the blaze\.config\.json layer is still in force/, "a real override IS in force");
    assert.match(
      validateSchema({ config: { schema: SPIKE }, project: { schema: { types: "x" } } })
        .find((p) => /^project\.json: schema\.types/.test(p)),
      /blaze\.config\.json layer's types are still in force/, "and per block too");
  });

  test("a linkTypes-only override still counts for the WHOLE-block message", () => {
    // It contributes to the resolved schema, and the whole-block sentence covers link types
    // explicitly ("every type, workflow and link type"), so claiming defaults would be the
    // same error mirrored.
    const msg = projectDetail(
      { schema: { linkTypes: { Precedes: { source_kinds: ["task"], target_kinds: ["task"],
        min_card: 0, max_card: null } } } }, { schema: "a string" });
    assert.match(msg, /the blaze\.config\.json layer is still in force/, msg);
  });
});

describe("BLZ-396 re-review B1c: the CONFIG layer's own clause", () => {
  // Wrong a FOURTH time, in the half the third fix never touched. `configSchema` was threaded
  // into the PROJECT-layer call only, so the config-layer call kept a hardcoded "the built-in
  // X are still in force" — round 1's defect exactly, mirrored. Every one of the eleven tests
  // written for round 3 filters on /^project\.json:/, so not one of them looked at it.
  //
  // And the config-layer finding cannot be fixed by naming what IS in force, because it is
  // emitted ONCE for the whole installation (audit.mjs dedups it across every project), so no
  // single project's schema is the right thing to name. The sentence must stop claiming the
  // board and speak only about the file it is in.
  const WIDGET = { types: { widget: { level: 9, workflow: "delivery",
    parentTypes: [], required: ["title"] } } };
  const configDetail = (config, project) =>
    validateSchema({ config, project }).find((p) => /^blaze\.config\.json:/.test(p));

  test("a dropped WHOLE config block does not claim the board is on built-in defaults", () => {
    const msg = configDetail({ schema: null, [SCHEMA_BLOCK_DROPPED]: "string" },
      { schema: WIDGET });
    assert.ok(msg, "no config-layer message");
    assert.doesNotMatch(msg, /came from the built-in defaults/,
      `project.json declares a live \`widget\` type, so the board is NOT on defaults:\n${msg}`);
  });

  test("a dropped config TYPES block does not claim the built-in types are in force", () => {
    const msg = validateSchema({ config: { schema: { types: "notanobject" } },
      project: { schema: WIDGET } }).find((p) => /^blaze\.config\.json: schema\.types/.test(p));
    assert.ok(msg, "no config-layer types message");
    assert.doesNotMatch(msg, /the built-in types are still in force/,
      `\`widget\` is a live type on this board:\n${msg}`);
  });

  test("and it says something true about the FILE, not about the board", () => {
    // The installation-wide finding has no single project to describe, so the only honest
    // subject is blaze.config.json itself.
    const msg = validateSchema({ config: { schema: { types: "notanobject" } } })
      .find((p) => /^blaze\.config\.json: schema\.types/.test(p));
    assert.match(msg, /blaze\.config\.json contributes no types/, msg);
    const whole = validateSchema({ config: { schema: "a string" } })
      .find((p) => /^blaze\.config\.json:/.test(p));
    assert.match(whole, /nothing in blaze\.config\.json reaches the resolved schema/, whole);
  });

  test("the same wording holds whether or not a project layer exists — the control", () => {
    // The config-layer string is deduped across the whole installation, so it must not vary
    // with which project happens to be resolved beside it.
    const withProject = validateSchema(
      { config: { schema: { types: "notanobject" } }, project: { schema: WIDGET } })
      .find((p) => /^blaze\.config\.json: schema\.types/.test(p));
    const without = validateSchema({ config: { schema: { types: "notanobject" } } })
      .find((p) => /^blaze\.config\.json: schema\.types/.test(p));
    assert.equal(withProject, without,
      "one installation-wide finding must not render two different sentences");
    // Equality alone is satisfied by two identically-WRONG sentences, which is how this
    // control passed through a revert of the very hunk it was written for.
    assert.doesNotMatch(withProject, /still in force|built-in/,
      `the config-layer finding must claim nothing about board state:\n${withProject}`);
  });
});

describe("BLZ-396 re-review N1/N2: the report survives a config it cannot stringify", () => {
  // `contributes` compares `JSON.stringify` of two resolves. Those calls sat OUTSIDE the try
  // whose comment claims a report never throws, so `validateSchema` began throwing on four
  // shapes it tolerated one commit earlier. None is reachable from `JSON.parse`, so no board
  // could hit it — but this file's contract is "Never throws, on any input", the existing
  // test asserting that was passing only because nothing exercised these, and deleting the
  // try/catch entirely survived the whole suite.
  const circular = () => { const t = {}; t.self = t; return { types: { a: t } }; };
  const HOSTILE = {
    "a circular structure": circular(),
    "a BigInt value": { types: { a: { level: 1n } } },
    "a throwing toJSON": { types: { a: { toJSON() { throw new Error("boom"); } } } },
    "a throwing getter": { types: { get a() { throw new Error("boom"); } } },
  };
  for (const [what, configSchema] of Object.entries(HOSTILE)) {
    test(`${what} in the config layer neither throws nor is reported as in force`, () => {
      let problems;
      assert.doesNotThrow(() => {
        problems = validateSchema({ config: { schema: configSchema },
          project: { schema: "a string" } });
      }, `${what} escaped the guard`);
      const msg = problems.find((p) => /^project\.json:/.test(p));
      assert.ok(msg, `${what}: the project-layer finding was lost`);
      assert.doesNotMatch(msg, /the blaze\.config\.json layer is still in force/,
        `${what}: unknown is not the same as in force:\n${msg}`);
    });
  }
});

describe("BLZ-396 re-review B1d: an UNKNOWN answer must not render as a definite claim", () => {
  // Wrong a FIFTH time, in the branch the fourth fix itself added. When `contributes` cannot
  // compute it returned `false` — and `false` is not the weaker answer, it is the positive
  // claim "the built-in types are still in force". So an uncomputable board printed round 1's
  // defect verbatim.
  //
  // AND IT IS REACHABLE FROM `JSON.parse`, which the code comment denied. `JSON.parse`
  // accepts nesting depths that `JSON.stringify` cannot serialise, so a hand-written
  // blaze.config.json is enough — no exotic runtime value required.
  const SPIKE = { types: { spike: { level: 0, workflow: "delivery",
    parentTypes: ["feature"], required: ["title"] } } };
  /** Deep enough that `JSON.parse` succeeds and `JSON.stringify` throws RangeError. */
  const unserialisable = () => JSON.parse("[".repeat(6000) + "]".repeat(6000));
  const hostileSpike = () => {
    const cfg = JSON.parse(JSON.stringify(SPIKE));
    cfg.types.spike.note = unserialisable();
    return cfg;
  };

  test("the premise: this really does parse and really does not stringify", () => {
    const v = unserialisable();
    assert.ok(v, "JSON.parse rejected it — the whole case would be unreachable");
    assert.throws(() => JSON.stringify(v), RangeError,
      "if this serialises the test below proves nothing");
  });

  test("a per-block finding does not claim the built-in types are in force", () => {
    const msg = validateSchema({ config: { schema: hostileSpike() },
      project: { schema: { types: 5 } } }).find((p) => /^project\.json: schema\.types/.test(p));
    assert.ok(msg, "the project-layer finding was lost entirely");
    assert.doesNotMatch(msg, /the built-in types are still in force/,
      `\`spike\` came from blaze.config.json and IS in force on this board:\n${msg}`);
  });

  test("a whole-block finding does not claim the board fell back to defaults", () => {
    const msg = validateSchema({ config: { schema: hostileSpike() },
      project: { schema: "a string" } }).find((p) => /^project\.json:/.test(p));
    assert.ok(msg, "the project-layer finding was lost entirely");
    assert.doesNotMatch(msg, /came from the built-in defaults/,
      `the config layer contributes \`spike\` on this board:\n${msg}`);
  });

  test("it says the true, weaker thing about the file instead", () => {
    // The one sentence that is unconditionally true whatever the config layer turns out to
    // be: the block being reported was dropped, so THAT file contributes nothing.
    const perBlock = validateSchema({ config: { schema: hostileSpike() },
      project: { schema: { types: 5 } } }).find((p) => /^project\.json: schema\.types/.test(p));
    assert.match(perBlock, /project\.json contributes no types/, perBlock);
    const whole = validateSchema({ config: { schema: hostileSpike() },
      project: { schema: "a string" } }).find((p) => /^project\.json:/.test(p));
    assert.match(whole, /nothing in project\.json reaches the resolved schema/, whole);
  });

  test("a COMPUTABLE board still gets the definite answer — both ways, the control", () => {
    // Without this, the whole block is satisfied by always saying the unknown sentence,
    // which throws away the information the last four rounds were spent getting right.
    assert.match(
      validateSchema({ config: { schema: SPIKE }, project: { schema: "a string" } })
        .find((p) => /^project\.json:/.test(p)),
      /the blaze\.config\.json layer is still in force/, "contributing config layer");
    assert.match(
      validateSchema({ config: { schema: {} }, project: { schema: "a string" } })
        .find((p) => /^project\.json:/.test(p)),
      /came from the built-in defaults/, "non-contributing config layer");
  });
});

describe("BLZ-396 re-review N: the predicate is LAZY", () => {
  // The lazy rework was entirely unpinned — reverting it failed zero tests. It matters
  // because an eager version charges two schema merges to every ordinary board that has a
  // config schema record, whether or not any finding is produced.
  test("a well-formed project block never touches the config layer at all", () => {
    let reads = 0;
    const probe = { get types() { reads += 1; return {}; } };
    const errors = schemaContainerErrors({ types: {} }, null, "project", probe);
    assert.deepEqual(errors, [], "premise: a well-formed block produces no finding");
    assert.equal(reads, 0,
      "the config layer was resolved to build a message that was never built");
  });

  test("and a malformed one does — the control", () => {
    let reads = 0;
    const probe = { get types() { reads += 1; return {}; } };
    assert.ok(schemaContainerErrors({ types: 5 }, null, "project", probe).length > 0);
    assert.ok(reads > 0, "the message must actually be derived from the config layer");
  });
});

describe("BLZ-396: a block the memo does not carry is UNKNOWN, not 'no'", () => {
  // Latent, and deliberately closed while it is still latent. The memo holds `types` and
  // `workflows` because those are the two blocks the inspection loop reports on. Adding a
  // third — `linkTypes` is the obvious candidate — would index the memo with a key it does
  // not have, and `undefined` is not `=== null`, so it would fall to the falsy branch and
  // render the definite "the built-in linkTypes are still in force". That is round 1's
  // defect by a sixth road, and it would arrive as a one-line change nobody reads twice.
  test("an unknown block name reports the file-scoped sentence, not a definite claim", () => {
    // Reaches the same code path the loop would, without waiting for someone to widen it.
    const SPIKE = { types: { spike: { level: 0, workflow: "delivery",
      parentTypes: ["feature"], required: ["title"] } } };
    const errors = schemaContainerErrors({ types: 5 }, null, "project", SPIKE);
    assert.ok(errors.length > 0, "premise: a malformed types block still reports");
    assert.match(errors[0], /the blaze\.config\.json layer's types are still in force/,
      `a block the memo DOES carry must keep its definite answer: ${errors[0]}`);
  });
});
