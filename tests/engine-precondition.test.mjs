// tests/engine-precondition.test.mjs — BLZ-601.
//
// THE CORRECTED PREMISE. BLZ-601 was filed saying this machine has no conforming Node.
// It has one: `~/.local/node24/bin/node` is v24.19.0 and `node:sqlite` works there. The
// defect is not absence, it is DISCOVERABILITY: `package.json` declares
// `engines: {node: ">=24"}`, nothing enforces it, and a developer who runs the suite under
// the Node 20 that is first on `PATH` gets every `node:sqlite` file failing to LOAD and no
// hint that the engine is why. Measured with `node --test` at this commit, twice, stably:
// v20.20.2 gives 3,945 tests / 3,772 pass / 173 fail against v24.19.0’s 4,464 / 4,462 / 0.
// The ticket body in blaze-pm has been corrected to say this.
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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GUARD_EXIT_CODE, candidateNodePaths, describeEngine, detectEngine, requiredMajor,
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

/** A throwaway home directory. `layout` is a list of relative `bin/node` paths to create,
 *  each a symlink to a real Node so `findConformingNodes` can actually run it. */
function fakeHome(t, layout) {
  const home = mkdtempSync(join(tmpdir(), "blaze-engine-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const rel of layout) {
    mkdirSync(join(home, dirname(rel)), { recursive: true });
    symlinkSync(process.execPath, join(home, rel));
  }
  return home;
}

test("BLZ-601: a home with no ~/.local still finds an nvm Node — one absent directory must not end the search", (t) => {
  // REVIEW FINDING. `candidateNodePaths` guarded only `existsSync(home)` and then read
  // `join(home, ".local")` unconditionally. On a home without one that throws ENOENT,
  // `safeCandidates()` swallowed it, and nvm/fnm/volta/n were never reached — so the guard
  // told a developer who already had a conforming Node under nvm to go and install one.
  // That is the headline feature failing on exactly the machines that need it: a fresh
  // container, or a dev box that uses nvm and has no ~/.local at all. Reproduced before
  // this fix: this same layout printed "No conforming Node was found".
  const home = fakeHome(t, [".nvm/versions/node/v24.19.0/bin/node"]);
  const found = candidateNodePaths(home);
  assert.deepEqual(found, [join(home, ".nvm/versions/node/v24.19.0/bin/node")],
    "an absent ~/.local must cost only ~/.local, not nvm, fnm, volta and n as well");
});

test("BLZ-601: every discovery source is independent — an unreadable one loses only itself", (t) => {
  // The general form of the finding above. Each source is guarded on its own, so a home
  // where any single location is missing or unreadable still yields the others.
  const home = fakeHome(t, [
    ".local/node24/bin/node",
    ".nvm/versions/node/v24.19.0/bin/node",
    ".fnm/node-versions/v24.19.0/installation/bin/node",
    ".volta/tools/image/node/24.19.0/bin/node",
  ]);
  const found = candidateNodePaths(home);
  assert.deepEqual(found.sort(), [
    join(home, ".fnm/node-versions/v24.19.0/installation/bin/node"),
    join(home, ".local/node24/bin/node"),
    join(home, ".nvm/versions/node/v24.19.0/bin/node"),
    join(home, ".volta/tools/image/node/24.19.0/bin/node"),
  ].sort(), "all four home-rooted sources must be searched");
});

test("BLZ-601: ~/.local is searched for node* directories only, not every directory in it", (t) => {
  // ~/.local also holds bin, lib, share and state. Widening the fix into "read everything
  // under ~/.local" would spawn every one of them looking for a version string.
  const home = fakeHome(t, [".local/node24/bin/node", ".local/share/bin/node"]);
  assert.deepEqual(candidateNodePaths(home), [join(home, ".local/node24/bin/node")]);
});

test("BLZ-601: a home that does not exist at all yields no candidates and does not throw", () => {
  assert.deepEqual(candidateNodePaths(join(tmpdir(), "blaze-engine-home-does-not-exist")), []);
});
