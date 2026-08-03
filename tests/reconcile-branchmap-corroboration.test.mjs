// INF-735 — the branch half of the ref-name-is-not-evidence defect.
//
// Gating only PRs is an incomplete fix. Drop a bogus PR's claim and the branch it
// was opened from is still sitting there, so `decide()` takes the `branch` path
// and moves the ticket to `in-progress` with bogus `branch:` frontmatter. Less
// damaging than a forced `done`, still wrong — and it would immediately re-corrupt
// any ticket repaired by hand.
//
// A branch has no title to read, so its evidence is its own commit subjects
// (`KEY-n: desc`, which `idFromSubject` already parses), the shipped signal, or —
// when it has no commits of its own — whether it is a FRESH branch or a stale
// fully-merged one. Those two look identical to `git log <ref> ^<default>` (both
// empty) but mean opposite things, which is the trap this file pins down.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBranchMap } from "../scripts/reconcile.mjs";

const idFromRef = (ref) => {
  const m = /\bZZZ-(\d+)/i.exec(ref || "");
  return m ? `ZZZ-${m[1]}` : null;
};

// Stand-in for the per-branch git reads: the subjects unique to the branch
// (`git log <ref> ^<default>`), and whether the branch tip IS the default tip.
//   { own: [...] }   -> branch has its own commits
//   { fresh: true }  -> `git checkout -b X`, tip == default tip, nothing committed
//   {}               -> no own commits AND tip != default tip: a stale merged branch
const inspectFrom = (table) => (ref) => ({
  own: (table[ref] || {}).own || [],
  sameTipAsDefault: Boolean((table[ref] || {}).fresh),
});

test("buildBranchMap: a branch whose own commits name the ticket is claimed", () => {
  const map = buildBranchMap(["ZZZ-13-close"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({ "ZZZ-13-close": { own: ["ZZZ-13: close the retirement epic"] } }),
  });
  assert.equal(map.get("ZZZ-13"), "ZZZ-13-close");
});

test("buildBranchMap: a branch named for a ticket it has no commits for is NOT claimed", () => {
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-28-docs-kickoff-brief": {
        own: ["docs: kickoff brief for the closeout", "ZZZ-19: retire the stale plan docs"],
      },
    }),
  });
  assert.equal(map.has("ZZZ-28"), false, "a ref name alone must not claim ZZZ-28");
  assert.equal(map.size, 0);
});

test("buildBranchMap: shippedSet corroborates a branch with no matching commit subject", () => {
  const map = buildBranchMap(["zzz-10-close"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(["ZZZ-10"]),
    inspect: inspectFrom({ "zzz-10-close": { own: ["docs: capture the epic"] } }),
  });
  assert.equal(map.get("ZZZ-10"), "zzz-10-close");
});

test("buildBranchMap: first corroborated branch wins, as before", () => {
  const map = buildBranchMap(["ZZZ-500-first", "ZZZ-500-second"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-500-first": { own: ["ZZZ-500: first"] },
      "ZZZ-500-second": { own: ["ZZZ-500: second"] },
    }),
  });
  assert.equal(map.get("ZZZ-500"), "ZZZ-500-first");
});

test("buildBranchMap: an uncorroborated branch does not shadow a later corroborated one", () => {
  const map = buildBranchMap(["ZZZ-500-bogus", "ZZZ-500-real"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-500-bogus": { own: ["docs: unrelated"] },
      "ZZZ-500-real": { own: ["ZZZ-500: the actual work"] },
    }),
  });
  assert.equal(map.get("ZZZ-500"), "ZZZ-500-real");
});

test("buildBranchMap: a FRESH branch (tip == default tip) is claimed on its name", () => {
  // `git checkout -b ZZZ-501-fix` and nothing else. Nothing contradicts the name,
  // and this is the ordinary "branched, about to work" signal the branch path
  // exists to catch. Gating it would delete the feature rather than fix the defect.
  const map = buildBranchMap(["you/ZZZ-501-fix-thing"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({ "you/ZZZ-501-fix-thing": { fresh: true } }),
  });
  assert.equal(map.get("ZZZ-501"), "you/ZZZ-501-fix-thing");
});

test("buildBranchMap: a STALE fully-merged branch is NOT claimed, though it also has no own commits", () => {
  // The live regression the first cut of this fix missed. `origin/INF-728-…` was
  // fully merged, so `git log <ref> ^<default>` came back empty — identical to a
  // fresh branch — and reconcile re-claimed the ticket and moved it back to
  // `in-progress`, undoing a hand repair.
  //
  // The discriminator is the tip: a fresh branch sits AT the default tip, a merged
  // one sits behind it. A fully-merged branch has nothing outstanding and is never
  // evidence of work in progress.
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({ "ZZZ-28-docs-kickoff-brief": {} }), // no own commits, behind default
  });
  assert.equal(map.has("ZZZ-28"), false,
    "a merged-and-behind branch must not signal in-progress");
  assert.equal(map.size, 0);
});

test("buildBranchMap: a branch WITH commits, none naming the ticket, is still rejected", () => {
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-28-docs-kickoff-brief": { own: ["docs: kickoff brief for the closeout"] },
    }),
  });
  assert.equal(map.has("ZZZ-28"), false);
});

test("buildBranchMap: a ref with no id is ignored", () => {
  const map = buildBranchMap(["chore/tidy"], idFromRef, {
    key: "ZZZ", shippedSet: new Set(), inspect: inspectFrom({}),
  });
  assert.equal(map.size, 0);
});
