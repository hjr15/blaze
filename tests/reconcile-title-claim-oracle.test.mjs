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
// The POSITIVE CONTROL is load-bearing: shapes 1-5 are genuine `KEY-n: desc` claims
// and MUST still corroborate. A "fix" that fails them has broken every legitimate
// reconcile on the board, which is a far worse defect than the one being fixed.
//
// Non-vacuity is proven by hand, outside this file, by re-introducing the defect on a
// committed tree and confirming THIS named test goes red for the reason its name
// claims — the commands and the failing output are in the PR body.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claimCorroborated, buildPrMap, decide, betterPr, prTitleClaim, PR_RANK } from "../scripts/reconcile.mjs";

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
    assert.equal(TITLE_SHAPES.length, 15, "title shapes");
    assert.equal(BRANCH_SHAPES.length, 4, "branch shapes");
    assert.equal(PR_STATES.length, 3, "PR states");
    assert.equal(SHIPPED.length, 2, "shipped-commit signal");
    assert.equal(EXPECTED_CASES, 360);
    assert.equal(cases.length, EXPECTED_CASES, "every dimension must reach every case");
    assert.equal(new Set(cases.map((c) => c.name)).size, EXPECTED_CASES, "case names must be distinct");
    // BLZ-440 round 2 added a POOL dimension on top of the single-PR product. Both
    // halves are pinned, so deleting either one fails this test rather than shrinking
    // the evidence quietly. 360 single-PR cases x 4 clauses + 18 pool pairings x 2
    // orderings x 4 clauses.
    assert.equal(EXPECTED_CASES * 4, 1440, "single-PR clause budget");
    assert.equal((9 + 9) * 2 * 4, 144, "pool-matrix clause budget");
  });

  test("the fixture set discriminates: mention-but-not-a-claim shapes exist, and so do genuine claims", () => {
    // Without this, a fix that made claimCorroborated always-false would pass every
    // negative clause below and the file would still be "green" in the wrong direction.
    const discriminating = TITLE_SHAPES.filter((t) => t.mentions && !t.claims);
    const positive = TITLE_SHAPES.filter((t) => t.claims);
    assert.equal(discriminating.length, 7, "titles where a bare mention disagrees with the house rule");
    assert.equal(positive.length, 5, "titles that genuinely claim the ticket (the positive control)");
    assert.ok(discriminating.some((t) => t.name === "range-downstream"), "PR #140's shape must be present");
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
  const uncorroboratedSubject = (state) => ({
    number: 140, state, url: "u140", headRefName: `${ID.toLowerCase()}-a`,
    title: `docs: successor kickoff for the ${ID}..439 lane`,   // a RANGE: mention, not claim
  });
  const corroboratedSubject = (state) => ({
    number: 140, state, url: "u140", headRefName: `${ID.toLowerCase()}-a`,
    title: `${ID}: the subject's own work`,
  });
  const companion = (state) => ({
    number: 200, state, url: "u200", headRefName: `${ID.toLowerCase()}-b`,
    title: `${ID}: the real work`,                              // always corroborated
  });

  // subjectState | companionState | winning PR number | target | recorded PR (or null)
  const UNCORROBORATED_POOL = [
    ["OPEN",   "OPEN",   200, "in-review",   "#200 — u200"],
    ["OPEN",   "MERGED", 140, "in-review",   null], // THE REVIEW'S FINDING: veto held
    ["OPEN",   "CLOSED", 140, "in-review",   null],
    ["MERGED", "OPEN",   200, "in-review",   "#200 — u200"],
    ["MERGED", "MERGED", 200, "done",        "#200 — u200"],
    ["MERGED", "CLOSED", 140, "in-review",   null],
    ["CLOSED", "OPEN",   200, "in-review",   "#200 — u200"],
    ["CLOSED", "MERGED", 200, "done",        "#200 — u200"],
    ["CLOSED", "CLOSED", 200, "in-progress", "#200 — u200"],
  ];

  // Both corroborated: the comparator's ordinary behaviour, unchanged by BLZ-440.
  // Ties at equal rank fall to the LOWER number, which is the subject (140).
  const CORROBORATED_POOL = [
    ["OPEN",   "OPEN",   140, "in-review",   "#140 — u140"],
    ["OPEN",   "MERGED", 140, "in-review",   "#140 — u140"],
    ["OPEN",   "CLOSED", 140, "in-review",   "#140 — u140"],
    ["MERGED", "OPEN",   200, "in-review",   "#200 — u200"],
    ["MERGED", "MERGED", 140, "done",        "#140 — u140"],
    ["MERGED", "CLOSED", 140, "done",        "#140 — u140"],
    ["CLOSED", "OPEN",   200, "in-review",   "#200 — u200"],
    ["CLOSED", "MERGED", 200, "done",        "#200 — u200"],
    ["CLOSED", "CLOSED", 140, "in-progress", "#140 — u140"],
  ];

  test("the pool matrix covers every uncorroborated state x every corroborated state", () => {
    assert.equal(UNCORROBORATED_POOL.length, 9, "3 subject states x 3 companion states");
    assert.equal(CORROBORATED_POOL.length, 9);
    for (const table of [UNCORROBORATED_POOL, CORROBORATED_POOL]) {
      assert.equal(new Set(table.map(([a, b]) => `${a}|${b}`)).size, 9, "no duplicate pairing");
      for (const [a, b] of table) {
        assert.ok(PR_STATES.includes(a) && PR_STATES.includes(b), `${a}|${b}`);
      }
    }
  });

  test("an uncorroborated claim in a POOL holds the ticket back and never advances it", () => {
    // Two orderings each, because `gh` decides which PR it lists first and a comparator
    // that is not a strict weak ordering makes the winner depend on that.
    let clauses = 0;
    for (const [sState, cState, wantWinner, wantTarget, wantRecord] of UNCORROBORATED_POOL) {
      const subject = uncorroboratedSubject(sState);
      const comp = companion(cState);
      for (const pool of [[subject, comp], [comp, subject]]) {
        const won = buildPrMap(pool, idFromRef, new Set()).get(ID);
        const label = `uncorroborated ${sState} + corroborated ${cState}`;
        assert.equal(won?.number, wantWinner, `${label}: winner`);
        const d = decide({ pr: won }, CURRENT, "epic");
        assert.equal(d.target, wantTarget, `${label}: target`);
        assert.equal(d.prVal, wantRecord, `${label}: record`);
        // The write-once trap: a terminal target takes a resolution with it.
        assert.equal(d.resolution, wantTarget === "done" ? "done" : undefined, `${label}: resolution`);
        clauses += 4;
      }
    }
    assert.equal(clauses, 9 * 2 * 4);
  });

  test("an uncorroborated MERGED PR never promotes itself past a corroborated OPEN one", () => {
    // Stated on its own because it is the exact live shape: PR #140 is MERGED and the
    // ticket's real work is elsewhere. If the merged uncorroborated PR ever wins here,
    // the ticket goes terminal with a write-once record naming the wrong PR.
    const won = buildPrMap([uncorroboratedSubject("MERGED"), companion("OPEN")], idFromRef, new Set()).get(ID);
    assert.equal(won.number, 200);
    assert.equal(decide({ pr: won }, "defined", "epic").target, "in-review");
  });

  test("POOL CONTROL: two corroborated PRs rank exactly as they always did", () => {
    let clauses = 0;
    for (const [sState, cState, wantWinner, wantTarget, wantRecord] of CORROBORATED_POOL) {
      for (const pool of [[corroboratedSubject(sState), companion(cState)],
                          [companion(cState), corroboratedSubject(sState)]]) {
        const won = buildPrMap(pool, idFromRef, new Set()).get(ID);
        const label = `corroborated ${sState} + corroborated ${cState}`;
        assert.equal(won?.number, wantWinner, `${label}: winner`);
        assert.equal(Boolean(won.uncorroborated), false, `${label}: neither is uncorroborated`);
        const d = decide({ pr: won }, CURRENT, "epic");
        assert.equal(d.target, wantTarget, `${label}: target`);
        assert.equal(d.prVal, wantRecord, `${label}: record`);
        clauses += 4;
      }
    }
    assert.equal(clauses, 9 * 2 * 4);
  });

  test("at EQUAL rank a corroborated PR always beats an uncorroborated one", () => {
    let clauses = 0;
    for (const state of PR_STATES) {
      for (const pool of [[uncorroboratedSubject(state), companion(state)],
                          [companion(state), uncorroboratedSubject(state)]]) {
        const won = buildPrMap(pool, idFromRef, new Set()).get(ID);
        assert.equal(won.number, 200, `${state}: corroborated 200 must beat uncorroborated 140`);
        assert.equal(Boolean(won.uncorroborated), false, state);
        clauses += 2;
      }
    }
    assert.equal(clauses, 3 * 2 * 2);
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
    assert.equal(clauses, 5 * 4 * 3 * 2 + 5 * 3 * 3 * 2, "positive-control clause count");
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
