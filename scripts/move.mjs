// scripts/move.mjs — `blaze move <id> <status>`: validate the transition, set
// resolution on terminal entry, rewrite frontmatter, and relocate the ticket file
// between status directories. applyMove() is pure-ish (fs only, no git) for tests;
// the CLI wrapper adds git add/commit.
import { dirname } from "node:path";
import { locateTicket, ambiguousIdError } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { fsStorage, ticketPath } from "./model/storage.mjs";
import { fsReadStorage } from "./model/read-storage.mjs";
import { planMove } from "./model/move-plan.mjs";
import { loadProject } from "./config.mjs";
import { isTerminal } from "./model/workflows.mjs";
import { isType } from "./model/schema.mjs";

export function applyMove(projectsDir, id, toStatus, opts = {}) {
  const { today = null, storage = fsStorage, readStorage = fsReadStorage } = opts;
  const { found, duplicates } = locateTicket(projectsDir, id);
  if (duplicates) return { ok: false, errors: [ambiguousIdError(id, duplicates)] };
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

  // Advisory-only: an open (non-terminal) Blocks link targeting this ticket never
  // stops the move, it just surfaces a warning for the caller to print.
  const warnings = [];
  if (toStatus === "in-progress") {
    // ADR-0009: ask the driver for the blockers instead of walking the corpus and
    // filtering here. This was the engine's worst read — a full 2,534-ticket walk to
    // answer a two-row question, ~22 ms and ~5.6 MiB per invocation against 0.06 ms
    // from an index.
    for (const t of readStorage.blockersOf(projectsDir, id)) {
      // A blocker whose type is unresolvable can't be classified terminal/open —
      // treat it as non-blocking rather than let isTerminal() throw and abort the move.
      if (isType(t.frontmatter.type) && !isTerminal(t.frontmatter.type, t.status)) {
        warnings.push(`advisory: ${id} is blocked by ${t.frontmatter.id} (open) — moving to in-progress anyway`);
      }
    }
  }

  const fm = { ...plan.frontmatter };
  if (today) fm.updated = today;
  const text = serializeTicket({ frontmatter: fm, body: plan.body });

  // The destination comes from the ticket's OWN project plus the target status, via
  // the path authority — never from arithmetic on found.file. Deriving the project
  // as dirname(dirname(file)) silently produced "done/BLZ-9" for any non-path
  // handle, and this function still returned ok:true. See ticketPath.relocate.
  const { file: destFile } = ticketPath.relocate(
    projectsDir, found.project, toStatus, found.file);
  storage.move(found.file, destFile, text);

  return { ok: true, id, from: found.status, to: toStatus, fromFile: found.file, file: destFile, resolution: plan.resolution, warnings };
}
