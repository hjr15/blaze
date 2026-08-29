// tests/reconcile-title-claim-oracle.test.mjs — BLZ-440.
//
// The product assertion: "a ticket MENTION in a PR title is not a delivery claim."
//
// INF-735 added `claimCorroborated` because a ref name is a naming convention, not
// evidence: `idFromRef` is an unanchored `\bKEY-(\d+)` run over every branch and PR
// head ref, so a repo's own docs branch claims tickets it never touched. The second
// signal it accepted was `new RegExp("\\b" + id + "\\b", "i").test(title)` — a bare
// MENTION anywhere in the title. `\bBLZ-408\b` matches inside `BLZ-408..439` (the `.`
// is a non-word character, so the right-hand boundary holds), so a PR named for a
// RANGE corroborates its own first element and drives an unworked ticket to `done`.
//
// This oracle:
//
//   1. GENERATES a cross-product of {title shape} x {branch-name shape} x {PR state}
//      x {shipped-commit signal} and asserts its own size, so deleting a dimension
//      fails the file rather than silently shrinking the evidence;
//   2. takes ground truth from the FIXTURE SPEC each case was generated from — every
//      title shape carries a hand-declared `claims` boolean saying whether the house
//      convention treats it as a delivery claim — never from `claimCorroborated`'s
//      own return, and never from `idsFromSubject` either;
//   3. checks BOTH the predicate (`claimCorroborated`) and the seam that consumes it
//      (`buildPrMap`), because a gate that is correct and unwired changes nothing;
//   4. carries PR #140's exact live strings as a named regression fixture.
//
// ROUND 2 CORRECTED THE RULE THIS FILE ENFORCES. Round 1 asserted that an uncorroborated
// claim is DROPPED, and adversarial review refuted it: `decide` reads the TOP-RANKED PR
// and `PR_RANK` puts OPEN above MERGED, so dropping a candidate is a SUBSTITUTION, not a
// subtraction — the next-ranked PR is promoted. Dropping an uncorroborated OPEN PR
// deleted BLZ-130's veto and took an `in-review` ticket to `done` with `resolution: done`
// and a WRITE-ONCE `pr:` record naming the wrong PR. The rule is now:
//
//     AN UNCORROBORATED CLAIM MAY ONLY EVER HOLD A TICKET BACK. IT MAY NEVER ADVANCE ONE.
//
// It stays in the ranking pool (keeping whatever veto its STATE earns) and can supply
// neither a delivery RECORD nor a forward TARGET.
//
// The defect survived round 1 because every generated case called `buildPrMap` with a
// ONE-ELEMENT array, and the extra guard asserted `map.size === 0` for each weak PR
// SINGLY. A subtraction test can never see a substitution. Hence the POOL MATRIX below:
// every uncorroborated PR state x every corroborated PR state, both orderings, with the
// winner AND the resulting target AND the record asserted from a hand-declared table.
//
// BLZ-458 widened it twice more, because "every state x every state" was about STATES
// only. The uncorroborated PR always carried the LOWER number (140 against 200) — the
// easy direction, since the number tiebreak is the LAST tier the comparator runs — and
// no pool ever held more than two PRs, so the fold in `buildPrMap` was only ever asked
// one question. Both gaps are now dimensions: the subject's number runs 140 AND 300, and
// a hand-declared eight-row table builds pools of THREE (two uncorroborated, one
// corroborated) over all six orderings.
//
// The POSITIVE CONTROL is load-bearing: shapes 1-5 are genuine `KEY-n: desc` claims
// and MUST still corroborate. A "fix" that fails them has broken every legitimate
// reconcile on the board, which is a far worse defect than the one being fixed.
//
// Non-vacuity is proven by hand, outside this file, by re-introducing the defect on a
// committed tree and confirming THIS named test goes red for the reason its name
// claims — the commands and the failing output are in the PR body.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { claimCorroborated, buildPrMap, decide, betterPr, prTitleClaim, PR_RANK, reconcile,
         idsFromSubject, idsFromCommitMessage } from "../scripts/reconcile.mjs";

const KEY = "ORC";
const N = 408;
const ID = `${KEY}-${N}`;

// The same unanchored derivation `config.mjs` builds — reproduced here rather than
// imported so this file does not need a loaded config. It is NOT the function under
// test; it is the input that makes a claim need corroborating in the first place.
const idFromRef = (ref) => {
  const m = new RegExp("\\b" + KEY + "-(\\d+)", "i").exec(ref || "");
  return m ? `${KEY}-${m[1]}` : null;
};

// =============================================================================
// THE FIXTURE SPEC — this table IS the ground truth.
//
// `claims` is declared by hand from the house convention as `idsFromSubject`'s own
// comment states it: a subject claims a ticket only when it OPENS with `KEY-n`
// followed by `:` (with the `+` `,` `&` `/` list forms), and "a downstream mention is
// never a claim — `BLZ-1: fixes BLZ-4` still yields only BLZ-1."
//
// `mentions` records whether the DEFECTIVE `\bID\b` test would have matched. It is not
// used to derive any expectation; it exists so the file can assert that the fixture
// set actually contains discriminating cases (shapes where the two rules DISAGREE),
// which is what stops this oracle from passing for the wrong reason.
// =============================================================================
const TITLE_SHAPES = [
  { name: "genuine-claim",        title: `${ID}: close the retirement epic`,                claims: true,  mentions: true },
  { name: "genuine-lowercase",    title: `${ID.toLowerCase()}: deploy-path observability`,  claims: true,  mentions: true },
  { name: "list-plus",            title: `${ID} + ${KEY}-999: two tickets, one PR`,         claims: true,  mentions: true },
  { name: "list-slash",           title: `${ID}/998/999: three tickets, one PR`,            claims: true,  mentions: true },
  { name: "list-comma-second",    title: `${KEY}-997, ${ID}: two tickets, one PR`,          claims: true,  mentions: true },
  // --- the live defect: a RANGE corroborating its own first element ---
  { name: "range-downstream",     title: `docs: successor kickoff for the ${ID}..439 lane`, claims: false, mentions: true },
  { name: "range-leading",        title: `${ID}..439: the follow-up lane`,                  claims: false, mentions: true },
  // --- downstream mentions: named work ABOUT the ticket, not delivery OF it ---
  { name: "mention-fixes",        title: `${KEY}-1: fixes ${ID}`,                           claims: false, mentions: true },
  { name: "mention-supersedes",   title: `${KEY}-2: supersedes ${ID}`,                      claims: false, mentions: true },
  { name: "mention-follow-up",    title: `docs: follow-up to ${ID}`,                        claims: false, mentions: true },
  { name: "mention-parenthetical", title: `docs: kickoff brief for the closeout (${ID})`,   claims: false, mentions: true },
  { name: "bare-mention-no-colon", title: `docs successor kickoff ${ID} follow-up lane`,    claims: false, mentions: true },
  // --- BLZ-455, DECIDED (operator, 2026-08-28), recorded in ADR-0026: an em-dash
  //     IMMEDIATELY after the id is an unambiguous SEPARATOR, exactly like the colon.
  //     It covers the 10 real `INF-nnn — desc` deliveries in `docs-central`. This row is
  //     the whole of the widening: nothing else moved from `claims: false` to `true`.
  { name: "em-dash-separator",    title: `${ID} — close the retirement epic`,               claims: true,  mentions: true },
  { name: "em-dash-unspaced",     title: `${ID}— close the retirement epic`,                claims: true,  mentions: true },
  // --- BLZ-469: the multi-ticket MANIFEST form. The subject claims the id it names and
  //     nothing else; the squash body's `* KEY-n:` bullets claim the rest (see
  //     `idsFromCommitMessage`). `15` is a COUNT, not an id — asserted below.
  { name: "bundle-n-more",        title: `${ID} + 15 more: the oracles are non-vacuous`,    claims: true,  mentions: true },
  // --- BLZ-455's REJECTED half, and it is the load-bearing half. Every one of these is
  //     a real merged-PR shape on the live board; admitting any of them readmits BLZ-440.
  //     `${ID} to ${KEY}-439: …` is `INF-889 to INF-892: corpus landing`, a RANGE.
  { name: "words-before-colon",   title: `${ID} to ${KEY}-439: corpus landing`,             claims: false, mentions: true },
  { name: "words-before-colon-2", title: `${ID} backfill + ${KEY}-411: the pair`,           claims: false, mentions: true },
  { name: "parenthetical-bundle", title: `${ID} (bundle 3/3): the last third`,              claims: false, mentions: true },
  { name: "en-dash-rejected",     title: `${ID} – close the retirement epic`,               claims: false, mentions: true },
  { name: "hyphen-rejected",      title: `${ID} - close the retirement epic`,               claims: false, mentions: true },
  { name: "conventional-scope",   title: `feat(${ID}): the conventional-commits scope`,     claims: false, mentions: true },
  { name: "bracketed",            title: `[${ID}] the bracketed form`,                      claims: false, mentions: true },
  { name: "revert-quoted",        title: `Revert "${ID}: close the retirement epic"`,       claims: false, mentions: true },
  { name: "wip-prefixed",         title: `WIP: ${ID}: close the retirement epic`,           claims: false, mentions: true },
  { name: "bundle-n-others",      title: `${ID} + 15 others: not the admitted form`,        claims: false, mentions: true },
  // --- no claim on THIS id at all ---
  { name: "prefix-superset",      title: `${ID}1: unrelated work on a longer id`,           claims: false, mentions: false },
  { name: "other-ids-only",       title: `docs: kickoff brief (${KEY}-19, ${KEY}-20)`,      claims: false, mentions: false },
  { name: "no-mention",           title: "chore: tidy the workspace",                       claims: false, mentions: false },
];

