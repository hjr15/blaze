// tests/transitions-id-parse.test.mjs — BLZ-233.
//
// `parseTransitions` derives a ticket id from the moved file's path. The id group was
// greedy (`[^/]+-\d+`), so any slug ENDING IN A DIGIT was swallowed whole: a move of
// `INF-783-…-tier-0.md` was recorded under the id `INF-783-…-tier-0`, which is not a
// ticket. Measured on the live board when this was filed: 86 of 314 transitions — 27% —
// carried a key that resolved to no ticket, and delivery metrics derive from that history.
//
// The bug is invisible: nothing errors, the cache is well-formed, and the counts look
// plausible. These tests pin the id, not the parse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTransitions } from "../scripts/model/transitions.mjs";

const NUL = "\0";
/** One rename record, in the shape `git log --diff-filter=R --name-status` emits. */
function log(from, to, sha = "abc123", ts = "2026-08-11T00:00:00+00:00") {
  return `${NUL}${sha}${NUL}${ts}\nR100\t${from}\t${to}`;
}

test("a slug ending in a letter parses to the bare id", () => {
  const out = parseTransitions(log(
    "projects/ACA/defined/ACA-2-audit-engine-v1-stand-up.md",
    "projects/ACA/done/ACA-2-audit-engine-v1-stand-up.md",
  ));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "ACA-2");
});

test("a slug ending in a DIGIT parses to the bare id, not the whole slug", () => {
  const out = parseTransitions(log(
    "projects/INF/defined/INF-783-repair-the-drift-left-by-the-tier-0.md",
    "projects/INF/done/INF-783-repair-the-drift-left-by-the-tier-0.md",
  ));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "INF-783");
});

test("a slug that itself contains a ticket-shaped suffix still parses to the owning id", () => {
  const out = parseTransitions(log(
    "projects/OBA/defined/OBA-732-oba-720.md",
    "projects/OBA/done/OBA-732-oba-720.md",
  ));
  assert.equal(out[0].id, "OBA-732");
});

test("a slugless filename still parses", () => {
  const out = parseTransitions(log(
    "projects/BLZ/defined/BLZ-9.md",
    "projects/BLZ/done/BLZ-9.md",
  ));
  assert.equal(out[0].id, "BLZ-9");
});

test("from/to statuses are carried through", () => {
  const out = parseTransitions(log(
    "projects/INF/in-review/INF-785-run-the-2022.md",
    "projects/INF/done/INF-785-run-the-2022.md",
  ));
  assert.deepEqual(
    { id: out[0].id, from: out[0].from, to: out[0].to },
    { id: "INF-785", from: "in-review", to: "done" },
  );
});

test("a pure slug rename inside one status is not a transition", () => {
  const out = parseTransitions(log(
    "projects/INF/done/INF-785-old-title-2022.md",
    "projects/INF/done/INF-785-new-title-2023.md",
  ));
  assert.equal(out.length, 0);
});

test("every parsed id is a bare KEY-n", () => {
  const paths = [
    ["projects/INF/defined/INF-782-trading-system-review-phase-4.md", "projects/INF/done/INF-782-trading-system-review-phase-4.md"],
    ["projects/INF/defined/INF-784-metals-play-review-4-5.md", "projects/INF/done/INF-784-metals-play-review-4-5.md"],
    ["projects/INF/defined/INF-787-home-bias-depth-rec-14.md", "projects/INF/done/INF-787-home-bias-depth-rec-14.md"],
  ];
  for (const [from, to] of paths) {
    const [t] = parseTransitions(log(from, to));
    assert.match(t.id, /^[A-Za-z]+-\d+$/, `${from} parsed to a non-id: ${t.id}`);
  }
});
