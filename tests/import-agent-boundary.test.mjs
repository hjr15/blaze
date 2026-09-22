// tests/import-agent-boundary.test.mjs — BLZ-636, design §4.3.
//
// THIS IS THE TEST THAT MAKES "NO MODEL RUNS ON THE DETERMINISTIC IMPORT
// PATH" A PROPERTY RATHER THAN A CLAIM IN A COMMENT.
//
// The property is narrower and truer than "no spawn": NO AGENT COMMAND IS
// EXECUTED. "No spawn" is simply false for a correct importer — staging
// shells out to `git`, `model/transitions.mjs:62` spawns one too, and six of
// the twenty-six modules the importer reaches import `node:child_process`
// because they have to. What must never happen is that the CONFIGURED AGENT
// COMMAND runs on the import path. A `cfg` carrying `agentCommand` is
// harmless if nothing runs it.
//
// HOW IT IS PINNED, and why the two obvious alternatives are wrong:
//
//   * NOT three static-graph assertions. Two of the first draft's three are
//     UNSATISFIABLE in this repo: "no module in the graph imports
//     child_process" is false for every entry point, and "no module reads
//     agentCommand" is false the moment the importer calls `loadConfig()` —
//     which it must, to resolve the type registry. Exactly one static
//     assertion survives, at the bottom of this file, and it has a real
//     positive control: absent HERE, present THERE.
//
//   * NOT an in-process patch of `child_process`. `cli.mjs:9` is
//     `spawnSync(process.execPath, [join(here, file), ...args], …)`, so the
//     runner is a SEPARATE PROCESS and a monkey-patch in this process reaches
//     nothing inside it. It would also miss `execSync`, `execFile` and
//     `fork`.
//
// So: PATH-SHADOWED SENTINEL STUBS, the `stubGh` pattern at
// tests/reconcile-delivery-truth.test.mjs:65-73 combined with the
// `agentCommand`-pointing-at-a-script pattern at
// tests/supervisor-identity.test.mjs:41-45. `cli.mjs` spawns with the
// inherited environment, so a PATH and a BLAZE_AGENT_COMMAND set here
// propagate all the way into the runner — which is exactly what the
// in-process patch could not do.
//
// TWO ARMS, TWO SENTINELS, and that is not belt-and-braces. `config.mjs:279`
// is `if (env.BLAZE_AGENT_COMMAND) cfg.agentCommand = env.BLAZE_AGENT_COMMAND`
// — an OVERRIDE, not a merge — and the spawn site splits `cfg.agentCommand`
// and spawns `cmd` directly. So with the env var set to a stub path, `cmd` is
// ABSOLUTE and PATH is never consulted. An earlier draft used ONE sentinel
// for both: across all of its assertions the PATH stub was never executed
// once, so a misconfigured shadow — wrong directory, not chmod +x, PATH not
// actually inherited — left assertion 1 passing and nothing noticing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { writeCsv } from "../scripts/model/csv.mjs";
import { MAPPING_DIR, headerDigest } from "../scripts/model/import-mapping.mjs";
import { RECEIPT_DIR } from "../scripts/model/import-apply.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

const ENV_HIT = "ENV_HIT";
const PATH_HIT = "PATH_HIT";

/** A CANDIDATE a benign stub answers with — valid enough that the whole
 *  propose path runs to completion, so assertion 4 measures the stubs and not
 *  a refusal somewhere downstream. */
const BENIGN_CANDIDATE = {
  mappingVersion: 1,
  schemaVersion: 1,
  name: "vendor",
  sourceIdColumn: "Key",
  columns: {
    title: { from: "Name" },
    description: { from: "Name" },
    type: { constant: "task" },
    status: { constant: "defined" },
    project: { constant: "BLZ" },
    estimate: { constant: "30" },
  },
  values: {},
  unmapped: [],
};

/**
 * A board, two stub scripts and two sentinel PATHS (the files themselves must
 * not exist yet — their existence afterwards is the whole measurement).
 *
 * `bin/claude` shadows the built-in default `"claude -p"` (config.mjs:29) on
 * PATH; `bin/env-agent.sh` is what BLAZE_AGENT_COMMAND points at. Each writes
 * its OWN sentinel, so the two arms can be told apart.
 */