// `yieldsId` is declared by hand: does the unanchored `idFromRef` pick THIS id out of
// this ref? It is what makes the claim exist and therefore need corroborating.
const BRANCH_SHAPES = [
  { name: "house",     ref: `${ID.toLowerCase()}-close-the-epic`,                       yieldsId: true },
  { name: "range",     ref: `docs-successor-kickoff-${ID.toLowerCase()}-439`,           yieldsId: true },
  { name: "prefixed",  ref: `feature/${ID.toLowerCase()}-work`,                         yieldsId: true },
  { name: "no-id",     ref: "chore/tidy-the-workspace",                                 yieldsId: false },
];

const PR_STATES = ["OPEN", "MERGED", "CLOSED"];

// Declared here so every expectation below is derived from the SPEC, and pinned against
// the module's constant by an assertion rather than imported for the derivation. A twin
// that silently drifts is worse than no twin; a twin that fails loudly is a pin.
const RANK_SPEC = { OPEN: 3, MERGED: 2, CLOSED: 1 };
// The status each PR state means, when a CORROBORATED PR is the winner. Also declared,
// not read from `decide`.
const TARGET_FOR_STATE = { OPEN: "in-review", MERGED: "done", CLOSED: "in-progress" };

// AC-4: the shippedSet arm is built from the strict `idsFromCommitMessage` and is NOT
// being changed. It is a dimension here so that this file would go red if the fix
// disturbed it — and so the "non-conventional title, real shipped commit" case that
// INF-735 deliberately allows keeps a home.
const SHIPPED = [false, true];

const EXPECTED_CASES = TITLE_SHAPES.length * BRANCH_SHAPES.length * PR_STATES.length * SHIPPED.length;

function buildCases() {
  const cases = [];
  for (const t of TITLE_SHAPES) {
    for (const b of BRANCH_SHAPES) {
      for (const state of PR_STATES) {
        for (const shipped of SHIPPED) {
          cases.push({
            name: `${t.name} | ${b.name} | ${state} | shipped=${shipped}`,
            titleSpec: t, branchSpec: b, state, shipped,
            pr: { number: 140, state, url: "https://example.invalid/pull/140", headRefName: b.ref, title: t.title },
            shippedSet: shipped ? new Set([ID]) : new Set(),
            // GROUND TRUTH, from the spec above and nothing else:
            //   corroborated <- a real shipped commit, or a title that CLAIMS the id
            //   inPool       <- the ref must yield the id; corroboration does NOT gate
            //                   pool membership (BLZ-440 round 2 — see the header)
            expectCorroborated: shipped || t.claims,
            expectInPool: b.yieldsId,
          });
        }
      }
    }
  }
  return cases;
}

