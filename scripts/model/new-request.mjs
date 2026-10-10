// scripts/model/new-request.mjs — the network boundary of `POST /api/new` and the remote
// refusals (BLZ-684). Pure, so it is unit-tested apart from a server, and run by `serve.mjs`
// BEFORE any id is allocated.
import { slugify } from "./storage.mjs";

/** The longest title `POST /api/new` accepts — a sanity bound on what one request may carry.
 *  It is NOT what keeps the file name legal; `ticketFileNameFits` is. */
export const NEW_TITLE_MAX = 300;

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
 * silently dropped; `estimate` must be a whole number of minutes that fits the column; a
 * `project` must be one this board configures (when it configures any) — a member must not be
 * able to mint a new project key over the network.
 * @returns { request } | { errors: string[] }
 */
export function newRequestOrErrors(payload, configuredProjects = []) {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  if (!p) return { errors: ["the body must be a JSON object"] };
  const errors = [];
  for (const k of ["project", "type", "title"]) {
    if (typeof p[k] !== "string" || !p[k].trim()) errors.push(`${k} must be a non-empty string`);
  }
  if (typeof p.title === "string" && p.title.length > NEW_TITLE_MAX) {
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
      && !(typeof p.estimate === "number" && Number.isFinite(p.estimate) && p.estimate > 0 && p.estimate <= 2147483645)) {
    errors.push("estimate must be a number of minutes above 0");
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
 *  `projects/…` tail. */
export function withoutServerPaths(errors) {
  return errors.map((e) => String(e).replace(/(^|[\s"'(])\/\S*?\/(projects\/)/g, "$1$2"));
}
