// INF-735 — the branch half of the same defect.
//
// Gating only PRs is an incomplete fix. Drop a bogus PR's claim and the branch it
// was opened from is still sitting there, so `decide()` takes the `branch` path
// and moves the ticket to `in-progress` with bogus `branch:` frontmatter. Less
// damaging than a forced `done`, still wrong — and it would immediately re-corrupt
// any ticket repaired by hand.
//
// A branch has no title to read, so its evidence is its own commit subjects
// (`KEY-n: desc`, which `idFromSubject` already parses) or the shipped signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBranchMap } from "../scripts/reconcile.mjs";

const idFromRef = (ref) => {
  const m = /\bZZZ-(\d+)/i.exec(ref || "");
  return m ? `ZZZ-${m[1]}` : null;
};

// Stand-in for `git log <ref> ^<default> --format=%s`.
const subjectsFrom = (table) => (ref) => table[ref] || [];

test("buildBranchMap: a branch whose own commits name the ticket is claimed", () => {
  const map = buildBranchMap(["ZZZ-13-close"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    subjectsFor: subjectsFrom({ "ZZZ-13-close": ["ZZZ-13: close the retirement epic"] }),
  });
  assert.equal(map.get("ZZZ-13"), "ZZZ-13-close");
});

test("buildBranchMap: a branch named for a ticket it has no commits for is NOT claimed", () => {
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    subjectsFor: subjectsFrom({
      "ZZZ-28-docs-kickoff-brief": [
        "docs: kickoff brief for the closeout",
        "ZZZ-19: retire the stale plan docs",
      ],
    }),
  });
  assert.equal(map.has("ZZZ-28"), false, "a ref name alone must not claim ZZZ-28");
  assert.equal(map.size, 0);
});

test("buildBranchMap: shippedSet corroborates a branch with no matching commit subject", () => {
  const map = buildBranchMap(["zzz-10-close"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(["ZZZ-10"]),
    subjectsFor: subjectsFrom({ "zzz-10-close": ["docs: capture the epic"] }),
  });
  assert.equal(map.get("ZZZ-10"), "zzz-10-close");
});

test("buildBranchMap: first corroborated branch wins, as before", () => {
  const map = buildBranchMap(["ZZZ-500-first", "ZZZ-500-second"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    subjectsFor: subjectsFrom({
      "ZZZ-500-first": ["ZZZ-500: first"],
      "ZZZ-500-second": ["ZZZ-500: second"],
    }),
  });
  assert.equal(map.get("ZZZ-500"), "ZZZ-500-first");
});

test("buildBranchMap: an uncorroborated branch does not shadow a later corroborated one", () => {
  // Ordering must not let a bogus ref squat the id and block the real branch.
  const map = buildBranchMap(["ZZZ-500-bogus", "ZZZ-500-real"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    subjectsFor: subjectsFrom({
      "ZZZ-500-bogus": ["docs: unrelated"],
      "ZZZ-500-real": ["ZZZ-500: the actual work"],
    }),
  });
  assert.equal(map.get("ZZZ-500"), "ZZZ-500-real");
});

test("buildBranchMap: a fresh branch with no commits of its own is claimed on its name", () => {
  // `git checkout -b ZZZ-501-fix` and nothing else. There is no content to
  // contradict the name, and this is the ordinary "branched, about to work"
  // signal the branch path exists to catch. Gating it would delete the feature
  // rather than fix the defect.
  const map = buildBranchMap(["you/ZZZ-501-fix-thing"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    subjectsFor: subjectsFrom({}), // no unique commits
  });
  assert.equal(map.get("ZZZ-501"), "you/ZZZ-501-fix-thing");
});

test("buildBranchMap: a branch WITH commits, none naming the ticket, is still rejected", () => {
  // The distinction that makes the rule coherent: once a branch has content, that
  // content is the evidence. A squash-merged PR leaves its originals unreachable
  // from the default branch, so they remain the branch's own commits.
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    subjectsFor: subjectsFrom({
      "ZZZ-28-docs-kickoff-brief": ["docs: kickoff brief for the closeout"],
    }),
  });
  assert.equal(map.has("ZZZ-28"), false);
});

test("buildBranchMap: a ref with no id is ignored", () => {
  const map = buildBranchMap(["chore/tidy"], idFromRef, {
    key: "ZZZ", shippedSet: new Set(), subjectsFor: subjectsFrom({}),
  });
  assert.equal(map.size, 0);
});
