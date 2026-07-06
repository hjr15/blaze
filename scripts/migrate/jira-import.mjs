// scripts/migrate/jira-import.mjs — the migration orchestrator. runDryRun (this
// task) runs the audit pipeline over the cache and returns the audit markdown +
// ledger object WITHOUT writing tickets. runLive (Task 9) executes the edited
// ledger. Pure of git; the runner does file writes + the bulk commit.
import { writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readRawCache } from "./jira-client.mjs";
import { normalizeIssue } from "./normalize.mjs";
import { mapIssue } from "./map.mjs";
import { proposeStructure } from "./restructure.mjs";
import { auditIssues } from "./audit.mjs";
import { renderAudit, renderLedger } from "./report.mjs";
import { serializeTicket } from "../model/ticket.mjs";
import { foldMerges, resolveLinkIntegrity } from "./merge.mjs";

export function loadNormalized(cacheDir, keys) {
  const norms = [];
  for (const key of keys) for (const raw of readRawCache(cacheDir, key)) norms.push(normalizeIssue(raw));
  return norms;
}

export function runDryRun({ cacheDir, keys, detectMerges = false }) {
  const norms = loadNormalized(cacheDir, keys);
  const restructure = proposeStructure(norms);
  const { dispositions, stats } = auditIssues(norms, restructure, { detectMerges });

  // Collect warnings by mapping each kept/re-parented item.
  const byKey = new Map(norms.map((n) => [n.key, n]));
  const warnings = [];
  for (const d of dispositions) {
    if (d.disposition !== "keep" && !d.disposition.startsWith("re-parent:")) continue;
    const { warnings: w } = mapIssue(byKey.get(d.id), { proposedParent: d.proposed_parent, proposedStatus: d.proposed_status });
    warnings.push(...w);
  }

  // Compute link-integrity report for the audit output.
  const { survivors: drySurvivors } = foldMerges(new Map(norms.map((n) => [n.key, n])), dispositions);
  const { integrity } = resolveLinkIntegrity(drySurvivors, dispositions);

  const source = {};
  for (const n of norms) source[n.project] = (source[n.project] || 0) + 1;

  return {
    auditMd: renderAudit({ norms, dispositions, restructure, warnings, integrity }),
    ledger: renderLedger(dispositions, source),
    stats,
  };
}

function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }

// Remove any existing file for `id` under projectsDir/<KEY>/* so a re-run with a
// changed status doesn't leave a duplicate (idempotency).
function removeExisting(projectsDir, project, id) {
  const projDir = join(projectsDir, project);
  let statuses = [];
  try { statuses = readdirSync(projDir); } catch { return; }
  for (const st of statuses) {
    const dir = join(projDir, st);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.startsWith(`${id}-`) || f === `${id}.md`) rmSync(join(dir, f), { force: true });
  }
}

export function runLive({ cacheDir, projectsDir, keys, ledger }) {
  const norms = loadNormalized(cacheDir, keys);
  const byKey = new Map(norms.map((n) => [n.key, n]));
  const dispositions = ledger.items;
  const dispById = new Map(dispositions.map((d) => [d.id, d]));

  const { survivors: rawSurvivors } = foldMerges(byKey, dispositions);
  const { survivors } = resolveLinkIntegrity(rawSurvivors, dispositions);

  const written = [];
  const files = [];
  let dropped = 0, merged = 0;
  for (const d of dispositions) {
    if (d.disposition === "drop") { dropped++; continue; }
    if (d.disposition.startsWith("merge-into:")) { merged++; continue; }
  }

  for (const [key, survivor] of survivors) {
    const d = dispById.get(key) || {};
    const { frontmatter, body, status } = mapIssue(survivor, { proposedParent: d.proposed_parent, proposedStatus: d.proposed_status });
    const project = frontmatter.project;
    removeExisting(projectsDir, project, key);
    const dir = join(projectsDir, project, status);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${key}-${slugify(frontmatter.title)}.md`);
    writeFileSync(file, serializeTicket({ frontmatter, body }));
    written.push(key);
    files.push(file);
  }
  return { written, dropped, merged, files };
}
