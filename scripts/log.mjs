// scripts/log.mjs — `blaze log <id> <minutes>`: append a worklog entry to a
// ticket. applyLog() is pure-fs (no git) for tests; the CLI wrapper commits.
// Worklog minutes round to 1m and must be positive (model/time.roundWorklog).
import { fsStorage } from "./model/storage.mjs";
import { fsWritePort } from "./model/write-port.mjs";
import { fsReadStorage } from "./model/read-storage.mjs";
import { basename, dirname } from "node:path";
import { locateTicket, ambiguousIdError } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { roundWorklog } from "./model/time.mjs";
import { isIsoDate } from "./model/sprints.mjs";

export async function applyLog(projectsDir, id, minutes, opts = {}) {
  const { date = null, note = null, today = null, storage = fsStorage, readStorage = fsReadStorage,
          writePort = fsWritePort(projectsDir, storage) } = opts;
  // BLZ-684: a given date must be a real one. `--date` (and now `POST /api/log`'s `date`) went
  // into the worklog verbatim — `not-a-date` landed in a file, and Postgres refused it with a 500.
  if (date !== null && date !== undefined && !isIsoDate(date)) {
    return { ok: false, errors: [`a worklog date must be a real YYYY-MM-DD date, got ${JSON.stringify(date)}`] };
  }
  const { found, duplicates } = await locateTicket(projectsDir, id, { storage: readStorage });
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
  const { file } = await writePort.write({
    project: found.project, status: found.status,
    frontmatter: fm, body: found.body, currentFile: found.file,
  }, { actor: opts.actor ?? "unknown", source: opts.source ?? "cli" });
  return { ok: true, id, minutes: rounded, total_worklog_minutes: total, file };
}
