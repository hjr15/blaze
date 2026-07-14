// scripts/model/index.mjs — build a queryable read model from all ticket files
// across all projects. The index is DISPOSABLE: rebuild any time from markdown
// (the source of truth). Pure-JS / zero-dep so it runs on blaze's Node floor.
// The Index interface is storage-agnostic — a future node:sqlite implementation
// must satisfy the same shape (spec §13, revised), so the swap stays contained.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseTicket } from "./ticket.mjs";
import { lintLinks } from "./links.mjs";

function safeReaddir(p) { try { return readdirSync(p); } catch { return []; } }
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// Per-file parse cache: path → { mtimeMs, size, frontmatter, body }.
// Validated by stat on every walk (same freshness semantics as re-reading —
// the board stays a pure view over files); hits skip readFileSync+parse.
// Yielded objects are shared across walks: callers must treat them as
// immutable. Entries for deleted/moved paths are pruned lazily.
const parseCache = new Map();

// Yields every ticket under projectsDir/<KEY>/<status>/<id>.md
export function* walkTickets(projectsDir) {
  const seen = new Set();
  for (const project of safeReaddir(projectsDir)) {
    const projPath = join(projectsDir, project);
    if (!isDir(projPath)) continue;
    for (const status of safeReaddir(projPath)) {
      const statusPath = join(projPath, status);
      if (!isDir(statusPath)) continue;
      for (const f of safeReaddir(statusPath)) {
        if (!f.endsWith(".md")) continue;
        const file = join(statusPath, f);
        let s; try { s = statSync(file); } catch { continue; }
        seen.add(file);
        const hit = parseCache.get(file);
        if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) {
          yield { frontmatter: hit.frontmatter, body: hit.body, status, file };
          continue;
        }
        const { frontmatter, body } = parseTicket(readFileSync(file, "utf8"));
        parseCache.set(file, { mtimeMs: s.mtimeMs, size: s.size, frontmatter, body });
        yield { frontmatter, body, status, file };
      }
    }
  }
  // Lazy prune: drop cache entries whose file vanished (moved/deleted) so a
  // long-lived server doesn't accumulate one stale entry per ticket move.
  // This only runs on a FULL drain of the generator — code here is reached
  // only when the loop above finishes on its own. A caller that breaks early
  // (move/edit/log/resolve all `break` once they find the id they're after)
  // calls the generator's implicit .return(), which unwinds at the last
  // `yield` and skips straight past this block; wrapping it in try/finally
  // would not change that, since `seen` at break time is partial and pruning
  // against a partial `seen` would wrongly evict entries for tickets the walk
  // simply hadn't reached yet, not entries that actually vanished. So partial
  // walks intentionally skip pruning; boardModel's full walk on every page
  // render is the reliable prune point that keeps the cache bounded.
  if (parseCache.size > seen.size) {
    for (const k of parseCache.keys()) if (!seen.has(k)) parseCache.delete(k);
  }
}

function makeIndex(rows, links, warnings) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    rows,
    links,
    warnings,
    get: (id) => byId.get(id),
    count: () => rows.length,
    byProject: (project) => rows.filter((r) => r.project === project),
    countByProject: () => rows.reduce((acc, r) => {
      acc[r.project] = (acc[r.project] || 0) + 1; return acc;
    }, {}),
    linksFrom: (id) => links.filter((l) => l.src === id),
    toJSON: () => ({ tickets: rows, links, warnings }),
  };
}

export function buildIndex(projectsDir, { tickets } = {}) {
  const rows = [];
  const links = [];
  const collected = [];
  for (const t of tickets ?? walkTickets(projectsDir)) {
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
    collected.push(fm);
  }
  const knownIds = new Set(rows.map((r) => r.id));
  const warnings = collected.flatMap((fm) => lintLinks(fm, knownIds));
  return makeIndex(rows, links, warnings);
}
