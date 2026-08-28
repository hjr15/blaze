// INF-735 — the corroboration gate wired into PR-map construction.
//
// `claimCorroborated` on its own changes nothing; this is the seam where a
// ref-derived claim is actually accepted or dropped, and where the PR_RANK
// contest that let a MERGED cross-repo PR outrank a ticket's real repo happens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrMap, decide } from "../scripts/reconcile.mjs";

const idFromRef = (ref) => {
  const m = /\bZZZ-(\d+)/i.exec(ref || "");
  return m ? `ZZZ-${m[1]}` : null;
};

test("buildPrMap: an uncorroborated merged PR cannot deliver the ticket", () => {
  // The live regression: a board-repo PR named for a ticket it never touched
  // drove that ticket to `done`.
  //
  // BLZ-440 round 2 CHANGED WHAT THIS ASSERTS, and the change is the point. This used to
  // assert `map.size === 0` — that the claim was DROPPED. Dropping is a SUBSTITUTION:
  // `decide` reads the top-ranked PR and OPEN outranks MERGED, so removing a candidate
  // promotes the next one. The claim is now NEUTERED instead: it stays in the pool and
  // is refused a record and a forward target, which is what "must not claim the ticket"
  // was always trying to say.
  const prs = [{
    number: 37, state: "MERGED", url: "u37",
    headRefName: "ZZZ-28-docs-kickoff-brief",
    title: "docs: kickoff brief for the closeout (ZZZ-19, ZZZ-20)",
  }];
  const map = buildPrMap(prs, idFromRef, new Set());
  assert.equal(map.get("ZZZ-28").uncorroborated, true, "a ref name alone is not evidence");
  const d = decide({ pr: map.get("ZZZ-28") }, "defined", "epic");
  assert.equal(d.target, "defined", "ZZZ-28 must not be moved by a ref name alone");
  assert.equal(d.prVal, null);
  assert.equal(d.branchVal, null);
});

test("buildPrMap: a corroborated PR still claims the ticket", () => {
  const prs = [{
    number: 35, state: "MERGED", url: "u35",
    headRefName: "ZZZ-13-close", title: "ZZZ-13: close the retirement epic",
  }];
  const map = buildPrMap(prs, idFromRef, new Set());
  assert.equal(map.get("ZZZ-13").number, 35);
});

test("buildPrMap: shippedSet corroborates a PR whose title breaks convention", () => {
  const prs = [{
    number: 28, state: "MERGED", url: "u28",
    headRefName: "zzz-10-close", title: "docs: capture the epic",
  }];
  const map = buildPrMap(prs, idFromRef, new Set(["ZZZ-10"]));
  assert.equal(map.get("ZZZ-10").number, 28);
});

// BLZ-130 INVERTED THIS. It previously asserted MERGED beats OPEN, which is the
// defect stated as an invariant: an early docs-only PR merging under an epic's key
// drove the epic to done while the PR carrying its work was still open. Corroboration
// (INF-735, this file's subject) is untouched — the gate still runs first and still
// drops uncorroborated claims. Only the contest BETWEEN two surviving claims moved.
test("buildPrMap: an OPEN PR beats a MERGED one — work outstanding is not work shipped", () => {
  const prs = [
    { number: 1, state: "OPEN", url: "u1", headRefName: "ZZZ-500-a", title: "ZZZ-500: open work" },
    { number: 2, state: "MERGED", url: "u2", headRefName: "ZZZ-500-b", title: "ZZZ-500: merged work" },
  ];
  const map = buildPrMap(prs, idFromRef, new Set());
  assert.equal(map.get("ZZZ-500").number, 1);
  assert.equal(map.get("ZZZ-500").state, "OPEN");
});

test("buildPrMap: an uncorroborated OPEN claim keeps its veto but delivers nothing", () => {
  // THE STATES ARE DELIBERATELY THIS WAY ROUND, and two adversarial reviews are why.
  //
  // This test used to put the bogus claim on MERGED and the real one on OPEN. That
  // was the original bug's shape, and under BLZ-130's reversed rank (OPEN 3, MERGED 2)
  // it became VACUOUS: deleting the corroboration gate outright left it green, because
  // the rank alone now picks OPEN. A control that passes with the control removed is
  // not a control.
  //
  // BLZ-440 round 2 then inverted the EXPECTATION, not the fixture. Round 1 asserted the
  // corroborated MERGED PR wins here — which is only true because the uncorroborated
  // OPEN one was DROPPED, and dropping it is exactly how an `in-review` ticket got taken
  // to `done` with a write-once record naming the wrong PR. The uncorroborated OPEN PR
  // now WINS the rank, because that is BLZ-130's veto doing its job, and is then refused
  // any power to move the ticket or write the record. Blank and true, instead of filled
  // and false.
  const prs = [
    { number: 37, state: "OPEN", url: "u37", headRefName: "ZZZ-28-docs-kickoff-brief",
      title: "docs: kickoff brief for the closeout" },
    { number: 40, state: "MERGED", url: "u40", headRefName: "ZZZ-28-real-work",
      title: "ZZZ-28: the work this ticket actually describes" },
  ];
  const map = buildPrMap(prs, idFromRef, new Set());
  assert.equal(map.get("ZZZ-28").number, 37, "the OPEN PR keeps the veto its state earns");
  assert.equal(map.get("ZZZ-28").uncorroborated, true);
  const d = decide({ pr: map.get("ZZZ-28") }, "in-review", "epic");
  assert.equal(d.target, "in-review", "no promotion of the merged PR behind it");
  assert.equal(d.prVal, null);
  assert.equal(d.resolution, undefined);
});

test("buildPrMap: a ref with no id is still ignored", () => {
  const map = buildPrMap(
    [{ number: 9, state: "MERGED", url: "u", headRefName: "chore/tidy", title: "chore: tidy" }],
    idFromRef, new Set(),
  );
  assert.equal(map.size, 0);
});
