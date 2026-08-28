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
// The POSITIVE CONTROL is load-bearing: shapes 1-5 are genuine `KEY-n: desc` claims
// and MUST still corroborate. A "fix" that fails them has broken every legitimate
// reconcile on the board, which is a far worse defect than the one being fixed.
//
// Non-vacuity is proven by hand, outside this file, by re-introducing the defect on a
// committed tree and confirming THIS named test goes red for the reason its name
// claims — the commands and the failing output are in the PR body.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { claimCorroborated, buildPrMap } from "../scripts/reconcile.mjs";

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
            //   corroborated  <- a real shipped commit, or a title that CLAIMS the id
            //   claimed       <- the ref must yield the id at all, then survive the gate
            expectCorroborated: shipped || t.claims,
            expectClaimed: b.yieldsId && (shipped || t.claims),
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

  test("every case's PR-map outcome matches the fixture spec, and fail-closed holds", () => {
    let clauses = 0;
    const failures = [];
    for (const c of cases) {
      const map = buildPrMap([c.pr], idFromRef, c.shippedSet);
      // (a) is the ticket claimed at all?
      clauses += 1;
      if (map.has(ID) !== c.expectClaimed) {
        failures.push(`${c.name}: buildPrMap.has(${ID}) -> ${map.has(ID)}, spec says ${c.expectClaimed}`);
      }
      // (b) fail-closed: an uncorroborated claim is DROPPED, never downgraded,
      //     never recorded, never left as an empty-but-present entry.
      clauses += 1;
      if (!c.expectClaimed && map.size !== 0) {
        failures.push(`${c.name}: fail-closed breached — map.size ${map.size}, expected 0`);
      }
      // (c) a surviving claim carries the whole PR through untouched, so the delivery
      //     record written downstream is the real one.
      clauses += 1;
      if (c.expectClaimed && map.get(ID)?.number !== 140) {
        failures.push(`${c.name}: surviving claim lost its PR — got ${JSON.stringify(map.get(ID))}`);
      }
    }
    assert.equal(clauses, EXPECTED_CASES * 3, "three clauses per case");
    assert.deepEqual(failures, [], `${failures.length} clause failures:\n` + failures.join("\n"));
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

  test("PR #140 claims no ticket in buildPrMap — BLZ-408 is not driven to done", () => {
    const map = buildPrMap([PR_140], blzFromRef, new Set());
    assert.equal(map.has("BLZ-408"), false, "BLZ-408 has never been worked; #140 must not speak for it");
    assert.equal(map.size, 0);
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
