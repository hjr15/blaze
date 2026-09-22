// tests/helpers/no-leak.mjs — BLZ-517.
//
// PROVING A SUITE LEAVES NO SCRATCH DIRECTORY BEHIND, ONCE, FOR EVERY SUITE THAT CLAIMS IT.
//
// An `after()` hook cannot be observed from inside the process that registers it. The only
// way to see whether one ran is from outside: point `TMPDIR` at an empty directory, run the
// suite in a child, and look at what is left. BLZ-491 wrote that by hand for one suite —
// about ten lines of spawn, env-strip, non-vacuity probe and `readdirSync` — and BLZ-503
// then fixed 34 more suites, at which point writing it 34 more times was the wrong shape.
//
// This is that proof, extracted. The covered suites are named by the caller, never globbed,
// because a list that discovers its own members can shrink to nothing and still pass.
//
// ONE CHILD, PER-SUITE VERDICTS. Running each suite in its own child would be 35 spawns for
// a property that one spawn can settle, so all of them run together and the leftovers are
// attributed back with `scripts/ci/tmp-scratch-attribution.mjs` — the registry BLZ-491 built
// for exactly this question. Each covered suite still gets its OWN named test, so reverting
// one suite's cleanup reddens a test that names that suite rather than a single aggregate
// nobody can read.
//
// NOTHING IS DROPPED. A leftover that attributes to no covered suite is not ignored: it goes
// to its own failing test, because a scan that quietly discarded what it could not place
// would report a clean corpus over directories it never explained.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { scanScratchSites, attributeScratch }
  from "../../scripts/ci/tmp-scratch-attribution.mjs";

const REPO = join(import.meta.dirname, "..", "..");

/** Entries a fresh `TMPDIR` box can legitimately hold that no suite minted.
 *
 *  `node-compile-cache` is Node's own on-disk compile cache, created under `TMPDIR` when
 *  `NODE_COMPILE_CACHE` is set — by the npm wrapper, not by anything in this corpus. It is
 *  named here with its reason rather than filtered by a pattern, so the list of things this
 *  proof forgives stays one line long and readable. */
export const NOT_A_SCRATCH_DIRECTORY = new Set(["node-compile-cache"]);

/** Declare the proof for `suites`, a list of repo-relative `tests/…test.mjs` paths.
 *
 *  Call at module scope. Declares, under one `describe`:
 *    - two non-vacuity tests — the child honoured `TMPDIR`, and the covered suites actually
 *      ran and passed — because an ignored `TMPDIR` and an empty run both leave an empty box
 *      and would make every verdict below pass over nothing;
 *    - one test per covered suite, named for that suite;
 *    - one test for leftovers no covered suite explains.
 *
 *  `minTests` is a floor on the child's passing count, well under what the covered suites
 *  carry, so it pins non-vacuity without pinning a number ordinary work moves. */
export function proveNoLeak({ label, suites, minTests }) {
  assert.ok(suites.length > 0, "proveNoLeak needs at least one suite — an empty list proves nothing");

  describe(label, () => {
    const state = { box: null, env: null, result: null, leftovers: [], byOwner: new Map() };

    before(() => {
      state.box = mkdtempSync(join(tmpdir(), "blz517-nolebox-"));
      // `node --test` marks its children with NODE_TEST_CONTEXT and swaps their reporter for
      // a serialised stream, which reaches a captured stdout as nothing at all — so the "did
      // it actually run" check below could see no summary to read. BLZ-491 hit this; the env
      // is stripped rather than the check weakened.
      state.env = { ...process.env, TMPDIR: state.box };
      for (const k of Object.keys(state.env)) if (k.startsWith("NODE_TEST")) delete state.env[k];

      state.result = spawnSync(process.execPath, ["--test", "--test-timeout=120000", ...suites],
        { cwd: REPO, env: state.env, encoding: "utf8" });

      const registry = scanScratchSites(join(REPO, "tests")).prefixes;
      for (const name of readdirSync(state.box)) {
        if (NOT_A_SCRATCH_DIRECTORY.has(name)) continue;
        state.leftovers.push(name);
        const owner = attributeScratch(name, registry);
        const key = owner === null ? null : owner.slice(REPO.length + 1).split("\\").join("/");
        if (!state.byOwner.has(key)) state.byOwner.set(key, []);
        state.byOwner.get(key).push(name);
      }
    });

    after(() => { if (state.box) rmSync(state.box, { recursive: true, force: true }); });

    test("TMPDIR is honoured by the child, or this proof can see nothing at all", () => {
      const probe = spawnSync(process.execPath,
        ["-e", "console.log(require('node:os').tmpdir())"], { env: state.env, encoding: "utf8" });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout.trim(), state.box,
        `TMPDIR was not honoured — the child resolved ${probe.stdout.trim()}, not ${state.box}. ` +
        "Without it the box would be empty because the suites wrote somewhere else");
    });

    test("the covered suites passed, and actually ran their tests", () => {
      assert.equal(state.result.status, 0,
        `the covered suites must pass before their litter can be judged:\n${state.result.stdout}\n${state.result.stderr}`);
      // Both summary spellings: `node --test` writes `ℹ pass N` through the spec reporter and
      // `# pass N` through the TAP one, and which a child gets depends on its stdout.
      const m = /^(?:#|ℹ)\s*pass\s+(\d+)\s*$/m.exec(state.result.stdout);
      assert.ok(m && Number(m[1]) >= minTests,
        `the covered suites reported ${m ? m[1] : "no"} passing tests, under the floor of ${minTests} ` +
        "— an empty run leaves an empty box too");
    });

    for (const suite of suites) {
      test(`${suite} leaves no scratch directory behind`, () => {
        const left = state.byOwner.get(suite) ?? [];
        assert.deepEqual(left, [],
          `${suite} left ${left.length} scratch director(ies): ${JSON.stringify(left.slice(0, 8))}. ` +
          "Register each one with tests/helpers/scratch.mjs so the file's after() hook removes " +
          "it — cleanup written as a test's trailing statement is skipped by a failing " +
          "assertion above it");
      });
    }

    test("every leftover was attributed to a covered suite — none was dropped", () => {
      const stray = [...state.byOwner]
        .filter(([owner]) => owner === null || !suites.includes(owner))
        .map(([owner, names]) => `${owner ?? "(no registered prefix explains it)"}: ${names.join(", ")}`);
      assert.deepEqual(stray, [],
        "a leftover this proof could not place on a covered suite. Either the suite that " +
        "made it belongs on the covered list, or the directory is not a scratch directory " +
        "and belongs in NOT_A_SCRATCH_DIRECTORY with its reason");
    });
  });
}
