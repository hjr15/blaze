// scripts/model/filters.mjs — pure resolvers for the status-filter chips.
//
// The chip bar shows one chip per resolved-schema status (with a live count)
// plus two presets: All and Active. "Active" is schema-driven — every status
// that is not terminal in ANY workflow — so an upstream user with a different
// workflow set gets a sensible preset without hardcoded status names.
//
// statusFilter() maps a hash value ("all" | "active" | "<status>") to the set
// of statuses a card/row must be in to stay visible; null means "show all".
import { WORKFLOWS } from "./workflows.mjs";

// Statuses that are terminal in some workflow (done, achieved, mitigated, …).
export function terminalStatuses(workflows = WORKFLOWS) {
  return new Set(Object.values(workflows).flatMap((w) => w.terminal || []));
}

// The Active preset: every status that is not terminal in any workflow,
// preserving the given status order.
export function activeStatuses(statuses, workflows = WORKFLOWS) {
  const term = terminalStatuses(workflows);
  return statuses.filter((s) => !term.has(s));
}

// null == no status constraint (show all). Otherwise a Set of allowed statuses.
export function statusFilter(value, statuses, workflows = WORKFLOWS) {
  const v = String(value ?? "all").toLowerCase();
  if (v === "all" || v === "") return null;
  if (v === "active") return new Set(activeStatuses(statuses, workflows));
  if (statuses.includes(v)) return new Set([v]);
  return null; // unknown → show all
}
