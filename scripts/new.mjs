// scripts/new.mjs — `blaze new`: allocate the next per-project id, build a
// schema-correct ticket, validate it, and write it into the type's initial
// status dir. Pure-fs (no git); the CLI wrapper adds the commit.
import { dirname } from "node:path";
import { allocateId } from "./model/ids.mjs";
import { walkTickets } from "./model/index.mjs";
import { writeClaim, remoteMaxClaim } from "./model/claims.mjs";
import { isType } from "./model/schema.mjs";
import { initialStatus } from "./model/workflows.mjs";
import { serializeTicket } from "./model/ticket.mjs";
import { fsStorage, ticketPath, slugify } from "./model/storage.mjs";
import { validateTicket } from "./model/rules.mjs";
import { loadProjectSchema } from "./model/schema-config.mjs";
import { roundEstimate } from "./model/time.mjs";
import { loadConfig, loadProject } from "./config.mjs";
import { validateTaxonomy, warnMissingRequired } from "./model/taxonomy.mjs";
import { loadSprints, validateSprintFields } from "./model/sprints.mjs";

export function applyNew(projectsDir, opts = {}) {
  const { project, type, title, priority = "medium", labels = [], today = null, extra = {},
          storage = fsStorage } = opts;
  const pre = [];
  if (!project) pre.push("missing project (use --project <KEY>)");
  if (!isType(type)) pre.push(`unknown or missing type: ${type}`);
  if (!title) pre.push("missing title");
  if (pre.length) return { ok: false, errors: pre };

  const dataRoot = dirname(projectsDir);
  const status = initialStatus(type);
  // INF-791: `id` is a placeholder until validation passes. Allocation is an
  // irreversible side effect (an O_EXCL reservation that survives a failed
  // create), so it happens AFTER the ticket is known to be valid — see below.
  // Declared first so the key order of the serialized frontmatter is unchanged.
  const frontmatter = {
    id: null, title, type, project, priority,
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
  // INF-791: validate the parent for real. This previously passed NO lookup and
  // then filtered out `parent not found`, on the reasoning that a parent might be
  // created later — which meant canParent() was never reached and `blaze new`
  // accepted epic -> epic without complaint. That is how the board accumulated
  // structurally invalid rows that the engine rejected everywhere else, and it
  // made `blaze edit` fail confusingly later on an unrelated field. The lookup
  // spans every ticket, matching edit.mjs, so parent-pair and cycle checks both
  // apply. Ids are allocated in order, so a parent that does not exist yet cannot
  // be named correctly anyway.
  const all = new Map();
  for (const t of walkTickets(projectsDir)) all.set(t.frontmatter.id, { frontmatter: t.frontmatter, body: t.body });
  // Validate against the TARGET PROJECT's registry, not the ambient one (BLZ-238).
  // BLZ-246: the registry is `default → top-level → project`, so the data root's config has
  // to be passed in. Without it `loadProjectSchema` defaults `config` to null, the top-level
  // `schema.types` block is skipped, and a board's declared override is honoured on the READ
  // path (schema.mjs resolves TYPES via ambientSchemaOverride) but silently ignored here —
  // which made `blaze new --parent <epic> --type task` fail on a board that declares that
  // edge. loadProject below already loads the same config, so this adds no new failure mode.
  const config = loadConfig({ root: dataRoot });
  const { types } = loadProjectSchema(projectsDir, project, { config });
  const errors = validateTicket({ frontmatter, body }, (pid) => all.get(pid) || null, { types });
  // allowMissing: creating a project's FIRST ticket is how a project comes into
  // existence, so its directory legitimately may not exist yet (BLZ-140).
  const project_cfg = loadProject(project, { root: dirname(projectsDir), projectsDir, allowMissing: true });
  errors.push(...validateTaxonomy(frontmatter, project_cfg));
  const { sprints } = loadSprints({ root: dirname(projectsDir) });
  errors.push(...validateSprintFields(frontmatter, { sprintIds: new Set(sprints.map((s) => s.id)) }));
  // Return BEFORE allocating: a rejected create must not consume an id. It used
  // to, which is how CRP-111 was lost, and it meant a gap in the id sequence was
  // not evidence that a ticket had been deleted.
  if (errors.length) return { ok: false, errors };

  // BLZ-136 / ADR-0005: allocate + atomically reserve, seeded by the remote's
  // published claims so a cross-machine collision is usually AVOIDED rather than
  // merely detected later. dataRoot is the parent of projectsDir, matching
  // BLAZE_PROJECTS_DIR's semantics elsewhere.
  //
  // null = the remote could not be read, so this allocation is against a
  // possibly stale view. A numeric 0 means the remote WAS read and simply has no
  // claims yet — a known-empty set, not a stale one.
  const remoteMax = remoteMaxClaim(dataRoot, project);
  const { id, n } = allocateId(projectsDir, project, { dataRoot, remoteMax: remoteMax ?? 0 });
  frontmatter.id = id;

  const { file } = ticketPath.parts(projectsDir, project, status, id, title);
  if (storage.exists(file)) return { ok: false, errors: [`refusing to overwrite ${file}`] };
  storage.write(file, serializeTicket({ frontmatter, body }));
  // The claim has to land WITH the ticket — new-runner stages both. A ticket
  // that reaches upstream without its claim merges as silently as it did before
  // this existed. remoteMax === 0 means the remote could not be read, so the
  // allocation was made against a possibly stale view: mark it provisional.
  const claimFile = writeClaim(projectsDir, project, n, slugify(title), { provisional: remoteMax === null });
  const warnings = warnMissingRequired(frontmatter, project_cfg, { reason: extra.reason ?? null });
  return { ok: true, id, type, project, status, file, claimFile, warnings };
}
