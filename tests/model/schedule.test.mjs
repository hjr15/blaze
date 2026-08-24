// tests/model/schedule.test.mjs — the CPM solve (BLZ-381, ADR-0022).
//
// Every test below is written against the RULE, not against the implementation: the
// eight mutations BLZ-360 §11 names must each break at least one of these, and a test
// that only pins what the code happens to do cannot do that. Where a test exists to kill
// a specific mutation it says which one.
//
// Time inside the solve is SIGNED WORKING MINUTES from project_epoch, so t=0 is the epoch
// instant and a date before the epoch is negative. That is what makes `max(0, ...)` the
// project_epoch floor rather than a separate clamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scheduleModel } from "../../scripts/model/schedule.mjs";

// 480 and Mon–Fri are the config defaults. Tests may name them; scripts/ may not
// (tests/config.test.mjs's grep test scans scripts/ only).
const SCHEDULE = { minutes_per_day: 480, working_days: [1, 2, 3, 4, 5] };
const MON = Date.parse("2026-08-24T00:00:00Z"); // a Monday — checked, not assumed

const t = (id, over = {}) => ({
  id, type: "task", status: "defined", estimate_minutes: null,
  constraint_start_no_earlier_than: null, deadline: null,
  start_date: null, due_date: null, ...over,
});
const edge = (src, target, lag_minutes = 0) => ({ type: "Precedes", src, target, lag_minutes });

const run = (tickets, links = [], over = {}) =>
  scheduleModel({ tickets, links, schedule: SCHEDULE, now: MON, ...over });

const byId = (r, id) => r.scheduled.find((s) => s.id === id);

// ---------------------------------------------------------------- project_epoch

test("project_epoch is the first working day on or after the injected now", () => {
  // Monday stays Monday: `now` is already a working day, so nothing is skipped.
  assert.equal(run([t("A")]).epochDate, "2026-08-24");
  // Saturday and Sunday both roll forward to the Monday.
  assert.equal(run([t("A")], [], { now: Date.parse("2026-08-22T00:00:00Z") }).epochDate, "2026-08-24");
  assert.equal(run([t("A")], [], { now: Date.parse("2026-08-23T00:00:00Z") }).epochDate, "2026-08-24");
});

test("MUTATION 8 — a not_before in the past does not start the schedule in the past", () => {
  // Drop the project_epoch floor and A starts on its constraint, 2026-06-01, which is
  // before `now`. "A plan that starts in the past is not a plan" (BLZ-360 §6.1).
  const r = run([t("A", { estimate_minutes: 60, constraint_start_no_earlier_than: "2026-06-01" })]);
  assert.equal(byId(r, "A").es, 0, "ES is floored at project_epoch, not driven negative");
  assert.equal(byId(r, "A").start_date, "2026-08-24");
});

test("a not_before in the future is an ordinary lower bound, with no dependencies at all", () => {
  // BLZ-360 §6.2's "constraint but no dependencies" row: the constraint fields are not
  // parasitic on the dependency graph.
  const r = run([t("A", { estimate_minutes: 60, constraint_start_no_earlier_than: "2026-08-26" })]);
  assert.equal(byId(r, "A").es, 2 * 480, "two working days after the Monday epoch");
  assert.equal(byId(r, "A").start_date, "2026-08-26");
  assert.equal(byId(r, "A").due_date, "2026-08-26");
});

// ---------------------------------------------------------------- the forward pass

test("EF = ES + duration, and duration comes from estimate_minutes", () => {
  const r = run([t("A", { estimate_minutes: 120 })]);
  assert.equal(byId(r, "A").es, 0);
  assert.equal(byId(r, "A").ef, 120);
  assert.equal(byId(r, "A").duration_minutes, 120);
});

test("MUTATION 7 — a missing estimate is duration 0, a milestone, not one day", () => {
  const r = run([t("M")]);
  const m = byId(r, "M");
  assert.equal(m.duration_minutes, 0, "no estimate means zero duration, never 480");
  assert.equal(m.es, 0);
  assert.equal(m.ef, 0, "ES === EF is what makes it a milestone");
  assert.equal(m.start_date, "2026-08-24");
  assert.equal(m.due_date, "2026-08-24", "a zero-duration milestone finishes on the day it starts");
});

test("a milestone still propagates its predecessor's finish to its successors", () => {
  // BLZ-360 §6.2: "it still propagates its predecessors' finish to its successors".
  const r = run([t("A", { estimate_minutes: 60 }), t("M"), t("B", { estimate_minutes: 60 })],
    [edge("A", "M"), edge("M", "B")]);
  assert.equal(byId(r, "M").es, 60);
  assert.equal(byId(r, "M").ef, 60);
  assert.equal(byId(r, "B").es, 60, "the chain stays connected through the zero-duration node");
});

test("ES takes the MAXIMUM over predecessors, not the first or the last", () => {
  const r = run([
    t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 600 }), t("C", { estimate_minutes: 30 }),
  ], [edge("A", "C"), edge("B", "C")]);
  assert.equal(byId(r, "C").es, 600, "the later predecessor binds");
});

test("MUTATION 2 — the + lag term is in the forward pass", () => {
  const r = run([t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 })],
    [edge("A", "B", 240)]);
  assert.equal(byId(r, "B").es, 300, "EF_pred (60) + lag (240)");
  assert.equal(byId(r, "B").ef, 360);
});

