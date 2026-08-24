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
