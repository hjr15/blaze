// tests/model/import-deps.test.mjs — BLZ-387 / BLZ-360 §5.5.
//
// THE TOOL NEVER GUESSES, and that is the whole design:
//
//   "A machine that picks a direction for a mutual pair is right half the time, and the wrong
//    half becomes an invisible schedule error."
//
// Measured on the live board: 392 directed `Blocks` edges, of which 248 (63.3%) sit in 124
// mutual pairs. The majority of the corpus carries NO usable direction, because frontmatter has
// no way to write the inverse — so "is blocked by" gets written as a second `Blocks` from the
// other end. Proposing a direction for those is the one thing this tool must not do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDependencyImport, DISPOSITION } from "../../scripts/model/import-deps.mjs";

const t = (id, over = {}) => ({ id, type: "task", status: "defined", ...over });
const b = (src, target) => ({ type: "Blocks", src, target });
const plan = (tickets, links) => planDependencyImport({ tickets, links });
const by = (p, k) => p.edges.filter((e) => e.disposition === k);
const pairKey = (e) => `${e.src}->${e.target}`;

test("a one-directional Blocks edge gets a PROPOSED Precedes direction", () => {
  const p = plan([t("A"), t("B")], [b("A", "B")]);
  assert.deepEqual(by(p, DISPOSITION.PROPOSED).map(pairKey), ["A->B"]);
  assert.equal(p.counts.proposed, 1);
});

test("A MUTUAL PAIR IS UNDECIDABLE, AND THE TOOL EMITS NO DIRECTION FOR IT", () => {
  // The criterion, and it is stated as "never emits a direction" rather than as a count.
  const p = plan([t("A"), t("B")], [b("A", "B"), b("B", "A")]);
  const und = by(p, DISPOSITION.UNDECIDABLE);
  assert.equal(und.length, 2, "both halves are reported, so the operator sees the whole pair");
  for (const e of und) {
    assert.equal(e.proposed, null, `${pairKey(e)} carries a proposed direction and must not`);
    assert.match(e.reason, /mutual pair/);
  }
  assert.deepEqual(by(p, DISPOSITION.PROPOSED), [], "nothing in a mutual pair is ever proposed");
  assert.equal(p.counts.mutualPairs, 1);
});

test("no undecidable edge anywhere in a mixed corpus carries a direction", () => {
  // The property, asserted over the whole result rather than one fixture.
  const p = plan([t("A"), t("B"), t("C"), t("D")],
    [b("A", "B"), b("B", "A"), b("C", "D"), b("A", "C"), b("C", "A")]);
  for (const e of p.edges) {
    if (e.disposition === DISPOSITION.UNDECIDABLE) assert.equal(e.proposed, null, pairKey(e));
  }
  assert.equal(p.counts.mutualPairs, 2);
  assert.deepEqual(by(p, DISPOSITION.PROPOSED).map(pairKey), ["C->D"]);
});

test("the endpoint default-deny REFUSES an edge and says which kind refused it", () => {
  // §5.4: the default-deny does most of the cleanup for free — 58 of 392, 36 of them
  // risk<->feature. "A risk does not belong in a delivery critical path."
  const p = plan([t("R", { type: "risk", status: "identified" }), t("F", { type: "feature" })],
    [b("R", "F")]);
  const ref = by(p, DISPOSITION.REFUSED);
  assert.deepEqual(ref.map(pairKey), ["R->F"]);
  assert.match(ref[0].reason, /risk/, "the message names the kind that refused it");
  assert.equal(ref[0].proposed, null);
});

test("a refused edge is REPORTED, never silently dropped", () => {
  const p = plan([t("G", { type: "goal" }), t("F", { type: "feature" })], [b("G", "F")]);
  assert.equal(p.edges.length, 1, "it is still in the report");
  assert.equal(p.counts.refused, 1);
});

test("the counts reconcile to the input, so no edge falls through a gap", () => {
  const p = plan(
    [t("A"), t("B"), t("C"), t("R", { type: "risk", status: "identified" })],
    [b("A", "B"), b("B", "A"), b("A", "C"), b("R", "A"), b("A", "GHOST")]);
  const c = p.counts;
  assert.equal(c.proposed + c.undecidable + c.refused + c.dangling, c.total);
  assert.equal(c.total, 5);
  assert.equal(p.edges.length, 5);
});

test("an edge whose target does not resolve is reported as dangling, not proposed", () => {
  const p = plan([t("A")], [b("A", "GHOST-1")]);
  assert.deepEqual(by(p, DISPOSITION.DANGLING).map(pairKey), ["A->GHOST-1"]);
  assert.equal(by(p, DISPOSITION.DANGLING)[0].proposed, null);
});

test("a non-Blocks link is not an input to the import at all", () => {
  const p = plan([t("A"), t("B")], [{ type: "Relates", src: "A", target: "B" }]);
  assert.deepEqual(p.edges, []);
  assert.equal(p.counts.total, 0);
});

