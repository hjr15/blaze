// scripts/log.mjs — `blaze log <id> <minutes>`: append a worklog entry to a
// ticket. applyLog() is pure-fs (no git) for tests; the CLI wrapper commits.
// Worklog minutes round to 1m and must be positive (model/time.roundWorklog).
import { writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { walkTickets } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { roundWorklog } from "./model/time.mjs";

// Same id resolution as move.mjs: prefer the ticket whose project dir matches
// the id prefix; fall back to the first id match.
function locate(projectsDir, id) {
  let fallback = null;
  for (const t of walkTickets(projectsDir)) {
    if (t.frontmatter.id !== id) continue;
    const projectKey = basename(dirname(dirname(t.file)));
    if (id.startsWith(`${projectKey}-`)) return t;
    fallback ??= t;
  }
  return fallback;
}

export function applyLog(projectsDir, id, minutes, opts = {}) {
  const { date = null, note = null, today = null } = opts;
  const found = locate(projectsDir, id);
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };

  let rounded;
  try { rounded = roundWorklog(minutes); }
  catch (e) { return { ok: false, errors: [e.message] }; }

  const entry = { date: date ?? today, minutes: rounded };
  if (note) entry.note = note;

  const fm = { ...found.frontmatter };
  const worklog = Array.isArray(fm.worklog) ? [...fm.worklog] : [];
  worklog.push(entry);
  fm.worklog = worklog;
  if (today) fm.updated = today;

  const total = worklog.reduce((s, w) => s + (Number(w.minutes) || 0), 0);
  writeFileSync(found.file, serializeTicket({ frontmatter: fm, body: found.body }));
  return { ok: true, id, minutes: rounded, total_worklog_minutes: total, file: found.file };
}
