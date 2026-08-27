// reconcile-selection-invariants.test.mjs — BLZ-395 + BLZ-398.
//
// WHY THIS FILE EXISTS. Five consecutive adversarial review rounds on this PR each found a
// real defect, and every one was the same SHAPE: a newly-added rule interacting wrongly with
// the existing PR-selection machinery. Not one was a typo.
//
//   round 2  the ambiguity refusal froze a rank-chosen record instead of preventing it
//   round 3  `samePr` decided identity on a field the forge controls
//   round 4  dropping an unnumberable PR deleted BLZ-130's veto — a SUBSTITUTION, not a
//            subtraction, because removing a candidate promotes the next-ranked one
//   round 5  the RECORDABLE tier outranked the title claim, so a docs chore was recorded
//            as having delivered an epic
//
// Every one was caught by an example. Examples arrive one round at a time, which is why
// this took five rounds. `buildPrMap`/`decide` now carries five interacting concerns —
// rank (status), title claim (deliverer), recordability (may it be written), ambiguity
// (should anything be written), and write-once (may it be replaced) — and the defect is
// always in how two of them ORDER against each other.
//
// So these are INVARIANTS, checked EXHAUSTIVELY over every candidate set drawn from a
// deliberately hostile pool, rather than one more example. They are the properties the
// whole lane's prose actually claims. If a future change breaks one, it fails here on the
// specific set that breaks it, in round zero rather than round six.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildPrMap, betterPr, decide, prTitleClaim, recordablePr } from "../scripts/reconcile.mjs";

const ID = "INF-645";
const idFromRef = () => ID;

// A pool covering every axis the comparator reads, including the shapes each round's
// defect turned on: an unrecordable strong claimant, a recordable weak one, equal claims
// separated only by number, and a state that ranks to zero.
const POOL = [
  { name: "merged/strong/10", state: "MERGED", number: 10, url: "u10",
    headRefName: `${ID}-a`, title: `${ID}: the real work` },
  { name: "merged/strong/40", state: "MERGED", number: 40, url: "u40",
    headRefName: `${ID}-b`, title: `${ID}: more of the work` },
  { name: "merged/strong/null", state: "MERGED", number: null, url: "u99",
    headRefName: `${ID}-c`, title: `${ID}: unnumberable real work` },
  { name: "merged/weak/40", state: "MERGED", number: 40, url: "u40w",
    headRefName: `${ID}-d`, title: `chore: tidy the runbook after ${ID}` },
  { name: "open/strong/41", state: "OPEN", number: 41, url: "u41",
    headRefName: `${ID}-e`, title: `${ID}: still in flight` },
  { name: "open/weak/null", state: "OPEN", number: null, url: "u42",
    headRefName: `${ID}-f`, title: `chore: follow-up for ${ID}` },
  { name: "closed/strong/7", state: "CLOSED", number: 7, url: "u7",
    headRefName: `${ID}-g`, title: `${ID}: abandoned attempt` },
  // The two house forms a hand-rolled /^INF-645:/ cannot see, and which the first draft of
  // this file therefore never exercised: the leading-id LIST that `idsFromSubject` exists
  // to parse, and a lowercase id (`claimCorroborated` and `idsFromSubject` are both /i).
  { name: "merged/list/5", state: "MERGED", number: 5, url: "u5",
    headRefName: `${ID}-h`, title: `${ID}, INF-646: joint work` },
  { name: "merged/lower/6", state: "MERGED", number: 6, url: "u6",
    headRefName: `${ID}-i`, title: "inf-645: lowercase is still a claim" },
];

/** Every non-empty subset of POOL, up to `max` members. */
function subsets(pool, max) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length) out.push([...acc]);
    if (acc.length === max) return;
    for (let i = start; i < pool.length; i += 1) walk(i + 1, [...acc, pool[i]]);
  };
  walk(0, []);
  return out;
}

function permutations(xs) {
  if (xs.length <= 1) return [xs];
  const out = [];
  for (let i = 0; i < xs.length; i += 1) {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([xs[i], ...p]);
  }
  return out;
}

const SETS = subsets(POOL, 3);
const RANK = { OPEN: 3, MERGED: 2, CLOSED: 1 };
const label = (s) => s.map((p) => p.name).join(" + ");

describe("BLZ-398: the selection is a function of the SET, not of the order it arrived in", () => {
  test("every candidate set picks the same winner under every permutation", () => {
    // Round 4's defect and round 5's were both order-sensitive in effect: the winner
    // changed with `codeRepos` scan order, or with which PR `gh` happened to list first.
    // A comparator that is not a strict weak ordering makes that unavoidable, and no
    // amount of example tests will find it reliably.
    for (const set of SETS) {
      const winners = new Set();
      for (const perm of permutations(set)) {
        const w = buildPrMap(perm, idFromRef, null).get(ID);
        winners.add(w ? w.name : "(none)");
      }
      assert.equal(winners.size, 1,
        `order changed the winner for [${label(set)}]: ${[...winners].join(" vs ")}`);
    }
  });

  test("betterPr is asymmetric — it never reports both directions as better", () => {
    for (const a of POOL) {
      for (const b of POOL) {
        if (a === b) continue;
        assert.equal(betterPr(a, b, ID) && betterPr(b, a, ID), false,
          `betterPr says both ${a.name} and ${b.name} beat each other`);
      }
    }
  });

  test("betterPr is transitive — a beats b beats c implies a beats c", () => {
    // Non-transitivity is the specific defect that makes a winner depend on comparison
    // order even when each individual comparison looks right.
    for (const a of POOL) {
      for (const b of POOL) {
        for (const c of POOL) {
          if (a === b || b === c || a === c) continue;
          if (betterPr(a, b, ID) && betterPr(b, c, ID)) {
            assert.ok(betterPr(a, c, ID),
              `${a.name} > ${b.name} > ${c.name}, but not ${a.name} > ${c.name}`);
          }
        }
      }
    }
  });

  test("anything beats nothing, however unusable it is", () => {
    for (const p of POOL) assert.equal(betterPr(p, null, ID), true, p.name);
    for (const p of POOL) assert.equal(betterPr(p, undefined, ID), true, p.name);
  });
});