test("a negative lag is a lead, and the forward pass honours it", () => {
  // link-schema.mjs puts no CHECK on lag_minutes' sign, and its comment says so in as
  // many words: "a negative lag is a lead, which finish-to-start scheduling uses".
  const r = run([t("A", { estimate_minutes: 480 }), t("B", { estimate_minutes: 60 })],
    [edge("A", "B", -180)]);
  assert.equal(byId(r, "B").es, 300, "B starts 180 minutes before A finishes");
});

test("a lead cannot pull a successor before project_epoch", () => {
  const r = run([t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 })],
    [edge("A", "B", -600)]);
  assert.equal(byId(r, "B").es, 0, "the epoch floor applies to every node, not only to sources");
});

// ---------------------------------------------------------------- the calendar

test("a duration longer than a working day spans working days and skips the weekend", () => {
  // 480/day: 1,200 minutes is 2.5 working days. Mon+Tue+half Wed.
  const r = run([t("A", { estimate_minutes: 1200 })]);
  assert.equal(byId(r, "A").start_date, "2026-08-24");
  assert.equal(byId(r, "A").due_date, "2026-08-26");
});

test("due_date is the last day work happens on, never the day after it ends", () => {
  // Exactly one working day of work finishes ON the Monday, not on the Tuesday. This is
  // the off-by-one that makes every deadline comparison one day too pessimistic.
  const r = run([t("A", { estimate_minutes: 480 })]);
  assert.equal(byId(r, "A").ef, 480);
  assert.equal(byId(r, "A").due_date, "2026-08-24");
});

test("the calendar reads working_days from the caller, not from a hardcoded Mon–Fri", () => {
  const seven = { minutes_per_day: 480, working_days: [0, 1, 2, 3, 4, 5, 6] };
  const r = run([t("A", { estimate_minutes: 480 * 6 })], [], { schedule: seven });
  assert.equal(byId(r, "A").due_date, "2026-08-29", "a Saturday, because Saturday is a working day here");
});

test("the calendar reads minutes_per_day from the caller too", () => {
  const half = { minutes_per_day: 240, working_days: [1, 2, 3, 4, 5] };
  const r = run([t("A", { estimate_minutes: 480 })], [], { schedule: half });
  assert.equal(byId(r, "A").due_date, "2026-08-25", "480 minutes is two days at 240/day");
});

// ---------------------------------------------------------------- terminal tickets

test("MUTATION 5 — a terminal ticket is not a node and is never rescheduled", () => {
  // BLZ-360 §6.2, stated plainly: "terminal tickets are NOT in the graph the scheduler
  // solves". Its dates are frozen actuals owned by history (§4).
  const r = run([
    t("DONE", { status: "done", estimate_minutes: 120, start_date: "2026-06-01", due_date: "2026-06-05" }),
    t("OPEN", { estimate_minutes: 60 }),
  ]);
  assert.equal(byId(r, "DONE"), undefined, "a terminal ticket produces no scheduled row");
  assert.deepEqual(r.unscheduled, [], "and it is never marked unscheduled either");
  assert.ok(byId(r, "OPEN"), "the rest of the board still schedules");
});

test("a terminal predecessor supplies a boundary finish and holds nothing back when it is past", () => {
  // §6.2's "Terminal ticket" row: as a boundary condition it does not hold anything back.
  const r = run([
    t("DONE", { status: "done", start_date: "2026-06-01", due_date: "2026-06-05" }),
    t("B", { estimate_minutes: 60 }),
  ], [edge("DONE", "B")]);
  assert.equal(byId(r, "B").es, 0, "a finish in the past cannot push a successor forward");
});

test("a terminal predecessor with no dates supplies project_epoch", () => {
  const r = run([
    t("DONE", { status: "done" }), t("B", { estimate_minutes: 60 }),
  ], [edge("DONE", "B")]);
  assert.equal(byId(r, "B").es, 0);
});

test("an edge whose target is terminal is dropped silently and raises nothing", () => {
  // Spec 3 §13.4 names this as a gap in §6.2 it is asserting rather than quoting: the
  // node filter drops the terminal successor, and an edge cannot connect a node that is
  // not there. It is NOT a dangling target — the id resolves.
  const r = run([
    t("A", { estimate_minutes: 60 }), t("DONE", { status: "done", due_date: "2026-06-05" }),
  ], [edge("A", "DONE")]);
  assert.equal(byId(r, "DONE"), undefined);
  assert.deepEqual(r.unscheduled, []);
  assert.deepEqual(r.dropped_edges.map((e) => `${e.src}->${e.target}`), ["A->DONE"]);
});

// ---------------------------------------------------------- the backward pass and float
//
// The horizon is BLZ-380's decision, recorded in ADR-0022 §The backward pass's horizon:
// max(EF) over the COMPLETED forward pass, one constant over every scheduled node, falling
// back to project_epoch when nothing is scheduled.

test("the horizon is max(EF) over the whole board, not per chain and not per component", () => {
  // Two disconnected islands. The horizon is the LATER island's finish, so the earlier
  // island gets real float rather than a critical path of its own.
  const r = run([
    t("LONG", { estimate_minutes: 960 }), t("SHORT", { estimate_minutes: 120 }),
  ]);
  assert.equal(r.horizon_minutes, 960);
  assert.equal(byId(r, "LONG").float_minutes, 0, "the island that sets the horizon is critical");
  assert.equal(byId(r, "SHORT").float_minutes, 840, "the other island is not");
  assert.equal(byId(r, "SHORT").is_critical, false);
});

