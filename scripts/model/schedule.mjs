// scripts/model/schedule.mjs — the CPM solve. ADR-0022: dependency edges, effort and date
// constraints are inputs; start_date, due_date, float and the critical path are outputs
// computed here and never hand-set.
//
// Pure, zero-dep. No Date.now(), no Math.random(): `now` is injected by the caller and a
// locale-independent `cmp` (never localeCompare) keeps every output array byte-stable.
// Ties break on ticket id — that last rule is BLZ-360 §6.1's addition, not something
// gantt.mjs's header says, and it is implemented here because a stable order is worth more
// than a faithful quotation.
//
// TIME IS SIGNED WORKING MINUTES FROM project_epoch. t=0 is the epoch instant, and a date
// before the epoch is negative rather than clamped on the way in. That is deliberate: it
// makes `max(0, ...)` in the forward pass BE the project_epoch floor (BLZ-360 §6.1's "a plan
// that starts in the past is not a plan") instead of a second, separate clamp that could
// disagree with it. It is also what lets a `done` predecessor whose actual finish is months
// past supply a boundary value that correctly holds nothing back.
//
// The graph is built by filtering IN THIS ORDER, and the order is part of the rule
// (BLZ-360 §6.2):
//   1. Edges — keep a `Precedes` edge only if both endpoints are DECLARED PRECEDES ENDPOINT
//      KINDS. Deliberately not "the delivery kinds": there are six delivery-workflow types and
//      `epic` is the sixth, a conflation link-schema.mjs warns against in as many words. Read
//      from DEFAULT_LINK_TYPES rather than restated.
//   2. Nodes — a ticket whose type is a declared Precedes SOURCE kind, and which is not
//      terminal (ADR-0022 §What the scheduler treats as a node). The same entry as rule 1, so
//      the node set and the edge set cannot drift. A terminal ticket is never a node, never an
//      SCC member, and is NEVER marked `unscheduled`: its dates are frozen actuals owned by
//      history. If Tarjan ran over the full graph the "every SCC member is unscheduled" rule
//      would overwrite them.
//   3. Tarjan over what is left.
import { isTerminal } from "./workflows.mjs";
import { DEFAULT_LINK_TYPES } from "./link-schema.mjs";

export const PRECEDES = "Precedes";
const DAY_MS = 24 * 60 * 60 * 1000;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const PRECEDES_TYPE = DEFAULT_LINK_TYPES.find((l) => l.name === PRECEDES);
const SOURCE_KINDS = new Set(PRECEDES_TYPE.source_kinds);
const TARGET_KINDS = new Set(PRECEDES_TYPE.target_kinds);

const parseDay = (iso) => Date.parse(iso + "T00:00:00Z");
const isoOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayOf = (ms) => new Date(ms).getUTCDay();

