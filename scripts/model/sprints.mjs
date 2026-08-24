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
  // BLZ-386. `start`/`due` became scheduler OUTPUTS under ADR-0022, so the checks above now
  // guard fields the scheduler writes correctly by construction — while the two fields an
  // operator actually types had no validation at all. That hole is this migration's to close,
  // not to open.
  //
  // A `not_before` after its `deadline` is NOT the same thing as `deadline-unreachable`, and
  // the difference is ADR-0022's own split: a missed deadline is a true statement about a
  // CORRECT corpus and ships soft, whereas "start no earlier than the 16th, finish by the
  // 11th" is two constraints that cannot both hold — the corpus being wrong.
  for (const f of ["not_before", "deadline"]) {
    if (fm[f] != null && fm[f] !== "" && !isIsoDate(fm[f])) {
      errors.push(`${f} '${fm[f]}' must be a YYYY-MM-DD date`);
    }
  }
  if (isIsoDate(fm.not_before) && isIsoDate(fm.deadline) && fm.not_before > fm.deadline) {
    errors.push(`not_before (${fm.not_before}) is after deadline (${fm.deadline})`);
  }
  return errors;
}

// --- BLZ-111: pure helpers for `blaze sprint new|list|active` --------------
// Kept here (not in sprint-runner.mjs) so they're covered — *-runner.mjs is
// coverage-excluded. Never mutate the registry passed in; always return a
// fresh object so callers can trust the input is untouched.

export function addSprint(registry, { name, start, end }) {
  if (!isIsoDate(start)) throw new Error(`blaze: start '${start}' must be a YYYY-MM-DD date`);
  if (!isIsoDate(end)) throw new Error(`blaze: end '${end}' must be a YYYY-MM-DD date`);
  if (start > end) throw new Error(`blaze: start (${start}) is after end (${end})`);
  const id = nextSprintId(registry);
  const sprint = { id, name, start, end };
  return {
    // Auto-activate the very first sprint (no active yet) so a fresh board's
    // gantt view has something to scope by without a separate `active` call.
    registry: { ...registry, active: registry.active ?? id, sprints: [...(registry.sprints ?? []), sprint] },
    id,
  };
}

export function setActive(registry, id) {
  if (!(registry.sprints ?? []).some((s) => s.id === id)) {
    throw new Error(`blaze: sprint '${id}' is not in the registry (sprints.json)`);
  }
  return { ...registry, active: id };
}

export function formatSprintList(registry) {
  const sprints = registry.sprints ?? [];
  if (sprints.length === 0) return "(no sprints)";
  return sprints
    .map((s) => `${s.id} · ${s.name} · ${s.start}..${s.end}${s.id === registry.active ? " (active)" : ""}`)
    .join("\n");
}