test("an empty schedulable graph falls back to project_epoch rather than -Infinity", () => {
  const r = run([t("DONE", { status: "done" })]);
  assert.deepEqual(r.scheduled, []);
  assert.equal(r.horizon_minutes, 0);
  assert.equal(r.horizon_date, "2026-08-24");
});

test("the fallback also covers a non-empty graph in which every node is in a cycle", () => {
  // "schedulable" is not "non-empty": every node here is an SCC member, so the scheduled
  // set is empty even though the graph is not.
  const r = run([t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 })],
    [edge("A", "B"), edge("B", "A")]);
  assert.deepEqual(r.scheduled, []);
  assert.equal(r.horizon_minutes, 0, "max over an empty set is project_epoch, never -Infinity");
});

test("MUTATION 3 — the backward pass takes the MIN over successors, not the max", () => {
  // A feeds a short successor and a long one. LF(A) must be bounded by the TIGHTER of the
  // two, which is the short chain: taking max would let A start late enough to sink it.
  const r = run([
    t("A", { estimate_minutes: 60 }),
    t("TIGHT", { estimate_minutes: 60 }),
    t("SLACK", { estimate_minutes: 60 }),
    t("SETS_HORIZON", { estimate_minutes: 6000 }),
  ], [edge("A", "TIGHT"), edge("A", "SLACK"), edge("TIGHT", "SETS_HORIZON")]);
  // Horizon 6120 (A 60 -> TIGHT 60 -> SETS_HORIZON 6000).
  assert.equal(r.horizon_minutes, 6120);
  assert.equal(byId(r, "SETS_HORIZON").ls, 120);
  assert.equal(byId(r, "TIGHT").ls, 60, "TIGHT is bound by SETS_HORIZON");
  assert.equal(byId(r, "SLACK").ls, 6060, "SLACK is a sink and is bound only by the horizon");
  assert.equal(byId(r, "A").lf, 60,
    "min(LS(TIGHT)=60, LS(SLACK)=6060) = 60 — max would give 6060 and lose the chain");
  assert.equal(byId(r, "A").float_minutes, 0);
});

test("MUTATION 4 — float is LS - ES, not ES - LS", () => {
  const r = run([t("LONG", { estimate_minutes: 960 }), t("SHORT", { estimate_minutes: 120 })]);
  const s = byId(r, "SHORT");
  assert.equal(s.ls - s.es, 840);
  assert.equal(s.float_minutes, 840, "positive slack, not -840");
  assert.ok(s.float_minutes > 0, "ES - LS would make every non-critical float negative");
});

test("float is never negative, on a graph that stresses every way it could go", () => {
  // The invariant ADR-0022 proves: LF(n) >= EF(n) for every n, so float >= 0 always. A
  // negative lag, a future not_before, a terminal boundary and a milestone all at once.
  const r = run([
    t("P", { status: "done", due_date: "2026-08-25" }),
    t("A", { estimate_minutes: 300 }),
    t("B", { estimate_minutes: 60, constraint_start_no_earlier_than: "2026-09-10" }),
    t("M"),
    t("C", { estimate_minutes: 45 }),
    t("D", { estimate_minutes: 2000 }),
  ], [edge("P", "B"), edge("A", "M", -120), edge("M", "C"), edge("B", "C", 30), edge("A", "D")]);
  for (const s of r.scheduled) {
    assert.ok(s.float_minutes >= 0, `${s.id} has float ${s.float_minutes}, which the horizon rule forbids`);
    assert.ok(s.lf >= s.ef, `${s.id}: LF ${s.lf} < EF ${s.ef}`);
  }
  assert.ok(r.scheduled.some((s) => s.is_critical), "and at least one node is always critical");
});

test("is_critical is exactly float === 0, and the critical chain is contiguous", () => {
  const r = run([
    t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 120 }), t("C", { estimate_minutes: 30 }),
    t("SIDE", { estimate_minutes: 15 }),
  ], [edge("A", "B"), edge("B", "C"), edge("A", "SIDE")]);
  assert.deepEqual(r.scheduled.filter((s) => s.is_critical).map((s) => s.id), ["A", "B", "C"]);
  assert.equal(byId(r, "SIDE").is_critical, false);
  assert.equal(byId(r, "SIDE").float_minutes, 135,
    "LS 195 (horizon 210 - duration 15) - ES 60 (SIDE starts when A finishes)");
});

test("lag is subtracted in the backward pass, mirroring the forward pass's addition", () => {
  const r = run([t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 })],
    [edge("A", "B", 240)]);
  assert.equal(r.horizon_minutes, 360);
  assert.equal(byId(r, "B").ls, 300);
  assert.equal(byId(r, "A").lf, 60, "LS(B) 300 - lag 240");
  assert.equal(byId(r, "A").float_minutes, 0);
});

// ---------------------------------------------------------------- cycles
//
// Measured on the live board: ZERO non-trivial SCCs exist in the non-terminal delivery
// graph, so this path is defensive and BLZ-360 §6.2 requires it be tested against a
// SYNTHETIC cycle rather than a corpus one. Every test below builds its own.