function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-agent-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  spawnSync("git", ["-C", root, "config", "user.name", "t"]);
  // No `agentCommand` here on purpose: unset, `cfg.agentCommand` falls back
  // to the built-in "claude -p" and the BARE name is resolved through PATH,
  // which is the arm assertion 3 exercises.
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "BLZ", projects: ["BLZ"] }));

  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const sentinels = { [ENV_HIT]: join(root, `${ENV_HIT}.sentinel`), [PATH_HIT]: join(root, `${PATH_HIT}.sentinel`) };
  const scripts = { [ENV_HIT]: join(bin, "env-agent.sh"), [PATH_HIT]: join(bin, "claude") };

  const arm = (which) => {
    // A sentinel stub: it records that it ran, says which arm it was on, and
    // FAILS. Asserting sentinel ABSENCE rather than merely a zero exit is
    // what distinguishes "nothing spawned it" from "it spawned and we ignored
    // the result".
    writeFileSync(scripts[which],
      `#!/usr/bin/env bash\nprintf '%s' "${which}" > "${sentinels[which]}"\n`
      + `echo "${which}: the stub ran — an agent command was executed" >&2\nexit 3\n`);
    execFileSync("chmod", ["+x", scripts[which]]);
  };
  const benign = (which) => {
    // The SAME two scripts, repointed at something harmless that succeeds.
    // This is the rollback control: it proves the two positive controls
    // failed because of the STUBS and not because of the harness, the
    // fixture, or an unrelated error.
    writeFileSync(scripts[which],
      `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(BENIGN_CANDIDATE)}\nJSON\n`);
    execFileSync("chmod", ["+x", scripts[which]]);
  };
  arm(ENV_HIT);
  arm(PATH_HIT);

  return { root, bin, sentinels, scripts, arm, benign };
}

/** The environment BOTH arms are reachable from. `envArm: false` UNSETS
 *  BLAZE_AGENT_COMMAND, which is the only way the PATH arm is ever taken. */
function envFor({ root, bin, scripts }, { envArm = true } = {}) {
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    BLAZE_PROJECTS_DIR: join(root, "projects"),
  };
  delete env.BLAZE_SESSION;
  if (envArm) env.BLAZE_AGENT_COMMAND = scripts[ENV_HIT];
  else delete env.BLAZE_AGENT_COMMAND;
  return env;
}

const runCli = (h, args, opts = {}) =>
  spawnSync(process.execPath, [cli, "import", ...args],
    { cwd: h.root, env: envFor(h, opts), encoding: "utf8", input: opts.input ?? "" });

/** A canonical 31-column CSV — the DETERMINISTIC path, which reads no mapping
 *  and must never reach `propose-mapping` at all. */
function canonicalCsv(root) {
  const base = Object.fromEntries(COLUMN_NAMES.map((n) => [n, ""]));
  const row = {
    ...base, schema_version: "1", id: "BLZ-1", project: "BLZ", type: "task",
    status: "defined", title: "t", description: "body", estimate: "30",
  };
  const p = join(root, "canonical.csv");
  writeFileSync(p, writeCsv([COLUMN_NAMES.slice(), COLUMN_NAMES.map((n) => row[n])]));
  return p;
}

/** A FOREIGN CSV — the only kind `propose-mapping` is for. */
function foreignCsv(root) {
  const p = join(root, "vendor.csv");
  writeFileSync(p, "Key,Name\nACME-1,first\nACME-2,second\n");
  return p;
}

/** A foreign CSV with a valid, already-CONFIRMED mapping — the `--mapping`
 *  and `repair` verbs, which §4.3's table also marks Model: never, and which
 *  BLZ-636's original draft did not exercise: only `blaze import`'s plain
 *  deterministic path was ever run, leaving these two entry points untested. */
