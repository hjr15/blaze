// scripts/migrate/map.mjs — pure: mapping tables + NormalizedIssue → a Blaze
// ticket object { frontmatter, body, status, warnings }. The single home for the
// Jira→blaze field/status/resolution/priority tables. Reuses model/* for rounding,
// the type set, workflow statuses, and validation. Does not serialize or write —
// the live orchestrator does that (Task 9).
import { roundEstimate, roundWorklog } from "../model/time.mjs";
import { isType } from "../model/schema.mjs";
import { initialStatus, statusesFor, isTerminal } from "../model/workflows.mjs";
import { validateTicket } from "../model/rules.mjs";

const TYPE_MAP = { goal: "goal", epic: "epic", risk: "risk", story: "story", task: "task", bug: "bug", "sub-task": "subtask", subtask: "subtask" };
const PRIORITY_SET = new Set(["highest", "high", "medium", "low", "lowest"]);
const RESOLUTION_MAP = { "done": "done", "won't do": "wont-do", "wont do": "wont-do", "duplicate": "duplicate", "cannot reproduce": "cannot-reproduce" };
// Jira status NAME → blaze status, per workflow. Lowercased lookup.
const STATUS_MAP = {
  delivery: { "defined": "defined", "to do": "defined", "in progress": "in-progress", "in review": "in-review", "done": "done" },
  goal:     { "defined": "defined", "in progress": "in-progress", "achieved": "achieved" },
  risk:     { "identified": "identified", "mitigated": "mitigated", "accepted": "accepted", "obsolete": "obsolete" },
};

export function mapType(t) {
  const key = String(t ?? "").toLowerCase();
  return TYPE_MAP[key] ?? key;
}
export function mapPriority(p) {
  const key = String(p ?? "").toLowerCase();
  return PRIORITY_SET.has(key) ? key : "medium";
}
export function mapResolution(r) {
  if (r == null) return null;
  return RESOLUTION_MAP[String(r).toLowerCase()] ?? null;
}

// workflow name for a blaze type, mirroring schema.mjs (avoids importing the full
// registry just for the workflow tag).
function workflowOf(blazeType) {
  if (blazeType === "goal") return "goal";
  if (blazeType === "risk") return "risk";
  return "delivery"; // epic/story/task/bug/subtask
}

function categoryFallback(blazeType, category) {
  const statuses = statusesFor(blazeType);
  if (category === "done") return statuses.find((s) => isTerminal(blazeType, s)) ?? statuses[statuses.length - 1];
  if (category === "indeterminate") return statuses.find((s) => s !== statuses[0] && !isTerminal(blazeType, s)) ?? statuses[0];
  return statuses[0]; // "new" or null/unknown → initial
}

export function mapStatus(blazeType, jiraStatus, statusCategory) {
  const wf = workflowOf(blazeType);
  const table = STATUS_MAP[wf] || {};
  const hit = table[String(jiraStatus ?? "").toLowerCase()];
  if (hit && (statusesFor(blazeType).includes(hit))) return { status: hit, unmapped: false };
  if (statusCategory) return { status: categoryFallback(blazeType, String(statusCategory).toLowerCase()), unmapped: false };
  return { status: initialStatus(blazeType), unmapped: true };
}

const IMPACT_WORDS = new Set(["extensive", "significant", "moderate", "minor"]);
const LIKELIHOOD_WORDS = new Set(["low", "medium", "high"]);
function firstWord(v) { return String(v ?? "").toLowerCase().split(/[^a-z]+/).find(Boolean) ?? null; }
function mapImpact(v) { if (v == null) return null; const w = firstWord(v); return IMPACT_WORDS.has(w) ? w : String(v).toLowerCase(); }
function mapLikelihood(v) { if (v == null) return null; const w = firstWord(v); return LIKELIHOOD_WORDS.has(w) ? w : String(v).toLowerCase(); }

export function mapIssue(norm, { proposedParent, proposedStatus } = {}) {
  const type = mapType(norm.type);
  const known = isType(type);
  const mapped = known ? mapStatus(type, norm.status, norm.statusCategory) : { status: null, unmapped: true };
  const status = proposedStatus ?? mapped.status;

  const estimate = roundEstimate(norm.estimateSeconds != null ? norm.estimateSeconds / 60 : null);
  const worklogWarnings = [];
  const worklog = (norm.worklog || []).flatMap((w) => {
    const mins = (w.seconds || 0) / 60;
    if (!Number.isFinite(mins) || mins <= 0) {
      worklogWarnings.push(`${norm.key}: skipped zero/negative worklog entry`);
      return [];
    }
    const entry = { date: w.date, minutes: roundWorklog(mins) };
    if (w.note) entry.note = w.note;
    return [entry];
  });

  const fm = {
    id: norm.key, title: norm.summary, type, project: norm.project,
    priority: mapPriority(norm.priority),
    resolution: mapResolution(norm.resolution),
    parent: proposedParent !== undefined ? proposedParent : (norm.parent ?? null),
    assignee: norm.assignee ?? "unassigned",
    labels: norm.labels || [], components: norm.components || [],
    estimate,
    worklog,
    links: norm.links || [],
    created: norm.created, updated: norm.updated,
  };
  if (type === "risk") {
    fm.likelihood = mapLikelihood(norm.likelihood);
    fm.impact = mapImpact(norm.impact);
  }

  const body = norm.description && norm.description.trim() ? norm.description : "## Context\n\n## Acceptance Criteria\n\n- [ ] \n\n## Notes\n";

  const warnings = [...worklogWarnings];
  if (!known) warnings.push(`unknown type '${norm.type}' for ${norm.key} (mapped to '${type}')`);
  if (mapped.unmapped && known) warnings.push(`unmapped status '${norm.status}' for ${norm.key} (parked in '${mapped.status}')`);
  for (const e of validateTicket({ frontmatter: fm, body })) {
    if (/parent not found/.test(e)) continue; // parent integrity is a reindex concern
    warnings.push(`${norm.key}: ${e}`);
  }
  return { frontmatter: fm, body, status, warnings };
}
