// scripts/model/links.mjs — pure: the canonical typed-link vocabulary and a
// linter that surfaces the malformed-link classes the 2026-07 audit found
// (wrong `to:` key, unknown type, dangling target). No filesystem.

export const LINK_TYPES = new Set(["Blocks", "Relates", "Duplicate", "Cloners"]);

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
