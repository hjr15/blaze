// scripts/new.mjs — `blaze new`: allocate the next per-project id, build a
// schema-correct ticket, validate it, and write it into the type's initial
// status dir. Pure-fs (no git); the CLI wrapper adds the commit.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { allocateId } from "./model/ids.mjs";
import { writeClaim, remoteMaxClaim } from "./model/claims.mjs";
import { isType } from "./model/schema.mjs";
import { initialStatus } from "./model/workflows.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { validateTicket } from "./model/rules.mjs";
import { roundEstimate } from "./model/time.mjs";
import { loadProject } from "./config.mjs";
import { validateTaxonomy, warnMissingRequired } from "./model/taxonomy.mjs";
import { loadSprints, validateSprintFields } from "./model/sprints.mjs";

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

  // BLZ-136 / ADR-0005: allocate + atomically reserve, seeded by the remote's
  // published claims so a cross-machine collision is usually AVOIDED rather than
  // merely detected later. dataRoot is the parent of projectsDir, matching
  // BLAZE_PROJECTS_DIR's semantics elsewhere.
  const dataRoot = dirname(projectsDir);
  // null = the remote could not be read, so this allocation is against a
  // possibly stale view. A numeric 0 means the remote WAS read and simply has no
  // claims yet — a known-empty set, not a stale one.
  const remoteMax = remoteMaxClaim(dataRoot, project);
  const { id, n } = allocateId(projectsDir, project, { dataRoot, remoteMax: remoteMax ?? 0 });
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
    sprint: extra.sprint ?? undefined,
    start: extra.start ?? undefined,
    due: extra.due ?? undefined,
    created: today, updated: today,
  };
  // Drop undefined risk-only keys so they don't serialize for non-risk types.
  if (frontmatter.likelihood === undefined) delete frontmatter.likelihood;
  if (frontmatter.impact === undefined) delete frontmatter.impact;
  // Drop undefined sprint fields so they don't serialize on every ticket (M2).
  if (frontmatter.sprint === undefined) delete frontmatter.sprint;
  if (frontmatter.start === undefined) delete frontmatter.start;
  if (frontmatter.due === undefined) delete frontmatter.due;

  const body = "## Context\n\n## Acceptance Criteria\n\n- [ ] \n\n## Notes\n";
  // Validate everything except parent-existence (parent integrity is a reindex
  // concern; at create time the parent may legitimately be created later).
  const errors = validateTicket({ frontmatter, body }).filter((e) => !/parent not found/.test(e));
  // allowMissing: creating a project's FIRST ticket is how a project comes into
  // existence, so its directory legitimately may not exist yet (BLZ-140).
  const project_cfg = loadProject(project, { root: dirname(projectsDir), projectsDir, allowMissing: true });
  errors.push(...validateTaxonomy(frontmatter, project_cfg));
  const { sprints } = loadSprints({ root: dirname(projectsDir) });
  errors.push(...validateSprintFields(frontmatter, { sprintIds: new Set(sprints.map((s) => s.id)) }));
  if (errors.length) return { ok: false, errors };

  const dir = join(projectsDir, project, status);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}-${slugify(title)}.md`);
  if (existsSync(file)) return { ok: false, errors: [`refusing to overwrite ${file}`] };
  writeFileSync(file, serializeTicket({ frontmatter, body }));
  // The claim has to land WITH the ticket — new-runner stages both. A ticket
  // that reaches upstream without its claim merges as silently as it did before
  // this existed. remoteMax === 0 means the remote could not be read, so the
  // allocation was made against a possibly stale view: mark it provisional.
  const claimFile = writeClaim(projectsDir, project, n, slugify(title), { provisional: remoteMax === null });
  const warnings = warnMissingRequired(frontmatter, project_cfg, { reason: extra.reason ?? null });
  return { ok: true, id, type, project, status, file, claimFile, warnings };
}
