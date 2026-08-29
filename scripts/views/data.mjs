// scripts/views/data.mjs — pure, read-only board/live models.
import { readRegularFileSync } from "../model/regular-file.mjs";
import { fsReadStorage } from "../model/read-storage.mjs";
import { join, basename } from "node:path";
import { buildIndex } from "../model/index.mjs";
import { rollUp } from "../model/rollup.mjs";
import { WORKFLOWS } from "../model/workflows.mjs";
import { TYPES, workflowFor } from "../model/schema.mjs";
import { deriveBoards, columnForStatus } from "../model/boards.mjs";
import { parseActivity, groupByTicket } from "../model/activity.mjs";
import { resolveRoots } from "../config.mjs";
import { scopedRows } from "../model/focus.mjs";

const PRIORITY_ORDER = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4, none: 5, urgent: 0 };

// The canonical column order = the union of every workflow's statuses, in
// declaration order, deduped. (delivery, then goal-only, then risk-only.)
const STATUS_ORDER = [...new Set(Object.values(WORKFLOWS).flatMap((w) => w.statuses))];

const title = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Pure board model: read every ticket under projectsDir, optionally filter to one
// project, and group into status columns. Read-only (the editable board is Phase 6).
export function boardModel(projectsDir, { project = "all", focus = null, flat = false, index = null,
                                          readStorage = fsReadStorage } = {}) {
  const walked = [...readStorage.listTickets(projectsDir)];
  const all = walked.map((t) => ({
    file: basename(t.file), meta: t.frontmatter, body: t.body,
    status: t.status, project: t.frontmatter.project,
  }));
  const projectsCount = all.reduce((acc, t) => {
    acc[t.project] = (acc[t.project] || 0) + 1; return acc;
  }, {});
  const rows = project === "all" ? all : all.filter((t) => t.project === project);

  const idx = index ?? buildIndex(projectsDir, { tickets: walked });
  // The shared drill-scope rule (scopedRows, BLZ-89) — board/list/map must
  // agree on what a level contains, so the rule lives in one place.
  const { focused, crumbs, rows: inScope } = scopedRows(idx, { focus, flat });
  const scopedIds = new Set(inScope.map((r) => r.id));
  const scoped = rows.filter((t) => scopedIds.has(t.meta.id));

  const childTally = {};
  for (const r of idx.rows) if (r.parent) childTally[r.parent] = (childTally[r.parent] || 0) + 1;
  for (const t of scoped) t.childCount = childTally[t.meta.id] || 0;

  const byStatus = new Map();
  for (const t of scoped) {
    if (!byStatus.has(t.status)) byStatus.set(t.status, []);
    byStatus.get(t.status).push(t);
  }
  const statuses = [
    ...STATUS_ORDER.filter((s) => byStatus.has(s)),
    ...[...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s)),
  ];
  const columns = statuses.map((dir) => ({
    dir, label: title(dir),
    tickets: byStatus.get(dir).sort((a, b) => {
      const pa = PRIORITY_ORDER[a.meta.priority] ?? 6, pb = PRIORITY_ORDER[b.meta.priority] ?? 6;
      return pa - pb || String(a.meta.id || "").localeCompare(String(b.meta.id || ""));
    }),
  }));
  const rollup = rollUp(idx);

  // --- additive: per-workflow boards. columns above stays the single
  // source metrics/chips/header read; boards is a second view over the same rows.
  const boardsDef = deriveBoards({ types: TYPES, workflows: WORKFLOWS });
  const boardOf = (t) => {
    let wf; try { wf = workflowFor(t.meta.type); } catch { wf = null; }
    return boardsDef.find((b) => b.workflows.includes(wf)) || boardsDef[0];
  };
  const boardViews = boardsDef.map((bd) => ({
    name: bd.name, label: bd.label,
    columns: bd.columns.map((c) => ({ dir: c.key, label: c.label, tickets: [] })),
  }));
  const byName = new Map(boardViews.map((b) => [b.name, b]));
  const extra = new Map(); // `${board} ${status}` -> ad-hoc column (degrade path)
  for (const t of scoped) {
    const bd = boardOf(t);
    const bv = byName.get(bd.name);
    const col = columnForStatus(bd, t.status);
    if (col) {
      t.badge = (col.folds.length > 1 && t.status !== col.key) ? t.status : null;
      bv.columns.find((c) => c.dir === col.key).tickets.push(t);
    } else {
      t.badge = null;
      const ek = `${bd.name} ${t.status}`;
      if (!extra.has(ek)) { const nc = { dir: t.status, label: title(t.status), tickets: [] }; extra.set(ek, nc); bv.columns.push(nc); }
      extra.get(ek).tickets.push(t);
    }
  }
  const sortTickets = (arr) => arr.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.meta.priority] ?? 6, pb = PRIORITY_ORDER[b.meta.priority] ?? 6;
    return pa - pb || String(a.meta.id || "").localeCompare(String(b.meta.id || ""));
  });
  for (const b of boardViews) for (const c of b.columns) sortTickets(c.tickets);
  const nonEmpty = boardViews.filter((b) => b.columns.some((c) => c.tickets.length));
  const boards = nonEmpty.length ? nonEmpty : [boardViews[0]].filter(Boolean);

  return {
    selected: project, projects: projectsCount, columns, total: scoped.length, rollup, boards,
    focus: focused ? { id: focus, crumbs } : null,
    index: idx,
  };
}

// The board's auto-reload poll asks one question: has anything changed? ADR-0009
// makes that a NAMED driver operation (`changeToken`) rather than a bespoke stat walk
// living in the view layer — it was the fourth read entry point and the only one that
// never went through walkTickets, which is why no earlier slice caught it.
//
// Scoped to projectsDir/<project> when project is given, so an edit in an unrelated
// project doesn't invalidate a project-focused view's poll.
export function contentHash({ projectsDir = resolveRoots().projectsDir, project = null,
                              readStorage = fsReadStorage } = {}) {
  return readStorage.changeToken(projectsDir, { project });
}

// Live-activity model: tail <dataRoot>/.blaze/activity.jsonl, group by ticket,
// attach each ticket's current column from the board index. Missing/empty file
// degrades to no groups. Read-only; the feed is written by the claude-config hook.
//
// BLZ-493: this is the one site of the ten that REPORTS rather than refuses, and the reason
// is that it is `serve.mjs`'s `/api/live` route on a LONG-LIVED process — the site whose hang
// was reproduced as exit 137. A throw would take a route down over an optional feed, so the
// guard degrades as before. But `groups: []` ALONE IS THE BUG: `views/live.mjs` renders
// exactly `No recent activity.` for it, a sentence about the world produced by a run that
// never looked at the world. So what could not be read travels out WITH the model, the way
// `forgeErrors` and `gitErrors` do (ADR-0030 §2), and the view says so instead.
//
// A MISSING feed stays silent. Nearly every board has none, and a banner that is permanent
// furniture is the gate people learn to skip. ADR-0031.
export function liveModel(dataRoot, projectsDir, { now = Date.now() } = {}) {
  const feed = join(dataRoot, ".blaze", "activity.jsonl");
  let text = "";
  let unreadable = null;
  try { text = readRegularFileSync(feed); }
  catch (e) {
    text = "";
    if (e && e.code === "ERR_BLAZE_NOT_A_REGULAR_FILE") unreadable = { path: feed, detail: e.message };
  }
  const events = parseActivity(text);
  const statusByKey = {};
  for (const r of buildIndex(projectsDir).rows) if (r.id) statusByKey[r.id] = r.status;
  return { groups: groupByTicket(events, { now, statusByKey }), unreadable };
}
