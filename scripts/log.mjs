// scripts/log.mjs — `blaze log <id> <minutes>`: append a worklog entry to a
// ticket. applyLog() is pure-fs (no git) for tests; the CLI wrapper commits.
// Worklog minutes round to 1m and must be positive (model/time.roundWorklog).
import { fsStorage } from "./model/storage.mjs";
import { basename, dirname } from "node:path";
import { locateTicket, ambiguousIdError } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { roundWorklog } from "./model/time.mjs";

export function applyLog(projectsDir, id, minutes, opts = {}) {
  const { date = null, note = null, today = null, storage = fsStorage } = opts;
  const { found, duplicates } = locateTicket(projectsDir, id);
  if (duplicates) return { ok: false, errors: [ambiguousIdError(id, duplicates)] };
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
  storage.write(found.file, serializeTicket({ frontmatter: fm, body: found.body }));
  return { ok: true, id, minutes: rounded, total_worklog_minutes: total, file: found.file };
}
