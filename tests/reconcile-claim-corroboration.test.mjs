// INF-735 — a branch/PR head ref alone must not attribute work to a ticket.
//
// `idFromRef` is an unanchored `\bKEY-(\d+)` match run against every branch and
// PR head ref in every one of a project's `codeRepos`. When a board/docs repo is
// itself a codeRepo for a project, its own branches claim that project's tickets
// they have nothing to do with — and a MERGED PR (PR_RANK 3) outranks the
// ticket's real repo, force-moving an unworked ticket to `done`. Terminal status
// is sticky and the MERGED signal never changes, so it re-asserts on every
// subsequent `reconcile --apply`.
//
// The fix: a ref-derived claim must be CORROBORATED by a second signal before it
// counts — the ticket id in the PR title, or a `KEY-n:` commit on the default
// branch (the existing `shippedSet`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { claimCorroborated } from "../scripts/reconcile.mjs";

test("claimCorroborated: a PR title naming the same id corroborates the ref's claim", () => {
  assert.equal(
    claimCorroborated("ZZZ-13", { title: "ZZZ-13: close the retirement epic" }),
    true,
  );
});

test("claimCorroborated: a PR title naming a DIFFERENT id does not corroborate", () => {
  // The regression shape: the branch is named for one ticket, the work is for others.
  assert.equal(
    claimCorroborated("ZZZ-28", { title: "docs: kickoff brief for the closeout (ZZZ-19, ZZZ-20)" }),
    false,
  );
});

test("claimCorroborated: a `KEY-n:` commit on the default branch corroborates a non-conventional title", () => {
  // Not every legitimate PR titles itself `KEY-n:`. A shipped commit is proof.
  assert.equal(
    claimCorroborated("ZZZ-10", { title: "docs: capture the epic", shippedSet: new Set(["ZZZ-10"]) }),
    true,
  );
});

test("claimCorroborated: an unrelated shippedSet does not corroborate", () => {
  assert.equal(
    claimCorroborated("ZZZ-28", {
      title: "docs: kickoff brief",
      shippedSet: new Set(["ZZZ-19", "ZZZ-20", "ZZZ-26"]),
    }),
    false,
  );
});

test("claimCorroborated: a longer id sharing a prefix does not corroborate — ZZZ-281 is not ZZZ-28", () => {
  assert.equal(claimCorroborated("ZZZ-28", { title: "ZZZ-281: unrelated work" }), false);
});

test("claimCorroborated: matching is case-insensitive, as idFromRef already is", () => {
  // Real refs are frequently lowercased: `zzz-93-some-slug`.
  assert.equal(claimCorroborated("ZZZ-93", { title: "zzz-93: deploy-path observability epic" }), true);
});

test("claimCorroborated: a missing title with no shipped signal does not corroborate", () => {
  assert.equal(claimCorroborated("ZZZ-28", {}), false);
});
