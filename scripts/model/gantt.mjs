// scripts/model/gantt.mjs — the Gantt view's pure model. Given the built index,
// the sprint registry, a requested sprint id, a project scope and an injected
// `now`, produce positioned rows (one bar per delivery ticket), group-header
// rows per distinct parent epic, a day axis, and a today-marker x.
//
// Pure, zero-dep, no Date.now()/Math.random() so the golden SVG stays stable.
// Dates parse as UTC via `Date.parse(d + "T00:00:00Z")`. A locale-independent
// `cmp` (never localeCompare) keeps the sort byte-stable across machines.
//
// Sprint scoping deliberately IGNORES the board's focus/flat rule: the gantt
// selects rows by `sprint` field, not by hierarchy, else no-focus would hide
// every level-0 row.
import { isType, workflowFor, hierarchyLevel } from "./schema.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const PX_PER_DAY = 28;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const parseDay = (d) => Date.parse(d + "T00:00:00Z");

// A row is a bar row iff its type resolves to the delivery workflow. Guard with
// isType FIRST — workflowFor throws on null/unknown (schema.mjs:37), and index
// rows carry `type: fm.type ?? null`, so an unguarded call would crash render.
function isDelivery(type) {
  return isType(type) && workflowFor(type) === "delivery";
}

const EMPTY = { selected: null, sprints: [], rows: [], groups: [], axis: null, nowX: null, warnings: [], empty: true };

export function ganttModel({ index, sprints, sprint, project = "all", now }) {
  const list = sprints && Array.isArray(sprints.sprints) ? sprints.sprints : [];
  if (list.length === 0) return { ...EMPTY };

  const active = sprints.active ?? null;
  const selectedId = sprint ?? active;
  // Requested sprint wins; else the active one; else the first registered.
  const sel = list.find((s) => s.id === selectedId) || list.find((s) => s.id === active) || list[0];

  // ---- axis: [sprint.start - 1d, sprint.end + 1d], one column per day --------
  const winStart = parseDay(sel.start);
  const winEnd = parseDay(sel.end);
  const startMs = winStart - DAY_MS;
  const dayCount = Math.round((winEnd - winStart) / DAY_MS) + 3; // pad one day each side
  const endMs = startMs + dayCount * DAY_MS; // exclusive end of the last day
  const width = dayCount * PX_PER_DAY;
  const xForMs = (ms) => ((ms - startMs) / DAY_MS) * PX_PER_DAY;

  const days = [];
  for (let i = 0; i < dayCount; i++) {
    const ms = startMs + i * DAY_MS;
    const d = new Date(ms);
    days.push({ ms, iso: d.toISOString().slice(0, 10), x: i * PX_PER_DAY, weekStart: d.getUTCDay() === 1 });
  }
  const axis = { startMs, endMs, days, pxPerDay: PX_PER_DAY, width };
  const nowX = now >= startMs && now <= endMs ? xForMs(now) : null;

  // ---- rows: in-scope delivery tickets, positioned ---------------------------
  const scoped = index.rows.filter(
    (r) => r.sprint === sel.id && (project === "all" || r.project === project),
  );
  const warnings = [];
  const rows = [];
  for (const r of scoped) {
    if (!isDelivery(r.type)) {
      warnings.push(`${r.id}: type '${r.type}' is not a delivery ticket — skipped`);
      continue;
    }
    const s = r.start ? parseDay(r.start) : null;
    const d = r.due ? parseDay(r.due) : null;
    let barKind, barStart, barEnd;
    if (s !== null && d !== null) { barKind = "solid"; barStart = s; barEnd = d + DAY_MS; }
    else if (s !== null) { barKind = "open-end"; barStart = s; barEnd = winEnd + DAY_MS; }
    else if (d !== null) { barKind = "open-start"; barStart = winStart; barEnd = d + DAY_MS; }
    else { barKind = "unplanned"; barStart = winStart; barEnd = winEnd + DAY_MS; }
    const x = xForMs(barStart);
    rows.push({
      id: r.id, title: r.title ?? null, type: r.type, status: r.status ?? null,
      assignee: r.assignee ?? null, parent: r.parent ?? null,
      start: r.start ?? null, due: r.due ?? null,
      barKind, x, w: xForMs(barEnd) - x,
    });
  }

  // Deterministic order: parent epic, then hierarchy level DESC, then id.
  rows.sort((a, b) =>
    cmp(a.parent ?? "", b.parent ?? "") ||
    cmp(hierarchyLevel(b.type), hierarchyLevel(a.type)) ||
    cmp(a.id, b.id));

  // ---- groups: one header per distinct parent epic ---------------------------
  const seen = new Set();
  const groups = [];
  for (const r of rows) {
    if (r.parent == null || seen.has(r.parent)) continue;
    seen.add(r.parent);
    const epicRow = index.get(r.parent);
    groups.push({ epicId: r.parent, title: epicRow?.title ?? null });
  }
  groups.sort((a, b) => cmp(a.epicId, b.epicId));

  return { selected: sel.id, sprints: list, rows, groups, axis, nowX, warnings, empty: false };
}
