// scripts/ci/quoted-sources.mjs — BLZ-523.
//
// A DOC QUOTE OPTS IN TO BEING CHECKED. NOTHING ELSE IS POLICED.
//
// Docs quote the product: an exact CLI string, a count the code determines, the two files a
// runner actually mutates. Those rot silently — the code moves, the sentence does not, and
// nothing notices until someone follows the doc and it is wrong.
//
// THE OBVIOUS MECHANISM WAS TRIED ON PAPER AND REJECTED. A corpus-wide grep — "find every
// quoted literal in docs/ and check it against the tree" — was investigated for this ticket
// on 2026-08-30 and does not work here. The evidence was four sites quoting a stale figure
// while two more quoted the same CLASS of figure correctly. A grep cannot separate those two
// populations, because the difference is not in the text: one is an assertion about today,
// the other is a measurement reported with the commit it was taken at. A guard that cannot
// tell them apart fires on the correct ones, gets an exception added, and is excepted into
// uselessness. That has a name in this repo and it is not a compliment.
//
// SO THE SCOPE IS THE REGISTRY, AND THE REGISTRY IS HAND-WRITTEN. An entry names the doc, the
// quote as the doc carries it, the deriver that says what the source of truth reads NOW, and
// WHY the quote is load-bearing. Everything not listed is untouched, including quotes that
// are demonstrably stale — `tests/quoted-sources.test.mjs` proves that by watching which
// files the checker opens, not by taking its silence as evidence.
//
// ARE FIGURES IN SCOPE? YES, AND SHA-PINNED ONES ARE NOT — deliberately, because both of the
// already-fixed sibling tickets were figures and the boundary would otherwise be set by
// accident. The distinction is not "figure vs string", it is **what the sentence claims**:
//
//   - "455 sites across 65 files" is a claim about HEAD. It rots on the next commit that
//     adds a test file, and nothing tells you. IN SCOPE.
//   - "330 tests in tests/reconcile-*.test.mjs on `0c76712`" is a measurement reported with
//     the commit it was taken at. It was true then and it is true now; it cannot rot. OUT OF
//     SCOPE — and registering it would be worse than leaving it alone, because the guard
//     would then demand that a true sentence change every time the tree moves.
//
// Pinning a measurement to a SHA is therefore the CHEAPER remedy and stays the first thing
// to reach for (ADR-0024's rule, which this repo already follows). This registry is for the
// quotes that cannot use it: live claims about what the product does right now. `SHA_PIN`
// below makes that boundary mechanical — a registered quote carrying a commit is refused.
//
// REFORMATTING DOES NOT DEFEAT IT. Both sides go through `normaliseQuote`, which collapses
// every run of whitespace — newlines included — and drops markdown emphasis and backticks.
// Re-wrapping a quote across lines, bolding it, or putting part of it in code ticks all
// still match. That failure has already happened once in this repo and only the revert rule
// caught it, so it is a property here rather than a hope.
//
// A QUOTE THAT LEFT THE DOC IS A FAILURE. The tempting shape is "if I find it, check it",
// which reports clean the moment the sentence is rewritten — precisely when it rotted. A
// registered quote that is no longer in its doc is `missing`, and `missing` is red.
//
//     node scripts/ci/quoted-sources.mjs     # report every entry's status
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MUTATIONS, MUTATION_TARGETS } from "./mutate-schedule.mjs";
import { scanCorpus } from "./temp-cleanup-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, "..", "..");

/** A quote carrying the commit it was measured at. Such a sentence is history, not a claim
 *  about HEAD, so it cannot rot and must not be registered. Matches the spellings this
 *  corpus actually uses: "at `0c76712`", "on `be4b110`", "(BLZ-505, `2535a6ae`)". */
export const SHA_PIN = /\b(?:at|on|against)\s+`?[0-9a-f]{7,40}`?\b|\(`?[0-9a-f]{7,40}`?\)/;

/** What each registered quote's source of truth reads RIGHT NOW.
 *
 *  A deriver returns the sentence fragment the doc is expected to contain, built from the
 *  code rather than copied from the doc — that is the whole mechanism. It runs in-process:
 *  nothing here shells out, so a registry entry cannot become a way to execute a string. */
export const DERIVERS = {
  /** BLZ-485's mutation runner: how many mutations, over which files. */
  "mutation-scope": () =>
    `${MUTATIONS.length} mutations to ${MUTATION_TARGETS.length === 2 ? "two" : String(MUTATION_TARGETS.length)}`
    + ` files — ${MUTATION_TARGETS.join(" and ")}`,

  /** BLZ-603's recorded cleanup debt, as the scanner counts it today. */
  "temp-cleanup-debt-size": () => {
    const counts = scanCorpus();
    const sites = Object.values(counts).reduce((a, b) => a + b, 0);
    return `${sites} sites across ${Object.keys(counts).length} files`;
  },
};