describe("BLZ-440 oracle: a ticket mention in a PR title is not a delivery claim", () => {
  const cases = buildCases();

  test("the cross-product is the size the dimensions declare", () => {
    assert.equal(TITLE_SHAPES.length, 28, "title shapes");
    assert.equal(BRANCH_SHAPES.length, 4, "branch shapes");
    assert.equal(PR_STATES.length, 3, "PR states");
    assert.equal(SHIPPED.length, 2, "shipped-commit signal");
    assert.equal(EXPECTED_CASES, 672);
    assert.equal(cases.length, EXPECTED_CASES, "every dimension must reach every case");
    assert.equal(new Set(cases.map((c) => c.name)).size, EXPECTED_CASES, "case names must be distinct");
    // BLZ-440 round 2 added a POOL dimension on top of the single-PR product; BLZ-458
    // added the uncorroborated PR's NUMBER and a pool of three. Every half is pinned, so
    // deleting one fails this test rather than shrinking the evidence quietly. The
    // figures below are the products the loops below actually run, written as products
    // so a deleted dimension changes them.
    assert.equal(EXPECTED_CASES * 4, 2688, "single-PR clause budget");
    assert.equal((9 + 9) * 2 * 2 * 4, 288,
      "pool-matrix clause budget: (9 uncorroborated + 9 corroborated) pairings x 2 number " +
      "directions x 2 orderings x 4 clauses");
    assert.equal(8 * 6 * 4, 192,
      "three-PR clause budget: 8 pools x 6 orderings x 4 clauses");
    assert.equal(2 * 3 * 2 * 2, 24, "equal-rank clause budget: 2 numbers x 3 states x 2 orderings x 2 clauses");
  });

  test("the fixture set discriminates: mention-but-not-a-claim shapes exist, and so do genuine claims", () => {
    // Without this, a fix that made claimCorroborated always-false would pass every
    // negative clause below and the file would still be "green" in the wrong direction.
    const discriminating = TITLE_SHAPES.filter((t) => t.mentions && !t.claims);
    const positive = TITLE_SHAPES.filter((t) => t.claims);
    assert.equal(discriminating.length, 17, "titles where a bare mention disagrees with the house rule");
    assert.equal(positive.length, 8, "titles that genuinely claim the ticket (the positive control)");
    assert.ok(discriminating.some((t) => t.name === "range-downstream"), "PR #140's shape must be present");
  });

  // ===========================================================================
  // BLZ-453 / BLZ-455 — THE DECIDED BOUNDARY, ASSERTED AS A UNIT.
  //
  // BLZ-453's finding: mutating `idsFromSubject`'s lookahead from `(?=\s*:)` to
  // `(?=\s*[:—])` left ALL 22 BLZ-440 tests green, so the decision not to widen was
  // pinned by nothing. The operator has since DECIDED to widen it — to the em-dash and
  // to nothing else (ADR-0026) — which makes the pin MORE necessary, not less: the
  // widening now has an exact edge, and every neighbour of that edge stays rejected.
  //
  // These are unit assertions on `idsFromSubject` itself rather than on the generated
  // cross-product, because the boundary is a property of the PARSER and the cross-product
  // can only see it through `claimCorroborated`.
  // ===========================================================================
  test("BLZ-455: the separator set is exactly `:` and `—`, and the neighbours stay rejected", () => {
    // ACCEPTED — the two decided separators, spaced and unspaced.
    assert.deepEqual(idsFromSubject(`${ID}: desc`, KEY), [ID], "colon");
    assert.deepEqual(idsFromSubject(`${ID} — desc`, KEY), [ID], "em-dash, spaced");
    assert.deepEqual(idsFromSubject(`${ID}— desc`, KEY), [ID], "em-dash, unspaced");
    assert.deepEqual(idsFromSubject(`${ID} : desc`, KEY), [ID], "colon, spaced");
    // REJECTED — every near neighbour of the em-dash, one code point at a time.
    for (const [what, sep] of [["en-dash", "–"], ["hyphen", "-"], ["minus", "−"],
                               ["horizontal-bar", "―"], ["double-hyphen", "--"],
                               ["semicolon", ";"], ["pipe", "|"]]) {
      assert.deepEqual(idsFromSubject(`${ID} ${sep} desc`, KEY), [],
        `${what} (${sep}) must NOT terminate the leading id list`);
    }
    // REJECTED — the shapes BLZ-455 names by hand. Words between the id and the colon
    // are the LOAD-BEARING half: `INF-889 to INF-892: corpus landing` is a real merged
    // PR title, and admitting it would make it claim INF-889 — a RANGE, which is
    // BLZ-440's defect readmitted through the front door.
    for (const bad of [`${ID} to ${KEY}-439: corpus landing`,
                       `${ID} backfill + ${KEY}-411: the pair`,
                       `${ID} (bundle 3/3): the last third`,
                       `${ID} follow-up: more of it`,
                       `feat(${ID}): scoped`, `[${ID}] bracketed`, `${ID} desc`,
                       `Revert "${ID}: desc"`, `WIP: ${ID}: desc`,
                       `${ID} and ${KEY}-409: joined by a word`]) {
      assert.deepEqual(idsFromSubject(bad, KEY), [], JSON.stringify(bad));
    }
    // The em-dash TERMINATES the list; it is not a list SEPARATOR. `KEY-1 — KEY-2: x`
    // claims the first id only, exactly as `KEY-1: fixes KEY-2` does.
    assert.deepEqual(idsFromSubject(`${ID} — ${KEY}-999: two ids`, KEY), [ID],
      "an em-dash ends the list — it does not continue it");
    // ...and a downstream em-dash is still no claim at all.
    assert.deepEqual(idsFromSubject(`docs — ${ID} mentioned`, KEY), []);
  });

  test("BLZ-469: `KEY-n + N more:` claims the id it names and NEVER the count", () => {
    // The count is a NUMBER sitting exactly where a bare list element sits after `/`.
    // Reading it as one would claim a ticket that does not exist — the same defect the
    // bare-number rule already refused for `BLZ-1 + 2026: annual review`.
    assert.deepEqual(idsFromSubject(`${ID} + 15 more: the oracles are non-vacuous`, KEY), [ID]);
    assert.deepEqual(idsFromSubject(`${ID} + 1 more: a pair`, KEY), [ID]);
    assert.deepEqual(idsFromSubject(`${ID} + 15 more — the em-dash form`, KEY), [ID]);
    // The explicit list form is unchanged and still claims every id it spells.
    assert.deepEqual(idsFromSubject(`${ID} + ${KEY}-999 + 2 more: a list and a tail`, KEY),
      [ID, `${KEY}-999`]);
    // NOT the admitted form — a bundle marker Blaze does not know claims nothing at all,
    // rather than silently claiming its leading id.
    for (const bad of [`${ID} + 15 others: no`, `${ID} + more: no`, `${ID} + 15: no`,
                       `${ID} + fifteen more: no`, `${ID} +15more: no`]) {
      assert.deepEqual(idsFromSubject(bad, KEY), [], JSON.stringify(bad));
    }
    // AND THE RANGE STILL CLAIMS NOTHING — BLZ-469's own acceptance criterion.
    assert.deepEqual(idsFromSubject(`${ID}..439: the follow-up lane`, KEY), []);
    assert.deepEqual(idsFromSubject(`${ID}..439 + 15 more: a range wearing a manifest`, KEY), []);
    assert.deepEqual(idsFromSubject(`${ID}-439: a hyphen range`, KEY), []);
  });

  test("every case's corroboration verdict matches the fixture spec", () => {
    let clauses = 0;
    const failures = [];
    for (const c of cases) {
      const got = claimCorroborated(ID, { title: c.pr.title, shippedSet: c.shippedSet });
      clauses += 1;
      if (got !== c.expectCorroborated) {
        failures.push(`${c.name}: claimCorroborated -> ${got}, spec says ${c.expectCorroborated} (title: ${JSON.stringify(c.pr.title)})`);
      }
    }
    assert.equal(clauses, EXPECTED_CASES, "one corroboration clause per case");
    assert.deepEqual(failures, [], `${failures.length}/${EXPECTED_CASES} cases disagree with the fixture spec:\n` + failures.join("\n"));
  });

  test("every case's PR-map outcome matches the fixture spec, and an uncorroborated claim only holds back", () => {
    // The rank table this file's expectations are derived from must be the one the
    // module actually uses. Pinned, not imported into the derivation.
    assert.deepEqual(RANK_SPEC, PR_RANK, "PR_RANK changed — every expectation below is stale");
    let clauses = 0;
    const failures = [];
    for (const c of cases) {
      const map = buildPrMap([c.pr], idFromRef, c.shippedSet);
      const won = map.get(ID);
      // (a) POOL MEMBERSHIP is decided by the ref alone. An uncorroborated claim is
      //     NEUTERED, NOT DROPPED — dropping it is a substitution that promotes the
      //     next-ranked PR (BLZ-440 round 2).
      clauses += 1;
      if (map.has(ID) !== c.expectInPool) {
        failures.push(`${c.name}: buildPrMap.has(${ID}) -> ${map.has(ID)}, spec says ${c.expectInPool}`);
      }
      // (b) the pooled claim is TAGGED with the spec's corroboration verdict.
      clauses += 1;
      if (c.expectInPool && Boolean(won?.uncorroborated) !== !c.expectCorroborated) {
        failures.push(`${c.name}: uncorroborated tag -> ${Boolean(won?.uncorroborated)}, spec says ${!c.expectCorroborated}`);
      }
      // (c) THE RULE: an uncorroborated claim may only ever hold a ticket BACK. No
      //     record, no forward target, no resolution — from a `defined` ticket, which
      //     is where PR #140 found BLZ-408.
      clauses += 1;
      if (c.expectInPool && !c.expectCorroborated) {
        const d = decide({ pr: won }, "defined", "epic");
        if (d.target !== "defined" || d.moved !== false || d.prVal !== null ||
            d.branchVal !== null || d.resolution !== undefined) {
          failures.push(`${c.name}: uncorroborated claim ADVANCED the ticket — ` +
            `target=${d.target} moved=${d.moved} prVal=${d.prVal} resolution=${d.resolution}`);
        }
      }
      // (d) a CORROBORATED claim still delivers: the right status and the real record.
      clauses += 1;
      if (c.expectInPool && c.expectCorroborated) {
        const d = decide({ pr: won }, "defined", "epic");
        if (won?.number !== 140) {
          failures.push(`${c.name}: corroborated claim lost its PR — ${JSON.stringify(won)}`);
        } else if (d.target !== TARGET_FOR_STATE[c.state] || d.prVal !== `#140 — ${c.pr.url}`) {
          failures.push(`${c.name}: corroborated claim did not deliver — ` +
            `target=${d.target} (spec ${TARGET_FOR_STATE[c.state]}) prVal=${d.prVal}`);
        }
      }
    }
    assert.equal(clauses, EXPECTED_CASES * 4, "four clauses per case");
    assert.deepEqual(failures, [], `${failures.length} clause failures:\n` + failures.join("\n"));
  });

  // ===========================================================================
  // MULTI-PR POOLS — the dimension whose absence let the substitution defect through.
  //
  // Round 1 called `buildPrMap` with a ONE-ELEMENT array in every generated case and
  // asserted `map.size === 0` for each uncorroborated PR SINGLY. A subtraction test can
  // never see a SUBSTITUTION: dropping an uncorroborated OPEN PR promotes the next
  // MERGED one, and with only one PR in the pool there is nothing to promote.
  //
  // Every expectation below is HAND-DECLARED from the documented comparator order
  // (RANK, then CORROBORATED, then CLAIM, then RECORDABLE, then LOWER NUMBER) and the
  // rule that an uncorroborated winner moves nothing. None is computed by calling
  // `betterPr`, `buildPrMap` or `decide`.
  // ===========================================================================
  const CURRENT = "in-review";
  // BLZ-458. THE UNCORROBORATED PR'S NUMBER IS NOW A DIMENSION. Round 2's matrix always
  // gave it 140 against the companion's 200 — the LOWER number, and therefore the easy
  // direction: the comparator's number tiebreak is the last tier that runs, so a defect
  // that lets an uncorroborated PR through only when it carries the HIGHER number was
  // invisible to every pool case. Measured: with `betterPr`'s corroboration tier skipped
  // whenever the uncorroborated candidate is the higher-numbered CLOSED one, the whole
  // reconcile suite — 318 tests, this file's 18 included — stayed green.
  const COMPANION_NUMBER = 200;
  const SUBJECT_NUMBERS = [140, 300];   // one below the companion, one above it
  const pr = (number, state, suffix, title) => ({
    number, state, url: `u${number}`, headRefName: `${ID.toLowerCase()}-${suffix}`, title,
  });
  const uncorroboratedSubject = (state, number = 140) =>
    // a RANGE: mention, not claim
    pr(number, state, "a", `docs: successor kickoff for the ${ID}..439 lane`);
  const corroboratedSubject = (state, number = 140) =>
    pr(number, state, "a", `${ID}: the subject's own work`);
  const companion = (state, number = COMPANION_NUMBER) =>
    pr(number, state, "b", `${ID}: the real work`);          // always corroborated
  /** The record a winning PR writes, formatted the way `decide` formats one. */
  const recordOf = (p) => `#${p.number} — u${p.number}`;

  // subjectState | companionState | winner | target | does the winner write its record?
  //
  // The winner is named "subject"/"companion" rather than by number, because it is the
  // SAME in both number directions: at equal rank the corroboration tier decides, and it
  // sits above the number tiebreak; at unequal rank the rank decides. That invariance is
  // itself the claim BLZ-458 adds, and it is asserted by running the table twice.
  const UNCORROBORATED_POOL = [
    ["OPEN",   "OPEN",   "companion", "in-review",   true],
    ["OPEN",   "MERGED", "subject",   "in-review",   false], // THE REVIEW'S FINDING: veto held
    ["OPEN",   "CLOSED", "subject",   "in-review",   false],
    ["MERGED", "OPEN",   "companion", "in-review",   true],
    ["MERGED", "MERGED", "companion", "done",        true],
    ["MERGED", "CLOSED", "subject",   "in-review",   false],
    ["CLOSED", "OPEN",   "companion", "in-review",   true],
    ["CLOSED", "MERGED", "companion", "done",        true],
    ["CLOSED", "CLOSED", "companion", "in-progress", true],
  ];

  // Both corroborated: the comparator's ordinary behaviour, unchanged by BLZ-440.
  // Ties at equal rank fall to the LOWER number, so THIS table is the one the number
  // direction moves — three of its nine rows change winner when the subject is 300.
  // Hand-declared per direction; nothing here is computed by calling the comparator.
  const CORROBORATED_POOL_SUBJECT_LOWER = [
    ["OPEN",   "OPEN",   "subject",   "in-review"],
    ["OPEN",   "MERGED", "subject",   "in-review"],
    ["OPEN",   "CLOSED", "subject",   "in-review"],
    ["MERGED", "OPEN",   "companion", "in-review"],
    ["MERGED", "MERGED", "subject",   "done"],
    ["MERGED", "CLOSED", "subject",   "done"],
    ["CLOSED", "OPEN",   "companion", "in-review"],
    ["CLOSED", "MERGED", "companion", "done"],
    ["CLOSED", "CLOSED", "subject",   "in-progress"],
  ];
  const CORROBORATED_POOL_SUBJECT_HIGHER = [
    ["OPEN",   "OPEN",   "companion", "in-review"],   // tie -> the LOWER number, now 200
    ["OPEN",   "MERGED", "subject",   "in-review"],   // rank decides, number irrelevant
    ["OPEN",   "CLOSED", "subject",   "in-review"],
    ["MERGED", "OPEN",   "companion", "in-review"],
    ["MERGED", "MERGED", "companion", "done"],        // tie -> 200
    ["MERGED", "CLOSED", "subject",   "done"],
    ["CLOSED", "OPEN",   "companion", "in-review"],
    ["CLOSED", "MERGED", "companion", "done"],
    ["CLOSED", "CLOSED", "companion", "in-progress"], // tie -> 200
  ];

  test("the pool matrix covers every uncorroborated state x every corroborated state, in both number directions", () => {
    assert.equal(UNCORROBORATED_POOL.length, 9, "3 subject states x 3 companion states");
    assert.equal(CORROBORATED_POOL_SUBJECT_LOWER.length, 9);
    assert.equal(CORROBORATED_POOL_SUBJECT_HIGHER.length, 9);
    // BLZ-458: the number dimension is declared, and it really is a dimension — one
    // subject number below the companion's and one above it.
    assert.equal(SUBJECT_NUMBERS.length, 2, "the uncorroborated PR's number is a dimension");
    assert.ok(SUBJECT_NUMBERS.some((n) => n < COMPANION_NUMBER)
      && SUBJECT_NUMBERS.some((n) => n > COMPANION_NUMBER),
      "both number directions must be exercised, or the tiebreak's easy side is the only side");
    for (const table of [UNCORROBORATED_POOL, CORROBORATED_POOL_SUBJECT_LOWER,
                         CORROBORATED_POOL_SUBJECT_HIGHER]) {
      assert.equal(new Set(table.map(([a, b]) => `${a}|${b}`)).size, 9, "no duplicate pairing");
      for (const [a, b] of table) {
        assert.ok(PR_STATES.includes(a) && PR_STATES.includes(b), `${a}|${b}`);
      }
    }
    // The two corroborated tables must genuinely DISAGREE, or the added direction is
    // decorative: exactly the three equal-rank rows change winner.
    const flipped = CORROBORATED_POOL_SUBJECT_LOWER
      .filter((row, i) => row[2] !== CORROBORATED_POOL_SUBJECT_HIGHER[i][2]);
    assert.equal(flipped.length, 3,
      "the number tiebreak must change the winner on exactly the three equal-rank rows, " +
      `it changes ${flipped.length}`);
  });

  test("an uncorroborated claim in a POOL holds the ticket back and never advances it", () => {
    // Two orderings each, because `gh` decides which PR it lists first and a comparator
    // that is not a strict weak ordering makes the winner depend on that. And BLZ-458:
    // two NUMBER directions each, because the tiebreak is the last tier that runs.
    let clauses = 0;
    for (const subjectNumber of SUBJECT_NUMBERS) {
      for (const [sState, cState, wantWinner, wantTarget, wantRecord] of UNCORROBORATED_POOL) {
        const subject = uncorroboratedSubject(sState, subjectNumber);
        const comp = companion(cState);
        const winner = wantWinner === "subject" ? subject : comp;
        for (const pool of [[subject, comp], [comp, subject]]) {
          const won = buildPrMap(pool, idFromRef, new Set()).get(ID);
          const label = `uncorroborated ${sState} (#${subjectNumber}) + corroborated ${cState}`;
          assert.equal(won?.number, winner.number, `${label}: winner`);
          const d = decide({ pr: won }, CURRENT, "epic");
          assert.equal(d.target, wantTarget, `${label}: target`);
          assert.equal(d.prVal, wantRecord ? recordOf(winner) : null, `${label}: record`);
          // The write-once trap: a terminal target takes a resolution with it.
          assert.equal(d.resolution, wantTarget === "done" ? "done" : undefined, `${label}: resolution`);
          clauses += 4;
        }
      }
    }
    assert.equal(clauses, SUBJECT_NUMBERS.length * 9 * 2 * 4);
  });

  test("an uncorroborated MERGED PR never promotes itself past a corroborated OPEN one", () => {
    // Stated on its own because it is the exact live shape: PR #140 is MERGED and the
    // ticket's real work is elsewhere. If the merged uncorroborated PR ever wins here,
    // the ticket goes terminal with a write-once record naming the wrong PR.
    const won = buildPrMap([uncorroboratedSubject("MERGED"), companion("OPEN")], idFromRef, new Set()).get(ID);
    assert.equal(won.number, 200);
    assert.equal(decide({ pr: won }, "defined", "epic").target, "in-review");
  });

  test("POOL CONTROL: two corroborated PRs rank exactly as they always did, in both number directions", () => {
    let clauses = 0;
    for (const [subjectNumber, table] of [[140, CORROBORATED_POOL_SUBJECT_LOWER],
                                          [300, CORROBORATED_POOL_SUBJECT_HIGHER]]) {
      for (const [sState, cState, wantWinner, wantTarget] of table) {
        const subject = corroboratedSubject(sState, subjectNumber);
        const comp = companion(cState);
        const winner = wantWinner === "subject" ? subject : comp;
        for (const pool of [[subject, comp], [comp, subject]]) {
          const won = buildPrMap(pool, idFromRef, new Set()).get(ID);
          const label = `corroborated ${sState} (#${subjectNumber}) + corroborated ${cState}`;
          assert.equal(won?.number, winner.number, `${label}: winner`);
          assert.equal(Boolean(won.uncorroborated), false, `${label}: neither is uncorroborated`);
          const d = decide({ pr: won }, CURRENT, "epic");
          assert.equal(d.target, wantTarget, `${label}: target`);
          assert.equal(d.prVal, recordOf(winner), `${label}: record`);
          clauses += 4;
        }
      }
    }
    assert.equal(clauses, SUBJECT_NUMBERS.length * 9 * 2 * 4);
  });

  test("at EQUAL rank a corroborated PR always beats an uncorroborated one — whichever number it carries", () => {
    // BLZ-458: run in both number directions. With the uncorroborated PR always at the
    // LOWER number, the corroboration tier and the number tiebreak agree on the answer,
    // so this test could not tell which of the two produced it.
    let clauses = 0;
    for (const subjectNumber of SUBJECT_NUMBERS) {
      for (const state of PR_STATES) {
        for (const pool of [[uncorroboratedSubject(state, subjectNumber), companion(state)],
                            [companion(state), uncorroboratedSubject(state, subjectNumber)]]) {
          const won = buildPrMap(pool, idFromRef, new Set()).get(ID);
          assert.equal(won.number, COMPANION_NUMBER,
            `${state}: corroborated #${COMPANION_NUMBER} must beat uncorroborated #${subjectNumber}`);
          assert.equal(Boolean(won.uncorroborated), false, `${state} #${subjectNumber}`);
          clauses += 2;
        }
      }
    }
    assert.equal(clauses, SUBJECT_NUMBERS.length * 3 * 2 * 2);
  });

  // ===========================================================================
  // BLZ-458 — POOLS OF THREE. Every pool above holds exactly TWO PRs, so the fold in
  // `buildPrMap` (`for (const pr of candidates) if (betterPr(pr, best, id)) best = pr`)
  // was only ever asked one question. A comparator that is not a strict weak ordering
  // shows itself on the THIRD element, and a veto that survives one rival but not two is
  // a different claim from the one the two-PR matrix makes.
  //
  // Every expectation is hand-declared from the documented comparator order (RANK, then
  // CORROBORATED, then CLAIM, then RECORDABLE, then LOWER NUMBER) and the rule that an
  // uncorroborated winner moves nothing. Nothing is computed by calling `betterPr`.
  // ===========================================================================
  // uncorroborated #140 | uncorroborated #300 | corroborated #200 | winner | target | record?
  const THREE_PR_POOL = [
    // all OPEN: equal rank throughout, so the corroborated one takes it.
    ["OPEN",   "OPEN",   "OPEN",   "corroborated", "in-review",   true],
    // the low-numbered uncorroborated OPEN outranks both MERGED rivals and vetoes.
    ["OPEN",   "MERGED", "MERGED", "uncorroboratedLow", "in-review", false],
    // the HIGH-numbered uncorroborated OPEN does the same — the veto is not a number.
    ["MERGED", "OPEN",   "MERGED", "uncorroboratedHigh", "in-review", false],
    // two uncorroborated MERGED rivals cannot out-rank a corroborated MERGED one.
    ["MERGED", "MERGED", "MERGED", "corroborated", "done",        true],
    // a corroborated OPEN outranks two uncorroborated MERGED PRs on RANK alone.
    ["MERGED", "MERGED", "OPEN",   "corroborated", "in-review",   true],
    // all CLOSED: equal rank, corroboration decides, and the record is still written.
    ["CLOSED", "CLOSED", "CLOSED", "corroborated", "in-progress", true],
    // the high-numbered uncorroborated MERGED outranks two CLOSED rivals and vetoes.
    ["CLOSED", "MERGED", "CLOSED", "uncorroboratedHigh", "in-review", false],
    // the low-numbered uncorroborated OPEN outranks a CLOSED pair and vetoes.
    ["OPEN",   "CLOSED", "CLOSED", "uncorroboratedLow", "in-review", false],
  ];

  /** Every ordering of a three-element pool — `gh` fixes none of them. */
  function permutations(xs) {
    if (xs.length <= 1) return [xs];
    return xs.flatMap((x, i) =>
      permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
  }

  test("a POOL OF THREE mixing corroborated and uncorroborated claims ranks the same in every ordering", () => {
    let clauses = 0;
    assert.equal(THREE_PR_POOL.length, 8, "the three-PR table changed size");
    assert.equal(permutations([1, 2, 3]).length, 6, "a three-element pool has six orderings");
    for (const [lowState, highState, corrState, wantWinner, wantTarget, wantRecord] of THREE_PR_POOL) {
      const low = uncorroboratedSubject(lowState, 140);
      const high = uncorroboratedSubject(highState, 300);
      const corr = companion(corrState);
      const winner = { uncorroboratedLow: low, uncorroboratedHigh: high, corroborated: corr }[wantWinner];
      assert.ok(winner, `unknown winner name ${wantWinner}`);
      for (const pool of permutations([low, high, corr])) {
        const label = `pool-of-3 [unc#140 ${lowState}, unc#300 ${highState}, corr#200 ${corrState}]` +
          ` order ${pool.map((p) => p.number).join(">")}`;
        const won = buildPrMap(pool, idFromRef, new Set()).get(ID);
        assert.equal(won?.number, winner.number, `${label}: winner`);
        assert.equal(Boolean(won.uncorroborated), wantWinner !== "corroborated",
          `${label}: the winner's corroboration flag`);
        const d = decide({ pr: won }, CURRENT, "epic");
        assert.equal(d.target, wantTarget, `${label}: target`);
        assert.equal(d.prVal, wantRecord ? recordOf(winner) : null, `${label}: record`);
        clauses += 4;
      }
    }
    assert.equal(clauses, THREE_PR_POOL.length * 6 * 4);
  });

  test("CROSS-REPO: a shipped-corroborated weak title beats an uncorroborated weak title at equal rank", () => {
    // THIS IS THE ONLY CASE THAT REACHES `betterPr`'s CORROBORATED TIER, and finding
    // that out took a mutation run: removing the tier left the test above GREEN.
    //
    // Within ONE repo the tier is unreachable, because corroboration and the claim tier
    // are the same question there — `claimCorroborated`'s title arm and `prTitleClaim`
    // both call `idsFromSubject`, so uncorroborated always implies claim 1 and
    // corroborated (absent a shipped signal) always implies claim 2, and the CLAIM tier
    // separates them first.
    //
    // ACROSS repos it is reachable, because `shippedSet` is computed PER REPO and
    // `gatherProject` compares the two repos' winners with `betterPr`. Repo A's own
    // `ORC-408:` commit corroborates a weak-titled PR there (claim 1, corroborated);
    // repo B has an uncorroborated weak-titled PR (claim 1) with a LOWER number. Equal
    // rank, equal claim, both recordable — so without the tier the tie-break falls to
    // LOWER NUMBER and the uncorroborated claim takes the selection, suppressing a
    // record that was sitting right there. That is the unnumberable-PR defect the
    // recordable tier exists for, re-entered on the corroboration axis.
    const weakCorroborated = { number: 200, state: "MERGED", url: "uA",
      headRefName: `${ID.toLowerCase()}-a`, title: `chore: tidy the runbook after ${ID}` };
    const weakUncorroborated = { number: 140, state: "MERGED", url: "uB",
      headRefName: `${ID.toLowerCase()}-b`, title: `docs: the ${ID}..439 lane` };

    const fromRepoA = buildPrMap([weakCorroborated], idFromRef, new Set([ID])).get(ID);
    const fromRepoB = buildPrMap([weakUncorroborated], idFromRef, new Set()).get(ID);

    // The premise: the claim tier genuinely CANNOT separate these two.
    assert.equal(prTitleClaim(fromRepoA, ID), 1, "repo A's title is weak");
    assert.equal(prTitleClaim(fromRepoB, ID), 1, "repo B's title is weak");
    assert.equal(Boolean(fromRepoA.uncorroborated), false, "repo A's own shipped commit corroborates it");
    assert.equal(fromRepoB.uncorroborated, true);
    assert.ok(fromRepoB.number < fromRepoA.number, "the uncorroborated one must have the LOWER number");

    // `gatherProject` merges repos with exactly this comparison.
    assert.equal(betterPr(fromRepoB, fromRepoA, ID), false,
      "an uncorroborated claim must not take the cross-repo selection from a corroborated one");
    assert.equal(betterPr(fromRepoA, fromRepoB, ID), true);

    // ...and the corroborated one still delivers its record.
    assert.equal(decide({ pr: fromRepoA }, "in-review", "epic").prVal, "#200 — uA");
  });

  test("POSITIVE CONTROL: a genuine KEY-n claim still corroborates in every branch/state/shipped combination", () => {
    // Stated separately from the loop above so that breaking legitimate reconcile
    // fails a test whose NAME says what broke, rather than one line inside a diff list.
    let clauses = 0;
    for (const c of cases.filter((x) => x.titleSpec.claims)) {
      assert.equal(claimCorroborated(ID, { title: c.pr.title, shippedSet: c.shippedSet }), true, c.name);
      clauses += 1;
      if (c.branchSpec.yieldsId) {
        assert.equal(buildPrMap([c.pr], idFromRef, c.shippedSet).get(ID)?.number, 140, c.name);
        clauses += 1;
      }
    }
    assert.equal(clauses, 8 * 4 * 3 * 2 + 8 * 3 * 3 * 2, "positive-control clause count");
  });

  test("a malformed id yields no key, and fails closed rather than fabricating one", () => {
    // NO CURRENT CALL PATH REACHES THIS. `idFromRef` always builds `${key}-${n}`, so a
    // dash is guaranteed today. It is here because the key is DERIVED from the id
    // (`id.slice(0, id.lastIndexOf("-"))`, the same derivation `prTitleClaim` uses) and
    // `lastIndexOf` returns -1 on a miss: `slice(0, -1)` would hand a plausible-looking
    // but wrong key straight into a RegExp constructor. Fail closed, and say so.
    for (const bad of ["", "NODASH", "-13", null, undefined]) {
      assert.equal(claimCorroborated(bad, { title: `${bad}: some work` }), false, String(bad));
    }
    // ...but a shipped signal still speaks, because that arm never needed a key.
    assert.equal(claimCorroborated("NODASH", { title: "x", shippedSet: new Set(["NODASH"]) }), true);
  });

  test("AC-4: the shippedSet arm is untouched — a strict shipped signal corroborates any title", () => {
    let clauses = 0;
    for (const c of cases.filter((x) => x.shipped)) {
      assert.equal(claimCorroborated(ID, { title: c.pr.title, shippedSet: c.shippedSet }), true, c.name);
      clauses += 1;
    }
    assert.equal(clauses, EXPECTED_CASES / 2, "half the cross-product carries a shipped signal");
    // ...and an unrelated shipped set does not.
    assert.equal(
      claimCorroborated(ID, { title: "docs: unrelated", shippedSet: new Set([`${KEY}-19`, `${KEY}-20`]) }),
      false,
    );
  });
});

// =============================================================================
// The live regression fixture: hjr15/blaze PR #140, verbatim.
//
// Ground truth comes from the board and the repo's git log, not from any function
// here: BLZ-408 sits in `projects/BLZ/defined/` on the live board and has never been
// worked, and #140's squash commit on the default branch (d2d8cd5) has the subject
// `docs: successor kickoff for the BLZ-408..439 follow-up lane (#140)`, which opens
// with `docs:` and therefore contributes NOTHING to the shippedSet. Corroboration for
// BLZ-408 came purely from the title mention.
// =============================================================================
describe("BLZ-440 regression fixture: hjr15/blaze PR #140", () => {
  const PR_140 = {
    number: 140,
    state: "MERGED",
    url: "https://github.com/hjr15/blaze/pull/140",
    headRefName: "docs-successor-kickoff-blz-408-439",
    title: "docs: successor kickoff for the BLZ-408..439 follow-up lane",
  };
  const blzFromRef = (ref) => {
    const m = /\bBLZ-(\d+)/i.exec(ref || "");
    return m ? `BLZ-${m[1]}` : null;
  };

  test("the branch really does yield BLZ-408 — the claim exists and must be gated, not absent", () => {
    assert.equal(blzFromRef(PR_140.headRefName), "BLZ-408");
  });

  test("PR #140's title corroborates NOTHING: BLZ-408..439 is a range, not a claim", () => {
    assert.equal(claimCorroborated("BLZ-408", { title: PR_140.title }), false);
    assert.equal(claimCorroborated("BLZ-439", { title: PR_140.title }), false);
  });

  test("PR #140 is NEUTERED, not dropped — BLZ-408 stays in defined with no record", () => {
    // DIRECTION 1, the bug this ticket exists for. #140 stays in the pool (dropping it
    // would promote whatever ranks next), but it may neither record nor advance.
    const map = buildPrMap([PR_140], blzFromRef, new Set());
    assert.equal(map.get("BLZ-408")?.uncorroborated, true, "#140's claim on BLZ-408 is uncorroborated");
    const d = decide({ pr: map.get("BLZ-408") }, "defined", "bug");
    assert.equal(d.target, "defined", "BLZ-408 has never been worked; #140 must not move it");
    assert.equal(d.moved, false);
    assert.equal(d.prVal, null, "a write-once record must not be written from a range mention");
    assert.equal(d.branchVal, null);
    assert.equal(d.resolution, undefined);
  });

  test("DIRECTION 2: dropping an uncorroborated OPEN PR would promote a MERGED one — it must not", () => {
    // The blocking finding from round 2's adversarial review, verbatim from
    // `reconcile-selection-invariants.test.mjs`'s own hostile pool. Round 1 DROPPED the
    // uncorroborated OPEN PR, which promoted the merged one and took an `in-review`
    // ticket terminal with `resolution: done` and a WRITE-ONCE `pr:` record naming the
    // wrong PR, while the open PR carrying the real work was still open — and
    // `openPrOnTerminal` was false, so nothing reported it. This test FAILS on ffcdd23.
    const inf = () => "INF-645";
    const pool = [
      { name: "merged/strong/10", state: "MERGED", number: 10, url: "u10",
        headRefName: "INF-645-a", title: "INF-645: the real work" },
      { name: "open/weak/null", state: "OPEN", number: 41, url: "u41",
        headRefName: "INF-645-f", title: "chore: follow-up for INF-645" },
    ];
    for (const order of [pool, [...pool].reverse()]) {
      const won = buildPrMap(order, inf, null).get("INF-645");
      assert.equal(won.number, 41, "the OPEN PR keeps the veto its STATE earns");
      assert.equal(won.uncorroborated, true);
      const d = decide({ pr: won }, "in-review", "epic");
      assert.equal(d.target, "in-review", "the ticket must not go terminal");
      assert.equal(d.moved, false);
      assert.equal(d.resolution, undefined, "no resolution: done");
      assert.equal(d.prVal, null, "no write-once record from an uncorroborated claim");
    }
  });

  test("the PR that ACTUALLY delivered BLZ-408 would still be honoured", () => {
    // The control against over-fixing: #140 is dropped because of what its TITLE says,
    // not because of anything about BLZ-408 or about docs PRs.
    const real = {
      number: 200, state: "MERGED", url: "https://github.com/hjr15/blaze/pull/200",
      headRefName: "BLZ-408-the-real-work", title: "BLZ-408: the work this ticket describes",
    };
    const map = buildPrMap([PR_140, real], blzFromRef, new Set());
    assert.equal(map.get("BLZ-408")?.number, 200);
  });
});

// =============================================================================
// BLZ-469 — THE SILENT HALF. A merged PR whose BRANCH derives an id its TITLE does not
// claim moves nothing, and until now said nothing either: PR #144 delivered sixteen
// tickets, moved none, and the operator found out by noticing the board had not changed.
//
// The refusal is CORRECT (BLZ-440) and is not being weakened. What is added is that the
// run SAYS SO. Scoped deliberately, because `gh pr list --state all --limit 1000` returns
// the whole history and a finding per historical non-conventional title would bury the
// findings that matter (the volume argument `fileUnverifiableRecord` already makes):
//
//   - MERGED only — an OPEN uncorroborated PR is a VETO, which is a signal working as
//     designed, not a delivery that failed to register;
//   - non-terminal tickets only — a done ticket missed nothing;
//   - and never when a `KEY-n:` commit corroborated it anyway, because then the ticket
//     moved and the title gap cost nothing.
// =============================================================================
describe("BLZ-469: reconcile WARNS when a merged PR's branch derives an id its title does not claim", () => {
  const WKEY = "WRN";

  function board(tmp, { title, subject, status = "in-progress", type = "task" }) {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin",
      "https://github.com/hjr15/warn.git"]);
    for (const [i, subj] of ["seed", subject].filter(Boolean).entries()) {
      writeFileSync(join(repo, `f${i}.md`), `x${i}\n`);
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", subj]);
    }
    const root = join(tmp, "board");
    const dir = join(root, "projects", WKEY, status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${WKEY}-7-t.md`),
      `---\nid: ${WKEY}-7\ntype: ${type}\nproject: ${WKEY}\nestimate: 30\n---\n\nbody\n`);
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: WKEY, projects: [WKEY], codeRepos: [repo] }));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n` +
      JSON.stringify([{ number: 144, state: "MERGED", url: "https://example.invalid/pull/144",
        headRefName: `${WKEY}-7-the-real-work`, title }]) + `\nJSON\n`);
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    return { root, bin };
  }

  async function run(opts) {
    const tmp = mkdtempSync(join(tmpdir(), "blz469-warn-"));
    const prev = process.env.PATH;
    try {
      const { root, bin } = board(tmp, opts);
      process.env.PATH = `${bin}:${prev}`;
      const r = await reconcile({ root, dryRun: true });
      return { r, warnings: r.findings.filter((f) => f.kind === "merged-pr-title-claims-nothing") };
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("the live shape: `KEY-n + N more` BEFORE the fix claimed nothing — the warning names it", async () => {
    // `+ 15 others` is deliberately NOT the admitted manifest form, so this reproduces
    // exactly what PR #144 did before BLZ-469: branch derives the id, title claims
    // nothing, nothing moves, and nothing said so.
    const { r, warnings } = await run({ title: `${WKEY}-7 + 15 others: the oracles are non-vacuous` });
    assert.equal(r.changes.length, 0, "the refusal itself is unchanged — nothing moves");
    assert.equal(warnings.length, 1, "exactly one warning, naming the ticket");
    assert.equal(warnings[0].id, `${WKEY}-7`);
    assert.equal(warnings[0].pr, 144);
    assert.match(warnings[0].message, new RegExp(`${WKEY}-7`));
    assert.match(warnings[0].message, /#144/);
    assert.match(warnings[0].message, /title/i);
  });

  test("the admitted manifest form does NOT warn — it claims, so the ticket moves", async () => {
    const { r, warnings } = await run({ title: `${WKEY}-7 + 15 more: the oracles are non-vacuous` });
    assert.deepEqual(warnings, [], "a title that claims the id has nothing to report");
    assert.deepEqual(r.changes.map((c) => c.id), [`${WKEY}-7`]);
    assert.equal(r.changes[0].to, "done");
  });

  test("an em-dash title does NOT warn either — BLZ-455 admitted it", async () => {
    const { r, warnings } = await run({ title: `${WKEY}-7 — the real work` });
    assert.deepEqual(warnings, []);
    assert.deepEqual(r.changes.map((c) => c.id), [`${WKEY}-7`]);
  });

  test("a shipped `KEY-n:` commit corroborates the weak title, so there is nothing to warn about", async () => {
    const { r, warnings } = await run({ title: "chore: tidy the runbook",
      subject: `${WKEY}-7: the real work` });
    assert.deepEqual(warnings, [], "the ticket moved — the title gap cost nothing");
    assert.deepEqual(r.changes.map((c) => c.id), [`${WKEY}-7`]);
  });

  test("an ALREADY-TERMINAL ticket does not warn — it missed nothing", async () => {
    const { warnings } = await run({ title: `docs: follow-up to ${WKEY}-7`, status: "done" });
    assert.deepEqual(warnings, []);
  });

  test("a non-delivery type does not warn — it never mirrors git state at all", async () => {
    const { warnings } = await run({ title: `docs: follow-up to ${WKEY}-7`, type: "goal",
      status: "defined" });
    assert.deepEqual(warnings, []);
  });

  test("an OPEN uncorroborated PR does not warn — a veto is a signal, not a missed delivery", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz469-open-"));
    const prev = process.env.PATH;
    try {
      const { root, bin } = board(tmp, { title: `docs: follow-up to ${WKEY}-7` });
      // Rewrite the stub to answer OPEN instead of MERGED.
      writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n` +
        JSON.stringify([{ number: 144, state: "OPEN", url: "u144",
          headRefName: `${WKEY}-7-the-real-work`, title: `docs: follow-up to ${WKEY}-7` }]) +
        `\nJSON\n`);
      execFileSync("chmod", ["+x", join(bin, "gh")]);
      process.env.PATH = `${bin}:${prev}`;
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.findings.filter((f) => f.kind === "merged-pr-title-claims-nothing"), []);
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// BLZ-455 ROUND 2 — WHAT A WIDER shippedSet CAN AND CANNOT WRITE.
//
// The round-1 ADR measured the em-dash widening at 0 additional ids and excused it with
// "the population lives in `docs-central`, which is a codeRepo of neither" — a CATEGORY
// ERROR, because the relation is project→codeRepo and `docs-central` is a configured
// codeRepo of both INF and CRP. Measured properly it harvests **+22 INF ids**, all of
// them on tickets that are already terminal, **12 of which hold no `pr:` record at all**.
//
// ADR-0023 lets a terminal ticket ACQUIRE a record it never had (`recordIfAbsentOnly`),
// so "can the widening newly write a delivery record onto one of those 12?" is a real
// question and it is NOT answerable by reading the rules — two different paths reach that
// write and they give OPPOSITE answers. Both are settled here by running `reconcile`
// against a real board and reading the file off disk, not by argument:
//
//   PATH 1 — shipped alone. REFUTED. `decide`'s `shipped` arm sets neither `branchVal`
//            nor `prVal`, and on a TERMINAL ticket it is not even reached: with no pr and
//            no branch the chain falls through to the `skip` return. A bundled child
//            recovered by a wider shippedSet moves nothing and records nothing.
//
//   PATH 2 — shipped as CORROBORATION. REAL. `claimCorroborated`'s first arm is
//            `shippedSet.has(id)`, so enlarging the set promotes a PR that was previously
//            uncorroborated — and an uncorroborated claim writes nothing, while a
//            corroborated MERGED one may fill an absent record on a terminal ticket. The
//            widening therefore CAN newly write a record, by a route the ADR never named.
//
// Each is paired with a control that fails if the mechanism under test never engaged.
// A "no record was written" assertion is worthless without proof the signal arrived.
// =============================================================================
describe("BLZ-455 round 2: a wider shippedSet moves nothing on its own, but it does corroborate", () => {
  const SKEY = "SHP";
  const SID = `${SKEY}-9`;

  /** A one-repo board with one ticket, one default-branch commit subject, and a stubbed
   *  `gh` payload. Everything the two paths differ on is a parameter. */
  function build(tmp, { subject, status, prs = [], record = null }) {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin",
      "https://github.com/hjr15/docs-central.git"]);
    for (const [i, subj] of ["seed", subject].entries()) {
      writeFileSync(join(repo, `f${i}.md`), `x${i}\n`);
      execFileSync("git", ["-C", repo, "add", "-A"]);
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", subj]);
    }
    const root = join(tmp, "board");
    const dir = join(root, "projects", SKEY, status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SID}-t.md`),
      `---\nid: ${SID}\ntype: task\nproject: ${SKEY}\nestimate: 30\n` +
      (record ? `branch: ${record.branch}\npr: ${record.pr}\n` : "") +
      (status === "done" ? "resolution: done\n" : "") + `---\n\nbody\n`);
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: SKEY, projects: [SKEY], codeRepos: [repo] }));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"),
      `#!/usr/bin/env bash\ncat <<'JSON'\n` + JSON.stringify(prs) + `\nJSON\n`);
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    return { root, bin };
  }

  /** Run a real applying reconcile and read the ticket back off disk. */
  async function apply(label, opts) {
    const tmp = mkdtempSync(join(tmpdir(), `blz455r2-${label}-`));
    const prev = process.env.PATH;
    try {
      const { root, bin } = build(tmp, opts);
      process.env.PATH = `${bin}:${prev}`;
      const r = await reconcile({ root, dryRun: false });
      const projectDir = join(root, "projects", SKEY);
      let landed = null, text = null;
      for (const st of readdirSync(projectDir)) {
        try { text = readFileSync(join(projectDir, st, `${SID}-t.md`), "utf8"); landed = st; }
        catch { /* not here */ }
      }
      return { r, landed, text };
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  const EM = `${SID} — the work this ticket describes`;   // the newly-qualifying shape
  const HYPHEN = `${SID} - the work this ticket describes`; // still rejected: the control

  test("PREMISE: an em-dash commit subject really does reach the ticket — it moves a NON-terminal one", async () => {
    // Without this, every "nothing was written" assertion below could be passing because
    // the em-dash subject was never harvested at all, which is the opposite of the claim.
    const { r, landed, text } = await apply("premise", { subject: EM, status: "in-progress" });
    assert.equal(landed, "done", "the widened shipped signal must actually drive the move");
    assert.deepEqual(r.changes.map((c) => c.id), [SID]);
    // ...and even here, where it DID move the ticket, it writes no record: the shipped arm
    // sets neither field. That is the same fact PATH 1 turns on, seen where the arm runs.
    assert.doesNotMatch(text, /^pr:/m, "the shipped arm has no record to give");
    assert.doesNotMatch(text, /^branch:/m);
  });

  test("CONTROL: the same subject with a HYPHEN moves nothing — the em-dash is what changed", async () => {
    const { r, landed } = await apply("control", { subject: HYPHEN, status: "in-progress" });
    assert.equal(landed, "in-progress", "a hyphen is not a terminator and must claim nothing");
    assert.deepEqual(r.changes, []);
  });

  test("PATH 1 REFUTED: a TERMINAL record-less ticket recovered by shipped alone acquires NO record", async () => {
    // This is the live shape: 12 of the 22 newly-harvested INF ids are bundled children
    // sitting in `done` with no branch and no pr, recovered only from body bullets that an
    // em-dash subject unlocked. ADR-0023 permits a terminal ticket to acquire an absent
    // record, so the question is real — and the answer is no.
    const { r, landed, text } = await apply("path1", { subject: EM, status: "done" });
    assert.equal(landed, "done");
    assert.doesNotMatch(text, /^pr:/m, "a shipped-only signal must not write a delivery record");
    assert.doesNotMatch(text, /^branch:/m);
    assert.deepEqual(r.changes, [], "and it is not even reported as a change");
  });

  test("PATH 2 REAL: a wider shippedSet CORROBORATES a weak-titled merged PR, which then fills the absent record", async () => {
    // `claimCorroborated`'s first arm is `shippedSet.has(id)`. Enlarging the set promotes a
    // PR whose title claims nothing from uncorroborated (writes nothing, ever) to
    // corroborated (may fill an absent record on a terminal ticket). The em-dash widening
    // therefore CAN newly write a record — by this route, not by the shipped arm.
    const weak = [{ number: 110, state: "MERGED", url: "https://example.invalid/pull/110",
      headRefName: `${SID}-health`, title: "chore: tidy the runbook" }];
    const { landed, text } = await apply("path2", { subject: EM, status: "done", prs: weak });
    assert.equal(landed, "done", "terminal-sticky still holds — this is a RECORD, not a move");
    assert.match(text, /^pr: '?#110 — https:\/\/example\.invalid\/pull\/110/m,
      "the newly-corroborated merged PR fills the record the ticket never had");

    // THE DISCRIMINATOR. Identical in every respect except the terminator, so a failure
    // here can only be the widening. With a hyphen the id is not in the shippedSet, the
    // same PR stays uncorroborated, and an uncorroborated claim may never write.
    const before = await apply("path2-control", { subject: HYPHEN, status: "done", prs: weak });
    assert.doesNotMatch(before.text, /^pr:/m,
      "without the widening the identical PR is uncorroborated and writes nothing");
  });

  test("PATH 2 does not become a REWRITE: a record already held is not repointed", async () => {
    // The other half of ADR-0023: acquire-if-absent, never replace. 10 of the 22 ids
    // already hold a record, and the widening must not touch them.
    const other = [{ number: 999, state: "MERGED", url: "https://example.invalid/pull/999",
      headRefName: `${SID}-later`, title: "chore: a later docs pass" }];
    const { text } = await apply("path2-writeonce", { subject: EM, status: "done", prs: other,
      record: { branch: `${SID}-original`, pr: "'#110 — https://example.invalid/pull/110'" } });
    assert.match(text, /#110/, "the original record must survive");
    assert.doesNotMatch(text, /#999/, "write-once: a wider shippedSet may not repoint a held record");
  });
});

// =============================================================================
// BLZ-458 ROUND 2 — THE NUMBER DIMENSION, PUT WHERE THE CORROBORATION TIER IS
// ACTUALLY REACHABLE.
//
// Round 1 made the subject's number a dimension of every WITHIN-REPO pool above, and
// adversarial review showed that is the one place it cannot matter. Within one repo
// `betterPr`'s CORROBORATED tier is unreachable — the file says so itself at the
// CROSS-REPO test above: corroboration and the claim tier are the same question there,
// so the CLAIM tier always separates the pair first and the number tiebreak is never
// consulted on a corroboration difference. The measurement: the literal mutant
//
//     const skipCorr = pr.uncorroborated && pr.state === "CLOSED" && pr.number > best.number;
//     if (!skipCorr && corroborated(pr) !== corroborated(best)) return ...
//
// left `node --test` at 3987/3987 pass. Every case round 1 added — `SUBJECT_NUMBERS`,
// both `CORROBORATED_POOL_*` tables, the eight-row `THREE_PR_POOL` — runs `buildPrMap`
// with ONE `shippedSet`, so none of them can see it.
//
// The tier is reachable only where `shippedSet` DIFFERS between the compared candidates,
// which is `gatherProject` merging two repos: `shippedSet` is computed per repo, so the
// same weak title is corroborated in the repo whose default branch carries the `KEY-n:`
// commit and uncorroborated in the one that does not. THAT is where the number dimension
// belongs, and it needs both directions AND the unrecordable (`number: null`) shape,
// because the two tiers underneath the corroboration tier are RECORDABLE and then LOWER
// NUMBER — so skipping corroboration hands the selection to the uncorroborated claim by
// a different route in each direction:
//
//   - uncorroborated LOWER  (#140 vs #200): the number tiebreak hands it over;
//   - uncorroborated HIGHER (#300 vs a corroborated PR the forge could not number):
//     the RECORDABLE tier hands it over, and the mutant above is exactly this case.
//
// In both, an uncorroborated claim takes the cross-repo selection from a corroborated
// one and — being uncorroborated — moves nothing and records nothing, suppressing the
// delivery signal that was sitting right there. There is NO production defect here:
// every ordered pair below is antisymmetric at HEAD. This is the coverage the tier's
// only reachable path never had.
// =============================================================================
describe("BLZ-458: cross-repo, the corroboration tier holds in BOTH number directions", () => {
  const CORR_TITLE = `chore: tidy the runbook after ${ID}`;   // weak title, claim 1
  const UNCORR_TITLE = `docs: the ${ID}..439 lane`;           // weak title, claim 1
  const xpr = (number, state, suffix, title) => ({
    number, state, url: number === null ? "uA-unnumbered" : `u${number}`,
    headRefName: `${ID.toLowerCase()}-${suffix}`, title,
  });

  // corroborated repo-A number | uncorroborated repo-B number | why the tier is load-bearing
  const NUMBER_DIRECTIONS = [
    [200, 140, "the uncorroborated claim carries the LOWER number: without the tier the " +
               "number tiebreak hands it the selection"],
    [200, 300, "the uncorroborated claim carries the HIGHER number: the tier must not be " +
               "a restatement of the number tiebreak"],
    [null, 140, "the corroborated PR is UNRECORDABLE and the uncorroborated one is lower: " +
                "without the tier, RECORDABLE and then NUMBER both hand it over"],
    [null, 300, "the corroborated PR is UNRECORDABLE and the uncorroborated one is HIGHER: " +
                "without the tier the RECORDABLE tier alone hands it over — the surviving mutant"],
  ];
  // state (shared by both repos, so RANK can never decide) | target | record from repo A?
  const XREPO_STATES = [
    ["OPEN", "in-review"],
    ["MERGED", "done"],
    ["CLOSED", "in-progress"],
  ];
  const START = "defined";

  test("the cross-repo grid declares both number directions and the unrecordable shape", () => {
    assert.equal(NUMBER_DIRECTIONS.length, 4, "the cross-repo grid changed size");
    assert.ok(NUMBER_DIRECTIONS.some(([c, u]) => u < (c ?? Infinity)),
      "one row must give the uncorroborated claim the LOWER number");
    assert.ok(NUMBER_DIRECTIONS.some(([c, u]) => c !== null && u > c),
      "one row must give the uncorroborated claim the HIGHER number");
    assert.ok(NUMBER_DIRECTIONS.some(([c]) => c === null),
      "one row must make the CORROBORATED PR unrecordable — the shape that makes the " +
      "suppression visible");
    assert.equal(XREPO_STATES.length, 3, "every PR state, so rank never decides");
  });

  test("TWO shippedSets: an uncorroborated claim never takes the selection, in either number direction", () => {
    // The premise, asserted rather than assumed: the two repos disagree about the SAME
    // title because `shippedSet` is per repo. Nothing here is computed by calling
    // `betterPr` — every expectation is hand-declared from the documented tier order.
    let clauses = 0;
    for (const [corrNumber, uncorrNumber, why] of NUMBER_DIRECTIONS) {
      for (const [state, wantTarget] of XREPO_STATES) {
        const label = `corr#${corrNumber} vs unc#${uncorrNumber} ${state}: ${why}`;
        // Repo A: its own default branch carries `ORC-408: …`, so the weak title corroborates.
        const fromRepoA = buildPrMap([xpr(corrNumber, state, "a", CORR_TITLE)], idFromRef,
          new Set([ID])).get(ID);
        // Repo B: nothing shipped there, so the same shape of weak title does not.
        const fromRepoB = buildPrMap([xpr(uncorrNumber, state, "b", UNCORR_TITLE)], idFromRef,
          new Set()).get(ID);
        assert.equal(prTitleClaim(fromRepoA, ID), 1, `${label}: repo A's title is weak`);
        assert.equal(prTitleClaim(fromRepoB, ID), 1, `${label}: repo B's title is weak`);
        assert.equal(Boolean(fromRepoA.uncorroborated), false, `${label}: repo A corroborated`);
        assert.equal(fromRepoB.uncorroborated, true, `${label}: repo B uncorroborated`);
        // The tier itself, in BOTH argument orders — `gatherProject` asks it in whichever
        // order `codeRepos` happens to list the repos, so a non-antisymmetric comparator
        // makes the winner scan-order dependent.
        assert.equal(betterPr(fromRepoB, fromRepoA, ID), false, `${label}: B must not beat A`);
        assert.equal(betterPr(fromRepoA, fromRepoB, ID), true, `${label}: A must beat B`);
        // ...and what the winner then does with the ticket.
        const d = decide({ pr: fromRepoA }, START, "epic");
        assert.equal(d.target, wantTarget, `${label}: target`);
        assert.equal(d.prVal, corrNumber === null ? null : `#${corrNumber} — u${corrNumber}`,
          `${label}: record`);
        clauses += 8;
      }
    }
    assert.equal(clauses, NUMBER_DIRECTIONS.length * XREPO_STATES.length * 8);
  });
});

// =============================================================================
// ...and the same grid through `gatherProject` itself, because the unit assertions
// above still call `betterPr` by hand. `gatherProject` is not exported — it is reached
// only by running `reconcile` over a board whose config names TWO code repos — so this
// is the seam that proves the tier is wired, not merely correct. Two real git repos,
// one carrying an `ORC-408:` commit on its default branch and one not, which is what
// makes the two `shippedSet`s differ; the forge payload is stubbed per repo.
//
// CLOSED on both sides throughout: `tiedDeliverers` only considers MERGED candidates,
// so a CLOSED pair keeps the ambiguity machinery out of the way and leaves the ticket's
// final status a clean readout of which repo's PR won the merge.
//
// Both `codeRepos` ORDERS are run and must agree. Scan order is not evidence, and it is
// the observable a non-antisymmetric comparator changes.
// =============================================================================
describe("BLZ-458: gatherProject merges two repos' shippedSets with the corroboration tier", () => {
  const XKEY = "ORC";

  function gitRepo(dir, name, subjects) {
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    // A forge remote, or `gatherPrs` reports `no-remote` and never calls `gh` at all.
    execFileSync("git", ["-C", dir, "remote", "add", "origin",
      `https://github.com/hjr15/${name}.git`]);
    for (const [i, subject] of subjects.entries()) {
      writeFileSync(join(dir, `f${i}.md`), `x${i}\n`);
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", subject]);
    }
    return dir;
  }

  /** Run a real reconcile over a two-repo board and report where the ticket landed. */
  async function twoRepoReconcile({ corrNumber, uncorrNumber, state, repoAFirst }) {
    const tmp = mkdtempSync(join(tmpdir(), "blz458-xrepo-"));
    const prev = process.env.PATH;
    try {
      // alpha's own default branch ships the id, so ITS shippedSet corroborates the weak
      // title. beta's log never mentions it, so the identical shape stays uncorroborated.
      const alpha = gitRepo(join(tmp, "alpha"), "alpha", ["seed", `${ID}: the work this ticket describes`]);
      const beta = gitRepo(join(tmp, "beta"), "beta", ["seed", "docs: unrelated"]);
      const repos = repoAFirst ? [alpha, beta] : [beta, alpha];

      const root = join(tmp, "board");
      const dir = join(root, "projects", XKEY, "defined");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${ID}-t.md`),
        `---\nid: ${ID}\ntype: epic\nproject: ${XKEY}\nestimate: 30\n---\n\nbody\n`);
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: XKEY, projects: [XKEY], codeRepos: repos }));

      const prA = { number: corrNumber, state,
        url: corrNumber === null ? "uA-unnumbered" : `u${corrNumber}`,
        headRefName: `${ID.toLowerCase()}-a`, title: `chore: tidy the runbook after ${ID}` };
      const prB = { number: uncorrNumber, state, url: `u${uncorrNumber}`,
        headRefName: `${ID.toLowerCase()}-b`, title: `docs: the ${ID}..439 lane` };
      const bin = join(tmp, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$PWD" in
  */alpha) cat <<'JSON'
${JSON.stringify([prA])}
JSON
  ;;
  *) cat <<'JSON'
${JSON.stringify([prB])}
JSON
  ;;
esac
`);
      execFileSync("chmod", ["+x", join(bin, "gh")]);
      process.env.PATH = `${bin}:${prev}`;

      const r = await reconcile({ root, dryRun: false });
      const projectDir = join(root, "projects", XKEY);
      let landed = null, text = null;
      for (const status of readdirSync(projectDir)) {
        const f = join(projectDir, status, `${ID}-t.md`);
        try { text = readFileSync(f, "utf8"); landed = status; } catch { /* not here */ }
      }
      return { landed, text, forgeErrors: r.forgeErrors };
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // corroborated repo-A number | uncorroborated repo-B number | what the tier is holding off
  const XREPO_ROWS = [
    [200, 140, "the LOWER-numbered uncorroborated claim (the number tiebreak's direction)"],
    [200, 300, "the HIGHER-numbered uncorroborated claim"],
    [null, 140, "a LOWER-numbered uncorroborated claim against an unrecordable corroborated one"],
    [null, 300, "a HIGHER-numbered uncorroborated claim against an unrecordable corroborated one"],
  ];

  for (const [corrNumber, uncorrNumber, what] of XREPO_ROWS) {
    for (const repoAFirst of [true, false]) {
      const order = repoAFirst ? "corroborated repo first" : "uncorroborated repo first";
      test(`CROSS-REPO through gatherProject: corr #${corrNumber} beats ${what} (${order})`, async () => {
        const { landed, text, forgeErrors } = await twoRepoReconcile({
          corrNumber, uncorrNumber, state: "CLOSED", repoAFirst });
        // The unnumbered corroborated PR legitimately raises the `gh-unusable-pr` WARNING
        // — that is the shape being exercised, and it is reported rather than hidden.
        // Anything else means the harness, not the tier, decided the outcome.
        assert.deepEqual(forgeErrors.filter((f) => f.reason !== "gh-unusable-pr"), []);
        assert.equal(forgeErrors.some((f) => f.reason === "gh-unusable-pr"), corrNumber === null,
          "the unrecordable shape must be REPORTED, and only that row may report it");
        // Hand-declared, not computed: the corroborated repo's CLOSED PR wins the merge,
        // and a corroborated CLOSED winner means `in-progress`. If the uncorroborated
        // claim took the selection instead, the winner would move NOTHING and the ticket
        // would still be sitting in `defined` — which is the suppression this tier stops.
        assert.equal(landed, "in-progress",
          "the corroborated repo's PR must decide the ticket, whatever its number");
        if (corrNumber === null) {
          assert.doesNotMatch(text, /^pr:/m,
            "an unrecordable winner writes no record — blank and true, never filled and false");
        } else {
          assert.match(text, new RegExp(`^pr: '?#${corrNumber} — u${corrNumber}`, "m"),
            "the corroborated repo's PR supplies the delivery record");
        }
      });
    }
  }
});

// =============================================================================
// BLZ-489 — the comment and the ADR must enumerate the SAME paths.
//
// `scripts/reconcile.mjs` said "Two paths reach that write and they answer differently"
// and listed two. ADR-0026 documents a THIRD: `buildBranchMap`'s own
// `shippedSet && shippedSet.has(id)` corroboration, which a wider set newly admits. On a
// terminal ticket it is blocked by terminal-sticky nulling both fields — which is why the
// conclusion for the twelve holds — and on a NON-terminal ticket the same arm writes
// `branch:` and moves the ticket to `in-progress`.
//
// The two texts had drifted apart, and the comment is the one an engineer reads at the
// moment they are changing the code. This is the pin that keeps them together: it is not
// prose-checking for its own sake, it is the specific disagreement BLZ-489 recorded.
// =============================================================================

const FLAT = (s) => s.replace(/\s+/g, " ");
// The comment markers have to come off before the text is flattened, or every sentence
// that wraps across two comment lines carries a `//` through the middle of it and no
// assertion below can match a sentence longer than one line.
const UNCOMMENT = (s) => FLAT(s.split("\n").map((l) => l.replace(/^\s*\/\/ ?/, "")).join("\n"));
const RECONCILE_SRC = UNCOMMENT(readFileSync(
  join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), "utf8"));
const ADR_0026 = FLAT(readFileSync(join(import.meta.dirname, "..", "docs", "decisions",
  "0026-a-pr-title-claims-a-ticket-with-a-colon-or-an-em-dash-and-nothing-else.md"), "utf8"));

describe("BLZ-489: reconcile's write-path comment enumerates the same paths ADR-0026 does", () => {
  test("the ADR really does document a third, guarded path — the premise, read from the ADR", () => {
    // Without this the assertions below could pass against an ADR that had quietly lost the
    // third path, which would make the comment right by accident and this file vacuous.
    assert.match(ADR_0026, /A third write path exists, and it is blocked only by a guard worth naming/);
    assert.match(ADR_0026, /`buildBranchMap` carries its own `shippedSet && shippedSet\.has\(id\)` corroboration/);
    assert.match(ADR_0026, /on a NON-terminal ticket the same arm writes `branch:` and moves the ticket to `in-progress`/);
    assert.match(ADR_0026, /safe \*\*because of\*\* that guard, not in spite of needing one/);
  });

  test("the comment enumerates THREE paths, and names the third one's arm", () => {
    assert.match(RECONCILE_SRC, /THREE paths reach that write/);
    assert.doesNotMatch(RECONCILE_SRC, /Two paths reach that write/,
      "the stale two-path enumeration is the defect BLZ-489 recorded");
    assert.match(RECONCILE_SRC, /`buildBranchMap` carries its OWN `shippedSet && shippedSet\.has\(id\)`/,
      "the third path must be named by its arm, not alluded to");
    assert.match(RECONCILE_SRC, /writes `branch:` and moves the ticket to `in-progress`/,
      "…including what it does on a NON-terminal ticket, which is the half that is not blocked");
  });

  test("…and it says the two-path conclusion holds BECAUSE of terminal-sticky", () => {
    assert.match(RECONCILE_SRC, /BECAUSE OF terminal-sticky, not in spite of needing it/,
      "AC-2: a guarded conclusion that does not name its guard reads as an unconditional one");
  });
});
