// tests/ci-mutation-sandbox.test.mjs — BLZ-472.
//
// `scripts/ci/mutate-schedule.mjs` used to rewrite `scripts/model/schedule.mjs` IN PLACE,
// in the shared working tree, with no lock. Anything else reading that module while it was
// mutating — a `node --test` run in the same worktree — saw a half-mutated file and
// reported a failure that was not real. Reproduced accidentally by the Lane F reviewer at a
// cost of one full re-run: `npm run test:coverage` reported
// `tests/model/link-type-overrides.test.mjs:422 ✖ a board that is all ONE DEPENDENCY CYCLE
// does not raise it — expected the cycle finding, got: (empty)`, which passed in isolation
// and re-ran clean at 4,017/0 against a 4,016/0 control on the parent commit.
//
// The fix removes the race rather than detecting it: the runner copies the working tree and
// mutates the copy. This file pins that, and it pins it the only way that is worth anything
// — by checking the CHECKOUT's own bytes across a write to what the runner thinks is its
// target. A test that only asserted "createSandbox returns a different path" would stay
// green if a single call site forgot to join onto it.
//
// It does NOT run the gate. Importing a module that ran seventeen mutations on import would
// be the hazard itself; the runner is behind a CLI guard for that reason.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSandbox, MUTATIONS, SANDBOX_CONTENTS } from "../scripts/ci/mutate-schedule.mjs";

/** Teardown for a directory this file did not create itself. Guarded, because the thing
 *  under test is a function that RETURNS a path we then recursively delete: if
 *  `createSandbox` ever returned the checkout — which is exactly the regression the first
 *  test exists to catch — an unguarded `rmSync` would delete the repository rather than
 *  fail the test. A safe teardown is what makes that mutation runnable. */
function discard(sandbox, repo) {
  assert.notEqual(sandbox, repo,
    "createSandbox returned the checkout itself — refusing to remove it. This IS the failure: " +
    "the runner would mutate the shared working tree in place");
  rmSync(sandbox, { recursive: true, force: true });
}

const REPO = join(import.meta.dirname, "..");
const SOLVE = "scripts/model/schedule.mjs";
const AUDIT = "scripts/model/audit.mjs";

describe("BLZ-472: the mutation runner mutates a COPY, never the shared working tree", () => {
  test("a write to the sandbox's copy leaves the checkout byte-identical", () => {
    const before = { [SOLVE]: readFileSync(join(REPO, SOLVE)), [AUDIT]: readFileSync(join(REPO, AUDIT)) };
    const sandbox = createSandbox(REPO);
    try {
      assert.notEqual(sandbox, REPO, "the sandbox must not BE the checkout");
      for (const target of [SOLVE, AUDIT]) {
        // Exactly what the runner does to each mutation target, and what it used to do to
        // the checkout's own copy.
        writeFileSync(join(sandbox, target), "// mutated\n");
        assert.equal(readFileSync(join(sandbox, target), "utf8"), "// mutated\n",
          `${target}: the sandbox copy must be the thing that changes`);
        assert.deepEqual(readFileSync(join(REPO, target)), before[target],
          `${target} in the CHECKOUT changed — a concurrent suite run would read a ` +
          "half-mutated module and report a failure that is not real");
      }
    } finally {
      discard(sandbox, REPO);
    }
  });

  test("the sandbox carries the WORKING TREE, not HEAD — uncommitted hunks are what this gate judges", () => {
    const sandbox = createSandbox(REPO);
    try {
      for (const entry of SANDBOX_CONTENTS) {
        assert.ok(existsSync(join(sandbox, entry)), `${entry} is missing from the sandbox`);
      }
      for (const target of [SOLVE, AUDIT]) {
        assert.deepEqual(readFileSync(join(sandbox, target)), readFileSync(join(REPO, target)),
          `${target}: the sandbox must carry the working tree's bytes. Copying HEAD instead ` +
          "would make this gate judge code nobody is about to ship");
      }
    } finally {
      discard(sandbox, REPO);
    }
  });

  test("every mutation's `from` string is present exactly once in the sandbox — the gate is not silently a no-op", () => {
    // A PATCH-MISS or PATCH-AMBIGUOUS is reported by the runner as a non-KILLED status, so
    // the gate already fails on it. Checked here as well because it is the one thing that
    // could make the sandbox wrong in a way the sandbox tests above cannot see: a copy that
    // arrived truncated would still be "not the checkout".
    assert.ok(MUTATIONS.length >= 17, `only ${MUTATIONS.length} mutations — the set shrank`);
    const sandbox = createSandbox(REPO);
    try {
      for (const m of MUTATIONS) {
        const src = readFileSync(join(sandbox, m.file ?? SOLVE), "utf8");
        assert.equal(src.split(m.from).length - 1, 1,
          `mutation #${m.n} (${m.name}): its \`from\` string appears ` +
          `${src.split(m.from).length - 1} time(s) in the sandbox copy, not once`);
      }
    } finally {
      discard(sandbox, REPO);
    }
  });

  test("the runner opens no file in the checkout for writing", () => {
    // A source check, deliberately, and stated as what it is: the three tests above prove
    // the sandbox is a copy and that writing to it spares the checkout, but they exercise
    // ONE write each. This is what says no OTHER call site writes a bare relative path,
    // which is how the defect worked in the first place — `writeFileSync(src, …)` where
    // `src` was `"scripts/model/schedule.mjs"`, resolved against the caller's cwd.
    const src = readFileSync(join(REPO, "scripts", "ci", "mutate-schedule.mjs"), "utf8");
    const writes = [...src.matchAll(/writeFileSync\(([^,]+),/g)].map((m) => m[1].trim());
    assert.ok(writes.length > 0, "no writeFileSync call was found — this check is vacuous");
    for (const arg of writes) {
      assert.match(arg, /^src$/,
        `writeFileSync's target is ${JSON.stringify(arg)}; every write must go through the ` +
        "sandbox-joined `src` binding");
    }
    assert.match(src, /const src = join\(sandbox, m\.file \?\? SOLVE\);/,
      "`src` must be joined onto the sandbox — a bare relative path resolves against the " +
      "caller's cwd, which is the shared checkout");
  });
});
