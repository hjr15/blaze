// tests/model/schedule-findings.test.mjs — BLZ-382 / BLZ-360 §7.
//
// ONE function, so `blaze audit` and the view layer cannot drift. A conflict that shows on
// the Gantt but not in CI is invisible to an agent; one that shows only in CI is invisible
// to the operator.
//
// All three kinds ship SOFT. audit.mjs's own header sets the test — HARD means the CORPUS is
// wrong — and a missed deadline is a true statement about a correct corpus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleModel } from "../../scripts/model/schedule.mjs";
import { scheduleFindings, groupScheduleFindings, HARD_KINDS, summarise } from "../../scripts/model/audit.mjs";

const SCHEDULE = { minutes_per_day: 480, working_days: [1, 2, 3, 4, 5] };
const MON = Date.parse("2026-08-24T00:00:00Z");

const t = (id, over = {}) => ({
  id, type: "task", status: "defined", estimate_minutes: null,
  constraint_start_no_earlier_than: null, deadline: null,
  start_date: null, due_date: null, ...over,
});
const edge = (src, target, lag_minutes = 0) => ({ type: "Precedes", src, target, lag_minutes });
const solve = (tickets, links = [], over = {}) =>
  scheduleModel({ tickets, links, schedule: SCHEDULE, now: MON, ...over });
const kinds = (f) => f.map((x) => x.kind);
const forId = (f, id) => f.find((x) => x.ticket === id);

// ---------------------------------------------------------------- severity

test("none of the three kinds is HARD — a missed deadline is not a wrong corpus", () => {
  for (const k of ["deadline-unreachable", "dependency-cycle", "schedule-stale"]) {
    assert.equal(HARD_KINDS.has(k), false, `${k} must not be in HARD_KINDS`);
  }
});

test("summarise classifies them soft without needing to know they exist", () => {
  const s = summarise([{ kind: "deadline-unreachable" }, { kind: "deadline-unreachable" }, { kind: "dependency-cycle" }]);
  assert.deepEqual(s, [
    { kind: "deadline-unreachable", count: 2, severity: "soft" },
    { kind: "dependency-cycle", count: 1, severity: "soft" },
  ]);
});

// ---------------------------------------------------------------- deadline-unreachable

test("MUTATION 1 — the comparison is strict: finishing ON the deadline is not a finding", () => {
  // Flip `EF > deadline` to `>=` and this fires. A deadline is a DATE, and finishing at
  // 16:00 on the deadline day is on time.
  const r = solve([t("A", { estimate_minutes: 480, deadline: "2026-08-24" })]);
  assert.equal(r.by_id.get("A").due_date, "2026-08-24");
  assert.deepEqual(scheduleFindings(r), [], "on-time is not late");
});

test("a derived due_date past the deadline raises exactly one soft finding", () => {
  const r = solve([t("A", { estimate_minutes: 480 * 3, deadline: "2026-08-25" })]);
  const f = scheduleFindings(r);
  assert.deepEqual(kinds(f), ["deadline-unreachable"]);
  assert.equal(f[0].ticket, "A");
});

test("the finding names the rule, both dates and the lateness in working days", () => {
  // Spec 1 §4.2's rule applies to findings too: every refusal names the rule and lists every
  // failing item. §7.2: a finding that says only "deadline missed" is a defect.
  const r = solve([t("A", { estimate_minutes: 480 * 3, deadline: "2026-08-25" })]);
  const d = scheduleFindings(r)[0].detail;
  assert.match(d, /deadline 2026-08-25/);
  assert.match(d, /earliest finish 2026-08-26/);
  assert.match(d, /1 working day late/);
});

test("THE BINDING CHAIN IS THE PAYLOAD — the finding carries the zero-float walk", () => {
  // §7.2: "'You are 11 days late' is a complaint; 'you are 11 days late and here are the
  // three tickets that decide it' is the thing the operator can act on."
  const r = solve([
    t("BLZ-341", { estimate_minutes: 480 }),
    t("BLZ-352", { estimate_minutes: 480 }),
    t("BLZ-360", { estimate_minutes: 480, deadline: "2026-08-25" }),
    t("UNRELATED", { estimate_minutes: 60 }),
  ], [edge("BLZ-341", "BLZ-352"), edge("BLZ-352", "BLZ-360")]);
  const f = forId(scheduleFindings(r), "BLZ-360");
  assert.deepEqual(f.chain, ["BLZ-341", "BLZ-352", "BLZ-360"]);
  assert.match(f.detail, /binding chain BLZ-341 → BLZ-352 → BLZ-360/);
  assert.match(f.detail, /float 0/);
  assert.ok(!f.chain.includes("UNRELATED"), "a ticket that decides nothing is not in the chain");
});