test("an edge whose target is TERMINAL is offered, and flagged that the solve will drop it", () => {
  // Spec 3 §13.4 leaves genuinely open whether import-deps should OFFER an edge whose target is
  // terminal, given §6.2's node filter discards it. DECIDED HERE: offer it, flagged. The operator
  // is resolving a half-migrated graph and a target that is `done` today may be reopened; hiding
  // the edge would make that decision for them, which is the thing §5.5 forbids.
  const p = plan([t("A"), t("D", { status: "done" })], [b("A", "D")]);
  const e = p.edges[0];
  assert.equal(e.disposition, DISPOSITION.PROPOSED);
  assert.equal(e.terminal_target, true);
  assert.match(e.note, /terminal.*solve will drop it/i);
  assert.equal(p.counts.terminalTarget, 1);
});

test("a self-edge is refused rather than proposed", () => {
  const p = plan([t("A")], [b("A", "A")]);
  assert.equal(by(p, DISPOSITION.PROPOSED).length, 0);
  assert.match(p.edges[0].reason, /self/);
});

test("the report is sorted, so two runs over the same board are byte-identical", () => {
  const tickets = [t("C"), t("A"), t("B")];
  const links = [b("B", "C"), b("A", "B"), b("A", "C")];
  const a = plan(tickets, links);
  const z = plan([...tickets].reverse(), [...links].reverse());
  assert.equal(JSON.stringify(a), JSON.stringify(z));
  assert.deepEqual(a.edges.map(pairKey), ["A->B", "A->C", "B->C"]);
});

test("nothing lints Blocks against Precedes — they coexist and need not agree", () => {
  // §5.5: "nothing lints them against each other — that would be a rule with no correct answer
  // while §5.5 is in progress." ADR-0001 is not reversed.
  const p = plan([t("A"), t("B")], [b("A", "B")]);
  assert.ok(!("conflicts" in p), "an agreement check would be a rule with no correct answer");
  assert.ok(!("lint" in p));
});

test("a mutual pair refused by the endpoint rule is REFUSED, and still never proposed", () => {
  // Measured, and it reconciles two numbers that look like a contradiction and are not.
  // §5.5's 124 mutual pairs are counted over the RAW 392-edge Blocks graph. This tool applies
  // the endpoint default-deny FIRST, so it reports 102 — the 22 difference are pairs with an
  // endpoint Precedes refuses outright, and calling those "undecidable" would be wrong. There
  // is nothing to decide about an edge that can never become a Precedes edge; "refused" is the
  // stronger and more useful statement. Both figures are right about different populations.
  //
  // What must hold across BOTH populations is the actual criterion: no mutual pair, however it
  // is classified, ever receives a proposed direction.
  const p = plan([t("R", { type: "risk", status: "identified" }), t("F", { type: "feature" })],
    [b("R", "F"), b("F", "R")]);
  assert.deepEqual(by(p, DISPOSITION.PROPOSED), [], "not one direction proposed for a mutual pair");
  assert.equal(p.counts.refused, 2, "the kind filter runs first, so these are refused");
  assert.equal(p.counts.mutualPairs, 0, "and they are not counted among the decidable-population pairs");
});

test("THE CRITERION, over a mixed population: no mutually-linked ticket pair is ever proposed", () => {
  // Asserted as a property over every edge rather than as a count, because a count can be right
  // while a single pair slips through.
  const tickets = [t("A"), t("B"), t("C"), t("D"),
    t("R", { type: "risk", status: "identified" }), t("G", { type: "goal" })];
  const links = [b("A", "B"), b("B", "A"), b("C", "D"), b("R", "A"), b("A", "R"),
    b("G", "C"), b("C", "G"), b("B", "C")];
  const p = plan(tickets, links);
  const mutual = new Set();
  const seen = new Set(links.map((l) => `${l.src} ${l.target}`));
  for (const l of links) if (seen.has(`${l.target} ${l.src}`)) mutual.add(`${l.src}->${l.target}`);
  for (const e of by(p, DISPOSITION.PROPOSED)) {
    assert.ok(!mutual.has(pairKey(e)), `${pairKey(e)} is half of a mutual pair and was PROPOSED`);
  }
  assert.deepEqual(by(p, DISPOSITION.PROPOSED).map(pairKey), ["B->C", "C->D"]);
});

test("REVIEW — a duplicated identical Blocks edge is reported once, not twice", () => {
  // Reported and counted twice before, which inflated every total and would have had the
  // operator resolve the same edge two times.
  const p = plan([t("A"), t("B")], [b("A", "B"), b("A", "B")]);
  assert.deepEqual(p.edges.map(pairKey), ["A->B"]);
  assert.equal(p.counts.total, 1);
});

test("REVIEW — a duplicate does not turn a one-way edge into a false mutual pair", () => {
  const p = plan([t("A"), t("B")], [b("A", "B"), b("A", "B"), b("B", "A")]);
  assert.equal(p.counts.mutualPairs, 1);
  assert.equal(p.counts.undecidable, 2, "one report per direction, not three");
});