// ---------------------------------------------------------------- the working calendar
//
// A tiny class so the arithmetic has one home and every conversion is reversible. Nothing
// here reads a default: minutes_per_day and working_days arrive from the caller, because
// BLZ-360 §2.3 ("Calendar") makes board config their single definition. ADR-0022 carries the
// rule but has NO numbered sections, and an earlier version of this comment cited one that does
// not exist. tests/config.test.mjs greps scripts/ to keep the rule honest.
class Calendar {
  constructor(minutesPerDay, workingDays, nowMs) {
    this.mpd = minutesPerDay;
    this.working = new Set(workingDays);
    // project_epoch: the first working day on or after `now`'s UTC date. BLZ-360 §6.1 calls
    // this "floored to the next working day"; on a working day that is the day itself, and
    // the reading matters because it decides whether a Monday plan starts on Monday.
    let ms = Date.UTC(...isoOf(nowMs).split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
    let guard = 0;
    while (!this.working.has(dayOf(ms))) {
      ms += DAY_MS;
      if (++guard > 7) throw new Error("blaze schedule: schedule.working_days contains no working day");
    }
    this.epochMs = ms;
    this.epochDate = isoOf(ms);
    this.perWeek = [0, 1, 2, 3, 4, 5, 6].filter((d) => this.working.has(d)).length;
  }

  /** Signed count of working days in [epoch, iso) — negative when iso precedes the epoch. */
  workingDaysFromEpoch(iso) {
    const d = Math.round((parseDay(iso) - this.epochMs) / DAY_MS);
    if (d === 0) return 0;
    const sign = d < 0 ? -1 : 1;
    const [from, span] = sign > 0 ? [this.epochMs, d] : [parseDay(iso), -d];
    const weeks = Math.floor(span / 7);
    let n = weeks * this.perWeek;
    for (let i = weeks * 7; i < span; i++) if (this.working.has(dayOf(from + i * DAY_MS))) n++;
    return sign * n;
  }

  /**
   * The calendar date of the k-th working day on or after the epoch.
   *
   * The `k >= 0` precondition was documented and UNENFORCED, which is exactly how a
   * fractional duration turned into a due_date before the epoch: dayIndexAt(-0.5) is -1 and
   * this walked backwards instead of refusing. A precondition nothing checks is a comment.
   */
  dateForWorkingDay(k) {
    if (!Number.isInteger(k) || k < 0) {
      throw new Error(`blaze schedule: negative working-day index ${k} — the epoch is day 0 `
        + "and nothing schedules before it");
    }
    const weeks = Math.floor(k / this.perWeek);
    let rem = k - weeks * this.perWeek;
    let ms = this.epochMs + weeks * 7 * DAY_MS;
    let guard = 0;
    for (;;) {
      if (this.working.has(dayOf(ms))) { if (rem === 0) return isoOf(ms); rem--; }
      ms += DAY_MS;
      if (++guard > 14) throw new Error("blaze schedule: working-day walk did not terminate");
    }
  }

  /** Working minutes from the epoch to the START of the first working day >= iso. */
  minutesAtStartOf(iso) { return this.workingDaysFromEpoch(iso) * this.mpd; }

  /**
   * Working minutes from the epoch to the instant work finishing ON iso is complete.
   *
   * For a WORKING day that is the end of that day. For a non-working one there is no "day
   * containing iso" to end, and this used to round UP — so a terminal predecessor that
   * finished on a Saturday was treated as if work ran through the following Monday and its
   * successor lost a working day. The right answer is the START of the next working day,
   * which workingDaysFromEpoch already returns for a non-working date. Measured: the live
   * board carries 10 tickets with a weekend `due` (5 Sat, 5 Sun).
   */
  minutesAtEndOf(iso) {
    const n = this.workingDaysFromEpoch(iso);
    return (this.working.has(dayOf(parseDay(iso))) ? n + 1 : n) * this.mpd;
  }

  /**
   * The date work is ON at working-minute t, for a span [es, ef). A span of one whole
   * working day finishes at the END of that day, so the inclusive last day is the one
   * containing (ef - 1) — not the one containing ef, which is the next day's first instant.
   * A zero-duration milestone has no last-minute, so it reports the day it starts on.
   */
  dayIndexAt(t) { return Math.floor(t / this.mpd); }
  // Math.max(es, ...) rather than a branch on ef === es: `ef - 1` is the last instant only
  // for an integer-minute duration, and a duration below one minute drove this below the day
  // the span starts on.
  lastDayIndex(es, ef) { return this.dayIndexAt(Math.max(es, ef - 1)); }
}

// ---------------------------------------------------------------- Tarjan
//
// Iterative rather than recursive: the board is 2,630 tickets and a deep chain would blow
// the stack on a path that is meant to be defensive. Node order and each adjacency list are
// pre-sorted by id, so the component list and its members are byte-stable.
function tarjan(ids, succ) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [], out = [];
  let next = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work = [{ v: root, i: 0 }];
    index.set(root, next); low.set(root, next); next++;
    stack.push(root); onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const kids = succ.get(frame.v) ?? [];
      if (frame.i < kids.length) {
        const w = kids[frame.i++];
        if (!index.has(w)) {
          index.set(w, next); low.set(w, next); next++;
          stack.push(w); onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v), index.get(w)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent), low.get(frame.v)));
      }
      if (low.get(frame.v) === index.get(frame.v)) {
        const comp = [];
        for (;;) {
          const w = stack.pop(); onStack.delete(w); comp.push(w);
          if (w === frame.v) break;
        }
        out.push(comp.sort(cmp));
      }
    }
  }
  return out.sort((a, b) => cmp(a[0], b[0]));
}

// ---------------------------------------------------------------- the solve

/**
 * @param tickets  [{ id, type, status, estimate_minutes, constraint_start_no_earlier_than,
 *                    deadline, start_date, due_date }]
 * @param links    [{ type, src, target, lag_minutes }] — every link; non-Precedes is ignored
 * @param schedule { minutes_per_day, working_days } — board config, never defaulted here
 * @param now      injected epoch-ms; the model never reads the clock
 * @param runId    stamped onto the result so a persisted row can be told stale
 */
