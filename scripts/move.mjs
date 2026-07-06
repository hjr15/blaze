// scripts/move.mjs — `blaze move <id> <status>`: validate the transition, set
// resolution on terminal entry, rewrite frontmatter, and relocate the ticket file
// between status directories. applyMove() is pure-ish (fs only, no git) for tests;
// the CLI wrapper adds git add/commit.
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { walkTickets } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { planMove } from "./model/move-plan.mjs";
import { loadProject } from "./config.mjs";

function locate(projectsDir, id) {
  let fallback = null;
  for (const t of walkTickets(projectsDir)) {
    if (t.frontmatter.id !== id) continue;
    const projectKey = basename(dirname(dirname(t.file))); // projects/<KEY>/<status>/<file>
    if (id.startsWith(`${projectKey}-`)) return t; // canonical: id prefix matches project dir
    fallback ??= t;
  }
  return fallback;
}

export function applyMove(projectsDir, id, toStatus, opts = {}) {
  const { today = null } = opts;
  const found = locate(projectsDir, id);
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };

  // requireWorklog: explicit opt wins; otherwise read the ticket's project config.
  let requireWorklog = opts.requireWorklog;
  if (requireWorklog === undefined) {
    try {
      const proj = loadProject(found.frontmatter.project, { root: dirname(projectsDir), projectsDir });
      requireWorklog = proj.requireWorklogBeforeTerminal;
    } catch { requireWorklog = false; }
  }

  const hasWorklog = Array.isArray(found.frontmatter.worklog) && found.frontmatter.worklog.length > 0;
  const plan = planMove({ frontmatter: found.frontmatter, body: found.body }, found.status, toStatus,
    { hasWorklog, requireWorklog });
  if (!plan.ok) return { ok: false, errors: plan.errors };

  const fm = { ...plan.frontmatter };
  if (today) fm.updated = today;
  const text = serializeTicket({ frontmatter: fm, body: plan.body });

  // project key = the directory two levels up from the file (projects/<KEY>/<status>/file)
  const statusDir = dirname(found.file);
  const projectDir = dirname(statusDir);
  const destDir = join(projectDir, toStatus);
  const destFile = join(destDir, basename(found.file));
  mkdirSync(destDir, { recursive: true });
  writeFileSync(found.file, text);
  if (destFile !== found.file) renameSync(found.file, destFile);

  return { ok: true, id, from: found.status, to: toStatus, fromFile: found.file, file: destFile, resolution: plan.resolution };
}
