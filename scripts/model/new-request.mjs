// scripts/model/new-request.mjs — the network boundary of `POST /api/new` and the remote
// refusals (BLZ-684). Pure, so it is unit-tested apart from a server, and run by `serve.mjs`
// BEFORE any id is allocated.
import { realpathSync } from "node:fs";
import { slugify } from "./storage.mjs";

/** The longest title `POST /api/new` accepts, in characters (Unicode code points, not UTF-16
 *  units — an emoji is one) — a sanity bound on what one request may carry. It is NOT what
 *  keeps the file name legal; `ticketFileNameFits` is. */
export const NEW_TITLE_MAX = 300;

/** The largest estimate (minutes) the column holds once `applyNew` rounds it to the nearest 5:
 *  2^31 - 1 is the Postgres `integer` ceiling, and 2147483645 is the last value that still
 *  rounds to a multiple of 5 at or below it. */
export const NEW_ESTIMATE_MAX = 2147483645;

/** The longest file name (in bytes) the filesystems Blaze runs on accept. */
export const FILE_NAME_MAX_BYTES = 255;

/**
 * Would the ticket's FILE NAME fit, whatever number it is given? An fs-mode ticket is
 * `<KEY>-<n>-<slug>.md` (`ticketPath`, with the engine's own `slugify`), and slugify does not
 * truncate, so a long title is an ENAMETOOLONG — AFTER the id was allocated, which burns it.
 * Judged against a 10-digit number, the widest an id will realistically reach, so the answer
 * cannot change between this check and the allocation. Applied in every mode: a title the
 * board cannot store as a file must not exist only because the board happens to be on a
 * database today.
 */
export function ticketFileNameFits(project, title) {
  return Buffer.byteLength(`${project}-9999999999-${slugify(title)}.md`) <= FILE_NAME_MAX_BYTES;
}
const NEW_STRING_FIELDS = ["parent", "assignee", "likelihood", "impact", "reason", "sprint",
                           "not_before", "deadline"];

/**
 * `POST /api/new`'s body → `applyNew`'s options, or the reasons it is refused. Pure, and run
 * BEFORE anything is allocated. A wrong-typed field is refused by name, never coerced or
 * silently dropped; `estimate` must be a finite number of minutes above 0 and at most
 * `NEW_ESTIMATE_MAX` — a fraction is accepted and rounded to the nearest 5 by `applyNew`, as
 * `blaze new --estimate` is; a `project` must be one this board configures (when it configures
 * any) — a member must not be able to mint a new project key over the network. A board that
 * configures NO projects keeps `blaze new`'s own behaviour, which creates the key: that is
 * documented in docs/architecture.md (the `/api/new` row).
 * @returns { request } | { errors: string[] }
 */
export function newRequestOrErrors(payload, configuredProjects = []) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!p) return { errors: ["the body must be a JSON object"] };
  const errors = [];
  for (const k of ["project", "type", "title"]) {
    if (typeof p[k] !== "string" || !p[k].trim()) errors.push(`${k} must be a non-empty string`);
  }
  if (typeof p.title === "string" && [...p.title].length > NEW_TITLE_MAX) {
    errors.push(`title is too long (${NEW_TITLE_MAX} characters max)`);
  } else if (typeof p.title === "string" && typeof p.project === "string"
             && !ticketFileNameFits(p.project, p.title)) {
    errors.push(`title is too long to name the ticket's file (${FILE_NAME_MAX_BYTES} bytes max, as a slug)`);
  }
  if (typeof p.project === "string" && Array.isArray(configuredProjects) && configuredProjects.length
      && !configuredProjects.includes(p.project)) {
    errors.push(`project ${JSON.stringify(p.project)} is not one this board configures (${configuredProjects.join(", ")})`);
  }
  if (p.priority !== undefined && typeof p.priority !== "string") errors.push("priority must be a string");
  for (const k of NEW_STRING_FIELDS) {
    if (p[k] !== undefined && typeof p[k] !== "string") errors.push(`${k} must be a string`);
  }
  for (const k of ["labels", "components"]) {
    if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].every((x) => typeof x === "string"))) {
      errors.push(`${k} must be a list of strings`);
    }
  }
  // A finite positive number, as `blaze new --estimate` takes: `applyNew` rounds it to the
  // nearest 5 (`roundEstimate`) on both paths, so 7.5 is 10 locally and remotely alike.
  if (p.estimate !== undefined
      && !(typeof p.estimate === "number" && Number.isFinite(p.estimate) && p.estimate > 0 && p.estimate <= NEW_ESTIMATE_MAX)) {
    errors.push(`estimate must be a number of minutes above 0 and at most ${NEW_ESTIMATE_MAX}`);
  }
  if (errors.length) return { errors };
  const extra = {};
  for (const k of NEW_STRING_FIELDS) if (p[k] !== undefined) extra[k] = p[k];
  if (p.components !== undefined) extra.components = p.components;
  if (p.estimate !== undefined) extra.estimate = p.estimate;
  return { request: { project: p.project, type: p.type, title: p.title, priority: p.priority ?? "medium",
                      labels: p.labels ?? [], extra } };
}

/** A refusal sent to a remote caller names a ticket, never where the server keeps its files:
 *  an absolute path in `refusing to overwrite /srv/…/projects/ENG/…` is reduced to its
 *  `projects/…` tail. BLZ-691: the board's REAL `projectsDir` is reduced the same way —
 *  `/srv/board/tickets/ENG/…` reads `projects/ENG/…` — so a projects directory that is not
 *  named `projects` does not leak either, and neither does its `realpath` when the configured
 *  path is a symlink. Matched only where a path STARTS (start of text, after whitespace, a
 *  quote, `(`, `[` or a backtick — never inside `/mnt/srv/…`) and where the directory ENDS (end
 *  of text, a separator, whitespace, a quote, a bracket, `,` `:` `;` a backtick, or a `.` that
 *  ends the sentence) — never a sibling such as `tickets-old` or `tickets.bak`. */
export function withoutServerPaths(errors, { projectsDir = null } = {}) {
  const real = projectsDirPattern(projectsDir);
  return errors.map((e) => {
    let s = String(e);
    if (real) s = s.replace(real, "projects");
    return s.replace(/(^|[\s"'(])\/\S*?\/(projects\/)/g, "$1$2");
  });
}

function projectsDirPattern(projectsDir) {
  const dir = projectsDir ? String(projectsDir).replace(/[\\/]+$/, "") : "";
  if (!dir) return null;
  const dirs = new Set([dir]);
  try { dirs.add(realpathSync(dir).replace(/[\\/]+$/, "")); } catch { /* absent or unreadable: the configured path alone */ }
  const alts = [...dirs].filter(Boolean).sort((a, b) => b.length - a.length)
    .map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<=^|[\\s"'(\\[\`])(?:${alts.join("|")})(?=$|[\\\\/\\s"'()\\[\\],:;\`]|\\.(?![\\w-]))`, "g");
}
