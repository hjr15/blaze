// tests/schema-fail-loud-on-load.test.mjs — BLZ-56, the load path.
//
// A SUBPROCESS test, for the same reason tests/audit-malformed-linktypes.test.mjs is
// one: the behaviour that matters is what the real CLI does with a real board, and
// every unit was green while `blaze audit` was dying with a stack trace.
//
// THE TWO PATHS, WHICH ARE THE WHOLE POINT (AC-4):
//   a mutating verb  -> FAILS LOUD, naming the file, the type and the field.
//   `blaze audit`    -> still REPORTS, because reporting this class is its entire job
//                       and killing it deletes the report. BLZ-392 closed that defect
//                       and this ticket must not reopen it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/cli.mjs", import.meta.url));

/** A one-ticket board whose config carries the given `schema` block, and optionally a
 *  per-project `schema` block on ENG. */
function board(schema, projectSchema = null) {
  const root = mkdtempSync(join(tmpdir(), "blz56-"));
  mkdirSync(join(root, "projects", "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ENG", projects: ["ENG"], ...(schema ? { schema } : {}) }, null, 2));
  writeFileSync(join(root, "projects", "ENG", "project.json"),
    JSON.stringify({ key: "ENG", name: "Eng", ...(projectSchema ? { schema: projectSchema } : {}) }));
  writeFileSync(join(root, "projects", "ENG", "defined", "ENG-1-t.md"),
    ["---", "id: ENG-1", "title: t", "type: task", "project: ENG", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  return root;
}

const run = (root, args) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") } });

/** A valid-JSON, wrong-shape override: level is a string, workflow does not exist. */
const MALFORMED = { types: { spike: { level: "0", workflow: "ghost", parentTypes: ["nope"], required: [] } } };
/** A legal widening — this must keep working, or the check is a wall not a gate. */
const GOOD = { types: { spike: { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title"] } } };

describe("BLZ-56: a malformed override fails loud on the load path", () => {
  test("a mutating verb refuses, naming the file, the type and the fields", () => {
    const root = board(MALFORMED);
    try {
      const r = run(root, ["new", "--project", "ENG", "--type", "task", "x", "--estimate", "30"]);
      assert.notEqual(r.status, 0, `expected a refusal\n${r.stdout}\n${r.stderr}`);
      const out = r.stderr + r.stdout;
      assert.match(out, /blaze\.config\.json/, "the operator must be told which file to fix");
      assert.match(out, /spike/, "and which type");
      assert.match(out, /level/, "and which field");
      assert.match(out, /ghost/);
      assert.doesNotMatch(out, /at assertSchemaValid|node:internal/,
        "a stack trace is not an actionable error");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a legal override is untouched — non-breaking must hold", () => {
    const root = board(GOOD);
    try {
      const r = run(root, ["audit"]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /not valid/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a board with NO schema block is untouched", () => {
    const root = board(null);
    try {
      const r = run(root, ["audit"]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stdout + r.stderr, /not valid/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-56: `blaze audit` still REPORTS — the BLZ-392 regression stays closed", () => {
  test("it produces a full report on the same malformed board, and does not die", () => {
    const root = board(MALFORMED);
    try {
      const r = run(root, ["audit"]);
      const out = r.stdout + r.stderr;
      // The precise exit code is audit's own business; what must not happen is a crash
      // with no report. Assert the REPORT exists, not merely that something was printed.
      assert.match(out, /schema-invalid/,
        "the malformed override must be REPORTED as a finding, which is what audit is for");
      assert.doesNotMatch(out, /at assertSchemaValid/,
        "audit must never take the loud path — a throw there loses the whole report");
      assert.doesNotMatch(out, /node:internal\/modules/,
        "and must never die at import");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("`blaze audit --json` is still parseable on a malformed board", () => {
    // The strongest form of "it still reports": a caller can still consume it.
    const root = board(MALFORMED);
    try {
      const r = run(root, ["audit", "--json"]);
      const parsed = JSON.parse(r.stdout);
      assert.ok(parsed, "audit --json must still emit JSON when the override is malformed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Round 2 — what an adversarial review broke
// =============================================================================

/** A complete, legal type record. */
const SPIKE = { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title"] };

describe("BLZ-56: the preflight must judge a board the way audit does", () => {
  test("a top-level Precedes naming a PROJECT-declared type does not brick the board", () => {
    // THE FALSE POSITIVE THAT MATTERED, AND WHY THIS PASSES TODAY. A top-level `Precedes`
    // list legitimately names a type only one project declares; judging it against the top
    // layer alone produced a finding its own report contradicted, which is what BLZ-392's
    // `endpointTypes` union answered. The first cut of this preflight built that union and
    // still exited 1 on this board, because it also threw on every SOFT finding.
    //
    // What makes this board run now is the hard/soft split, NOT the union: the endpoint-kind
    // finding is soft, so `assertSchemaValid` never sees it and the preflight builds no union
    // at all (scripts/cli.mjs says why). The classification that carries this test is pinned
    // directly by "the endpoint-kind finding is SOFT, and cli.mjs's preflight depends on it"
    // in tests/model/schema-validate-on-load.test.mjs. This test stays because the behaviour
    // it asserts — a board `blaze audit` calls clean is not bricked for every other verb —
    // is worth guarding whatever mechanism delivers it.
    const root = board(
      { linkTypes: { Precedes: {
        source_kinds: ["task", "spike"], target_kinds: ["task", "spike"],
        inverse_name: "Follows", min_card: 0, max_card: null } } },
      { types: { spike: SPIKE } },
    );
    try {
      const audit = run(root, ["audit"]);
      const verb = run(root, ["rollup"]);
      assert.equal(audit.status, 0, `audit: ${audit.stdout}${audit.stderr}`);
      assert.equal(verb.status, 0,
        `a verb must not refuse a board audit calls clean\n${verb.stdout}${verb.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a NON-EXEMPT verb runs clean on an ordinary good board", () => {
    // Every "non-breaking" test in the first cut ran `blaze audit`, which is EXEMPT — so
    // nothing exercised the preflight on a board that should pass it.
    const root = board(GOOD);
    try {
      const r = run(root, ["rollup"]);
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a malformed PER-PROJECT override fails loud too", () => {
    // The mirror of the false positive: the first cut validated only the top layer, so a
    // project.json carrying the partial record the docs call "the trap worth knowing"
    // passed every verb while audit reported it.
    const root = board(null, { types: { task: { workflow: "delivery" } } });
    try {
      const r = run(root, ["rollup"]);
      assert.notEqual(r.status, 0, `expected a refusal\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr + r.stdout, /task/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("`blaze commit` is exempt — it flushes git and reads no schema", () => {
    // commit-runner.mjs imports nothing from the model: it is a git flush of the pending
    // ledger. Refusing it strands ticket files that verbs have ALREADY relocated but not
    // committed, which is the hazard cli.mjs's own read-only gate cites.
    const root = board(MALFORMED);
    try {
      const r = run(root, ["commit"]);
      assert.doesNotMatch(r.stderr, /is not valid/,
        "refusing commit would strand relocated-but-uncommitted ticket files");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("BLZ-56: the loud error survives the pipe it is written to", () => {
  test("a very large error is not truncated at 64 KiB", () => {
    // `console.error` before `process.exit(1)` cuts at exactly 65,536 bytes on a pipe —
    // the repo's own documented class. The design's stated value is "every problem at
    // once", and truncation is precisely what destroys it.
    const types = {};
    for (let i = 0; i < 500; i += 1) types[`bad${i}`] = { level: "0", workflow: "ghost", parentTypes: [], required: [] };
    const root = board({ types });
    try {
      // THROUGH A REAL SHELL PIPE. `spawnSync` does not reproduce this — measured, the
      // first version of this test passed with `console.error` too, which made it no
      // control at all. Piped through `cat`, console.error cuts at exactly 65,536 bytes
      // and a synchronous fd write delivers all 90,992.
      const r = spawnSync("sh", ["-c", `exec node ${JSON.stringify(CLI)} rollup 2>&1 >/dev/null | cat`],
        { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") } });
      assert.ok(r.stdout.length > 65536, `expected >64KiB, got ${r.stdout.length}`);
      assert.notEqual(r.stdout.length, 65536, "exactly 64KiB is the truncation signature");
      assert.match(r.stdout, /Fix blaze\.config\.json/,
        "the tail must survive — truncation loses the instruction, which is the point");
      assert.match(r.stdout, /bad499/, "and the last problem, not just the first");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Round 3 — the preflight was a WALL on two boards audit calls clean, and a
// NO-OP on two boards it should have refused.
// =============================================================================

/** A board with full control over the config, the project.json, and the name of the
 *  directory the projects live in — because two of the four defects below are only
 *  reachable when that name is not the literal "projects". */
function board3({ config = {}, projectJson = { key: "ENG", name: "Eng" }, dirName = "projects" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blz56r3-"));
  mkdirSync(join(root, dirName, "ENG", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify(config, null, 2));
  writeFileSync(join(root, dirName, "ENG", "project.json"), JSON.stringify(projectJson, null, 2));
  writeFileSync(join(root, dirName, "ENG", "defined", "ENG-1-t.md"),
    ["---", "id: ENG-1", "title: t", "type: task", "project: ENG", "priority: medium",
     "estimate: 30", "created: 2026-01-01", "updated: 2026-01-01", "---", "", "body", ""].join("\n"));
  return { root, projectsDir: join(root, dirName) };
}

const run3 = ({ root, projectsDir }, args) => spawnSync(process.execPath, [CLI, ...args],
  { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: projectsDir } });

/** The partial type record docs/schema-customization.md calls "the trap worth knowing":
 *  `mergeTypes` is a per-entry replace, so this silently drops level/parentTypes/required. */
const PARTIAL_TYPE = { key: "ENG", name: "Eng", schema: { types: { task: { workflow: "delivery" } } } };

describe("BLZ-56: a legal-but-advisory board is not refused — audit and the preflight agree", () => {
  test("a per-project schema.linkTypes block does not brick every verb", () => {
    // The block "resolves correctly but reaches nothing" (docs/schema-customization.md,
    // "What reads the resolved schema"). `blaze audit` says ok=true. Refusing every
    // non-exempt verb over a note about where to move a block is a wall, not a gate.
    const b = board3({
      config: { key: "ENG", projects: ["ENG"] },
      projectJson: { key: "ENG", name: "Eng", schema: { linkTypes: { Precedes: {
        source_kinds: ["task"], target_kinds: ["task"],
        inverse_name: "Follows", min_card: 0, max_card: null } } } },
    });
    try {
      const audit = run3(b, ["audit"]);
      assert.match(audit.stdout, /ok=true/, `${audit.stdout}${audit.stderr}`);
      const verb = run3(b, ["rollup"]);
      assert.equal(verb.status, 0,
        `a verb must not refuse a board audit calls clean\n${verb.stdout}${verb.stderr}`);
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("a deliberately narrowed `requirement` workflow does not brick every verb", () => {
    // BLZ-361/R48. `validateSchema`'s own comment calls this "legal when deliberate" and
    // its message ends "Add them, or drop the gate deliberately". Advice, not a refusal.
    const b = board3({
      config: { key: "ENG", projects: ["ENG"], schema: { workflows: { requirement: {
        statuses: ["proposed", "implemented", "rejected", "obsolete"],
        terminal: ["implemented", "rejected", "obsolete"],
        transitions: [["proposed", "implemented"]],
        reopenTo: "proposed",
        resolutionOnTerminal: { implemented: "done", rejected: "wont-do", obsolete: "wont-do" } } } } },
    });
    try {
      const audit = run3(b, ["audit"]);
      assert.match(audit.stdout, /ok=true/, `${audit.stdout}${audit.stderr}`);
      const verb = run3(b, ["rollup"]);
      assert.equal(verb.status, 0,
        `a verb must not refuse a board audit calls clean\n${verb.stdout}${verb.stderr}`);
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });
});

describe("BLZ-56: the preflight must actually FIND the projects it claims to validate", () => {
  test("a projects dir not named `projects` is still discovered", () => {
    // `resolveRoots()` derives dataRoot as the PARENT of projectsDir, and `loadProject`
    // defaults projectsDir to join(root, "projects"). With BLAZE_PROJECTS_DIR pointing at
    // a directory named anything else, every loadProject threw, was swallowed, and every
    // project resolved to null — so the project layer was never validated at all.
    // scripts/audit-runner.mjs uses `roots.projectsDir` verbatim; this follows it.
    const b = board3({ config: { key: "ENG", projects: ["ENG"] }, projectJson: PARTIAL_TYPE, dirName: "tickets" });
    try {
      const r = run3(b, ["rollup"]);
      assert.notEqual(r.status, 0, `expected a refusal\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr + r.stdout, /task/, "and it must name the type");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("a config with no `projects` array falls back to the directories on disk", () => {
    // `listProjects(config)` returns [] when the key is absent, so the preflight validated
    // NOTHING and passed. scripts/audit-runner.mjs has the fallback for exactly this, with
    // the reason in its own comment: "A gate that passes because it measured nothing is
    // worse than no gate."
    const b = board3({ config: { key: "ENG" }, projectJson: PARTIAL_TYPE });
    try {
      const r = run3(b, ["rollup"]);
      assert.notEqual(r.status, 0, `expected a refusal\n${r.stdout}${r.stderr}`);
      assert.match(r.stderr + r.stdout, /task/, "and it must name the type");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("and neither fallback breaks the silence the preflight owes a non-board", () => {
    // The preflight is not in the business of "there is no board here". An empty dir with
    // no config and no projects must behave exactly as it did before this check existed.
    const root = mkdtempSync(join(tmpdir(), "blz56r3-empty-"));
    mkdirSync(join(root, "projects"), { recursive: true });
    try {
      const r = spawnSync(process.execPath, [CLI, "rollup"],
        { cwd: root, encoding: "utf8", env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") } });
      assert.doesNotMatch(r.stderr, /is not valid/, `${r.stdout}${r.stderr}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Three guards the code had and no test reached. Each mutation below left the FULL
// 2,407-test suite green, and each changes real behaviour — the vacuous-test shape this
// branch has now been refuted for at every round.
// =============================================================================

describe("BLZ-56: the preflight's own escape hatches are pinned", () => {
  test("ONLY a SchemaOverrideError stops the verb — the preflight stays silent on the rest", () => {
    // `if (e && e.name === "SchemaOverrideError")` → `if (e)` survived everything. That
    // mutation turns EVERY "not its business" case — an unparseable config, no board, a
    // packaged install with no data dir — into a hard refusal FROM THE PREFLIGHT, which is
    // precisely the regression the comment beside it and docs/schema-customization.md
    // promise cannot happen.
    //
    // Both trees exit 1 here, so the exit code cannot tell them apart — the DISCRIMINATOR
    // is who reported it. Shipped, the preflight swallows the parse error and the verb
    // runs, so the message carries the runner's own `blaze rollup failed:` prefix. Under
    // the mutation the preflight writes and `process.exit(1)`s, and the runner never runs.
    const b = board3({ config: { key: "ENG", projects: ["ENG"] } });
    try {
      writeFileSync(join(b.root, "blaze.config.json"), "{ this is not json");
      const verb = run3(b, ["rollup"]);
      const out = `${verb.stdout}${verb.stderr}`;
      assert.match(out, /rollup failed/,
        "the verb must have RUN and reported this itself — the preflight is not to stop it");
      assert.doesNotMatch(out, /the schema override in/,
        "an unparseable config is not a bad schema override");
      assert.doesNotMatch(out, /would be internally inconsistent/);
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("one unloadable project does not silently disarm the whole preflight", () => {
    // Dropping the per-project try/catch survived too, and it is NOT equivalent: with a
    // key naming a directory that does not exist, `loadProject` throws, the throw escapes
    // the per-ticket loop, and the outer catch swallows it — so a board with a genuinely
    // malformed TOP-level schema goes from a full refusal to exit 0. The gate disarms
    // itself on an unrelated misconfiguration.
    const b = board3({
      config: { key: "ENG", projects: ["ENG", "GONE"], schema: MALFORMED },
    });
    try {
      const verb = run3(b, ["rollup"]);
      assert.equal(verb.status, 1,
        "a missing project key must not stop the top-level schema from being judged");
      assert.match(`${verb.stdout}${verb.stderr}`, /the schema override in blaze.config.json is not valid/);
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });

  test("the refusal names the project file the operator actually has", () => {
    // The label was hardcoded `projects/${k}/project.json` while the LOOKUP already
    // followed projectsDir, so a board under BLAZE_PROJECTS_DIR=<root>/boards was told to
    // "Fix projects/ENG/project.json" — a path that does not exist. The whole value of
    // this error is naming the file to fix.
    const b = board3({
      config: { key: "ENG", projects: ["ENG"] },
      projectJson: { key: "ENG", name: "Eng", schema: MALFORMED },
      dirName: "boards",
    });
    try {
      const verb = run3(b, ["rollup"]);
      assert.equal(verb.status, 1);
      const out = `${verb.stdout}${verb.stderr}`;
      assert.match(out, /boards\/ENG\/project\.json/,
        "the refusal must name the real path");
      assert.doesNotMatch(out, /projects\/ENG\/project\.json/,
        "and must not name a path the operator does not have");
    } finally { rmSync(b.root, { recursive: true, force: true }); }
  });
});
