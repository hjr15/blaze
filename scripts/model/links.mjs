// scripts/model/links.mjs — pure: the canonical typed-link vocabulary and a
// linter that surfaces the malformed-link classes the 2026-07 audit found
// (wrong `to:` key, unknown type, dangling target). No filesystem.

// The traceability pair (BLZ-237). Both are DIRECTIONAL and the direction is load-bearing:
//   feature      --Implements--> requirement
//   architecture --Addresses---> requirement
// They are named separately because a matrix wants the traceability subset, not every link.
// blaze-pm ADR-0015 puts traceability on these rather than on a multi-valued `parent`; until
// the engine accepted them, every trace on that board was prose parsed by a regular
// expression — unvalidated, one-directional, and invisible to the link graph.
export const TRACE_LINK_TYPES = new Set(["Implements", "Addresses"]);

export const LINK_TYPES = new Set(["Blocks", "Relates", "Duplicate", "Cloners", ...TRACE_LINK_TYPES]);

// knownIds is required (buildIndex always passes the id set; tests pass one too) —
// no default, so c8 doesn't flag an unexercised default-param branch.
export function lintLinks(fm, knownIds) {
  const warnings = [];
  const id = fm?.id ?? "?";
  for (const link of fm?.links ?? []) {
    if (link == null || typeof link !== "object") { warnings.push(`${id}: malformed link entry (not an object)`); continue; }
    if (link.target === undefined) {
      const badKey = Object.keys(link).find((k) => k !== "type");
      warnings.push(`${id}: link missing 'target:' key${badKey ? ` (found '${badKey}:' — the audit's silently-dropped-link class)` : ""}`);
      continue;
    }
    if (!LINK_TYPES.has(link.type)) warnings.push(`${id}: unknown link type '${link.type}' (expected ${[...LINK_TYPES].join("/")})`);
    if (!knownIds.has(link.target)) warnings.push(`${id}: link target '${link.target}' does not resolve (dangling)`);
  }
  return warnings;
}

export function addLink(links, type, target) {
  const list = links ?? [];
  if (list.some((l) => l.type === type && l.target === target)) return list.slice();
  return [...list, { type, target }];
}

export function removeLink(links, type, target) {
  return (links ?? []).filter((l) => !(l.type === type && l.target === target));
}

/** Both ends of a requirement's traceability, read from the tickets that point AT it.
 *  The trace lives on the delivery ticket, so the requirement's view is derived rather
 *  than separately maintained — which is what stops the two drifting apart. */
export function traceEndpointsFor(requirementId, tickets) {
  const implementedBy = [];
  const addressedBy = [];
  for (const t of tickets ?? []) {
    for (const l of t?.links ?? []) {
      if (l?.target !== requirementId) continue;
      if (l.type === "Implements") implementedBy.push(t.id);
      else if (l.type === "Addresses") addressedBy.push(t.id);
    }
  }
  return { implementedBy, addressedBy };
}
