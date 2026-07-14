// scripts/new.mjs — `blaze new`: allocate the next per-project id, build a
// schema-correct ticket, validate it, and write it into the type's initial
// status dir. Pure-fs (no git); the CLI wrapper adds the commit.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { nextId } from "./model/ids.mjs";
import { isType } from "./model/schema.mjs";
import { initialStatus } from "./model/workflows.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { validateTicket } from "./model/rules.mjs";
import { roundEstimate } from "./model/time.mjs";
import { loadProject } from "./config.mjs";
import { validateTaxonomy } from "./model/taxonomy.mjs";

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function applyNew(projectsDir, opts = {}) {
  const { project, type, title, priority = "medium", labels = [], today = null, extra = {} } = opts;
  const pre = [];
  if (!project) pre.push("missing project (use --project <KEY>)");
  if (!isType(type)) pre.push(`unknown or missing type: ${type}`);
  if (!title) pre.push("missing title");
  if (pre.length) return { ok: false, errors: pre };

  const id = nextId(projectsDir, project);
  const status = initialStatus(type);
  const frontmatter = {
    id, title, type, project, priority,
    resolution: null,
    parent: extra.parent ?? null,
    assignee: extra.assignee ?? "unassigned",
    labels, components: extra.components ?? [],
    estimate: roundEstimate(extra.estimate),
    likelihood: extra.likelihood ?? undefined,
    impact: extra.impact ?? undefined,
    created: today, updated: today,
  };
  // Drop undefined risk-only keys so they don't serialize for non-risk types.
  if (frontmatter.likelihood === undefined) delete frontmatter.likelihood;
  if (frontmatter.impact === undefined) delete frontmatter.impact;

  const body = "## Context\n\n## Acceptance Criteria\n\n- [ ] \n\n## Notes\n";
  // Validate everything except parent-existence (parent integrity is a reindex
  // concern; at create time the parent may legitimately be created later).
  const errors = validateTicket({ frontmatter, body }).filter((e) => !/parent not found/.test(e));
  const project_cfg = loadProject(project, { root: dirname(projectsDir), projectsDir });
  errors.push(...validateTaxonomy(frontmatter, project_cfg));
  if (errors.length) return { ok: false, errors };

  const dir = join(projectsDir, project, status);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}-${slugify(title)}.md`);
  if (existsSync(file)) return { ok: false, errors: [`refusing to overwrite ${file}`] };
  writeFileSync(file, serializeTicket({ frontmatter, body }));
  return { ok: true, id, type, project, status, file };
}
