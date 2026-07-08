// scripts/views/data.mjs — pure, read-only board/live models.
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { walkTickets, buildIndex } from "../model/index.mjs";
import { rollUp } from "../model/rollup.mjs";
import { WORKFLOWS } from "../model/workflows.mjs";
import { parseActivity, groupByTicket } from "../model/activity.mjs";
import { resolveRoots } from "../config.mjs";

const PRIORITY_ORDER = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4, none: 5, urgent: 0 };

// The canonical column order = the union of every workflow's statuses, in
// declaration order, deduped. (delivery, then goal-only, then risk-only.)
const STATUS_ORDER = [...new Set(Object.values(WORKFLOWS).flatMap((w) => w.statuses))];

const title = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Pure board model: read every ticket under projectsDir, optionally filter to one
// project, and group into status columns. Read-only (the editable board is Phase 6).
export function boardModel(projectsDir, { project = "all" } = {}) {
  const all = [...walkTickets(projectsDir)].map((t) => ({
    file: basename(t.file), meta: t.frontmatter, body: t.body,
    status: t.status, project: t.frontmatter.project,
  }));
  const projectsCount = all.reduce((acc, t) => {
    acc[t.project] = (acc[t.project] || 0) + 1; return acc;
  }, {});
  const rows = project === "all" ? all : all.filter((t) => t.project === project);

  const byStatus = new Map();
  for (const t of rows) {
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
  const rollup = rollUp(buildIndex(projectsDir));
  return { selected: project, projects: projectsCount, columns, total: rows.length, rollup };
}

// A cheap hash of all ticket files' size+mtime, for the auto-reload poll.
export function contentHash() {
  let h = 0;
  const projectsDir = resolveRoots().projectsDir;
  const stack = [projectsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e);
      let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { stack.push(p); continue; }
      const sig = `${p}:${s.size}:${s.mtimeMs}`;
      for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
    }
  }
  return String(h);
}

// Live-activity model: tail <dataRoot>/.blaze/activity.jsonl, group by ticket,
// attach each ticket's current column from the board index. Missing/empty file
// degrades to no groups. Read-only; the feed is written by the claude-config hook.
export function liveModel(dataRoot, projectsDir, { now = Date.now() } = {}) {
  let text = "";
  try { text = readFileSync(join(dataRoot, ".blaze", "activity.jsonl"), "utf8"); } catch { text = ""; }
  const events = parseActivity(text);
  const statusByKey = {};
  for (const r of buildIndex(projectsDir).rows) if (r.id) statusByKey[r.id] = r.status;
  return { groups: groupByTicket(events, { now, statusByKey }) };
}