/** Every quote that has opted in.
 *
 *  Adding one is the only way anything becomes checked. `why` is required and is not
 *  decoration: an entry whose author could not say what breaks when the quote rots is an
 *  entry that should not be here. */
export const REGISTRY = [
  {
    id: "ci-doc-mutation-scope",
    doc: "docs/ci.md",
    quote: "17 mutations to two files — scripts/model/schedule.mjs and scripts/model/audit.mjs",
    deriver: "mutation-scope",
    why: "docs/ci.md exists partly to stop this runner being read as a whole-repo mutation "
      + "gate, which has produced false evidence more than once (BLZ-441). If the runner "
      + "gained a third target or dropped a mutation and this sentence did not move, the "
      + "page would be understating the scope of a gate people reason about.",
  },
  {
    id: "ci-doc-temp-cleanup-debt-size",
    doc: "docs/ci.md",
    quote: "455 sites across 65 files",
    deriver: "temp-cleanup-debt-size",
    why: "the number is the size of a ratchet the whole corpus is held to, quoted as a "
      + "current fact rather than pinned to a commit. It moves whenever a test file is "
      + "added or cleaned up, which is often, and a reader comparing it against "
      + "`temp-cleanup-guard.mjs`'s output would conclude the debt file is out of date.",
  },
];

/** Whitespace, emphasis and code ticks removed, so the check survives reformatting.
 *
 *  Both the registered quote and the doc go through this before they are compared, which is
 *  what makes re-wrapping a quote across lines a non-event. Nothing else is forgiven: a
 *  changed WORD still fails, or the check would be unfalsifiable. */
export function normaliseQuote(text) {
  return text.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** One entry's verdict: `{ id, status, quote, derived, problem }`.
 *
 *  `status` is one of:
 *    - `ok`         — the deriver's value is the registered quote, and the doc contains it;
 *    - `stale`      — the source of truth has moved on from the registered quote;
 *    - `missing`    — the doc no longer contains the quote, however it is now worded;
 *    - `unreadable` — the registry names a doc that is not there.
 *
 *  `derivers` and `readFile` are injectable so the mechanism can be exercised over a
 *  throwaway tree instead of only over today's docs. */
export function checkEntry(entry, { repo = REPO, derivers = DERIVERS, readFile = null, onRead = null } = {}) {
  const out = { id: entry.id, doc: entry.doc, quote: entry.quote, derived: null, status: "ok", problem: "" };

  const derive = derivers[entry.deriver];
  if (typeof derive !== "function") {
    return { ...out, status: "stale", problem: `no deriver named ${JSON.stringify(entry.deriver)}` };
  }
  out.derived = derive();
  if (normaliseQuote(out.derived) !== normaliseQuote(entry.quote)) {
    return {
      ...out,
      status: "stale",
      problem: `${entry.id}: the source now reads ${JSON.stringify(out.derived)}, but the `
        + `registry (and ${entry.doc}) still say ${JSON.stringify(entry.quote)}. Update both `
        + "in the same change — the registry exists so this is one edit, not a discovery.",
    };
  }

  let text;
  try {
    if (onRead) onRead(entry.doc);
    text = readFile ? readFile(entry.doc) : readFileSync(join(repo, entry.doc), "utf8");
  } catch (e) {
    return { ...out, status: "unreadable", problem: `${entry.id}: cannot read ${entry.doc} — ${e.message}` };
  }

  if (!normaliseQuote(text).includes(normaliseQuote(entry.quote))) {
    return {
      ...out,
      status: "missing",
      problem: `${entry.id}: ${entry.doc} no longer contains the registered quote `
        + `${JSON.stringify(entry.quote)}. Reformatting does not cause this — whitespace, `
        + "emphasis and backticks are all forgiven — so the sentence was rewritten or moved. "
        + "Re-register it at its new wording, or drop the entry if the claim is gone.",
    };
  }
  return out;
}

/** Every entry's verdict, in registry order. Opens the registry's docs and no others. */
export function checkRegistry(registry = REGISTRY, opts = {}) {
  return registry.map((e) => checkEntry(e, opts));
}

// --- CLI ----------------------------------------------------------------------
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = checkRegistry();
  for (const r of results) {
    console.log(`${r.status === "ok" ? "  ok " : "FAIL"}  ${r.id}  (${r.doc})`);
    if (r.status !== "ok") console.log(`        ${r.problem}`);
  }
  const bad = results.filter((r) => r.status !== "ok").length;
  console.log(`\n${results.length} registered quote(s), ${bad} rotted.`);
  if (bad) process.exitCode = 1;
}
