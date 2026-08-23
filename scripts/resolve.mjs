// scripts/resolve.mjs — `blaze resolve <id> <resolution>`: override the resolution
// field independently of status (the non-Done close path). Does NOT move the file.
import { fsStorage } from "./model/storage.mjs";
import { fsWritePort } from "./model/write-port.mjs";
import { locateTicket, ambiguousIdError } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { RESOLUTIONS } from "./model/workflows.mjs";

export async function applyResolve(projectsDir, id, resolution, opts = {}) {
  const { today = null, storage = fsStorage,
          writePort = fsWritePort(projectsDir, storage) } = opts;
  if (!RESOLUTIONS.includes(resolution)) {
    return { ok: false, errors: [`invalid resolution: ${resolution} (expected ${RESOLUTIONS.join(", ")})`] };
  }
  const { found, duplicates } = locateTicket(projectsDir, id);
  if (duplicates) return { ok: false, errors: [ambiguousIdError(id, duplicates)] };
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };

  const fm = { ...found.frontmatter, resolution };
  if (today) fm.updated = today;
  const { file } = await writePort.write({
    project: found.project, status: found.status,
    frontmatter: fm, body: found.body, currentFile: found.file,
  }, { actor: opts.actor ?? "unknown", source: opts.source ?? "cli" });
  return { ok: true, id, resolution, file };
}
