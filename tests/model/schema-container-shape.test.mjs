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

  test("the CONFIG layer still says built-in defaults, because there it is true", () => {
    const msg = validateSchema({ config: { schema: { types: "notanobject" } } })
      .find((p) => /^blaze\.config\.json: schema\.types/.test(p));
    assert.ok(msg && /built-in/.test(msg), `the top layer really does fall back: ${msg}`);
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
         + "so every type, workflow and link type came from the built-in defaults"],
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
    assert.match(schemaContainerErrors({ types: "x" })[0], /the built-in types are still in force/);
  });
});