function mappedCsv(root) {
  const header = ["Key", "Name"];
  const csvPath = join(root, "vendor-mapped.csv");
  writeFileSync(csvPath, `${header.join(",")}\nACME-1,first\n`);
  mkdirSync(join(root, MAPPING_DIR), { recursive: true });
  const mappingPath = join(root, MAPPING_DIR, "acme.json");
  writeFileSync(mappingPath, `${JSON.stringify({
    mappingVersion: 1, schemaVersion: 1, name: "acme",
    source: { columns: header, sha256: headerDigest(header) },
    sourceIdColumn: "Key",
    columns: {
      title: { from: "Name" }, description: { from: "Name" },
      project: { constant: "BLZ" }, type: { constant: "task" }, status: { constant: "defined" },
      estimate: { constant: "30" },
    },
    values: {}, unmapped: [],
  }, null, 2)}\n`);
  return { csvPath, mappingPath };
}

const hit = (h, which) => existsSync(h.sentinels[which]);

// =============================================================================
// 1 — NO AGENT COMMAND RUNS ON THE IMPORT PATH
// =============================================================================

test("BLZ-636/1: `blaze import --apply` succeeds and leaves BOTH sentinels untouched", (t) => {
  const h = harness(t);
  const r = runCli(h, ["--apply", canonicalCsv(h.root)]);

  assert.equal(r.status, 0, `the import itself must succeed, or absence proves nothing:\n${r.stderr}`);
  assert.equal(existsSync(join(h.root, "projects", "BLZ", "defined", "BLZ-1-t.md")), true,
    "the run genuinely imported — a run that refused early would leave the sentinels absent too");

  assert.equal(hit(h, ENV_HIT), false,
    "BLAZE_AGENT_COMMAND was set to a sentinel stub for this entire run and the stub DID NOT RUN. "
    + "That is the property: the configured agent command is not executed on the import path");
  assert.equal(hit(h, PATH_HIT), false,
    "and a `claude` shadowing the built-in default on PATH did not run either");
});

test("BLZ-636/1b: `blaze import --mapping` and `blaze import repair` ALSO leave both sentinels untouched", (t) => {
  // §4.3's table says Model: never for THREE verbs, not one — the plain
  // deterministic import, the mapped import, and repair. BLZ-636's original
  // draft only ever exercised the first; a model spawned from either of the
  // other two would have passed test 1 above vacuously.
  const h = harness(t);
  const { csvPath, mappingPath } = mappedCsv(h.root);

  const mapped = runCli(h, ["--apply", "--mapping", mappingPath, csvPath, "--allocate-ids"]);
  assert.equal(mapped.status, 0, `the mapped import must succeed, or absence proves nothing:\n${mapped.stderr}`);
  assert.equal(hit(h, ENV_HIT), false, "a mapped import never spawns the agent command");
  assert.equal(hit(h, PATH_HIT), false, "on either arm");

  const receiptName = readdirSync(join(h.root, RECEIPT_DIR))[0];
  const repaired = runCli(h, ["repair", join(h.root, RECEIPT_DIR, receiptName)]);
  assert.notEqual(repaired.status, null, `repair must run to completion:\n${repaired.stderr}`);
  assert.equal(hit(h, ENV_HIT), false, "repair never spawns the agent command either");
  assert.equal(hit(h, PATH_HIT), false, "on either arm");
});

// =============================================================================
// 2 — POSITIVE CONTROL, ENV ARM
// =============================================================================

test("BLZ-636/2: `propose-mapping` under the IDENTICAL environment fails, and ENV_HIT exists", (t) => {
  const h = harness(t);
  const r = runCli(h, ["propose-mapping", foreignCsv(h.root)]);

  assert.notEqual(r.status, 0, "the sentinel stub exits non-zero and the verb reports it");
  assert.equal(hit(h, ENV_HIT), true,
    "the env arm is genuinely EXERCISED — a stub that is never invoked proves nothing, which is "
    + "what made the one-sentinel draft vacuously green for the whole default-config class");
  assert.match(`${r.stdout}${r.stderr}`, new RegExp(ENV_HIT),
    "§4.3 assertion 2: the failure message carries the sentinel's own string, so the failure is "
    + "attributable to the stub rather than to anything else");
  assert.equal(existsSync(join(h.root, MAPPING_DIR)), false, "and no mapping file was written");
});

// =============================================================================
// 3 — POSITIVE CONTROL, PATH ARM
// =============================================================================

