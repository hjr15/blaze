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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, existsSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "acorn";
import { createSandbox, discardSandbox, MUTATIONS, SANDBOX_CONTENTS }
  from "../scripts/ci/mutate-schedule.mjs";

/** Parse a module the way every executable file in this tree is written (BLZ-504).
 *  `acorn` is a devDependency — this package ships zero runtime dependencies — and
 *  `tests/model/seam-closure.test.mjs` already depends on it for the same reason: a source
 *  property asked of raw text answers about prose as readily as about code. */
const ast = (source) => parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });

/** Every node in an acorn tree, in source order. */
function* nodes(node) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) yield* nodes(n); return; }
  if (typeof node.type === "string") yield node;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    yield* nodes(node[key]);
  }
}

/** Every REAL `rmSync(...)` call in `source`, as `[{ line }]`, in source order.
 *
 *  Both spellings count: the bare `rmSync(p)` of a named import and the `fs.rmSync(p)` of a
 *  namespace one. A comment, a string, a template literal or a regex that merely names the
 *  call is not a call and is not here — that is the whole of BLZ-504. */
export function rmSyncCallSites(source) {
  const out = [];
  for (const n of nodes(ast(source))) {
    if (n.type !== "CallExpression") continue;
    const c = n.callee;
    const name = c.type === "Identifier" ? c.name
      : (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier"
        ? c.property.name : null);
    if (name === "rmSync") out.push({ line: n.loc.start.line });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** `{ start, end }` — the 1-based line range of the function declared as `name`, or `null`.
 *  Exported as a declaration or not; what matters is where its body begins and ends, so
 *  "is the delete inside the guard" is a question about the parse rather than about where a
 *  substring happened to fall in the file. */
export function functionRange(source, name) {
  for (const n of nodes(ast(source))) {
    if (n.type !== "FunctionDeclaration" || n.id?.name !== name) continue;
    return { start: n.loc.start.line, end: n.loc.end.line };
  }
  return null;
}

/** Teardown for a directory this file did not create itself, through the RUNNER's own
 *  guard rather than a second copy of it (BLZ-485). The thing under test is a function
 *  that RETURNS a path we then recursively delete: if `createSandbox` ever returned the
 *  checkout — which is exactly the regression the first test exists to catch — an
 *  unguarded `rmSync` would delete the repository rather than fail the test. A safe
 *  teardown is what makes that mutation runnable.
 *
 *  This used to hold its own `assert.notEqual(sandbox, repo)`, which is why BLZ-485
 *  exists: the guard lived here and not in the runner, and it compared strings. */
function discard(sandbox, repo) {
  discardSandbox(sandbox, repo);
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

// BLZ-485: the teardown guard belongs to the RUNNER, and it compares resolved real paths.
//
// BLZ-472 left the runner's teardown a bare `rmSync(sandbox, {recursive:true, force:true})`
// and put the "refusing to remove the checkout" guard in this file's `discard` helper only.
// So the safety belonged to the tests, not to the thing that ships: `runMutations` would
// recursively delete whatever `createSandbox` handed it, and a refactor that made
// `createSandbox` return the checkout — the precise regression the tests above exist to
// catch — would have deleted the repository before any test could report it.
//
// NOT REACHABLE TODAY, and stated as such rather than implied to be pinned: `createSandbox`
// always returns a fresh `mkdtempSync(join(tmpdir(), "blz-mutate-"))` path, and the tests
// above pin that it is neither the checkout nor a copy of HEAD. No current call path can
// reach the refusal, so NO MUTATION OF THE GUARD CAN BE KILLED THROUGH `runMutations`. It is
// pinned by direct call, below, against a STAND-IN repository — never the real checkout,
// because a test whose failure mode is "the repository is gone" is not a test anyone can
// run twice.
//
// The old helper's compare was `sandbox !== repo` on the raw strings, which is defeated by
// every other spelling of the same directory: a symlink into the checkout, or a `..`
// segment. The tests below are written against those spellings specifically — a string
// compare passes the first of them and fails the rest.
describe("BLZ-485: the runner refuses to delete the checkout, on resolved real paths", () => {
  /** A throwaway stand-in for "the checkout". Every path this block hands to
   *  `discardSandbox` is under `tmpdir()`; the real repository is never an argument to it
   *  here, deliberately. */
  const scratch = () => mkdtempSync(join(tmpdir(), "blz-485-"));
  /** Cleanup for this block's own scratch trees. Not `discardSandbox` — the point of half
   *  these tests is that `discardSandbox` REFUSES the path we need to remove. Narrowed to
   *  the prefix `scratch()` mints so it can never name anything else. */
  const cleanup = (dir) => {
    assert.ok(dir.startsWith(join(tmpdir(), "blz-485-")), `refusing to clean up ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  };

  test("it refuses when the sandbox IS the repo, and leaves the repo on disk", () => {
    const repo = scratch();
    try {
      assert.throws(() => discardSandbox(repo, repo), /refusing to remove it/);
      assert.ok(existsSync(repo), "the repo was deleted — the guard did not hold");
    } finally { cleanup(repo); }
  });

  test("it refuses a SYMLINK to the repo — a string compare passes this and deletes it", () => {
    // The exact case the old helper's `assert.notEqual(sandbox, repo)` could not see: two
    // different strings naming one directory.
    const base = scratch();
    try {
      const repo = join(base, "checkout");
      mkdirSync(repo);
      writeFileSync(join(repo, "canary.txt"), "still here\n");
      const link = join(base, "link-to-checkout");
      symlinkSync(repo, link, "dir");
      assert.notEqual(link, repo, "the premise: these are different strings");
      assert.throws(() => discardSandbox(link, repo), /refusing to remove it/);
      assert.ok(existsSync(join(repo, "canary.txt")),
        "the checkout was deleted through a symlink — the compare is not on real paths");
    } finally { cleanup(base); }
  });

  test("it refuses a NON-NORMALISED path naming the repo (a `..` segment)", () => {
    const base = scratch();
    try {
      const repo = join(base, "checkout");
      mkdirSync(repo);
      writeFileSync(join(repo, "canary.txt"), "still here\n");
      const roundabout = `${base}/./sibling/../checkout`;
      assert.notEqual(roundabout, repo, "the premise: these are different strings");
      mkdirSync(join(base, "sibling"));
      assert.throws(() => discardSandbox(roundabout, repo), /refusing to remove it/);
      assert.ok(existsSync(join(repo, "canary.txt")), "the checkout was deleted via `..`");
    } finally { cleanup(base); }
  });

  test("it refuses an ANCESTOR of the repo — deleting it takes the checkout with it", () => {
    const base = scratch();
    try {
      const repo = join(base, "nested", "checkout");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "canary.txt"), "still here\n");
      assert.throws(() => discardSandbox(base, repo), /refusing to remove it/);
      assert.ok(existsSync(join(repo, "canary.txt")),
        "an ancestor was removed recursively, which deletes the checkout inside it");
    } finally { cleanup(base); }
  });

  // The ancestor test above passes under BOTH the correct predicate and the broken
  // `rel.startsWith("..")` one, because `nested/checkout` starts with neither. This case is
  // the one that separates them, and it is why it exists: `relative(base, repo)` here is
  // `..cache/checkout` — a DESCENT whose first component merely begins with `..`. Read as a
  // climb-out, the guard accepts, and `rm -rf base` takes the working tree with it. That is
  // the round-1 defect, reproduced end to end by review; without this test it could return
  // silently, since `discardSandbox` has exactly one consumer and `.c8rc.json` excludes
  // `scripts/ci/**` from coverage.
  test("it refuses an ancestor whose next component NAMES itself `..something` — a descent " +
       "is not a climb-out", () => {
    const base = scratch();
    try {
      const repo = join(base, "..cache", "checkout");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "canary.txt"), "still here\n");
      assert.throws(() => discardSandbox(base, repo), /refusing to remove it/,
        "`..cache/checkout` is a descent into a directory named `..cache`, not a climb out " +
        "of `base` — a guard that reads it as a climb deletes the checkout");
      assert.ok(existsSync(join(repo, "canary.txt")),
        "the checkout was deleted through a `..`-prefixed directory NAME");
    } finally { cleanup(base); }
  });

  test("a genuine sibling sandbox is still removed — the `..` rule did not over-refuse", () => {
    const base = scratch();
    try {
      const repo = join(base, "checkout");
      const sbx = join(base, "sandbox");
      mkdirSync(repo, { recursive: true });
      mkdirSync(sbx, { recursive: true });
      writeFileSync(join(repo, "canary.txt"), "still here\n");
      writeFileSync(join(sbx, "junk.txt"), "delete me\n");
      discardSandbox(sbx, repo);
      assert.equal(existsSync(sbx), false, "a real sibling sandbox must still be removed");
      assert.ok(existsSync(join(repo, "canary.txt")), "and the checkout must survive it");
    } finally { cleanup(base); }
  });

  test("it DOES remove a genuine sandbox — the guard is not simply refusing everything", () => {
    // Non-vacuity. Without this, a `discardSandbox` that threw unconditionally would pass
    // every test above and leave a temp directory behind on every mutation run.
    const repo = scratch();
    const sandbox = scratch();
    try {
      writeFileSync(join(sandbox, "f.txt"), "x");
      discardSandbox(sandbox, repo);
      assert.ok(!existsSync(sandbox), "a real sandbox must actually be removed");
      assert.ok(existsSync(repo), "and the repo must be untouched");
    } finally { cleanup(repo); cleanup(sandbox); }
  });

  test("the runner's teardown goes through the guard — there is no bare rmSync left", () => {
    // A source check, and stated as what it is. The guard is unreachable from
    // `runMutations` today (see the header), so no behavioural test can prove the runner
    // calls it; what CAN be proved is that the runner contains exactly one `rmSync` CALL,
    // that it sits inside `discardSandbox`, and that the `finally` delegates to it. That is
    // the property BLZ-485 is about: the safety is in the shipped runner, not in this file.
    const src = readFileSync(join(REPO, "scripts", "ci", "mutate-schedule.mjs"), "utf8");
    const calls = rmSyncCallSites(src);
    assert.equal(calls.length, 1,
      `${calls.length} rmSync CALLS in the runner (lines ${calls.map((c) => c.line).join(", ")}) ` +
      "— every recursive delete must go through discardSandbox, which is the only place " +
      "allowed to name a path to remove");
    const guard = functionRange(src, "discardSandbox");
    assert.notEqual(guard, null, "discardSandbox is not declared in the runner");
    assert.ok(calls[0].line >= guard.start && calls[0].line <= guard.end,
      `the runner's single rmSync is at line ${calls[0].line}, outside discardSandbox ` +
      `(lines ${guard.start}–${guard.end})`);
    assert.match(src, /\}\s*finally\s*\{\s*\n\s*discardSandbox\(sandbox\);/,
      "runMutations' finally must delegate to discardSandbox — a bare rmSync there is the " +
      "defect BLZ-485 closes");
  });
});

// BLZ-504 — the guard above counted a STRING, so a comment inflated it.
//
// It was `src.split("rmSync(").length - 1 === 1` over the whole file text. Writing
// `rmSync(sandbox)` inside a COMMENT — explaining what the teardown used to be, which this
// file's own headers do repeatedly — made the count 2 and failed the test on a change that
// altered no code. That happened, and it was worked around by rewording the comment, which
// is the wrong fix: it leaves the next person to discover the rule by tripping over it, and
// it means the guard's number does not mean what its message says it means.
//
// The fix is the convention this corpus already reached for the same class of bug in
// `tests/model/seam-closure.test.mjs`: parse, do not grep. That file records why —
// stripping `//` lines only still left a JSDoc block or an error string naming a write as a
// false offender — and it hard-depends on `acorn`, a devDependency, for exactly this.
//
// Counting CALL SITES also makes the check stricter, not just quieter. A raw-text count
// cannot tell `rmSync(a)` from `fs.rmSync(a)` and would miss the second spelling entirely,
// so the old guard could have been defeated by a bare delete written through a namespace
// import. Both spellings are call sites here.
/** The three spellings of one delete. At module scope, not inside a test body, because
 *  `scripts/ci/temp-cleanup-guard.mjs` reads a delete-looking call inside a test as that
 *  test's own trailing cleanup — these are fixtures for a parser, and recording them as
 *  corpus debt would make that ratchet's number mean less than it says. */
const SPELLINGS = [
  ["a named import", 'import { rmSync } from "node:fs";\nrmSync(p);'],
  ["a namespace import", 'import * as fs from "node:fs";\nfs.rmSync(p);'],
  ["whitespace inside the call", "fs . rmSync (p);"],
];
const TWO_CALLS = 'import { rmSync } from "node:fs";\nrmSync(a);\nrmSync(b);';

describe("BLZ-504: the teardown guard counts call sites, not occurrences of a word", () => {
  const withCall = (extra) => `import { rmSync } from "node:fs";\n${extra}\nrmSync(p, { force: true });\n`;

  for (const [what, source] of [
    ["a line comment", "// rmSync(sandbox, { recursive: true, force: true }) used to live here"],
    ["a JSDoc block", "/** Teardown. Was a bare `rmSync(sandbox)` before BLZ-485. */"],
    ["a trailing comment on a real line", "const p = \"x\"; // not rmSync(p) any more"],
    ["a string literal", 'const msg = "call rmSync(p) only inside the guard";'],
    ["a template literal", "const msg = `rmSync(${1}) is refused here`;"],
    ["a regex literal", "const RE = /\\brmSync\\s*\\(/;"],
  ]) {
    test(`${what} naming rmSync( is not a call site`, () => {
      assert.deepEqual(rmSyncCallSites(source), [],
        `${what} is prose, not a delete — counting it is the false positive BLZ-504 closes`);
      assert.equal(rmSyncCallSites(withCall(source)).length, 1,
        `…and it must not hide a REAL call on another line either`);
    });
  }

  for (const [spelling, source] of SPELLINGS) {
    test(`${spelling} is counted — a text match could not do all three`, () => {
      assert.equal(rmSyncCallSites(source).length, 1,
        "a delete is a delete however it is spelled. A raw `rmSync(` text count matches a " +
        "namespace call only by accident, through the substring, and misses a spaced one " +
        "outright — so the old guard could have been defeated by writing the delete " +
        "differently rather than by not doing it");
    });
  }

  test("the counter is not simply returning nothing — two calls count as two", () => {
    // Non-vacuity. A `rmSyncCallSites` that always returned [] would pass every assertion
    // above and turn the guard it serves into a test that can no longer fail.
    const two = rmSyncCallSites(TWO_CALLS);
    assert.equal(two.length, 2);
    assert.deepEqual(two.map((c) => c.line), [2, 3], "…and it reports where, so a failure is actionable");
  });

  test("functionRange finds the guard's own extent, so 'inside it' is a real question", () => {
    const src = 'function a() {\n  return 1;\n}\nexport function discardSandbox(s) {\n  rmSync(s);\n}\n';
    const r = functionRange(src, "discardSandbox");
    assert.deepEqual([r.start, r.end], [4, 6]);
    assert.equal(functionRange(src, "nope"), null);
    const [call] = rmSyncCallSites(src);
    assert.ok(call.line >= r.start && call.line <= r.end);
    // …and a call OUTSIDE it is outside it, which is the judgement the guard makes.
    const moved = 'export function discardSandbox(s) {\n  return s;\n}\nrmSync(x);\n';
    const [out] = rmSyncCallSites(moved);
    const rr = functionRange(moved, "discardSandbox");
    assert.ok(out.line < rr.start || out.line > rr.end);
  });
});

// =============================================================================
// BLZ-490 — the two gaps review found in BLZ-485's guard, both outside that ticket.
//
//   1. DESCENDANTS WERE NOT REFUSED. The guard above refuses the checkout and every
//      ANCESTOR of it, because a recursive delete of an ancestor takes the checkout with
//      it. It said nothing about a path INSIDE the checkout: `discardSandbox(join(REPO,
//      "scripts"), REPO)` was accepted and deleted the directory. Reproduced before this
//      block was written. A refactor that returns a path inside the tree — a `.sandbox/`
//      under the repo, a `TMPDIR` pointed at the checkout — is as plausible as one that
//      returns the tree itself, and it is the same failure at a smaller radius.
//
//   2. `rmSync(s)` DELETED THE RESOLVED SYMLINK TARGET, NOT THE LINK. BLZ-485 made the
//      comparison run on real paths, which was right, and then handed the RESOLVED path to
//      `rmSync`. That widened the blast radius over the `rmSync(sandbox)` it replaced: a
//      symlink sandbox pointing anywhere outside the checkout now destroys the tree at the
//      far end of the link, which passes both containment checks because the link's target
//      genuinely is neither the checkout nor an ancestor of it. Also reproduced.
//
// SAME REACHABILITY AS EVERY OTHER CLAUSE IN THIS GUARD, and said plainly rather than
// implied: `createSandbox` is the sole producer of the argument on today's call paths and
// always returns a fresh `mkdtempSync(join(tmpdir(), "blz-mutate-"))` directory — never a
// descendant of the checkout, never a symlink. NO CURRENT CALL PATH REACHES EITHER REFUSAL,
// so no mutation of either can be killed through `runMutations`, and neither is claimed to
// be mutation-pinned. Both are defence in depth on a function whose failure mode is
// deleting a working tree, and both are pinned by direct call below, against a stand-in
// repository.
// =============================================================================

describe("BLZ-490: the guard refuses a path INSIDE the checkout, and never follows a symlink", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "blz-490-"));
  const cleanup = (dir) => {
    assert.ok(dir.startsWith(join(tmpdir(), "blz-490-")), `refusing to clean up ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  };

  test("it refuses a DESCENDANT of the repo — a directory inside the checkout is not a sandbox", () => {
    const repo = scratch();
    try {
      const inside = join(repo, "scripts");
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, "canary.txt"), "still here\n");
      assert.throws(() => discardSandbox(inside, repo), /refusing to remove it/,
        "`<repo>/scripts` is INSIDE the checkout — deleting it recursively removes part of " +
        "the working tree, which is the same defect as deleting all of it");
      assert.ok(existsSync(join(inside, "canary.txt")),
        "a directory inside the checkout was deleted — the guard only looked upwards");
    } finally { cleanup(repo); }
  });

  test("it refuses a DESCENDANT reached through a `..` segment — the check is on real paths", () => {
    // The descendant rule has to survive the same spellings the ancestor rule does, or it
    // is a string compare wearing a `relative()` costume.
    const repo = scratch();
    try {
      const inside = join(repo, "scripts");
      mkdirSync(join(repo, "sibling"), { recursive: true });
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(inside, "canary.txt"), "still here\n");
      const roundabout = `${repo}/sibling/../scripts`;
      assert.notEqual(roundabout, inside, "the premise: these are different strings");
      assert.throws(() => discardSandbox(roundabout, repo), /refusing to remove it/);
      assert.ok(existsSync(join(inside, "canary.txt")), "the descendant was deleted via `..`");
    } finally { cleanup(repo); }
  });

  test("it refuses a SYMLINK sandbox rather than deleting the tree it points at", () => {
    // The widening BLZ-485 introduced. `victim` is neither the checkout nor an ancestor of
    // it, so both containment checks pass; the only thing standing between a symlinked
    // sandbox and `rm -rf` on someone else's directory is that the link is not followed.
    const base = scratch();
    try {
      const repo = join(base, "checkout");
      const victim = join(base, "victim");
      mkdirSync(repo, { recursive: true });
      mkdirSync(victim, { recursive: true });
      writeFileSync(join(victim, "canary.txt"), "still here\n");
      const link = join(base, "link-to-victim");
      symlinkSync(victim, link, "dir");
      assert.throws(() => discardSandbox(link, repo), /refusing to remove it/,
        "a symlink is a name for a directory somebody else owns; `createSandbox` never " +
        "returns one, so there is nothing to lose by refusing it");
      assert.ok(existsSync(join(victim, "canary.txt")),
        "the SYMLINK TARGET was deleted — `rmSync` on the resolved path follows the link, " +
        "which is strictly wider than the `rmSync(sandbox)` this replaced");
      assert.ok(existsSync(link), "and the link itself must survive a refusal too");
    } finally { cleanup(base); }
  });

  test("it refuses a SYMLINK sandbox SPELLED with a trailing separator or `/.` — the " +
       "spelling must not defeat the check", () => {
    // The hole review found in the first cut of the clause above, and the reason that clause
    // is now written against a NORMALISED path. `lstat` does not follow the last component —
    // unless the caller writes a trailing separator, which forces the OS to resolve it:
    //
    //   "<T>/link"    isSymbolicLink: true    realpath: <T>/victim
    //   "<T>/link/"   isSymbolicLink: false   realpath: <T>/victim
    //   "<T>/link/."  isSymbolicLink: false   realpath: <T>/victim
    //
    // Measured directly, both spellings. With `isSymbolicLink()` false the guard fell
    // through to `rmSync(s)`, where `s` is the REALPATH — the victim tree — and review
    // reproduced the whole deletion end to end. The containment checks above never had this
    // hole because they run on `s`, which normalises both spellings; only this clause read
    // the raw argument, and that asymmetry was the entire defect.
    for (const suffix of ["/", "/."]) {
      const base = scratch();
      try {
        const repo = join(base, "checkout");
        const victim = join(base, "victim");
        mkdirSync(repo, { recursive: true });
        mkdirSync(victim, { recursive: true });
        writeFileSync(join(victim, "canary.txt"), "still here\n");
        const link = join(base, "link-to-victim");
        symlinkSync(victim, link, "dir");
        assert.throws(() => discardSandbox(link + suffix, repo), /refusing to remove it/,
          `\`link${suffix}\` names the same symlink as \`link\`, and a guard a trailing ` +
          "separator switches off is not a guard");
        assert.ok(existsSync(join(victim, "canary.txt")),
          `the symlink TARGET was deleted through the \`link${suffix}\` spelling`);
      } finally { cleanup(base); }
    }
  });

  test("a real directory whose PARENT is a symlink is still removed — the check is the last component only", () => {
    // Non-vacuity for the symlink rule, and the case that decides whether it over-refuses:
    // on a machine where `tmpdir()` is itself a symlink (macOS `/tmp` → `/private/tmp`),
    // every genuine sandbox is reached through one. Refusing those would break the runner
    // on exactly that machine, which is worse than the gap this closes.
    const base = scratch();
    try {
      const real = join(base, "real");
      const repo = join(base, "checkout");
      mkdirSync(repo, { recursive: true });
      mkdirSync(join(real, "sandbox"), { recursive: true });
      const viaLink = join(base, "link-to-real");
      symlinkSync(real, viaLink, "dir");
      const sandbox = join(viaLink, "sandbox");
      writeFileSync(join(sandbox, "junk.txt"), "delete me\n");
      discardSandbox(sandbox, repo);
      assert.equal(existsSync(join(real, "sandbox")), false,
        "a genuine sandbox reached through a symlinked parent must still be removed");
      assert.ok(existsSync(viaLink), "and the parent link itself is not what was removed");
    } finally { cleanup(base); }
  });
});
