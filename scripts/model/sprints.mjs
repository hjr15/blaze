// scripts/model/sprints.mjs — the sprint registry (sprints.json) at the data root.
// Sprints are DATA, not engine config: read per-render (like .blaze/transitions.json),
// so a mid-session edit is never stale. See ADR-0004.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EMPTY = { active: null, sprints: [] };

/**
 * The registry shape this engine writes (BLZ-369).
 *
 * Not a compatibility gate — it is a MARK. An engine released before this stamp existed rewrites
 * `sprints.json` through its own two-key whitelist and drops every key it does not recognise, the
 * stamp included. Its absence on a registry that holds sprints is therefore the only evidence
 * available that such an engine has been through the file.
 */
export const SPRINT_REGISTRY_VERSION = 1;

/** Stamps are integers from 1 up. `0`, a negative, a string or an object are all hand-edits. */
const isRegistryVersion = (v) => Number.isInteger(v) && v >= 1;

/**
 * Load the registry WITHOUT discarding what this engine does not understand (BLZ-369).
 *
 * This whitelisted `active` and `sprints`, so `loadSprints -> setActive -> saveSprints` wrote
 * every other key out of existence. Spec 2 §9 measured it:
 *
 *     file keys BEFORE : [ active, activeByProject, sprints ]
 *     loadSprints keys : [ active, sprints ]        <- never reaches a reader
 *
 * `addSprint` and `setActive` were never at fault; both already spread `...registry`. The loader
 * was the whole mechanism, which is why the fix is one spread.
 *
 * WHY NOW, BEFORE `activeByProject` EXISTS. Whichever engine version is current when that key
 * ships becomes "the old engine" for every board that migrates. An engine that preserves what it
 * does not understand can never be that engine. This does nothing for versions already released
 * — they are shipped and cannot be changed — which is what the stamp is for.
 *
 * A MALFORMED registry still yields EMPTY and carries nothing forward. Preserving unknown keys
 * must not promote a junk file into a half-trusted one.
 */
export function loadSprints({ root }) {
  try {
    const raw = readFileSync(join(root, "sprints.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sprints)) return { ...EMPTY };
    return { ...parsed, active: parsed.active ?? null, sprints: parsed.sprints };
  } catch {
    return { ...EMPTY };
  }
}

export function saveSprints({ root }, registry) {
  // NEVER DOWNGRADE THE STAMP. Writing our own version unconditionally would turn a
  // `registryVersion: 2` file into a `1` while faithfully preserving the v2 keys beside it — the
  // file would then under-claim its own shape, which is a worse lie than no stamp at all and
  // exactly the overconfidence this ticket exists to remove. Unreachable until a version 2
  // exists; written now because the moment it does, this is where the bug would be.
  const existing = registry?.registryVersion;
  const version = isRegistryVersion(existing) && existing > SPRINT_REGISTRY_VERSION
    ? existing
    : SPRINT_REGISTRY_VERSION;
  writeFileSync(join(root, "sprints.json"),
    JSON.stringify({ ...registry, registryVersion: version }, null, 2) + "\n");
}

/**
 * A registry holding sprints but no version stamp — or `null` when there is nothing to say.
 *
 * Two things produce it and the file alone cannot tell them apart: a board written before the
 * stamp existed, and a board an older engine has rewritten since. The message says both rather
 * than picking one, because guessing would be the same overconfidence this whole ticket is about.
 *
 * A board with NO sprints is silent — there is nothing it could have lost, and every fresh board
 * would otherwise warn on its first `blaze sprint new`.
 *
 * WHAT THIS CANNOT REACH, recorded because the ticket's whole subject is silent destruction. A
 * `sprints.json` that is corrupt JSON, or whose `sprints` is not an array, loads as EMPTY and is
 * then overwritten wholesale by the next write — operator keys and all — and this detector sees
 * the already-emptied registry, so it stays silent. It is not a regression (the same clobber
 * predates BLZ-369) and it is not an OLD-ENGINE window, which is what this ticket scopes, but it
 * is the same failure mode by a different route. Closing it needs `loadSprints` to distinguish
 * "no file" from "unreadable file", which changes the shape every caller receives.
 */
export function unstampedRegistryWarning(registry) {
  const sprints = registry?.sprints;
  if (!Array.isArray(sprints) || sprints.length === 0) return null;
  // A VERSION, not merely "present" and not merely a number. `null`, `"1"` and `{}` all silenced
  // this, and so did `0` — which is version-shaped but names no version, since stamps start at 1.
  // Only a hand-edit produces any of them, because an older engine drops the key entirely; a
  // stamp that is not a version is still not a stamp.
  if (isRegistryVersion(registry.registryVersion)) return null;
  return "sprints.json carries no version stamp. Either it predates this engine's stamp, or an "
    + "engine older than it rewrote the file and dropped every key it did not recognise — "
    + "per-project state among them, which nothing can reconstruct. Saving now stamps it.";
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
