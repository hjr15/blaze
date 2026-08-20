// tests/model/ac-blocks.test.mjs — BLZ-279, design D6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findAcSection, parseAcBlocks } from "../../scripts/model/ac-blocks.mjs";

const doc = (heading, ...lines) => ["# T", "", "intro", "", heading, ...lines, "", "## Notes", "after"].join("\n");

// --- the finding that costs 153 tickets if missed --------------------------------
test("the heading match is CASE-INSENSITIVE — 153 live tickets depend on it", () => {
  for (const h of ["## Acceptance Criteria", "## Acceptance criteria",
                   "## acceptance criteria", "### Acceptance Criteria"]) {
    const r = parseAcBlocks(doc(h, "- [ ] one"));
    assert.equal(r.blocks.length, 1, `heading not found: ${h}`);
    assert.equal(r.heading, h, "the heading is preserved verbatim for a byte-exact round-trip");
  }
});

test("a case-SENSITIVE matcher would silently drop them — this is what that looks like", () => {
  // The brief's own grep is `^#{1,3} +Acceptance Criteria`, and today's regex matches
  // it. Against a lower-case `c` it finds nothing and returns no criteria at all —
  // no error, no warning, just an empty AC section in the database.
  const CASE_SENSITIVE = /^#{1,3}[ \t]+Acceptance[ \t]+Criteria[ \t]*$/;
  const body = doc("## Acceptance criteria", "- [x] done", "- [ ] todo");
  assert.equal(body.split("\n").some((l) => CASE_SENSITIVE.test(l)), false,
    "the case-sensitive matcher finds nothing");
  assert.equal(parseAcBlocks(body).blocks.length, 2, "ours finds both criteria");
});

test("near-miss headings are still AC sections, and are flagged as inexact", () => {
  for (const h of ["## Acceptance", "## AC", "## Acceptance Criteria (mitigation)"]) {
    const r = parseAcBlocks(doc(h, "- [ ] one"));
    assert.equal(r.blocks.length, 1, `not found: ${h}`);
  }
  assert.equal(parseAcBlocks(doc("## Acceptance Criteria", "- [ ] x")).exact, true);
  assert.equal(parseAcBlocks(doc("## AC", "- [ ] x")).exact, false,
    "so a migration can report how many sections were matched loosely");
});

// --- nothing is refused ----------------------------------------------------------
test("prose, plain bullets and ordered items become notes rather than being refused", () => {
  const r = parseAcBlocks(doc("## Acceptance Criteria",
    "Some framing prose.", "- [ ] a real criterion", "- a plain bullet", "1. an ordered item"));
  assert.deepEqual(r.blocks.map((b) => b.kind), ["note", "criterion", "note", "note"]);
  assert.deepEqual(r.blocks.map((b) => b.ord), [0, 1, 2, 3]);
  assert.equal(r.blocks[0].text, "Some framing prose.");
});

test("checked state is read from the box, and notes are never checked", () => {
  const r = parseAcBlocks(doc("## Acceptance Criteria", "- [x] done", "- [X] also done", "- [ ] not", "prose"));
  assert.deepEqual(r.blocks.map((b) => b.checked), [true, true, false, false]);
});

// --- the wrap join: 2,751 lines across the corpus --------------------------------
test("a soft-wrapped criterion is rejoined, not truncated at the wrap", () => {
  const r = parseAcBlocks(doc("## Acceptance Criteria",
    "- [ ] this criterion runs on", "      to a second line", "      and a third"));
  assert.equal(r.blocks.length, 1, "one criterion, not three blocks");
  assert.equal(r.blocks[0].text, "this criterion runs on to a second line and a third");
});

test("an indented LIST item after a criterion starts a new block, it is not a wrap", () => {
  const r = parseAcBlocks(doc("## Acceptance Criteria", "- [ ] parent", "  - a nested bullet"));
  assert.deepEqual(r.blocks.map((b) => b.kind), ["criterion", "note"]);
  assert.equal(r.blocks[0].text, "parent", "the nested bullet must NOT be swallowed into it");
});

test("an indented line with no preceding criterion is a note, not a crash", () => {
  const r = parseAcBlocks(doc("## Acceptance Criteria", "   orphaned indented text"));
  assert.deepEqual(r.blocks.map((b) => b.kind), ["note"]);
});

// --- boundaries ------------------------------------------------------------------
test("the section ends at the next heading of any level", () => {
  const r = parseAcBlocks(doc("## Acceptance Criteria", "- [ ] inside"));
  assert.equal(r.blocks.length, 1, "'after', under ## Notes, must not be included");
});

test("a fenced block is carried verbatim, including lines that look like criteria", () => {
  const r = parseAcBlocks(doc("## Acceptance Criteria", "```", "- [ ] not a real criterion", "```"));
  assert.deepEqual(r.blocks.map((b) => b.kind), ["note", "note", "note"]);
});

test("a ticket with no AC section yields no blocks and no heading", () => {
  assert.deepEqual(parseAcBlocks("# T\n\njust a body\n"), { heading: null, blocks: [], exact: false });
  assert.equal(findAcSection("no section here"), null);
});

test("empty and nullish bodies do not throw", () => {
  for (const b of ["", null, undefined]) assert.deepEqual(parseAcBlocks(b).blocks, []);
});