test("BLZ-636/3: with BLAZE_AGENT_COMMAND UNSET, `propose-mapping` fails and PATH_HIT exists", (t) => {
  const h = harness(t);
  const r = runCli(h, ["propose-mapping", foreignCsv(h.root)], { envArm: false });

  assert.notEqual(r.status, 0);
  assert.equal(hit(h, PATH_HIT), true,
    "unset, `cfg.agentCommand` is the built-in \"claude -p\" and the BARE name IS resolved "
    + "through PATH. Without this assertion the shadow is never executed and its correctness is "
    + "never observed — a resolution-order bug in the PATH fallback would go undetected");
  assert.equal(hit(h, ENV_HIT), false,
    "and the env arm's stub did not run: the two arms are distinguishable, which is the entire "
    + "reason there are two sentinels");
});

// =============================================================================
// 4 — ROLLBACK CONTROL
// =============================================================================

test("BLZ-636/4: with BOTH stubs repointed at benign commands, `propose-mapping` SUCCEEDS", (t) => {
  // One harness per arm rather than one harness reset between them: a
  // rollback control that restores one of the two stubs attributes only one
  // of the two positive controls, and a mid-test cleanup is a cleanup a
  // failing assertion skips.
  for (const envArm of [true, false]) {
    const h = harness(t);
    h.benign(ENV_HIT);
    h.benign(PATH_HIT);

    const r = runCli(h, ["propose-mapping", foreignCsv(h.root)], { envArm, input: "y\n" });
    const arm = envArm ? "env arm" : "PATH arm";
    assert.equal(r.status, 0, `${arm}:\n${r.stdout}\n${r.stderr}`);
    assert.equal(existsSync(join(h.root, MAPPING_DIR, "vendor.json")), true,
      `${arm}: the proposal ran end to end and the operator's \`y\` wrote exactly one file`);
    assert.equal(hit(h, ENV_HIT), false, "a benign stub writes no sentinel");
    assert.equal(hit(h, PATH_HIT), false);
  }
});

// =============================================================================
// The ONE static assertion that survives, and its positive control
// =============================================================================

/** The transitive graph of RELATIVE imports from an entry point, the way Node
 *  resolves them. Bare specifiers (`node:*`, packages) are not this tree. */
function graphOf(entry) {
  const seen = new Set();
  const queue = [resolve(entry)];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import[\s\S]*?|export[\s\S]*?)\bfrom\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      queue.push(resolve(dirname(file), spec));
    }
  }
  return seen;
}

test("BLZ-636/static: the proposer is ABSENT from the import runner's graph and PRESENT in the propose runner's", () => {
  const proposer = resolve(REPO, "scripts", "model", "import-mapping-propose.mjs");

  const importGraph = graphOf(join(REPO, "scripts", "import-runner.mjs"));
  const proposeGraph = graphOf(join(REPO, "scripts", "import-mapping-runner.mjs"));

  // ABSENT HERE. `import-runner.mjs` reaches `propose-mapping` by SPAWNING
  // its runner (design §6), not by importing it, so the one module that can
  // execute `agentCommand` is not linked into the verb that writes tickets.
  assert.equal(importGraph.has(proposer), false,
    "`scripts/import-runner.mjs` can reach the proposer module. The dynamic assertions above are "
    + "what actually carry the property, but a link here is the shape that makes an accidental "
    + "call possible at all — and it is the one static condition this repo's module structure "
    + "does NOT already violate for every entry point");

  // PRESENT THERE — the positive control. Absent-here alone is satisfied by a
  // walker that resolves nothing at all, which is precisely how a negative
  // result gets trusted for the wrong reason.
  assert.equal(proposeGraph.has(proposer), true,
    "the walker must actually resolve modules: if the proposer is not in its OWN runner's graph, "
    + "the absence asserted above measures nothing");

  // ...and the control is not vacuous about the import runner either: its
  // graph is genuinely populated with the modules the importer needs.
  for (const name of ["import-plan.mjs", "import-apply.mjs", "import-mapping.mjs"]) {
    assert.equal(importGraph.has(resolve(REPO, "scripts", "model", name)), true,
      `the import runner's graph should contain ${name}`);
  }
});
