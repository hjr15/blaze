// scripts/model/fields.mjs — pure: the editable-field allowlist + per-field input
// descriptors for the panel's schema-driven inline editor. No filesystem.
import { PRIORITIES, allTypes } from "./schema.mjs";

// The ONE source of truth for what /api/edit accepts and what the panel offers.
// status/resolution stay move/resolve-only; id/project/dates are read-only.
//
// THAT LAST CLAUSE IS TRUE FOR THE FIRST TIME (BLZ-386 / BLZ-360 §4.2). Until the date
// migration this comment said "dates are read-only" while the set below contained `start` and
// `due` — ADR-0022's own Context cites that contradiction as the reason the ADR exists. Under
// ADR-0022 those two are SCHEDULER OUTPUTS, so the operator loses them and gains the two
// constraints that drive them: `not_before` and `deadline`.
//
// `sprint` stays. It is not a date, and `blaze sprint new --start` is the sprint WINDOW's
// start — a different flag on a different runner, found by grepping rather than reasoning.
//
// `type` IS editable (BLZ-230). A model migration is a re-typing exercise, and excluding
// `type` meant the migration's central operation had to be a raw file rewrite with no
// validation at all. `applyEdit` validates a retype in BOTH directions — the ticket's own
// parent edge and every child pointing at it — because a retype is the only edit that can
// invalidate a ticket other than the one being edited.
export const EDITABLE_FIELDS = new Set([
  "title", "type", "assignee", "priority", "labels", "components", "estimate", "parent",
  "likelihood", "impact", "sprint", "not_before", "deadline",
]);

// The two fields the scheduler took over, and what to set instead. Spec 1 §4.2's rule is that
// every refusal names the rule and lists every failing item; §4.2 applies it here in as many
// words — "A refusal that does not name the replacement field is a defect."
const DERIVED_REPLACEMENT = { start: "not_before", due: "deadline" };

/** The refusal for a field the scheduler now owns, or null if this is not one of them. */
export function derivedFieldRefusal(field) {
  const replacement = DERIVED_REPLACEMENT[field];
  if (!replacement) return null;
  return `${field} is derived by the scheduler; set '${replacement}' to constrain it`;
}

const SURFACED = new Set(["title", "pr", "links"]);

function displayValue(k, v) {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return v == null ? "" : String(v);
}

export function fieldInputs(meta, { priorities = PRIORITIES, types = null } = {}) {
  const typeOptions = types ?? allTypes();
  return Object.entries(meta)
    .filter(([k, v]) => !SURFACED.has(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      const editable = EDITABLE_FIELDS.has(k);
      // `type` is a select over the declared registry (BLZ-230): a retype from the board is
      // a choice from the model, never a free-text guess. The write is still validated in
      // both directions by applyEdit — the select is the affordance, not the safety.
      const kind = k === "priority" || k === "type" ? "select" : "text";
      const out = { key: k, editable, kind, value: displayValue(k, v) };
      if (k === "priority") out.options = priorities;
      if (k === "type") out.options = typeOptions;
      return out;
    });
}