test("MUTATION 6 — every SCC member is unscheduled, not scheduled", () => {
  const r = run([
    t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 }), t("C", { estimate_minutes: 60 }),
    t("FREE", { estimate_minutes: 90 }),
  ], [edge("A", "B"), edge("B", "C"), edge("C", "A")]);
  assert.deepEqual(r.unscheduled.map((u) => u.id), ["A", "B", "C"]);
  assert.deepEqual([...new Set(r.unscheduled.map((u) => u.reason))], ["dependency-cycle"]);
  assert.deepEqual(r.unscheduled[0].scc, ["A", "B", "C"], "each member carries the whole SCC");
  assert.deepEqual(r.scheduled.map((s) => s.id), ["FREE"], "and nothing in the cycle is scheduled");
});

test("the rest of the graph still schedules around a cycle", () => {
  // §6.2: "the rest of the graph still schedules". A scheduler that refuses to produce any
  // output because one cycle was authored yesterday is a scheduler nobody runs.
  const r = run([
    t("X", { estimate_minutes: 60 }), t("Y", { estimate_minutes: 60 }),
    t("P", { estimate_minutes: 30 }), t("Q", { estimate_minutes: 30 }),
  ], [edge("X", "Y"), edge("Y", "X"), edge("P", "Q")]);
  assert.deepEqual(r.unscheduled.map((u) => u.id), ["X", "Y"]);
  assert.deepEqual(r.scheduled.map((s) => s.id), ["P", "Q"]);
  assert.equal(byId(r, "Q").es, 30);
});

test("an edge OUT of a cycle is treated as unconstrained — the stated approximation", () => {
  // §6.2 states this as an approximation rather than hiding it: a successor of a cycle gets
  // an optimistic date. AFTER must schedule at the epoch, not wait for a date that
  // does not exist.
  const r = run([
    t("X", { estimate_minutes: 600 }), t("Y", { estimate_minutes: 600 }), t("AFTER", { estimate_minutes: 60 }),
  ], [edge("X", "Y"), edge("Y", "X"), edge("Y", "AFTER")]);
  assert.equal(byId(r, "AFTER").es, 0, "optimistic, and named as an approximation in §6.2");
  assert.equal(byId(r, "AFTER").is_critical, true);
});

test("a self-edge is a cycle of one and is refused, though the DB's CHECK forbids it", () => {
  // link-schema.mjs has CHECK (source_id <> target_id), so this is unreachable from the DB.
  // The pure model still receives whatever a caller hands it.
  const r = run([t("A", { estimate_minutes: 60 })], [edge("A", "A")]);
  assert.deepEqual(r.scheduled.map((s) => s.id), ["A"], "the node still schedules");
  assert.deepEqual(r.dropped_edges.map((e) => e.reason), ["self-edge"]);
});

test("a two-node mutual pair is the smallest real cycle and is caught", () => {
  const r = run([t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 })],
    [edge("A", "B"), edge("B", "A")]);
  assert.deepEqual(r.cycles, [["A", "B"]]);
});

test("two independent cycles are reported as two components, not merged", () => {
  const r = run([
    t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 }),
    t("C", { estimate_minutes: 60 }), t("D", { estimate_minutes: 60 }),
  ], [edge("A", "B"), edge("B", "A"), edge("C", "D"), edge("D", "C")]);
  assert.deepEqual(r.cycles, [["A", "B"], ["C", "D"]]);
});

// ---------------------------------------------------------------- the edge filter

test("the endpoint default-deny drops an edge whose endpoint is not a declared kind", () => {
  // BLZ-360 §5.3's source_kinds/target_kinds, read from DEFAULT_LINK_TYPES rather than
  // restated here. A risk does not belong in a delivery critical path.
  const r = run([
    t("R", { type: "risk", status: "identified" }), t("F", { type: "feature", estimate_minutes: 60 }),
  ], [edge("R", "F")]);
  assert.deepEqual(r.dropped_edges.map((e) => e.reason), ["undeclared-kind"]);
  assert.deepEqual(r.edges, []);
});

test("BLZ-378/BLZ-383 — an epic is not a node at all, because it is not a Precedes endpoint", () => {
  // DECIDED under BLZ-388, and it collapses two tickets into one rule. The solve's node set is
  // exactly `Precedes`' declared endpoint kinds — not "the delivery workflow", which is a
  // second definition that happens to coincide.
  //
  // An earlier version of this test asserted the opposite ("the epic is still a NODE"). That
  // followed from a node filter of `workflowFor(type) === "delivery"`, which includes `epic`
  // and therefore gave a container its own CPM-derived dates from its own estimate — double
  // counting the children those dates should be rolled up FROM (spec 4's hierarchy roll-up).
  //
  // The two definitions differ by exactly `epic` and the board holds zero of them, so they
  // select the same set — verified 2026-08-25 against the live corpus, zero ids in either
  // difference. A simplification with no behaviour change, and one rule where there were two.
  const r = run([
    t("E", { type: "epic", status: "defined", estimate_minutes: 60 }),
    t("S", { type: "story", estimate_minutes: 60 }),
  ], [edge("E", "S")]);
  assert.deepEqual(r.dropped_edges.map((e) => e.reason), ["undeclared-kind"]);
  assert.equal(byId(r, "E"), undefined, "an epic gets no CPM dates — its dates come from roll-up");
  assert.deepEqual(r.unscheduled, [], "and it is not marked unscheduled either");
  assert.deepEqual(r.scheduled.map((x) => x.id), ["S"]);
});