test("the chain crosses projects and says so, because the unit of solve is the board", () => {
  // §6.2: "every finding and every critical-path output carries the full chain including
  // foreign ids."
  const r = solve([
    t("INF-744", { estimate_minutes: 480 }),
    t("OBA-429", { estimate_minutes: 480, deadline: "2026-08-24" }),
  ], [edge("INF-744", "OBA-429")]);
  const f = forId(scheduleFindings(r), "OBA-429");
  assert.deepEqual(f.chain, ["INF-744", "OBA-429"]);
  assert.equal(f.crosses_projects, true);
  assert.match(f.detail, /crosses projects/);
});

test("a deadline ticket with no predecessors says so instead of shipping an empty chain", () => {
  // This is the LIVE case, not a corner: the board carries no Precedes edge at all today, so
  // every one of the 11 day-one findings has a chain of exactly itself. An empty chain
  // rendered as a chain would read as a defect in the tool.
  const r = solve([t("INF-748", { type: "bug", estimate_minutes: 20, deadline: "2026-08-07" })]);
  const f = forId(scheduleFindings(r), "INF-748");
  assert.deepEqual(f.chain, ["INF-748"]);
  assert.match(f.detail, /no predecessors — nothing else decides this date/);
});

test("only the BINDING predecessor is in the chain, not every predecessor", () => {
  const r = solve([
    t("SLOW", { estimate_minutes: 480 * 2 }), t("FAST", { estimate_minutes: 30 }),
    t("X", { estimate_minutes: 480, deadline: "2026-08-24" }),
  ], [edge("SLOW", "X"), edge("FAST", "X")]);
  assert.deepEqual(forId(scheduleFindings(r), "X").chain, ["SLOW", "X"]);
});

test("a terminal ticket never raises a deadline finding — it has no derived date", () => {
  const r = solve([t("DONE", { status: "done", deadline: "2026-01-01", due_date: "2026-06-05" })]);
  assert.deepEqual(scheduleFindings(r), []);
});

// ---------------------------------------------------------------- dependency-cycle

test("every SCC member raises a soft dependency-cycle finding naming the whole cycle", () => {
  const r = solve([t("INF-275", { estimate_minutes: 60 }), t("INF-276", { estimate_minutes: 120 })],
    [edge("INF-275", "INF-276"), edge("INF-276", "INF-275")]);
  const f = scheduleFindings(r);
  assert.deepEqual(kinds(f), ["dependency-cycle", "dependency-cycle"]);
  assert.deepEqual(f.map((x) => x.ticket), ["INF-275", "INF-276"]);
  assert.match(f[0].detail, /Precedes cycle INF-275 → INF-276 → INF-275/);
  assert.match(f[0].detail, /2 tickets unscheduled/);
});

// ---------------------------------------------------------------- schedule-stale

test("a persisted row stamped with an older run is stale, and is never rendered as a date", () => {
  const r = solve([t("A", { estimate_minutes: 60 }), t("B", { estimate_minutes: 60 })], [], { runId: "run-2" });
  const f = scheduleFindings(r, { persisted: [
    { id: "A", schedule_run_id: "run-2" },
    { id: "B", schedule_run_id: "run-1" },
  ] });
  assert.deepEqual(kinds(f), ["schedule-stale"]);
  assert.equal(f[0].ticket, "B");
  assert.match(f[0].detail, /run-1.*run-2/);
});

test("a persisted row that was never stamped is stale too, not silently fresh", () => {
  const r = solve([t("A", { estimate_minutes: 60 })], [], { runId: "run-2" });
  const f = scheduleFindings(r, { persisted: [{ id: "A", schedule_run_id: null }] });
  assert.deepEqual(kinds(f), ["schedule-stale"]);
  assert.match(f[0].detail, /never stamped/);
});

test("with nothing persisted there is nothing to be stale about", () => {
  const r = solve([t("A", { estimate_minutes: 60 })], [], { runId: "run-2" });
  assert.deepEqual(scheduleFindings(r), []);
});

// ---------------------------------------------------------------- the grouped presentation

