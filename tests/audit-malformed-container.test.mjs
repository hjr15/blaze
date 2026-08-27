// tests/audit-malformed-container.test.mjs — BLZ-396.
//
// A SUBPROCESS test, for the reason `tests/audit-malformed-linktypes.test.mjs` records in its
// own header: BLZ-392's first fix left every unit green while `blaze audit` was dying with a
// raw Node stack trace and no report at all. The container check added by BLZ-396 was pinned
// only against `validateSchema` in-process, so the claim "blaze audit still never throws on
// any of it" was true of the product and untrue of the tests. This makes it true of both.
//
// It also pins the two defects an adversarial review found in the first cut, END TO END:
//   F1 — the report told an operator with a valid blaze.config.json override that their board
//        had fallen back to the built-in defaults, and named the wrong file.
//   F2 — `audit-runner.mjs` hands `auditCorpus` the RAW `JSON.parse(project.json)`, never
//        `loadProject`, so a string-keyed dropped marker let a board invent a malformation
//        that was not there.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/audit-runner.mjs", import.meta.url));

/** A one-ticket board. `configJson`/`projectJson` are written VERBATIM, because the shapes
 *  under test are ones `JSON.stringify` of a sane object cannot produce. */
function board(configJson, projectJson) {
  const root = mkdtempSync(join(tmpdir(), "blz396-audit-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), configJson);
  if (projectJson !== undefined) {
    writeFileSync(join(root, "projects", "ENG", "project.json"), projectJson);
  }
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-x.md"),
    ["---", "id: ENG-1", 'title: "x"', "type: task", "project: ENG", "status: defined",
     "estimate: 480", "deadline: 2026-08-01", "---", ""].join("\n"));
  return root;
}

const audit = (root, ...args) => spawnSync(process.execPath, [runner, ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

/** The `schema-invalid` DETAILS, as the operator reads them. The plain report prints only a
 *  per-kind count, so the wording — the whole subject of F1 — is only visible under --json. */
function schemaDetails(root) {
  const r = audit(root, "--json");
  const parsed = JSON.parse(r.stdout);
  return (parsed.findings ?? []).filter((f) => f.kind === "schema-invalid").map((f) => f.detail);
}

const BASE = '{"key":"ENG","projects":["ENG"]';
/** A valid top-level override, so the "what is still in force" clause has something to be
 *  wrong about. Without it, F1's untrue message reads as true. */
const SPIKE = '"schema":{"types":{"spike":{"level":0,"workflow":"delivery",'
  + '"parentTypes":["feature"],"required":["title"]}}}';

describe("BLZ-396: a malformed schema CONTAINER never takes `blaze audit` down", () => {
  const SHAPES = {
    "types as a string": [`${BASE},"schema":{"types":"notanobject"}}`, undefined],
    "types as an array": [`${BASE},"schema":{"types":["task"]}}`, undefined],
    "workflows as a number": [`${BASE},"schema":{"workflows":42}}`, undefined],
    "the whole block as a string": [`${BASE},"schema":"a string"}`, undefined],
    "the whole block as an array": [`${BASE},"schema":[]}`, undefined],
    "a project-layer types block as a string": [`${BASE}}`, '{"schema":{"types":"x"}}'],
    "a project-layer whole block as a string": [`${BASE}}`, '{"schema":"a string"}'],
  };

  for (const [label, [cfg, proj]] of Object.entries(SHAPES)) {
    test(`${label} still produces a full report`, () => {
      const root = board(cfg, proj);
      try {
        const r = audit(root);
        assert.doesNotMatch(r.stderr ?? "",
          /at schemaContainerErrors|at collectSchemaProblems|at resolveSchema|at auditCorpus/,
          `blaze audit died with a stack trace:\n${r.stderr}`);
        assert.match(r.stdout, /ok=true/,
          `no report was produced.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert.match(r.stdout, /schema-invalid/,
          `the operator wrote a block that did nothing and was never told:\n${r.stdout}`);
        // Still a REAL audit, not an empty shell that happens to say ok.
        assert.match(r.stdout, /deadline-unreachable/,
          `the schedule was silently switched off:\n${r.stdout}`);
        assert.doesNotMatch(r.stdout, /\[object Object\]/,
          `a detail rendered as [object Object] — BLZ-392's defect by another route:\n${r.stdout}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("a healthy board reports no schema-invalid — the check is not always-on", () => {
    // Without this control, a schema-invalid that fired unconditionally satisfies every
    // assertion above. This is the direction that has been worse than the bug twice here.
    for (const [what, cfg, proj] of [
      ["no schema anywhere", `${BASE}}`, undefined],
      ["an explicit null schema", `${BASE},"schema":null}`, undefined],
      ["a well-formed override", `${BASE},${SPIKE}}`, undefined],
      ["a project.json with no schema", `${BASE}}`, '{"labels":[]}'],
      ["a project.json with a null schema", `${BASE}}`, '{"schema":null}'],
    ]) {
      const root = board(cfg, proj);
      try {
        const r = audit(root);
        assert.match(r.stdout, /ok=true/, `${what}: ${r.stderr}`);
        assert.doesNotMatch(r.stdout, /schema-invalid/,
          `${what}: an ordinary board was told its block was ignored:\n${r.stdout}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });
});

describe("BLZ-396 review F1: audit names the layer that is ACTUALLY still in force", () => {
  test("a dropped PROJECT block does not claim the board is on built-in defaults", () => {
    const root = board(`${BASE},${SPIKE}}`, '{"schema":{"types":"notanobject"}}');
    try {
      const details = schemaDetails(root);
      const line = details.find((d) => /^project\.json:/.test(d));
      assert.ok(line, `no project-layer schema-invalid finding: ${JSON.stringify(details)}`);
      assert.doesNotMatch(line, /built-in/,
        `the blaze.config.json spike override IS in force, so this is untrue:\n${line}`);
      assert.match(line, /blaze\.config\.json layer/,
        `and the operator must be told which layer IS in force:\n${line}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a dropped CONFIG block still says built-in defaults, because there it is true", () => {
    const root = board(`${BASE},"schema":{"types":"notanobject"}}`, undefined);
    try {
      const line = schemaDetails(root).find((d) => /^blaze\.config\.json:/.test(d));
      assert.ok(line && /built-in/.test(line), `the top layer really does fall back:\n${line}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-396 review F2: a hand-written marker key invents no finding", () => {
  // `audit-runner.mjs` never calls `loadProject`, so before the marker became a Symbol this
  // reported "the whole block was IGNORED" on a project.json with no schema block at all —
  // and the load path disagreed with audit on the very same board.
  for (const forged of ['"string"', '{"a":1}', '"an array"', "42"]) {
    test(`a forged schemaBlockDropped: ${forged} reports nothing`, () => {
      const root = board(`${BASE}}`, `{"key":"ENG","schemaBlockDropped":${forged}}`);
      try {
        const r = audit(root);
        assert.match(r.stdout, /ok=true/, r.stderr);
        assert.doesNotMatch(r.stdout, /schema-invalid/,
          `audit invented a malformation the board does not have:\n${r.stdout}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});