test("BLZ-383 — the node rule IS the Precedes endpoint kinds, read from one place", () => {
  // Not restated here and not inferred: the same DEFAULT_LINK_TYPES entry that decides which
  // EDGES are legal decides which NODES exist. One source, so they cannot drift.
  const kinds = ["feature", "story", "task", "bug", "subtask"];
  const r = run(kinds.map((k, i) => t(`K${i}`, { type: k, estimate_minutes: 60 })));
  assert.deepEqual(r.scheduled.map((x) => x.id), kinds.map((_, i) => `K${i}`));
});

test("a non-Precedes link is ignored, so a caller may hand the solve every link it has", () => {
  const r = run([t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 })],
    [{ type: "Blocks", src: "A", target: "B", lag_minutes: 0 }]);
  assert.deepEqual(r.dropped_edges.map((e) => e.reason), ["not-precedes"]);
  assert.equal(byId(r, "B").es, 0, "Blocks stays advisory — ADR-0001 is not reversed");
});

test("an edge to an id that does not resolve is dropped rather than crashing the solve", () => {
  const r = run([t("A", { estimate_minutes: 60 })], [edge("A", "GHOST-1")]);
  assert.deepEqual(r.dropped_edges.map((e) => e.reason), ["dangling-endpoint"]);
  assert.ok(byId(r, "A"));
});

test("the filters run in order: the edge filter is applied before the node filter", () => {
  // §6.2: "the order is part of the rule". A risk that is also terminal must be refused by
  // the KIND rule, and the dropped reason is how you can tell which filter caught it.
  const r = run([
    t("R", { type: "risk", status: "closed" }), t("F", { type: "feature", estimate_minutes: 60 }),
  ], [edge("R", "F")]);
  assert.deepEqual(r.dropped_edges.map((e) => e.reason), ["undeclared-kind"],
    "not 'terminal-predecessor' — the kind filter is first");
});

// ---------------------------------------------------------------- determinism

test("the solve is byte-stable under input reordering", () => {
  const tickets = [
    t("C", { estimate_minutes: 30 }), t("A", { estimate_minutes: 60 }),
    t("D", { estimate_minutes: 15 }), t("B", { estimate_minutes: 120 }),
  ];
  const links = [edge("A", "B"), edge("B", "C"), edge("A", "D")];
  const a = run(tickets, links);
  const b = run([...tickets].reverse(), [...links].reverse());
  assert.equal(JSON.stringify(a.scheduled), JSON.stringify(b.scheduled));
  assert.deepEqual(a.scheduled.map((s) => s.id), ["A", "B", "C", "D"], "ties break on ticket id");

  // The WHOLE result, not just the scheduled rows. dropped_edges was the one array not sorted
  // and its order came from two separate push loops, so a caller that reordered its links got
  // a different object back — which is exactly what "byte-stable" is supposed to forbid.
  const full = [t("R", { type: "risk", status: "identified" }), t("DONE", { status: "done" }), ...tickets];
  const fullLinks = [edge("R", "A"), edge("DONE", "A"), edge("A", "DONE"), ...links,
    { type: "Blocks", src: "A", target: "C" }, edge("A", "GHOST-9")];
  assert.equal(
    JSON.stringify(run(full, fullLinks), (k, v) => (v instanceof Map ? [...v] : v)),
    JSON.stringify(run([...full].reverse(), [...fullLinks].reverse()), (k, v) => (v instanceof Map ? [...v] : v)),
    "every array in the result is order-independent, dropped_edges included");
});

test("the model reads no clock and refuses to invent one", () => {
  assert.throws(() => scheduleModel({ tickets: [t("A")], schedule: SCHEDULE }), /now.*injected/);
  const src = readFileSync(new URL("../../scripts/model/schedule.mjs", import.meta.url), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Date\.now\(\)/.test(src), "Date.now() in the model breaks the golden outputs");
  assert.ok(!/Math\.random/.test(src), "Math.random in the model breaks the golden outputs");
  assert.ok(!/localeCompare/.test(src), "localeCompare sorts differently per machine");
});

test("board config is required, never defaulted inside the model", () => {
  assert.throws(() => scheduleModel({ tickets: [], now: MON }), /minutes_per_day/);
  assert.throws(() => scheduleModel({ tickets: [], now: MON, schedule: { minutes_per_day: 480 } }), /working_days/);
});

// ------------------------------------------------------- fixtures from the real corpus
//
// BLZ-360 §11 requires three fixtures be DRAWN FROM the corpus rather than invented, because
// each already exists. Every id, type, status, estimate and date below was measured against
// the live board on 2026-08-24 (2,630 tickets, 392 `Blocks` edges) and is transcribed here
// rather than imagined. The tests are still hermetic: the board is a separate repository and
// no test may reach outside this one.
//
// `Blocks` is read as a PROPOSED `Precedes` direction throughout. It is not one yet —
// BLZ-360 §5.5's `import-deps` is operator-driven and the tool never guesses — so these
// fixtures answer "what would the solve do with this shape", which is what they are for.

