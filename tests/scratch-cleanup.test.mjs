// tests/scratch-cleanup.test.mjs — BLZ-503.
//
// THE CORPUS REMOVES THE SCRATCH DIRECTORIES IT MINTS.
//
// BLZ-491 fixed one suite and measured that the rest of the corpus did not. This is that
// measurement, taken against c355b9c with `TMPDIR` pointed at an empty directory and the
// whole suite run once:
//
//     299 leftover directories, from 56 mkdtempSync call sites in 34 test files.
//
// Nothing about that is dangerous on its own. What it costs is the ability to read `/tmp`:
// BLZ-485's mutation runner asserts ZERO leftover `/tmp/blz-mutate-*` as the evidence its
// teardown works, and a corpus that litters 299 directories a run trains everyone reading
// that assertion to treat litter as background noise. The same run after the fix leaves
// zero — `node-compile-cache`, which Node's own compile cache creates, is the only entry in
// the box and no scratch prefix claims it.
//
// The fix is `tests/helpers/scratch.mjs`: a file-level registry plus one `after()` hook, the
// shape BLZ-491 established, applied to all 34 files. It is NOT a `/tmp` sweeper. Nothing
// here or there removes a directory this corpus did not itself mint and record — BLZ-394 is
// about exactly that blast radius, and `force: true` on a path the registry handed us is the
// whole of the destructive surface.
//
// WHAT THIS TEST IS. The only way to observe an `after()` hook from outside is to run the
// suite under a redirected `TMPDIR` and look at what is left, which is what BLZ-491 did for
// its one suite. Three of the worst offenders are run here, in one child, and the box is
// asserted empty. BLZ-517 extracts this into a shared helper and names the full covered set;
// this file is the proof for the three that dominated the measurement.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = join(import.meta.dirname, "..");

/** The three suites that produced 74 of the 299 directories, named rather than implied. */
const COVERED = [
  "tests/model/read-seam-projection.test.mjs", //  29 × "seam-" and four siblings
  "tests/migrate/oracle-field-coverage.test.mjs", // 23 × "ofc-"
  "tests/model/read-seam.test.mjs", //             22 × "blaze-readseam-" and two siblings
];

describe("BLZ-503: the worst scratch offenders leave an empty TMPDIR behind", () => {
  let box = null;
  let run = null;

  before(() => {
    box = mkdtempSync(join(tmpdir(), "blz503-box-"));
    // `node --test` marks its children with NODE_TEST_CONTEXT and swaps their reporter for a
    // serialised stream, which arrives here as empty stdout — so the "did it actually run"
    // check below could see nothing. BLZ-491 hit this; the env is stripped rather than the
    // check weakened.
    const env = { ...process.env, TMPDIR: box };
    for (const k of Object.keys(env)) if (k.startsWith("NODE_TEST")) delete env[k];
    run = { env, box };
    run.result = spawnSync(process.execPath, ["--test", ...COVERED],
      { cwd: REPO, env, encoding: "utf8" });
  });

  after(() => { if (box) rmSync(box, { recursive: true, force: true }); });

  test("TMPDIR is honoured, or this test can see nothing at all", () => {
    // Non-vacuity first: a TMPDIR the runtime ignored would make an empty box read as a
    // clean corpus, and every assertion below would pass over a suite that never ran here.
    const probe = spawnSync(process.execPath,
      ["-e", "console.log(require('node:os').tmpdir())"], { env: run.env, encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    assert.equal(probe.stdout.trim(), run.box,
      `TMPDIR was not honoured — the child resolved ${probe.stdout.trim()}, not ${run.box}`);
  });

  test("the covered suites pass and actually ran their tests", () => {
    assert.equal(run.result.status, 0,
      `the covered suites must pass before their litter can be judged:\n${run.result.stdout}\n${run.result.stderr}`);
    // An empty run leaves an empty box too. The floor is well under the ~60 these three
    // carry, so it pins non-vacuity without pinning a count that ordinary work moves.
    // Matched against both summary spellings — `node --test` writes `ℹ pass N` through the
    // spec reporter and `# pass N` through the TAP one, and which of the two a child gets
    // depends on whether its stdout is a terminal.
    const m = /^(?:#|ℹ)\s*pass\s+(\d+)\s*$/m.exec(run.result.stdout);
    assert.ok(m && Number(m[1]) >= 40,
      `the covered suites reported ${m ? m[1] : "no"} passing tests — an empty run proves nothing`);
  });

  test("…and left nothing behind", () => {
    const left = readdirSync(run.box).filter((n) => n !== "node-compile-cache");
    assert.deepEqual(left, [],
      `${left.length} scratch director(ies) survived the run: ${JSON.stringify(left.slice(0, 8))}. ` +
      "Every directory a suite mints must be registered with tests/helpers/scratch.mjs so " +
      "the file's after() hook removes it — a trailing rmSync in the test body is skipped by " +
      "the failing assertion above it");
  });
});
