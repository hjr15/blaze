// scripts/edit.mjs — validated in-place field edits and AC-checkbox toggling.
// fs-only (no git); the board/CLI wrappers commit. All business rules come from
// model/ — this file only marshals a patch through validateTicket before writing.
import { writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { walkTickets } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { validateTicket } from "./model/rules.mjs";
import { roundEstimate } from "./model/time.mjs";
import { EDITABLE_FIELDS } from "./model/fields.mjs";
import { loadProject } from "./config.mjs";
import { validateTaxonomy } from "./model/taxonomy.mjs";
import { loadSprints, validateSprintFields } from "./model/sprints.mjs";

// Same id resolution as move.mjs/log.mjs: prefer the project-dir-matching id.
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

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return v == null ? [] : [v];
}

export function applyEdit(projectsDir, id, patch, opts = {}) {
  const { today = null } = opts;
  const bad = Object.keys(patch).filter((k) => !EDITABLE_FIELDS.has(k));
  if (bad.length) return { ok: false, errors: [`field(s) not editable: ${bad.join(", ")}`] };

  const found = locate(projectsDir, id);
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };

  const fm = { ...found.frontmatter };
  for (const [k, v] of Object.entries(patch)) {
    if (k === "estimate") fm.estimate = roundEstimate(v);
    else if (k === "labels" || k === "components") fm[k] = asArray(v);
    else fm[k] = v === "" ? null : v;
  }

  // Validate the merged ticket. lookup spans every ticket for parent-pair + cycle checks.
  const all = new Map();
  for (const t of walkTickets(projectsDir)) all.set(t.frontmatter.id, { frontmatter: t.frontmatter, body: t.body });
  all.set(id, { frontmatter: fm, body: found.body });
  const errors = validateTicket({ frontmatter: fm, body: found.body }, (pid) => all.get(pid) || null);
  if (fm.project) {
    const project_cfg = loadProject(fm.project, { root: dirname(projectsDir), projectsDir });
    errors.push(...validateTaxonomy(fm, project_cfg));
  }
  const { sprints } = loadSprints({ root: dirname(projectsDir) });
  errors.push(...validateSprintFields(fm, { sprintIds: new Set(sprints.map((s) => s.id)) }));
  if (errors.length) return { ok: false, errors };

  if (today) fm.updated = today;
  writeFileSync(found.file, serializeTicket({ frontmatter: fm, body: found.body }));
  return { ok: true, id, file: found.file };
}

// Flip one checkbox under the `## Acceptance Criteria` heading, by ordinal.
// Only lines within that section count; a `- [ ]` elsewhere in the body is ignored.
export function applyToggleAc(projectsDir, id, { index, checked }, opts = {}) {
  const { today = null } = opts;
  const found = locate(projectsDir, id);
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };

  const lines = found.body.split("\n");
  const isHeading = (l) => /^\s{0,3}#{1,6}\s/.test(l);
  const start = lines.findIndex((l) => /^\s{0,3}#{1,6}\s+acceptance criteria\s*$/i.test(l));
  if (start === -1) return { ok: false, errors: ["ticket has no ## Acceptance Criteria section"] };

  const acLineIdx = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) break;                 // next section ends AC
    if (/^\s*- \[[ xX]\]\s/.test(lines[i])) acLineIdx.push(i);
  }
  if (index < 0 || index >= acLineIdx.length) {
    return { ok: false, errors: [`AC index ${index} out of range (0..${acLineIdx.length - 1})`] };
  }
  const li = acLineIdx[index];
  lines[li] = lines[li].replace(/^(\s*- )\[[ xX]\]/, `$1[${checked ? "x" : " "}]`);

  const fm = { ...found.frontmatter };
  if (today) fm.updated = today;
  writeFileSync(found.file, serializeTicket({ frontmatter: fm, body: lines.join("\n") }));
  return { ok: true, id, file: found.file };
}