describe("BLZ-130: the STATUS depends on the winning state, and on nothing else", () => {
  test("the target always matches the highest-ranked state in the set", () => {
    // The safety argument every tie-break change in this branch has rested on. Claim,
    // recordability and number decide only which PR the RECORD comes from; if any of them
    // could move a ticket, every one of those changes was unsafe.
    for (const set of SETS) {
      const top = Math.max(...set.map((p) => RANK[p.state]));
      const expected = top === 3 ? "in-review" : top === 2 ? "done" : "in-progress";
      const w = buildPrMap(set, idFromRef, null).get(ID);
      assert.ok(w, `no winner for [${label(set)}]`);
      assert.equal(decide({ pr: w }, "defined", "epic").target, expected,
        `[${label(set)}] should reach ${expected}`);
    }
  });

  test("an OPEN pull request in the set always vetoes done", () => {
    // BLZ-130 itself, as an invariant rather than an example. Round 4 broke exactly this
    // by dropping an unnumberable OPEN PR, and the example test that would have caught it
    // did not exist yet.
    for (const set of SETS) {
      if (!set.some((p) => p.state === "OPEN")) continue;
      const w = buildPrMap(set, idFromRef, null).get(ID);
      assert.notEqual(decide({ pr: w }, "defined", "epic").target, "done",
        `[${label(set)}] contains an OPEN PR and must not reach done`);
    }
  });
});

describe("BLZ-398: the record is never written from something Blaze cannot name", () => {
  test("an unrecordable winner writes NEITHER field", () => {
    for (const set of SETS) {
      const w = buildPrMap(set, idFromRef, null).get(ID);
      if (recordablePr(w)) continue;
      const d = decide({ pr: w }, "in-review", "epic");
      assert.equal(d.prVal, null, `[${label(set)}] wrote a pr from an unnumberable PR`);
      assert.equal(d.branchVal, null,
        `[${label(set)}] wrote a branch while withholding the pr — the record is one unit`);
    }
  });

  test("a recordable winner writes BOTH fields — the rule is not just 'refuse'", () => {
    // The direction that stops every test above from passing on an engine that records
    // nothing at all.
    for (const set of SETS) {
      const w = buildPrMap(set, idFromRef, null).get(ID);
      if (!recordablePr(w)) continue;
      // MERGED only: `decide` clamps the record on a terminal ticket unless the winning PR
      // is merged, so a non-merged winner proves nothing about the write here.
      if (w.state !== "MERGED") continue;
      const d = decide({ pr: w }, "in-review", "epic");
      assert.equal(d.prVal, `#${w.number} — ${w.url}`, `[${label(set)}]`);
      assert.equal(d.branchVal, w.headRefName, `[${label(set)}]`);
    }
  });

  test("between EQUAL claims at equal rank, a recordable PR always wins", () => {
    // The recordable tier's own contract, stated as an invariant. It exists because
    // `pr.number` is `null` for an unnumberable PR and `null < 10` is TRUE, so the number
    // tie-break handed the selection to the one PR that cannot supply a record — and the
    // ticket lost a record that was sitting right there. Demoting the tier below the claim
    // (round 5) must not have demoted it out of existence.
    for (const set of SETS) {
      const w = buildPrMap(set, idFromRef, null).get(ID);
      const peers = set.filter((p) =>
        RANK[p.state] === RANK[w.state] && prTitleClaim(p, ID) === prTitleClaim(w, ID));
      if (!peers.some((p) => recordablePr(p))) continue;
      assert.ok(recordablePr(w),
        `[${label(set)}] picked unrecordable ${w.name} while an equal-claim recordable peer existed`);
    }
  });

  test("a strong claim is never beaten by a weak one, whatever else differs", () => {
    // Round 5's defect as an invariant: within one rank, the ticket-titled PR wins, and
    // being unrecordable makes it write NOTHING rather than hand the record to a chore.
    for (const set of SETS) {
      const w = buildPrMap(set, idFromRef, null).get(ID);
      // `prTitleClaim`, the SHIPPED predicate — not a regex twin of it. Review found the
      // twin diverges on two house-legal titles (`INF-645, INF-646: joint work` and a
      // lowercase id), so this invariant would have raised false failures the moment
      // anyone added one to the pool. An invariant stated in terms of the wrong predicate
      // is the worst case of all: it fires on correct behaviour.
      const sameRank = set.filter((p) => RANK[p.state] === RANK[w.state]);
      const top = Math.max(...sameRank.map((p) => prTitleClaim(p, ID)));
      assert.equal(prTitleClaim(w, ID), top,
        `[${label(set)}] picked ${w.name} (claim ${prTitleClaim(w, ID)}) over a claim-${top} PR`);
    }
  });
});
