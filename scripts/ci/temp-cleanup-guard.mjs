// scripts/ci/temp-cleanup-guard.mjs — BLZ-603.
//
// CLEANUP THAT ONLY RUNS WHEN THE TEST PASSES IS NOT CLEANUP.
//
// `tests/commit-settled-drain.test.mjs` removed its scratch repo with `rmSync(root, …)`
// as the LAST STATEMENT of each test. A failing assertion throws before that line, so a
// red run left `/tmp/blaze-settled-*` and `/tmp/lane-*` behind — exactly when you most
// want a clean machine to re-run on. The same shape in
// `tests/model/driver-conformance.test.mjs` was worse than litter: the trailing statement
// there was `await s.close?.()` on a Postgres client, and a `node --test` child holding a
// live referenced socket CANNOT EXIT. That is BLZ-534's hang, and it reproduces on demand
// — mutate one assertion in that file with `BLAZE_TEST_PG_URL` set and the process runs
// forever.
//
// So this is a scanner for one shape: a cleanup call inside a `test`/`it` callback, AFTER
// the first assertion in that callback, and NOT inside an `after`/`before` hook or a
// `finally` block. Cleanup before any assertion cannot be skipped by a failing assertion,
// which is why the first-assertion line is where the rule starts.
//
// WHAT IT IS NOT. It is a line scanner, not a parser: it reasons about brace depth and
// call names, so it will not follow cleanup done inside a helper function called from a
// test. Those exist in this corpus and are NOT reported here — see
// `tests/temp-cleanup-guard.test.mjs`, which states that limit rather than letting the
// count look complete.
//
// THE DEBT IS RECORDED, NOT HIDDEN. This corpus has hundreds of pre-existing sites of this
// shape. Fixing them all is a separate body of work, so `debt.json` beside this file
// records the exact count per file and `tests/temp-cleanup-guard.test.mjs` holds it to
// EQUALITY: a file cannot gain a site, and a file that is cleaned up must have its entry
// removed in the same change. A file with no entry must have none.
//
// Run it to see where things stand:
//
//     node scripts/ci/temp-cleanup-guard.mjs            # report
//     node scripts/ci/temp-cleanup-guard.mjs --write    # re-record debt.json
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TESTS_DIR = join(HERE, "..", "..", "tests");
export const DEBT_FILE = join(HERE, "temp-cleanup-debt.json");

/** Calls that release a resource. `close?.(` is here because BLZ-534's hang was a Postgres
 *  client left open by a trailing `await s.close?.()`, which is this defect exactly. */
const CLEANUP = /\brmSync\s*\(|\brmdirSync\s*\(|"worktree"\s*,\s*"remove"|\bclose\?\.\(/;
const TEST_OPEN = /(^|[^\w.$])(test|it)\s*\(/;
/** Anything that makes the call run regardless of outcome. */
const GUARD_OPEN = /(^|[^\w.$])(t\.after|t\.before|after|afterEach|before|beforeEach)\s*\(|\bfinally\s*\{/;
const ASSERTION = /\bassert\b|\bt\.assert\./;
const LINE_COMMENT = /^\s*(\/\/|\*|\/\*)/;

/** Every unguarded cleanup site in one file's source, as `{ line, text }`.
 *
 *  Frames are closed by brace depth. A frame's recorded depth is the depth INSIDE its block
 *  minus one, which is what makes `} finally {` work: that line closes the `try` and opens
 *  the `finally` in one go, so the depth it ends on is not the depth it started on. A guard
 *  written entirely on one line (`t.after(() => rmSync(root, …));`) opens no block at all,
 *  so it is handled by the `opensGuard` flag on the line itself rather than by a frame. */
export function scanSource(source) {
  const found = [];
  const stack = [];
  let depth = 0;
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (LINE_COMMENT.test(raw)) continue;
    const line = raw.replace(/\/\/.*$/, "");
    const opensGuard = GUARD_OPEN.test(line);
    const opensTest = TEST_OPEN.test(line);
    if (ASSERTION.test(line)) for (const f of stack) if (f.kind === "test") f.sawAssertion = true;
    if (CLEANUP.test(line)) {
      const test = [...stack].reverse().find((f) => f.kind === "test");
      const guarded = opensGuard || stack.some((f) => f.kind === "guard");
      if (test?.sawAssertion && !guarded) found.push({ line: i + 1, text: raw.trim() });
    }
    const opens = (line.match(/[{(]/g) ?? []).length;
    const closes = (line.match(/[})]/g) ?? []).length;
    const after = depth + opens - closes;
    if (line.trimEnd().endsWith("{") || after > depth) {
      if (opensGuard) stack.push({ kind: "guard", depth: after - 1 });
      else if (opensTest) stack.push({ kind: "test", depth: after - 1, sawAssertion: false });
    }
    depth = after;
    while (stack.length && depth <= stack[stack.length - 1].depth) stack.pop();
  }
  return found;
}

/** This guard's OWN test file carries synthetic sources — deliberately unguarded ones —
 *  inside template literals, so scanning it would count the scanner's fixtures as corpus
 *  debt and the recorded number would stop meaning what it says. */
export const NOT_CORPUS = new Set(["temp-cleanup-guard.test.mjs"]);

/** Every `*.test.mjs` under `dir`, as repo-relative POSIX paths. */
export function testFiles(dir = TESTS_DIR) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.mjs")) {
        const rel = relative(dir, p).split(sep).join("/");
        if (!NOT_CORPUS.has(rel)) out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}

/** `{ "relative/path.test.mjs": count }` for every file with at least one site. */
export function scanCorpus(dir = TESTS_DIR) {
  const counts = {};
  for (const rel of testFiles(dir)) {
    const n = scanSource(readFileSync(join(dir, rel), "utf8")).length;
    if (n) counts[rel] = n;
  }
  return counts;
}

export function readDebt() {
  return JSON.parse(readFileSync(DEBT_FILE, "utf8")).files;
}

/** `{ regressions, fixed }` — files over their recorded budget, and files under it. */
export function compareToDebt(counts = scanCorpus(), debt = readDebt()) {
  const regressions = [], fixed = [];
  for (const f of new Set([...Object.keys(counts), ...Object.keys(debt)])) {
    const now = counts[f] ?? 0, recorded = debt[f] ?? 0;
    if (now > recorded) regressions.push({ file: f, now, recorded });
    else if (now < recorded) fixed.push({ file: f, now, recorded });
  }
  return { regressions, fixed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = scanCorpus();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (process.argv.includes("--write")) {
    writeFileSync(DEBT_FILE, `${JSON.stringify({
      comment: "BLZ-603. Cleanup calls that a failing assertion skips, per test file. "
        + "Generated by `node scripts/ci/temp-cleanup-guard.mjs --write`; held to EQUALITY "
        + "by tests/temp-cleanup-guard.test.mjs so neither a new leak nor a silent fix goes "
        + "unrecorded.",
      files: counts,
    }, null, 2)}\n`);
    console.log(`wrote ${DEBT_FILE}: ${Object.keys(counts).length} files, ${total} sites`);
  } else {
    for (const [f, n] of Object.entries(counts)) console.log(String(n).padStart(4), f);
    console.log(`${Object.keys(counts).length} files, ${total} unguarded cleanup sites`);
    const { regressions, fixed } = compareToDebt(counts);
    for (const r of regressions) console.log(`REGRESSION ${r.file}: ${r.now} > recorded ${r.recorded}`);
    for (const r of fixed) console.log(`FIXED ${r.file}: ${r.now} < recorded ${r.recorded} — re-record with --write`);
    process.exitCode = regressions.length ? 1 : 0;
  }
}
