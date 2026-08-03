// INF-735 — the corroboration gate wired into PR-map construction.
//
// `claimCorroborated` on its own changes nothing; this is the seam where a
// ref-derived claim is actually accepted or dropped, and where the PR_RANK
// contest that let a MERGED cross-repo PR outrank a ticket's real repo happens.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrMap } from "../scripts/reconcile.mjs";

const idFromRef = (ref) => {
  const m = /\bZZZ-(\d+)/i.exec(ref || "");
  return m ? `ZZZ-${m[1]}` : null;
};

test("buildPrMap: an uncorroborated merged PR does not claim the ticket", () => {
  // The live regression: a board-repo PR named for a ticket it never touched
  // drove that ticket to `done`.
  const prs = [{
    number: 37, state: "MERGED", url: "u37",
    headRefName: "ZZZ-28-docs-kickoff-brief",
    title: "docs: kickoff brief for the closeout (ZZZ-19, ZZZ-20)",
  }];
  const map = buildPrMap(prs, idFromRef, new Set());
  assert.equal(map.has("ZZZ-28"), false, "ZZZ-28 must not be claimed by a ref name alone");
  assert.equal(map.size, 0);
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

test("buildPrMap: rank contest is unchanged for corroborated PRs — MERGED beats OPEN", () => {
  const prs = [
    { number: 1, state: "OPEN", url: "u1", headRefName: "ZZZ-500-a", title: "ZZZ-500: open work" },
    { number: 2, state: "MERGED", url: "u2", headRefName: "ZZZ-500-b", title: "ZZZ-500: merged work" },
  ];
  const map = buildPrMap(prs, idFromRef, new Set());
  assert.equal(map.get("ZZZ-500").number, 2);
  assert.equal(map.get("ZZZ-500").state, "MERGED");
});

test("buildPrMap: an uncorroborated MERGED PR cannot outrank a corroborated OPEN one", () => {
  // The ranking half of the bug: MERGED (rank 3) beat the real repo's OPEN
  // (rank 2). Dropping the bogus claim must leave the real one standing.
  const prs = [
    { number: 37, state: "MERGED", url: "u37", headRefName: "ZZZ-28-docs-kickoff-brief",
      title: "docs: kickoff brief for the closeout" },
    { number: 40, state: "OPEN", url: "u40", headRefName: "ZZZ-28-real-work",
      title: "ZZZ-28: the work this ticket actually describes" },
  ];
  const map = buildPrMap(prs, idFromRef, new Set());
  assert.equal(map.get("ZZZ-28").number, 40);
  assert.equal(map.get("ZZZ-28").state, "OPEN");
});

test("buildPrMap: a ref with no id is still ignored", () => {
  const map = buildPrMap(
    [{ number: 9, state: "MERGED", url: "u", headRefName: "chore/tidy", title: "chore: tidy" }],
    idFromRef, new Set(),
  );
  assert.equal(map.size, 0);
});