export function scheduleModel({ tickets = [], links = [], schedule = null, now, runId = null } = {}) {
  if (!schedule || typeof schedule.minutes_per_day !== "number" || !Array.isArray(schedule.working_days)) {
    throw new Error("blaze schedule: schedule.minutes_per_day and schedule.working_days are required "
      + "— board config is their single definition (BLZ-360 §2.3)");
  }
  // The message deliberately does not name the forbidden call: the determinism test greps
  // this file for it, and a mention inside a string would be a false positive that the fix
  // is to weaken the test.
  if (!Number.isFinite(now)) throw new Error("blaze schedule: `now` must be injected by the caller — the model reads no clock");
  const cal = new Calendar(schedule.minutes_per_day, schedule.working_days, now);

  // A duplicate id was LAST-WINS, so the same two rows in the other order produced a
  // different schedule and a different horizon. read-storage.mjs:33 states the principle that
  // broke — "an id that resolves to two files is ambiguous and a write must not land on a
  // guess" — and the solve was guessing silently. It is dropped rather than thrown: `blaze
  // audit` already raises `duplicate-status` HARD for this corpus, and taking the whole audit
  // down to re-report a condition it already reports would be worse.
  const rows = new Map();
  const duplicated = new Set();
  for (const t of tickets) {
    if (!t || t.id == null) continue;
    if (rows.has(t.id)) duplicated.add(t.id); else rows.set(t.id, t);
  }
  const terminalOf = (t) => { try { return isTerminal(t.type, t.status); } catch { return false; } };
  // A node is a ticket whose type is a declared `Precedes` SOURCE kind — the same
  // DEFAULT_LINK_TYPES entry that decides which EDGES are legal. One source, so the node set and
  // the edge set cannot drift apart.
  //
  // This replaced `workflowFor(type) === "delivery"` under BLZ-388, which was a SECOND definition
  // that merely coincided. The two differ by exactly one type — `epic` — and giving a container
  // its own CPM dates from its own estimate double-counts the children those dates should be
  // rolled up FROM. The two rules differ by exactly `epic` and the board holds zero of them, so
  // they select the same set — verified 2026-08-25 by running both over the live corpus, zero
  // ids in either difference. That invariant is the claim; the cardinality moves with the board.
  //
  // It also closes BLZ-378: `link-schema.mjs` and `gantt.mjs` no longer disagree about `epic`,
  // because the solve no longer asks the gantt's question. BLZ-360 §8.3 is the argument — "a
  // parent's dates are a roll-up OF the finished schedule, computed afterwards" — so putting a
  // container in the CPM graph computes the same quantity twice by two methods.
  //
  // That roll-up is spec 4's and is NOT BUILT: both existing roll-ups sum estimate/worklog and
  // neither touches a date. So an epic gets no derived dates from anywhere today. Inert here
  // (zero epics), and stated rather than papered over — see ADR-0022 §What the scheduler treats
  // as a node.
  const isNodeKind = (t) => SOURCE_KINDS.has(t.type);

  // --- filter 1: edges, on the declared endpoint kinds (default-deny at the store) -------
  const dropped = [];
  const kept = [];
  for (const l of links) {
    const src = l.src, target = l.target;
    const drop = (reason) => dropped.push({ src, target, type: l.type ?? null, reason });
    if ((l.type ?? PRECEDES) !== PRECEDES) { drop("not-precedes"); continue; }
    if (src === target) { drop("self-edge"); continue; }
    const a = rows.get(src), b = rows.get(target);
    if (!a || !b) { drop("dangling-endpoint"); continue; }
    if (!SOURCE_KINDS.has(a.type) || !TARGET_KINDS.has(b.type)) { drop("undeclared-kind"); continue; }
    kept.push({ src, target, lag_minutes: Number(l.lag_minutes ?? 0) });
  }

  // --- filter 2: nodes — non-terminal, and a declared Precedes SOURCE kind ---------------
  //
  // The node rule is ADR-0022's, §What the scheduler treats as a node, and it is no longer this
  // module's inference: BLZ-383 asked whether it was §6.2's rule or a reading, and BLZ-388
  // decided and recorded it. `isNodeKind` above is where it comes from.
  //
  // Two things it excludes, for two different reasons:
  //
  //   non-delivery types — a `goal`, `risk`, `requirement` or `architecture` would otherwise be
  //     an isolated node handed a derived start_date and due_date CPM never meant for it.
  //     Measured 2026-08-25: 203 of them (43/65/89/6). None can carry an edge anyway, because
  //     Precedes' endpoint kinds refuse all four.
  //   `epic` — a container. BLZ-360 §8.3: "a parent's dates are a roll-up OF the finished
  //     schedule, computed afterwards", so scheduling one computes the same quantity twice.
  //
  // It does not change the horizon today: the largest estimate on a non-terminal non-delivery
  // ticket is OBA-1 (`goal/in-progress`) at 830 minutes, against BLZ-253's 4,800. It could on
  // another board, which is why the filter is here rather than left to luck.
  const nodeIds = [...rows.keys()]
    .filter((id) => !terminalOf(rows.get(id)) && isNodeKind(rows.get(id)) && !duplicated.has(id))
    .sort(cmp);
  const isNode = new Set(nodeIds);

  // An edge into or out of a ticket that is not a node cannot exist: the node is not there.
  // A terminal PREDECESSOR is different — it is not a node either, but §6.2 keeps it as a
  // boundary condition, so its edge survives as a lower bound rather than as graph structure.
  const boundary = new Map();   // node id -> earliest start forced by terminal predecessors
  const edges = [];
  for (const e of kept) {
    if (!isNode.has(e.target)) { dropped.push({ ...e, type: PRECEDES, reason: "terminal-endpoint" }); continue; }
    if (!isNode.has(e.src)) {
      // EF of a terminal predecessor is its actual due, or project_epoch if it has none.
      const d = rows.get(e.src).due_date;
      const ef = d ? cal.minutesAtEndOf(d) : 0;
      boundary.set(e.target, Math.max(boundary.get(e.target) ?? -Infinity, ef + e.lag_minutes));
      dropped.push({ ...e, type: PRECEDES, reason: "terminal-predecessor" });
      continue;
    }
    edges.push(e);
  }

  // --- filter 3: Tarjan over what is left ------------------------------------------------
  const succ = new Map(nodeIds.map((id) => [id, []]));
  for (const e of [...edges].sort((a, b) => cmp(a.src, b.src) || cmp(a.target, b.target) || (a.lag_minutes - b.lag_minutes))) {
    succ.get(e.src).push(e.target);
  }
  const comps = tarjan(nodeIds, succ);
  const cycles = comps.filter((c) => c.length > 1);
  const inCycle = new Set(cycles.flat());

  const unscheduled = [];
  for (const c of cycles) for (const id of c) unscheduled.push({ id, reason: "dependency-cycle", scc: c });
  for (const id of [...duplicated].sort(cmp)) unscheduled.push({ id, reason: "duplicate-id", scc: [id] });
  unscheduled.sort((a, b) => cmp(a.id, b.id));

  // Edges out of a cycle are treated as unconstrained and edges into one have nothing to
  // constrain — §6.2 states the out-edge relaxation as the approximation it is.
  const solveIds = nodeIds.filter((id) => !inCycle.has(id));
  const solveSet = new Set(solveIds);
  const out = new Map(solveIds.map((id) => [id, []]));
  const into = new Map(solveIds.map((id) => [id, []]));
  for (const e of edges) {
    if (!solveSet.has(e.src) || !solveSet.has(e.target)) continue;
    out.get(e.src).push(e);
    into.get(e.target).push(e);
  }
  for (const list of out.values()) list.sort((a, b) => cmp(a.target, b.target));
  for (const list of into.values()) list.sort((a, b) => cmp(a.src, b.src));

  // --- topological order, ties broken by id so the walk is byte-stable -------------------
  const indeg = new Map(solveIds.map((id) => [id, into.get(id).length]));
  const ready = solveIds.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (ready.length) {
    ready.sort(cmp);
    const v = ready.shift();
    order.push(v);
    for (const e of out.get(v)) {
      const n = indeg.get(e.target) - 1;
      indeg.set(e.target, n);
      if (n === 0) ready.push(e.target);
    }
  }
  if (order.length !== solveIds.length) throw new Error("blaze schedule: cycle survived Tarjan — this is a bug in the solve");

  // --- forward pass ---------------------------------------------------------------------
  const dur = new Map(), es = new Map(), ef = new Map();
  for (const id of solveIds) {
    const e = rows.get(id).estimate_minutes;
    dur.set(id, Number.isFinite(e) && e > 0 ? e : 0);   // no estimate => 0 => a milestone
  }
  for (const id of order) {
    const r = rows.get(id);
    // The project_epoch floor is this `0`, and mutation 8 is dropping it.
    let start = 0;
    if (r.constraint_start_no_earlier_than) start = Math.max(start, cal.minutesAtStartOf(r.constraint_start_no_earlier_than));
    if (boundary.has(id)) start = Math.max(start, boundary.get(id));
    for (const e of into.get(id)) start = Math.max(start, ef.get(e.src) + e.lag_minutes);
    es.set(id, start);
    ef.set(id, start + dur.get(id));
  }

  // --- the horizon (BLZ-380, ADR-0022 §The backward pass's horizon) ----------------------
  // max(EF) over the COMPLETED forward pass: one constant over every scheduled node on the
  // board. The self-reference is apparent — the forward pass is finished by the time this
  // line runs. When nothing is scheduled, max over an empty set is undefined and the rule
  // is project_epoch, which is 0 on this axis.
  let horizon = 0;
  for (const id of solveIds) horizon = Math.max(horizon, ef.get(id));

  // --- backward pass --------------------------------------------------------------------
  const lf = new Map(), ls = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    let late = null;
    // MIN over successors, not max: mutation 3. A node whose successors were all filtered
    // out is a sink and seeds from the horizon, which is spec 3 §13.4's terminal-successor
    // case arriving here rather than as a special rule.
    for (const e of out.get(id)) late = late === null ? ls.get(e.target) - e.lag_minutes : Math.min(late, ls.get(e.target) - e.lag_minutes);
    if (late === null) late = horizon;
    lf.set(id, late);
    ls.set(id, late - dur.get(id));
  }

  const scheduled = solveIds.map((id) => {
    const floatMinutes = ls.get(id) - es.get(id);   // LS - ES: mutation 4 inverts it
    return {
      id,
      es: es.get(id), ef: ef.get(id), ls: ls.get(id), lf: lf.get(id),
      duration_minutes: dur.get(id),
      float_minutes: floatMinutes,
      is_critical: floatMinutes === 0,
      start_date: cal.dateForWorkingDay(cal.dayIndexAt(es.get(id))),
      due_date: cal.dateForWorkingDay(cal.lastDayIndex(es.get(id), ef.get(id))),
      deadline: rows.get(id).deadline ?? null,
      schedule_run_id: runId,
    };
  }).sort((a, b) => cmp(a.id, b.id));

  return {
    run_id: runId,
    epoch_date: cal.epochDate,
    epochDate: cal.epochDate,
    minutes_per_day: cal.mpd,
    working_days: [0, 1, 2, 3, 4, 5, 6].filter((d) => cal.working.has(d)),
    horizon_minutes: horizon,
    horizon_date: cal.dateForWorkingDay(cal.lastDayIndex(0, horizon)),
    scheduled,
    unscheduled,
    cycles,
    edges: edges.slice().sort((a, b) =>
      cmp(a.src, b.src) || cmp(a.target, b.target) || (a.lag_minutes - b.lag_minutes)),
    // Sorted like every other array here. It is the only one that was not, and its order was
    // input-order dependent across two separate push loops — a real hole in "byte-stable",
    // because a caller that reorders its links would get a different result object. Proved by
    // reverting the sort: the determinism test fails, so it discriminates.
    // Sorted like every other array here, and the tie-break runs all the way down to the lag:
    // Array.prototype.sort is stable, so two Precedes edges between the SAME pair carrying
    // different lags kept the caller's input order until `lag_minutes` joined the key.
    dropped_edges: dropped.slice().sort((a, b) =>
      cmp(a.src, b.src) || cmp(a.target, b.target) || cmp(a.reason, b.reason)
      || ((a.lag_minutes ?? 0) - (b.lag_minutes ?? 0))),
    by_id: new Map(scheduled.map((s) => [s.id, s])),
    // So a finding can NAME what bound a start rather than guess at it (audit.mjs's boundBy).
    constraint_of: new Map(solveIds
      .filter((id) => rows.get(id).constraint_start_no_earlier_than)
      .map((id) => [id, rows.get(id).constraint_start_no_earlier_than])),
  };
}
