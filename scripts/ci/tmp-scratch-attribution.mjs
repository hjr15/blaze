// scripts/ci/tmp-scratch-attribution.mjs — BLZ-491.
//
// A LEAKED SCRATCH DIRECTORY MUST NAME THE SUITE THAT MADE IT.
//
// `tests/board-overstatement-guards.test.mjs` created `/tmp/blz-guards-board-*` on every
// run and removed none of them; 348 were on this machine when the fix was written. That is
// harmless on its own and it is not what this file is for. What it costs is the ability to
// read `/tmp` at all: BLZ-485's mutation runner asserts ZERO leftover `/tmp/blz-mutate-*`
// as the evidence its teardown works, and a suite that litters trains the reader of that
// assertion to treat litter as background noise. Adding an `after()` hook to one suite
// fixes one suite; the second half of the ticket is the general property, which is that
// WHEN something does leak, the leftover directory can be traced back to the test file that
// created it without anyone having to guess.
//
// The mechanism is the name. `mkdtempSync(join(tmpdir(), PREFIX))` returns PREFIX plus
// exactly six random characters, so a leftover directory is attributable precisely when its
// PREFIX belongs to exactly one test file. That is a property of the corpus, and it is
// scannable — which is what this module does, and what `tests/tmp-scratch-attribution.test.mjs`
// asserts on every run so a new suite cannot quietly reuse another's prefix.
//
// Run it as a CLI to attribute what is on the machine right now:
//
//     node scripts/ci/tmp-scratch-attribution.mjs
//     node scripts/ci/tmp-scratch-attribution.mjs --tmp /some/other/dir
//
// It reports every scratch-looking directory it finds against the registry, and lists the
// ones it CANNOT attribute separately rather than dropping them — an unattributable leak is
// the finding, not an absence of one.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The buckets `scanScratchSites` sorts a call into. `unaccounted` is the one that matters:
 *  it is what a scan reports instead of dropping a call it could not read. */
export const SITE_BUCKETS = ["comment", "literal", "nested", "template", "unaccounted"];

/** `mkdtempSync` replaces a trailing `XXXXXX`, so the suffix is exactly six characters.
 *  This is the whole reason attribution is unambiguous even when one registered prefix is a
 *  strict prefix of another: `blz-guards-` + 6 and `blz-guards-board-` + 6 are different
 *  LENGTHS, so a name can only ever match one of them. */
export const MKDTEMP_SUFFIX = 6;

/** Every way a test file is allowed to name a scratch directory directly under `tmpdir()`.
 *  A call this cannot read lands in `unaccounted`, which is a failure, not a skip. */
