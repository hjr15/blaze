// scripts/link.mjs — `blaze link [--rm] <id> <TYPE> <target>`: add/remove a typed
// link on a ticket's `links:` frontmatter, validating the type vocabulary and (on
// add) that the target resolves to a real ticket. fs-only; the runner commits.
import { writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { walkTickets } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { LINK_TYPES, addLink, removeLink } from "./model/links.mjs";

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

export function applyLink(projectsDir, id, { type, target, remove = false }, opts = {}) {
  const { today = null } = opts;
  if (!LINK_TYPES.has(type)) {
    return { ok: false, errors: [`unknown link type '${type}' (expected ${[...LINK_TYPES].join("/")})`] };
  }
  const found = locate(projectsDir, id);
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };
  if (!remove && !locate(projectsDir, target)) {
    return { ok: false, errors: [`link target does not resolve: ${target}`] };
  }
  const fm = { ...found.frontmatter };
  fm.links = remove ? removeLink(fm.links, type, target) : addLink(fm.links, type, target);
  if (today) fm.updated = today;
  writeFileSync(found.file, serializeTicket({ frontmatter: fm, body: found.body }));
  return { ok: true, id, file: found.file };
}
