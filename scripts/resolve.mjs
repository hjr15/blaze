// scripts/resolve.mjs — `blaze resolve <id> <resolution>`: override the resolution
// field independently of status (the non-Done close path). Does NOT move the file.
import { writeFileSync } from "node:fs";
import { walkTickets } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { RESOLUTIONS } from "./model/workflows.mjs";

export function applyResolve(projectsDir, id, resolution, opts = {}) {
  const { today = null } = opts;
  if (!RESOLUTIONS.includes(resolution)) {
    return { ok: false, errors: [`invalid resolution: ${resolution} (expected ${RESOLUTIONS.join(", ")})`] };
  }
  let found = null;
  for (const t of walkTickets(projectsDir)) { if (t.frontmatter.id === id) { found = t; break; } }
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };

  const fm = { ...found.frontmatter, resolution };
  if (today) fm.updated = today;
  writeFileSync(found.file, serializeTicket({ frontmatter: fm, body: found.body }));
  return { ok: true, id, resolution, file: found.file };
}
