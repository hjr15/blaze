// tests/engine-precondition.test.mjs — BLZ-601.
//
// THE CORRECTED PREMISE. BLZ-601 was filed saying this machine has no conforming Node.
// It has one: `~/.local/node24/bin/node` is v24.19.0 and `node:sqlite` works there. The suite measured under it is 4,408 tests / 4,406 pass / 0 fail. The defect is
// not absence, it is DISCOVERABILITY: `package.json` declares `engines: {node: ">=24"}`,
// nothing enforces it, and a developer who runs the suite under the Node 20 that is first
// on `PATH` gets every `node:sqlite` file failing to LOAD and no hint that the engine is
// why. Measured on this branch 2026-09-07: v20.20.2 gives 3,916 tests / 3,743 pass / 173
// fail against v24.19.0's 4,408 / 4,406 / 0. The ticket body in blaze-pm has been
// corrected to say this.
//
// So the fix is a precondition that fails FAST and says three things: what is required,
// what is running, and how to get the required one — including, when the guard can find
// one, the exact `export PATH=` line for a conforming Node already on the machine.
//
// Two places, because they catch different people:
//   * `pretest` / `pretest:coverage` — `npm test` refuses to start at all.
//   * this test file — someone running `node --test` directly bypasses npm, and gets one
//     failure that explains the other 171.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUARD_EXIT_CODE, describeEngine, detectEngine, requiredMajor,
} from "../scripts/ci/require-engine.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(REPO, "scripts", "ci", "require-engine.mjs");

test("BLZ-601: the required major comes from package.json, so it cannot drift from the declaration", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=24");
  assert.equal(requiredMajor(), 24);
});

test("BLZ-601: a Node below the floor is refused, and the refusal names required, detected, and a remedy", () => {
  const d = describeEngine({ version: "v20.20.2", major: 20, sqlite: false, required: 24, conforming: [] });
  assert.equal(d.ok, false);
  assert.match(d.message, /Node 24/, "must name what is required");
  // Anchored to the `detected:` line, not to the string appearing anywhere. An earlier
  // version matched /v20\.20\.2/ loose and passed against a mutant that dropped the detected
  // version entirely — the message quotes a measured v20.20.2 run elsewhere in its body.
  assert.match(d.message, /detected: {2}v20\.20\.2$/m, "must name what is actually running");
  assert.match(d.message, /node:sqlite/,
    "must connect the engine to the symptom the developer is about to see");
  assert.match(d.message, /nvm install 24|fnm install 24/, "must say how to get one");
});

test("BLZ-601: a conforming Node already on the machine is named with the exact PATH line", () => {
  // The whole defect is discoverability. Telling someone to install Node 24 when they
  // already have it, unfound, is the same failure one level up.
  const d = describeEngine({
    version: "v20.20.2", major: 20, sqlite: false, required: 24,
    conforming: [{ path: "/opt/nodes/node24/bin/node", version: "24.19.0" }],
  });
  assert.equal(d.ok, false);
  assert.match(d.message, /export PATH=\/opt\/nodes\/node24\/bin:\$PATH/,
    "a conforming Node that was found must come with the line that selects it");
  assert.match(d.message, /24\.19\.0/);
});

test("BLZ-601: a conforming Node passes, and the guard says nothing", () => {
  const d = describeEngine({ version: "v24.19.0", major: 24, sqlite: true, required: 24, conforming: [] });
  assert.equal(d.ok, true);
  assert.equal(d.message, "");
});

test("BLZ-601: the floor is a major-version floor, not an equality — 25 must pass", () => {
  assert.equal(describeEngine({ version: "v25.0.0", major: 25, sqlite: true, required: 24, conforming: [] }).ok, true);
});

test("BLZ-601: a Node at the floor whose node:sqlite is missing is still refused", () => {
  // The floor exists BECAUSE of node:sqlite. A build without it satisfies the number and
  // still fails 34 files, which is the confusing outcome this guard exists to prevent.
  const d = describeEngine({ version: "v24.0.0", major: 24, sqlite: false, required: 24, conforming: [] });
  assert.equal(d.ok, false);
  assert.match(d.message, /node:sqlite/);
});

test("BLZ-601: THIS runtime satisfies the engine — a red suite here is a real failure, not the wrong Node", () => {
  const engine = detectEngine();
  const d = describeEngine({ ...engine, required: requiredMajor(), conforming: [] });
  assert.equal(d.ok, true, d.message);
});

test("BLZ-601: the guard CLI exits 0 on a conforming runtime and prints nothing to stderr", () => {
  const r = spawnSync(process.execPath, [GUARD], { encoding: "utf8", cwd: REPO });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stderr.trim(), "");
});

test("BLZ-601: the guard CLI refuses loudly on a non-conforming runtime", () => {
  // BLAZE_ENGINE_GUARD_FAKE_VERSION is a test seam, and the only one: it substitutes the
  // detected version so the refusal path can be exercised anywhere, including on CI where
  // every Node available is conforming. Without it this test could only run on a machine
  // that happened to have an old Node, which is exactly the kind of check that quietly
  // stops running.
  const r = spawnSync(process.execPath, [GUARD], {
    encoding: "utf8", cwd: REPO,
    env: { ...process.env, BLAZE_ENGINE_GUARD_FAKE_VERSION: "v20.20.2" },
  });
  assert.equal(r.status, GUARD_EXIT_CODE, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stderr, /detected: {2}v20\.20\.2$/m);
  assert.match(r.stderr, /^blaze requires Node 24 or newer/m);
});

test("BLZ-601: npm test cannot start under the wrong engine — the pre-scripts run the guard", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  for (const name of ["pretest", "pretest:coverage"]) {
    assert.match(pkg.scripts[name] ?? "", /scripts\/ci\/require-engine\.mjs/,
      `npm run ${name.slice(3)} must refuse before running a suite whose failures would be `
      + "the engine rather than the code");
  }
});