test("CORPUS — the INF-275 ↔ INF-276 mutual pair is not a cycle, because INF-275 is done", () => {
  // The pair BLZ-360 §7.2 prints as the `dependency-cycle` example, and the single clearest
  // reason the live board measures ZERO non-trivial SCCs. Both edges are the same Blocks
  // pair written from each end. INF-275 is `done` and carries no estimate; INF-276 is
  // `defined` with estimate 120.
  const r = run([
    t("INF-275", { status: "done" }),
    t("INF-276", { estimate_minutes: 120 }),
  ], [edge("INF-275", "INF-276"), edge("INF-276", "INF-275")]);

  assert.deepEqual(r.cycles, [], "the node filter runs BEFORE Tarjan, so the cycle never forms");
  assert.deepEqual(r.unscheduled, [], "and INF-275 is never marked unscheduled — its dates are actuals");
  assert.deepEqual(r.scheduled.map((s) => s.id), ["INF-276"]);
  assert.deepEqual(r.dropped_edges.map((e) => `${e.src}->${e.target}:${e.reason}`).sort(),
    ["INF-275->INF-276:terminal-predecessor", "INF-276->INF-275:terminal-endpoint"]);
  assert.equal(byId(r, "INF-276").es, 0, "INF-275 has no due date, so it supplies project_epoch");
});

test("CORPUS — the mutual pair WOULD be a cycle if the terminal filter were removed", () => {
  // Mutation 5's second face, and the reason the filter ORDER is part of the rule. Reopen
  // INF-275 and the same two edges become an SCC — which is what would have happened had
  // Tarjan run over the full graph, marking a `done` ticket `unscheduled` and overwriting
  // one of §4's 28 frozen actuals.
  const r = run([
    t("INF-275", { status: "defined" }),
    t("INF-276", { estimate_minutes: 120 }),
  ], [edge("INF-275", "INF-276"), edge("INF-276", "INF-275")]);
  assert.deepEqual(r.cycles, [["INF-275", "INF-276"]]);
  assert.deepEqual(r.unscheduled.map((u) => u.id), ["INF-275", "INF-276"]);
});

test("CORPUS — a cross-project edge is allowed and scheduled: the unit of solve is the board", () => {
  // Measured: 22 of the 392 `Blocks` edges cross a project. Exactly ONE of the 22 has both
  // endpoints non-terminal — CRP-8 → SN-5, both `feature/defined` and both without an
  // estimate. (That is a different statistic from spec 3 §13.3's "1 of 36", which counts
  // open Precedes-ELIGIBLE edges; the two populations are not the same and are not
  // reconciled here.) Two features with no estimate are two milestones, so this fixture also
  // pins that a chain of milestones stays connected.
  const r = run([
    t("CRP-8", { type: "feature" }), t("SN-5", { type: "feature" }),
  ], [edge("CRP-8", "SN-5")]);
  assert.deepEqual(r.scheduled.map((s) => s.id), ["CRP-8", "SN-5"], "no project partition");
  assert.deepEqual(r.edges.map((e) => `${e.src}->${e.target}`), ["CRP-8->SN-5"], "the edge survives");
  assert.equal(byId(r, "SN-5").es, 0);
  assert.equal(byId(r, "SN-5").duration_minutes, 0);
});

test("CORPUS — a cross-project edge with a terminal predecessor still crosses", () => {
  // BLZ-136 (`task/done`, estimate 240) blocks INF-744 (`task/defined`, estimate 480).
  const r = run([
    t("BLZ-136", { status: "done", estimate_minutes: 240, due_date: "2026-07-01" }),
    t("INF-744", { estimate_minutes: 480 }),
  ], [edge("BLZ-136", "INF-744")]);
  assert.deepEqual(r.scheduled.map((s) => s.id), ["INF-744"]);
  assert.equal(byId(r, "INF-744").es, 0, "a July finish cannot push an August schedule");
  assert.equal(byId(r, "INF-744").due_date, "2026-08-24", "480 minutes is one working day");
});

test("CORPUS — OMA-1 is a goal, and the endpoint default-deny refuses it", () => {
  // OMA-1 (`goal/defined`) blocks KPA-2 (`feature/done`) — one of the 22. `goal` is not in
  // Precedes' source_kinds, so the edge is refused by the KIND filter, before terminality
  // is even consulted.
  const r = run([
    t("OMA-1", { type: "goal", status: "defined" }), t("KPA-2", { type: "feature", status: "done" }),
  ], [edge("OMA-1", "KPA-2")]);
  assert.deepEqual(r.dropped_edges.map((e) => e.reason), ["undeclared-kind"]);
});

test("CORPUS — OMA-4 carries a deadline with no start, and it is not unreachable", () => {
  // The single non-terminal due-only ticket in §4's migration: `task/defined`, estimate 30,
  // `due: 2026-10-20` becoming `deadline: 2026-10-20`, and NO start constraint. Measured
  // 2026-08-24: OMA-4 carries zero `Blocks` edges in either direction, so nothing can be
  // scheduled in front of it and its 30 minutes finish on the epoch day itself.
  const r = run([t("OMA-4", { estimate_minutes: 30, deadline: "2026-10-20" })]);
  const o = byId(r, "OMA-4");
  assert.equal(o.es, 0);
  assert.equal(o.ef, 30);
  assert.equal(o.start_date, "2026-08-24");
  assert.equal(o.due_date, "2026-08-24", "it finishes on the epoch day, 57 calendar days clear");
  assert.ok(o.due_date < o.deadline, "so it is the one migrated deadline that is NOT unreachable");
});

