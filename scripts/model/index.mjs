// scripts/model/index.mjs — build a queryable read model from all ticket files
// across all projects. The index is DISPOSABLE: rebuild any time from markdown
// (the source of truth). Pure-JS / zero-dep so it runs on blaze's Node floor.
// The Index interface is storage-agnostic — a future node:sqlite implementation
// must satisfy the same shape (spec §13, revised), so the swap stays contained.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseTicket } from "./ticket.mjs";

function safeReaddir(p) { try { return readdirSync(p); } catch { return []; } }
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// Yields every ticket under projectsDir/<KEY>/<status>/<id>.md
export function* walkTickets(projectsDir) {
  for (const project of safeReaddir(projectsDir)) {
    const projPath = join(projectsDir, project);
    if (!isDir(projPath)) continue;
    for (const status of safeReaddir(projPath)) {
      const statusPath = join(projPath, status);
      if (!isDir(statusPath)) continue;
      for (const f of safeReaddir(statusPath)) {
        if (!f.endsWith(".md")) continue;
        const file = join(statusPath, f);
        const { frontmatter, body } = parseTicket(readFileSync(file, "utf8"));
        yield { frontmatter, body, status, file };
      }
    }
  }
}

function makeIndex(rows, links) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    rows,
    links,
    get: (id) => byId.get(id),
    count: () => rows.length,
    byProject: (project) => rows.filter((r) => r.project === project),
    countByProject: () => rows.reduce((acc, r) => {
      acc[r.project] = (acc[r.project] || 0) + 1; return acc;
    }, {}),
    linksFrom: (id) => links.filter((l) => l.src === id),
    toJSON: () => ({ tickets: rows, links }),
  };
}

export function buildIndex(projectsDir) {
  const rows = [];
  const links = [];
  for (const t of walkTickets(projectsDir)) {
    const fm = t.frontmatter;
    const worklog_minutes = Array.isArray(fm.worklog)
      ? fm.worklog.reduce((s, w) => s + (Number(w.minutes) || 0), 0) : 0;
    rows.push({
      id: fm.id, project: fm.project ?? null, type: fm.type ?? null, title: fm.title ?? null,
      status: t.status, priority: fm.priority ?? null, resolution: fm.resolution ?? null,
      parent: fm.parent ?? null, assignee: fm.assignee ?? null, estimate: fm.estimate ?? null,
      worklog_minutes, file: t.file,
    });
    for (const link of fm.links ?? []) links.push({ src: fm.id, type: link.type, target: link.target });
  }
  return makeIndex(rows, links);
}