test("findings are grouped by kind with a count — eleven red rows teaches an operator to ignore it", () => {
  // Spec 3 §8's presentation rule, and it exists because of a measurement: 11 of the 12
  // migrated deadlines are already in the past, so this kind fires 11 times on day one.
  const tickets = ["INF-451", "INF-455", "INF-597", "INF-642", "INF-656", "INF-662",
    "INF-731", "INF-733", "INF-748", "INF-574", "INF-657"]
    .map((id) => t(id, { estimate_minutes: 60, deadline: "2026-08-16" }));
  const r = solve(tickets);
  const f = scheduleFindings(r);
  assert.equal(f.length, 11);
  const g = groupScheduleFindings(f, { migratedDeadlines: tickets.map((x) => x.id) });
  assert.equal(g.length, 1);
  assert.equal(g[0].kind, "deadline-unreachable");
  assert.equal(g[0].count, 11);
  assert.equal(g[0].severity, "soft");
  assert.equal(g[0].all_migration_artefacts, true);
  assert.match(g[0].summary, /11 deadlines unreachable/);
  assert.match(g[0].summary, /all 11 are dates migrated/);
  assert.deepEqual(g[0].items.map((x) => x.ticket), f.map((x) => x.ticket));
});

test("a kind with even one non-migrated member does NOT claim to be a migration artefact", () => {
  // The claim has to be false-able, or the banner is decoration. OMA-4 is in the 12-id
  // cohort; NEW-1 is not.
  const r = solve([
    t("INF-748", { estimate_minutes: 60, deadline: "2026-08-07" }),
    t("NEW-1", { estimate_minutes: 60, deadline: "2026-08-07" }),
  ]);
  const g = groupScheduleFindings(scheduleFindings(r), { migratedDeadlines: ["INF-748"] });
  assert.equal(g[0].count, 2);
  assert.equal(g[0].all_migration_artefacts, false);
  assert.ok(!/all \d+ are dates migrated/.test(g[0].summary));
});

test("with no migrated set supplied, the banner claims nothing rather than guessing", () => {
  const r = solve([t("A", { estimate_minutes: 60, deadline: "2026-08-07" })]);
  const g = groupScheduleFindings(scheduleFindings(r));
  assert.equal(g[0].all_migration_artefacts, false);
});

test("groups come back in a stable order and carry every failing item", () => {
  const r = solve([
    t("A", { estimate_minutes: 60, deadline: "2026-08-07" }),
    t("C1", { estimate_minutes: 60 }), t("C2", { estimate_minutes: 60 }),
  ], [edge("C1", "C2"), edge("C2", "C1")], { runId: "run-2" });
  const g = groupScheduleFindings(scheduleFindings(r, { persisted: [{ id: "A", schedule_run_id: "old" }] }));
  assert.deepEqual(g.map((x) => `${x.kind}:${x.count}`),
    ["deadline-unreachable:1", "dependency-cycle:2", "schedule-stale:1"]);
  for (const grp of g) assert.equal(grp.items.length, grp.count, "every failing item is listed");
});

// ---------------------------------------------------------------- the one-function rule

test("one function serves both readers — audit's shape and the view's shape are the same data", () => {
  // The findings array is {ticket, kind, detail}, exactly auditCorpus's shape, so `blaze
  // audit` can concatenate it and summarise() needs no change. The view reads the same
  // objects through groupScheduleFindings. There is no second computation to drift.
  const r = solve([t("A", { estimate_minutes: 480 * 3, deadline: "2026-08-25" })]);
  const f = scheduleFindings(r);
  for (const x of f) assert.deepEqual(Object.keys(x).slice(0, 3), ["ticket", "kind", "detail"]);
  assert.deepEqual(summarise(f), [{ kind: "deadline-unreachable", count: 1, severity: "soft" }]);
  assert.equal(groupScheduleFindings(f)[0].items[0], f[0], "the view groups the SAME objects");
});

// ------------------------------------------------- defects found by adversarial review