test("CORPUS — the 11 migrated deadlines already in the past are unreachable on day one", () => {
  // The other side of §4's non-terminal cohort. INF-748 is the earliest at 2026-08-07; THREE tie for
  // the latest at 2026-08-16 (INF-451, INF-642, INF-657) and an earlier version of this comment
  // called INF-657 "the latest" as though it were alone. Every one of the 11 is before the
  // 2026-08-24 epoch, so
  // project_epoch ALONE already exceeds them and no estimate can rescue any.
  const r = run([
    t("INF-748", { type: "bug", estimate_minutes: 20, deadline: "2026-08-07", constraint_start_no_earlier_than: "2026-08-07" }),
    t("INF-657", { type: "bug", status: "in-progress", estimate_minutes: 240, deadline: "2026-08-16", constraint_start_no_earlier_than: "2026-08-11" }),
  ]);
  for (const s of r.scheduled) {
    assert.equal(s.es, 0, `${s.id}: a not_before in the past is floored at project_epoch`);
    assert.ok(s.due_date > s.deadline, `${s.id}: derived ${s.due_date} is past deadline ${s.deadline}`);
  }
});

test("CORPUS — BLZ-253's 4,800 minutes is the board's max EF, so it sets the horizon", () => {
  // Measured over the live board: of 538 non-terminal delivery tickets, 398 carry an
  // estimate, and the largest is BLZ-253 (`feature/in-progress`) at 4,800 minutes = 10.0
  // working days at 480/day. No Precedes edge and no not_before exists on the board yet, so
  // every node is isolated and max(EF) is exactly that estimate. Spec 3 §5.1 and §2.3 both
  // report the same figure; this reproduces it rather than transcribing it.
  const r = run([
    t("BLZ-253", { type: "feature", status: "in-progress", estimate_minutes: 4800 }),
    t("OMA-4", { estimate_minutes: 30, deadline: "2026-10-20" }),
  ]);
  assert.equal(r.horizon_minutes, 4800);
  assert.equal(r.horizon_minutes / 480, 10, "10.0 working days");
  assert.equal(r.horizon_date, "2026-09-04", "ten working days from Monday 2026-08-24");
  assert.equal(byId(r, "BLZ-253").is_critical, true, "the ticket that sets the horizon is the critical one");
  assert.equal(byId(r, "OMA-4").float_minutes, 4770);
});

// ---------------------------------------------------------------- the delivery-graph filter
//
// This filter is an INFERENCE, flagged as one in schedule.mjs: BLZ-360 §6.2's numbered list
// names only the edge-kind rule and terminality, while §6.2's heading and §7.1 both call the
// population "the non-terminal DELIVERY graph". These tests pin the reading.

test("a non-delivery ticket is not a node, so CPM never hands it a derived date", () => {
  // Measured on the live board 2026-08-25: 203 non-terminal non-delivery tickets — 43 goal,
  // 65 risk, 89 requirement, 6 architecture — none of which can carry a Precedes edge either.
  const r = run([
    t("G", { type: "goal", status: "in-progress", estimate_minutes: 830 }),
    t("RQ", { type: "requirement", status: "proposed" }),
    t("RK", { type: "risk", status: "identified" }),
    t("T", { estimate_minutes: 60 }),
  ]);
  assert.deepEqual(r.scheduled.map((s) => s.id), ["T"]);
  assert.deepEqual(r.unscheduled, [], "and none of them is marked unscheduled either");
});

test("a non-delivery ticket cannot set the board's horizon", () => {
  // OBA-1 is a `goal/in-progress` carrying 830 minutes — the largest estimate on any
  // non-terminal non-delivery ticket on the live board. It must not move the horizon.
  const r = run([
    t("OBA-1", { type: "goal", status: "in-progress", estimate_minutes: 830 }),
    t("T", { estimate_minutes: 120 }),
  ]);
  assert.equal(r.horizon_minutes, 120, "the goal's 830 minutes are not in the solve at all");
});

test("a row whose type did not parse is skipped, not crashed on", () => {
  // gantt.mjs:23 guards with isType FIRST because workflowFor throws on null/unknown, and
  // index rows carry `type: fm.type ?? null`.
  const r = run([t("BAD", { type: null }), t("ALSO-BAD", { type: "nonsense" }), t("T", { estimate_minutes: 60 })]);
  assert.deepEqual(r.scheduled.map((s) => s.id), ["T"]);
});

// ------------------------------------------------- defects found by adversarial review
//
// Each of these failed before the fix in the same commit. They are kept as named tests
// rather than folded into the ones above, so a regression says which defect came back.

test("REVIEW 1 — a sub-minute duration cannot put due_date before start_date", () => {
  // `lastDayIndex` read the last instant of a span as `ef - 1`, which is one whole MINUTE and
  // is only the last instant when the duration is an integer. With estimate 0.5 the ticket
  // finished on 2026-08-21 — a Friday BEFORE the epoch — because dayIndexAt(-0.5) is -1 and
  // dateForWorkingDay walked backwards past its own documented k >= 0 precondition.
  //
  // Reachable from a hand-edited file: `estimate: 0.5` survives coerceScalar (its regex is
  // /^-?\d+$/, so it stays a string) and audit-runner's Number(...) turns it into 0.5.
  // `roundEstimate` blocks it on the `blaze new` / `blaze edit` path; the exported model has
  // no such guard and must not need one.
  for (const est of [0.25, 0.5, 0.9999]) {
    const r = run([t("F", { estimate_minutes: est })]);
    const f = byId(r, "F");
    assert.ok(f.due_date >= f.start_date, `estimate ${est}: due ${f.due_date} < start ${f.start_date}`);
    assert.ok(f.start_date >= r.epoch_date, `estimate ${est}: start ${f.start_date} precedes the epoch`);
    assert.equal(f.due_date, "2026-08-24");
  }
  const chained = run([t("A", { estimate_minutes: 960 }), t("B", { estimate_minutes: 0.5 })], [edge("A", "B")]);
  assert.ok(byId(chained, "B").due_date >= byId(chained, "B").start_date);
});