const SITE_PATTERNS = [
  // A line that is entirely a comment mints nothing. Recognised EXPLICITLY, and only when
  // the comment opens the line, so a real call carrying a trailing comment is still read as
  // a call — prose about `mkdtempSync` is common in this corpus's headers and must not be
  // mistaken for either a scratch directory or an unreadable one.
  { bucket: "comment", re: /^\s*(?:\/\/|\*|\/\*)/ },
  // mkdtempSync(join(tmpdir(), "literal-prefix-"))
  { bucket: "literal", re: /mkdtempSync\(\s*join\(\s*tmpdir\(\)\s*,\s*"([^"]*)"/ },
  // mkdtempSync(join(tmpdir(), `static-head-${something}`)) — only the STATIC head can be
  // registered, so it is what has to be unique.
  { bucket: "template", re: /mkdtempSync\(\s*join\(\s*tmpdir\(\)\s*,\s*`([^`$]*)/ },
  // mkdtempSync(join(someLocalTmp, …)) — nested INSIDE a directory that was itself minted
  // above, so it is not a top-level `/tmp` entry and is attributable through its parent.
  { bucket: "nested", re: /mkdtempSync\(\s*join\(\s*(?!tmpdir\(\))[A-Za-z_$][\w$]*\s*,/ },
];

function* testFiles(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* testFiles(p);
    else if (p.endsWith(".test.mjs")) yield p;
  }
}

/** Scan `testsDir` for every `mkdtempSync` call and classify each one.
 *
 *  Returns `{ sites, prefixes, unaccounted, ambiguous }` where `sites` is EVERY call found
 *  — not only the ones that were understood — `prefixes` maps a registered prefix to the
 *  sorted list of files using it, `unaccounted` holds the calls no pattern read, and
 *  `ambiguous` holds the prefixes claimed by more than one file. The three buckets are
 *  reported separately on purpose: a scan that silently dropped what it could not parse
 *  would report a clean registry over a corpus it never read. */
export function scanScratchSites(testsDir) {
  const sites = [];
  for (const file of testFiles(testsDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/mkdtempSync\s*\(/.test(line)) return;
      const site = { file, line: i + 1, text: line.trim(), bucket: "unaccounted", prefix: null };
      for (const { bucket, re } of SITE_PATTERNS) {
        const m = re.exec(line);
        if (!m) continue;
        site.bucket = bucket;
        site.prefix = (bucket === "nested" || bucket === "comment") ? null : m[1];
        // An empty static head names nothing: `join(tmpdir(), name)` and
        // `join(tmpdir(), `${name}`)` are equally unattributable, so both are refused here
        // rather than registered as the prefix "".
        if (site.prefix === "") { site.bucket = "unaccounted"; site.prefix = null; }
        break;
      }
      sites.push(site);
    });
  }

  const acc = new Map();
  for (const s of sites) {
    if (!s.prefix) continue;
    if (!acc.has(s.prefix)) acc.set(s.prefix, { files: new Set(), exact: true });
    const e = acc.get(s.prefix);
    e.files.add(s.file);
    // A template site registers only its STATIC head, so the directory it mints is that head
    // plus an interpolated segment plus six — longer than an exact match allows. Recorded
    // per prefix rather than assumed, because a prefix used by both forms is not exact.
    if (s.bucket === "template") e.exact = false;
  }
  const registry = new Map([...acc]
    .map(([p, e]) => [p, { files: [...e.files].sort(), exact: e.exact }])
    .sort(([a], [b]) => (a < b ? -1 : 1)));

  // An inexact prefix matches anything that STARTS with it, so another file's prefix sitting
  // underneath one is the same ambiguity as two files sharing a prefix outright — and it is
  // invisible to a duplicate check. Both are reported, in one list, because the reader's
  // question is the same: can a leak carrying this name be traced to one suite?
  const shadowed = [];
  for (const [p, e] of registry) {
    if (e.exact) continue;
    for (const [q, f] of registry) {
      if (q === p || !q.startsWith(p)) continue;
      if (f.files.some((x) => !e.files.includes(x))) shadowed.push([p, [...new Set([...e.files, ...f.files])].sort()]);
    }
  }

  return {
    sites,
    prefixes: registry,
    unaccounted: sites.filter((s) => s.bucket === "unaccounted"),
    ambiguous: [...[...registry].filter(([, e]) => e.files.length > 1).map(([p, e]) => [p, e.files]),
      ...shadowed],
  };
}

/** The directory name a leak carries → the test file that made it, or `null`.
 *
 *  Matching is on prefix AND length, never on prefix alone: `blz-guards-board-Ab12Cd` is
 *  `blz-guards-board-` plus six, and is NOT `blz-guards-` plus six, so two registered
 *  prefixes where one contains the other still attribute to one file each. A prefix
 *  registered from a TEMPLATE site is the static head only, so it matches on length
 *  `>=` instead — and `scanScratchSites` reports any other file's prefix that head would
 *  swallow, so the looser rule cannot quietly claim someone else's leak. Returns `null`
 *  for anything no registered prefix explains — including a directory some other program
 *  left there, which is exactly what the caller needs to be told. */
export function attributeScratch(name, registry) {
  const owners = new Set();
  for (const [prefix, entry] of registry) {
    const files = Array.isArray(entry) ? entry : entry.files;
    const exact = Array.isArray(entry) ? true : entry.exact;
    const fits = exact
      ? name.length === prefix.length + MKDTEMP_SUFFIX
      : name.length >= prefix.length + MKDTEMP_SUFFIX;
    if (fits && name.startsWith(prefix)) for (const f of files) owners.add(f);
  }
  return owners.size === 1 ? [...owners][0] : null;
}

// --- CLI ----------------------------------------------------------------------
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = join(import.meta.dirname, "..", "..");
  const where = process.argv.includes("--tmp")
    ? process.argv[process.argv.indexOf("--tmp") + 1] : tmpdir();
  const scan = scanScratchSites(join(repo, "tests"));
  console.log(`=== BLZ-491 scratch attribution: ${where} ===`);
  console.log(`  registry: ${scan.prefixes.size} prefixes over ${scan.sites.length} mkdtempSync call(s)`);
  if (scan.unaccounted.length) {
    console.log(`  ${scan.unaccounted.length} call(s) this scan could NOT read — the registry is incomplete:`);
    for (const s of scan.unaccounted) console.log(`    ${s.file}:${s.line}  ${s.text}`);
  }
  if (scan.ambiguous.length) {
    console.log(`  ${scan.ambiguous.length} prefix(es) claimed by more than one file — a leak from these is NOT attributable:`);
    for (const [p, files] of scan.ambiguous) console.log(`    "${p}"  ${files.join(" , ")}`);
  }
  const byOwner = new Map();
  const orphans = [];
  for (const name of readdirSync(where)) {
    const owner = attributeScratch(name, scan.prefixes);
    if (owner === null) { orphans.push(name); continue; }
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(name);
  }
  const owned = [...byOwner.values()].reduce((n, v) => n + v.length, 0);
  console.log(`\n  ${owned} leftover director(ies) attributed to a test file:`);
  for (const [owner, names] of [...byOwner].sort(([a], [b]) => (a < b ? -1 : 1))) {
    console.log(`    ${names.length.toString().padStart(5)}  ${owner}`);
  }
  console.log(`\n  ${orphans.length} entr(ies) no registered prefix explains (other programs' files live here too).`);
}