test("REVIEW — a finding does not say 'no predecessors' about a ticket that has one", () => {
  // bindingChain returns [id] whenever no predecessor is BINDING, and the tail text read that
  // as "no predecessors at all". Here A → B exists and B's ES is driven by its not_before, so
  // the old text asserted something the result object itself contradicts — and never named
  // the constraint that actually decides the date, which is §7.2's whole rule.
  const r = solve([
    t("A", { estimate_minutes: 480 }),
    t("B", { estimate_minutes: 480, constraint_start_no_earlier_than: "2026-09-14", deadline: "2026-09-01" }),
  ], [edge("A", "B")]);
  const f = forId(scheduleFindings(r), "B");
  assert.ok(r.edges.some((e) => e.target === "B"), "B really does have a predecessor");
  assert.ok(!/no predecessors/.test(f.detail), `said "no predecessors" but B has one: ${f.detail}`);
  assert.match(f.detail, /not_before 2026-09-14/, "and it names the constraint that binds instead");
});

test("REVIEW — a ticket with genuinely no predecessors still says so", () => {
  const r = solve([t("SOLO", { estimate_minutes: 60, deadline: "2026-08-07" })]);
  assert.match(forId(scheduleFindings(r), "SOLO").detail, /no predecessors — nothing else decides this date/);
});

test("REVIEW — the migration banner checks the dates it claims are in the past", () => {
  // `all_migration_artefacts` was pure cohort membership while the summary string conjoined a
  // second, unverified claim — "and already in the past". OMA-4 is IN the 12-id cohort and its
  // deadline is 2026-10-20, so the twelfth member falsifies the banner the moment it fires.
  const r = solve([
    t("PAST", { estimate_minutes: 60, deadline: "2026-01-05" }),
    t("FUTURE", { estimate_minutes: 480 * 40, deadline: "2026-09-30" }),
  ]);
  const g = groupScheduleFindings(scheduleFindings(r), { migratedDeadlines: ["PAST", "FUTURE"] });
  assert.equal(g[0].count, 2);
  assert.equal(g[0].all_migration_artefacts, true, "both ARE migrated");
  assert.equal(g[0].all_already_past, false, "but one deadline is after the epoch");
  assert.ok(!/already in the past/.test(g[0].summary), `banner overclaimed: ${g[0].summary}`);
  assert.match(g[0].summary, /all 2 are dates migrated/);
});

test("REVIEW — when every member IS in the past, the banner says both things", () => {
  const r = solve([
    t("A", { estimate_minutes: 60, deadline: "2026-08-07" }),
    t("B", { estimate_minutes: 60, deadline: "2026-08-16" }),
  ]);
  const g = groupScheduleFindings(scheduleFindings(r), { migratedDeadlines: ["A", "B"] });
  assert.equal(g[0].all_already_past, true);
  assert.match(g[0].summary, /all 2 are dates migrated .* and already in the past/);
});

test("REVIEW — crosses_projects is false when the chain stays inside one project", () => {
  // Only the POSITIVE direction was asserted, so forcing crosses_projects always-true survived
  // mutation. §6.2's rule is that a foreign-derived date must SAY SO — a flag that is always
  // true says nothing.
  const r = solve([
    t("INF-1", { estimate_minutes: 480 }), t("INF-2", { estimate_minutes: 480, deadline: "2026-08-24" }),
  ], [edge("INF-1", "INF-2")]);
  const f = forId(scheduleFindings(r), "INF-2");
  assert.deepEqual(f.chain, ["INF-1", "INF-2"]);
  assert.equal(f.crosses_projects, false);
  assert.ok(!/crosses projects/.test(f.detail), `claimed a crossing that is not there: ${f.detail}`);
});

test("REVIEW — lateness is counted in WORKING days, so a weekend is not two days late", () => {
  // The only lateness assertion was /1 working day late/, which reads the same whether the
  // count is working days or calendar days — no test spanned a weekend, so counting calendar
  // days survived mutation. Deadline Friday 2026-08-28, finish Monday 2026-08-31: three
  // calendar days, ONE working day.
  const r = solve([t("A", { estimate_minutes: 480 * 6, deadline: "2026-08-28" })]);
  const f = forId(scheduleFindings(r), "A");
  assert.equal(f.due_date ?? r.by_id.get("A").due_date, "2026-08-31");
  assert.equal(f.late_working_days, 1, "Sat and Sun are not lateness");
  assert.match(f.detail, /1 working day late/);
});

test("REVIEW — lateness over a longer span counts only working days", () => {
  const r = solve([t("A", { estimate_minutes: 480 * 11, deadline: "2026-08-24" })]);
  const f = forId(scheduleFindings(r), "A");
  assert.equal(r.by_id.get("A").due_date, "2026-09-07");
  assert.equal(f.late_working_days, 10, "14 calendar days, 10 working ones");
});
