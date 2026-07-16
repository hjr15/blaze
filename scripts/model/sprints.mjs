// scripts/model/sprints.mjs — the sprint registry (sprints.json) at the data root.
// Sprints are DATA, not engine config: read per-render (like .blaze/transitions.json),
// so a mid-session edit is never stale. See ADR-0004.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EMPTY = { active: null, sprints: [] };

export function loadSprints({ root }) {
  try {
    const raw = readFileSync(join(root, "sprints.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sprints)) return { ...EMPTY };
    return { active: parsed.active ?? null, sprints: parsed.sprints };
  } catch {
    return { ...EMPTY };
  }
}

export function saveSprints({ root }, registry) {
  writeFileSync(join(root, "sprints.json"), JSON.stringify(registry, null, 2) + "\n");
}

export function nextSprintId(registry) {
  const nums = (registry.sprints ?? []).map((s) => Number(/^S(\d+)$/.exec(s.id)?.[1] ?? 0));
  return "S" + (Math.max(0, ...nums) + 1);
}

export function isIsoDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(s + "T00:00:00Z");
  if (Number.isNaN(ms)) return false;
  // reject normalized-away impossible dates (2026-02-30 -> Mar 2)
  return new Date(ms).toISOString().slice(0, 10) === s;
}

export function validateSprintFields(fm, { sprintIds }) {
  const errors = [];
  if (fm.sprint != null && fm.sprint !== "" && !sprintIds.has(fm.sprint)) {
    errors.push(`sprint '${fm.sprint}' is not in the registry (sprints.json)`);
  }
  for (const f of ["start", "due"]) {
    if (fm[f] != null && fm[f] !== "" && !isIsoDate(fm[f])) {
      errors.push(`${f} '${fm[f]}' must be a YYYY-MM-DD date`);
    }
  }
  if (isIsoDate(fm.start) && isIsoDate(fm.due) && fm.start > fm.due) {
    errors.push(`start (${fm.start}) is after due (${fm.due})`);
  }
  return errors;
}
