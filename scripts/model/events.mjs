// scripts/model/events.mjs — replaying the ticket event log (BLZ-278, design D7).
//
// This is the designated replacement for `git log --follow <ticket>` and for the
// revert that git gave for free. The brief is explicit that it has to exist BEFORE
// files freeze: once the filesystem stops being the store, any history not captured
// here is gone, and a revert path bolted on afterwards has nothing to replay.
//
// Deliberately PURE. The fold takes events and returns state; it touches no database
// and no filesystem, so both drivers replay identically and the hard part is testable
// without either. The driver's only job is to hand over the events in order.
//
// Honest scope: this reconstructs the FIELDS the log records. A `create` event seeds
// the state and each `edit` moves one field, so a ticket's field history is exact.
// Kinds that carry no field delta — worklog, link-add, ac-toggle — are recorded for
// the audit trail but are not replayed into scalar state here; they have their own
// tables and their own history. `stateAt` says so rather than silently returning a
// half-reconstructed ticket.
const FIELD_KINDS = new Set(["create", "edit", "transition", "resolve", "sprint-assign"]);

/**
 * Fold the log up to and including `throughEventId` (or the whole log if omitted).
 *
 * @returns { state, replayed, skipped } — `skipped` names the kinds that carry no
 *   field delta, so a caller can tell "nothing changed" from "I ignored things".
 */
export function stateAt(events, throughEventId = null) {
  const state = {};
  let replayed = 0;
  const skipped = new Map();
  for (const e of events) {
    if (throughEventId !== null && e.id > throughEventId) break;
    if (!FIELD_KINDS.has(e.kind)) {
      skipped.set(e.kind, (skipped.get(e.kind) ?? 0) + 1);
      continue;
    }
    replayed++;
    if (e.kind === "create") {
      Object.assign(state, e.detail ? JSON.parse(e.detail) : {});
      continue;
    }
    if (e.kind === "transition") { state.status = e.to_status; continue; }
    // edit / resolve / sprint-assign all carry (field, new_value)
    if (e.field) state[e.field] = e.new_value;
  }
  return { state, replayed, skipped: Object.fromEntries(skipped) };
}

/**
 * What a revert to `throughEventId` would change, as a field patch.
 *
 * Returned rather than applied, deliberately: a revert that writes before anyone has
 * seen the diff is how you lose the thing you meant to keep. The caller decides.
 */
export function revertPlan(events, throughEventId) {
  const target = stateAt(events, throughEventId);
  const current = stateAt(events, null);
  const patch = {};
  for (const k of new Set([...Object.keys(current.state), ...Object.keys(target.state)])) {
    const to = target.state[k] ?? null;
    const from = current.state[k] ?? null;
    if (String(from ?? "") !== String(to ?? "")) patch[k] = { from, to };
  }
  return { patch, replayed: target.replayed, skipped: target.skipped,
           noop: Object.keys(patch).length === 0 };
}
