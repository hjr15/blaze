// scripts/model/metrics.mjs — pure metrics model: tile summary + a daily
// cumulative-flow-diagram (CFD) series, derived from a boardModel(...) result
// and a transitions list (Metrics-view Task 1's `{id,from,to,ts}` history).
//
// No import from views/ or serve.mjs — model→view imports would invert
// layering. Status ordering is re-derived from WORKFLOWS locally (do not
// import the private STATUS_ORDER const from views/data.mjs).
//
// `now` is always a caller-supplied parameter — never Date.now() in here —
// so the model is deterministic and testable without wall-clock flakiness.

import { WORKFLOWS } from "./workflows.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const IN_FLIGHT_STATUSES = new Set(["in-progress", "in-review", "todo"]);

// Canonical status order = the union of every workflow's statuses, in
// declaration order, deduped. Used to seed each day's `counts` with every
// known status at 0 so the CFD series has stable, gap-free keys across days.
const STATUS_ORDER = [...new Set(Object.values(WORKFLOWS).flatMap((w) => w.statuses))];

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function flattenTickets(board) {
  return board.columns.flatMap((c) => c.tickets);
}

// Latest (max-ts) transition for `id` whose `to` matches, in ms — null if none.
function latestToTs(transitions, id, to) {
  let latest = null;
  for (const tr of transitions) {
    if (tr.id !== id || tr.to !== to) continue;
    const ts = Date.parse(tr.ts);
    if (latest === null || ts > latest) latest = ts;
  }
  return latest;
}

// Replay each ticket's timeline (created → first status, then each transition
// in ts order) and tally, per calendar day (UTC) from the earliest ticket's
// creation through `now`, how many tickets sit in each status.
function buildSeries(tickets, transitions, now) {
  if (transitions.length === 0) return []; // DETERMINISM RULE — no history, no chart.
  if (tickets.length === 0) return [];

  const byId = new Map();
  for (const tr of transitions) {
    if (!byId.has(tr.id)) byId.set(tr.id, []);
    byId.get(tr.id).push(tr);
  }
  for (const list of byId.values()) list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const timelines = tickets.map((t) => {
    const trs = byId.get(t.meta.id) || [];
    const createdMs = Date.parse(t.meta.created);
    const initialStatus = trs.length ? trs[0].from : t.status;
    const events = [
      { ts: createdMs, status: initialStatus },
      ...trs.map((tr) => ({ ts: Date.parse(tr.ts), status: tr.to })),
    ];
    return { createdMs, events };
  });

  const dayStartOf = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
  const firstDay = dayStartOf(Math.min(...timelines.map((tl) => tl.createdMs)));
  const lastDay = dayStartOf(now);

  const series = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const cutoff = Math.min(day + DAY_MS - 1, now);
    const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    for (const tl of timelines) {
      if (tl.createdMs > cutoff) continue; // ticket doesn't exist yet on this day
      let status = tl.events[0].status;
      for (const ev of tl.events) {
        if (ev.ts <= cutoff) status = ev.status;
        else break;
      }
      counts[status] = (counts[status] ?? 0) + 1;
    }
    series.push({ date: new Date(day).toISOString().slice(0, 10), counts });
  }
  return series;
}

export function metricsModel({ board, transitions, now, project = "all" }) {
  // ids known to the board, mapped to their project — used to scope the
  // (project-agnostic) transitions list to the tickets actually in view.
  const idToProject = new Map();
  for (const t of flattenTickets(board)) idToProject.set(t.meta.id, t.project);

  const scopedTickets = flattenTickets(board).filter(
    (t) => project === "all" || t.project === project,
  );
  const scopedTransitions = transitions.filter((tr) => {
    const proj = idToProject.get(tr.id);
    if (proj === undefined) return false;
    return project === "all" || proj === project;
  });

  const doneCount = scopedTickets.filter((t) => t.status === "done").length;
  const inFlight = scopedTickets.filter((t) => IN_FLIGHT_STATUSES.has(t.status)).length;
  const donePct = board.total === 0 ? 0 : Math.round((doneCount / board.total) * 100);

  const windowStart = now - 14 * DAY_MS;
  const throughput14d = scopedTransitions.filter((tr) => {
    if (tr.to !== "done") return false;
    const ts = Date.parse(tr.ts);
    return ts >= windowStart && ts <= now;
  }).length;

  const cycleTimes = [];
  for (const t of scopedTickets) {
    const doneTs = latestToTs(scopedTransitions, t.meta.id, "done");
    if (doneTs === null) continue;
    cycleTimes.push(doneTs - Date.parse(t.meta.created));
  }
  const medianCycleTime = median(cycleTimes);

  const tiles = { total: board.total, inFlight, donePct, throughput14d, medianCycleTime };
  const series = buildSeries(scopedTickets, scopedTransitions, now);

  return { tiles, series };
}
