// scripts/model/move-plan.mjs — pure planner for a status move: validate the
// transition, apply the optional worklog-before-terminal guard, and compute the
// new frontmatter with resolution set/cleared by the post-function. No I/O.
import { validateTransition } from "./rules.mjs";
import { isTerminal, resolutionForTerminal } from "./workflows.mjs";
import { hierarchyLevel } from "./schema.mjs";

export function planMove(ticket, currentStatus, toStatus, opts = {}) {
  const { hasWorklog = true, requireWorklog = false } = opts;
  const type = ticket.frontmatter.type;
  const errors = validateTransition(type, currentStatus, toStatus);
  // The worklog-before-terminal guard applies to LEAF work items only
  // (story/task/bug/subtask, hierarchyLevel <= 0). Epics/goals/risks aggregate —
  // their time rolls up from children, so they carry no direct worklog and must
  // not be blocked from reaching a terminal status.
  const enforceWorklog = requireWorklog && hierarchyLevel(type) <= 0;
  if (errors.length === 0 && enforceWorklog && isTerminal(type, toStatus) && !hasWorklog) {
    errors.push(`worklog required before entering terminal status ${toStatus}`);
  }
  if (errors.length) return { ok: false, errors };

  const frontmatter = { ...ticket.frontmatter };
  frontmatter.resolution = isTerminal(type, toStatus) ? resolutionForTerminal(type, toStatus) : null;
  return { ok: true, errors: [], frontmatter, body: ticket.body, resolution: frontmatter.resolution };
}
