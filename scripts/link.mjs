// scripts/link.mjs — `blaze link [--rm] <id> <TYPE> <target>`: add/remove a typed
// link on a ticket's `links:` frontmatter, validating the type vocabulary and (on
// add) that the target resolves to a real ticket. fs-only; the runner commits.
import { fsStorage } from "./model/storage.mjs";
import { fsWritePort } from "./model/write-port.mjs";
import { basename, dirname } from "node:path";
import { locateTicket, ambiguousIdError } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { LINK_TYPES, addLink, removeLink } from "./model/links.mjs";

export async function applyLink(projectsDir, id, { type, target, remove = false }, opts = {}) {
  const { today = null, storage = fsStorage,
          writePort = fsWritePort(projectsDir, storage) } = opts;
  if (!LINK_TYPES.has(type)) {
    return { ok: false, errors: [`unknown link type '${type}' (expected ${[...LINK_TYPES].join("/")})`] };
  }
  const { found, duplicates } = locateTicket(projectsDir, id);
  if (duplicates) return { ok: false, errors: [ambiguousIdError(id, duplicates)] };
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };
  if (!remove) {
    // A target resolving to two files is not a resolved target: the link would point at two
    // different tickets, and which one it meant is unrecoverable from the frontmatter alone.
    const t = locateTicket(projectsDir, target);
    if (t.duplicates) return { ok: false, errors: [ambiguousIdError(target, t.duplicates)] };
    if (!t.found) return { ok: false, errors: [`link target does not resolve: ${target}`] };
  }
  const fm = { ...found.frontmatter };
  fm.links = remove ? removeLink(fm.links, type, target) : addLink(fm.links, type, target);
  if (today) fm.updated = today;
  const { file } = await writePort.write({
    project: found.project, status: found.status,
    frontmatter: fm, body: found.body, currentFile: found.file,
  });
  return { ok: true, id, file };
}
