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

  // INF-762: a move must never silently discard a resolution someone chose.
  // Previously this was an unconditional write — the terminal default on entering
  // a terminal status, null otherwise — which defeated the documented order
  // (`blaze resolve` for non-Done outcomes, then move). Both halves lost it: the
  // mandatory in-review hop cleared it, then the terminal move overwrote it with
  // `done`. Every wont-do / duplicate / cannot-reproduce closed that way was
  // recorded as `done`.
  //
  // Blank counts as unset — `blaze new` writes `resolution: ` — so the common
  // case still gets its default.
  const chosen = typeof ticket.frontmatter.resolution === "string"
    ? ticket.frontmatter.resolution.trim() : ticket.frontmatter.resolution;
  const existing = chosen || null;

  if (isTerminal(type, toStatus)) {
    // Entering terminal: keep a deliberate choice, else apply the default.
    frontmatter.resolution = existing || resolutionForTerminal(type, toStatus);
  } else if (isTerminal(type, currentStatus)) {
    // Reopening: clear. A stale `done` must not stay sticky through a reopen, or
    // a repaired ticket keeps claiming it was finished.
    frontmatter.resolution = null;
  } else {
    // Moving between non-terminal statuses carries the choice along untouched.
    frontmatter.resolution = existing;
  }

  return { ok: true, errors: [], frontmatter, body: ticket.body, resolution: frontmatter.resolution };
}
