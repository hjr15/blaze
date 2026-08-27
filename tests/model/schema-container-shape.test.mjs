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
import { validateSchema, assertSchemaValid } from "../../scripts/model/schema-config.mjs";
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
  { what: "the whole schema as a string", cfg: { schema: "a string" }, re: /schema/ },
  { what: "the whole schema as an array", cfg: { schema: [] }, re: /schema/ },
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

describe("BLZ-396: audit still never throws on any of it", () => {
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