test("REVIEW 1 — a terminal predecessor that finished on a weekend does not cost a working day", () => {
  // minutesAtEndOf ROUNDED UP for a non-working date, so a Saturday finish was treated as if
  // work ran through the following Monday and the successor started Tuesday. Measured: the
  // live board carries 10 tickets with a weekend `due` — 5 Saturday, 5 Sunday — and they are
  // exactly the frozen actuals that feed the boundary once import-deps populates Precedes.
  const after = (due) => {
    const r = run([t("P", { status: "done", due_date: due }), t("S", { estimate_minutes: 60 })],
      [edge("P", "S")]);
    return byId(r, "S").start_date;
  };
  assert.equal(after("2026-08-28"), "2026-08-31", "Friday finish → Monday start");
  assert.equal(after("2026-08-29"), "2026-08-31", "SATURDAY finish → Monday start, not Tuesday");
  assert.equal(after("2026-08-30"), "2026-08-31", "SUNDAY finish → Monday start, not Tuesday");
  assert.equal(after("2026-08-31"), "2026-09-01", "Monday finish → Tuesday start");
});

test("REVIEW 1 — parallel edges with different lags are ordered, not left to input order", () => {
  // The dropped_edges sort tie-broke on (src, target, reason) and Array.sort is stable, so two
  // Precedes edges between the SAME pair carrying different lags came back in whichever order
  // the caller supplied. `scheduled` was unaffected — the forward pass takes a max — so this
  // was a byte-stability hole with no wrong dates behind it.
  const ser = (x) => JSON.stringify(x, (k, v) => (v instanceof Map ? [...v] : v));
  const tk = [t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 }),
    t("Z", { status: "done", due_date: "2026-06-01" })];
  const ls = [edge("A", "B", 60), edge("A", "B", 600), edge("A", "Z", 60), edge("A", "Z", 120)];
  assert.equal(ser(run(tk, ls)), ser(run(tk, [...ls].reverse())));
  assert.deepEqual(run(tk, ls).edges.map((e) => e.lag_minutes), [60, 600]);
});

test("REVIEW 1 — a duplicate ticket id is refused, not resolved by input order", () => {
  // `rows.set(t.id, t)` was last-wins, so the same two rows in the other order produced a
  // different schedule AND a different horizon. read-storage.mjs:33 states the principle this
  // broke: "an id that resolves to two files is ambiguous and a write must not land on a
  // guess." The solve was guessing silently.
  //
  // It is dropped rather than thrown: `blaze audit` already raises `duplicate-status` HARD for
  // this corpus, and taking the whole audit down to re-report a condition it already reports
  // would be worse. Dropping is order-independent and guesses nothing.
  const a = run([t("A", { estimate_minutes: 60 }), t("A", { estimate_minutes: 4800 })]);
  const b = run([t("A", { estimate_minutes: 4800 }), t("A", { estimate_minutes: 60 })]);
  assert.deepEqual(a.scheduled, [], "neither reading is chosen");
  assert.deepEqual(a.unscheduled, [{ id: "A", reason: "duplicate-id", scc: ["A"] }]);
  assert.equal(JSON.stringify(a.scheduled), JSON.stringify(b.scheduled));
  assert.equal(a.horizon_minutes, b.horizon_minutes, "and it cannot move the horizon either way");
});

test("REVIEW 1 — a duplicate id does not take the rest of the board down with it", () => {
  const r = run([t("A", { estimate_minutes: 60 }), t("A", { estimate_minutes: 90 }),
    t("B", { estimate_minutes: 120 })]);
  assert.deepEqual(r.scheduled.map((s) => s.id), ["B"]);
  assert.equal(r.horizon_minutes, 120);
});

test("REVIEW 1 — no estimate, however odd, can produce a date before the epoch", () => {
  // dateForWorkingDay's `k >= 0` precondition is now ENFORCED rather than merely documented —
  // that is how defect 1 got past the calendar and into a date. The guard is belt-and-braces:
  // a negative or non-finite estimate already floors to duration 0, so nothing below reaches
  // it. This test pins the property the guard protects rather than the guard itself, because
  // an assertion that can only be made true by breaking the epoch floor would be testing the
  // mutation, not the rule.
  for (const est of [-1e9, -1, -0.5, 0, 0.25, 1, NaN, Infinity, -Infinity, null, undefined, "60"]) {
    const r = run([t("A", { estimate_minutes: est }), t("B", { estimate_minutes: 60 })], [edge("A", "B")]);
    for (const row of r.scheduled) {
      assert.ok(row.es >= 0, `estimate ${String(est)}: ES ${row.es} is before the epoch`);
      assert.ok(row.start_date >= r.epoch_date, `estimate ${String(est)}: ${row.start_date} < epoch`);
      assert.ok(row.due_date >= row.start_date, `estimate ${String(est)}: due < start`);
      assert.ok(row.float_minutes >= 0, `estimate ${String(est)}: negative float`);
    }
  }
});
