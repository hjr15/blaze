// scripts/model/fields.mjs — pure: the editable-field allowlist + per-field input
// descriptors for the panel's schema-driven inline editor. No filesystem.
import { PRIORITIES } from "./schema.mjs";

// The ONE source of truth for what /api/edit accepts and what the panel offers.
// status/resolution stay move/resolve-only; id/type/project/dates are read-only.
export const EDITABLE_FIELDS = new Set([
  "title", "assignee", "priority", "labels", "components", "estimate", "parent",
  "likelihood", "impact", "due",
]);

const SURFACED = new Set(["title", "pr", "links"]);

function displayValue(k, v) {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
  if (v && typeof v === "object") return JSON.stringify(v);
  return v == null ? "" : String(v);
}

export function fieldInputs(meta, { priorities = PRIORITIES } = {}) {
  return Object.entries(meta)
    .filter(([k, v]) => !SURFACED.has(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      const editable = EDITABLE_FIELDS.has(k);
      const kind = k === "priority" ? "select" : "text";
      const out = { key: k, editable, kind, value: displayValue(k, v) };
      if (kind === "select") out.options = priorities;
      return out;
    });
}
