// scripts/model/matrix-filter.mjs — spec §5's "filterable by custom field on BOTH axes"
// (BLZ-334).
//
// The value's HOME is an implementation detail the caller must not have to know: a
// filterable field was promoted to a real `cf_<key>` column at definition time (BLZ-321),
// everything else lives in the `custom_fields` JSON tail (BLZ-332). One filter reads
// either. Making the caller pick would leak §3.4's promotion decision into every consumer,
// and the decision is allowed to change per project.
//
// PURE and SYNCHRONOUS, like every other decision function here.
import { splitCustomFields } from "./field-validation.mjs";

/**
 * SQLite hands `custom_fields` back as JSON TEXT where Postgres hands back a parsed
 * object. A filter that handles only one shape silently matches NOTHING on the other
 * engine — and silently matching nothing is the failure mode this whole module is written
 * to avoid.
 */
function tailOf(item) {
  const raw = item.custom_fields;
  if (raw == null) return {};
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * @param items        the axis being filtered — rows or cols, identically.
 * @param definitions  field_definition rows, scoped here by (project_key, kind).
 * @param filter       { key, equals } or null. Null means "no filter" and returns `items`
 *                     untouched, so an unfiltered axis is not a special case at call sites.
 * @returns { ok, error, items }
 */
export function filterByField({ items = [], definitions = [], filter = null,
                                project_key = "BLZ", kind = "requirement" } = {}) {
  if (!filter || filter.key == null) return { ok: true, error: null, items };

  const scoped = definitions.filter(
    (d) => d.project_key === project_key && d.applies_to_kind === kind);
  const def = scoped.find((d) => d.key === filter.key);
  // Default deny, and the reason is specific to a REPORT rather than a write: an unknown
  // key that quietly matches nothing returns an empty matrix, which reads as a real
  // finding — "no requirements are high-risk" — when the truth is that the field name was
  // typed wrong. A wrong answer nobody can tell is wrong.
  if (!def) {
    return { ok: false, items: [], error:
      `no field named ${JSON.stringify(filter.key)} is defined for ${kind} in ${project_key} — `
      + `filtering on it would report an empty matrix as though it were a result` };
  }

  // Which home this key uses is decided by the SAME split the write path uses, so a filter
  // can never disagree with where the value was actually put.
  const { promoted } = splitCustomFields({
    definitions: scoped, values: { [filter.key]: null }, project_key, kind });
  const column = Object.keys(promoted)[0] ?? null;

  const read = (item) => (column ? item[column] : tailOf(item)[filter.key]);

  return {
    ok: true, error: null,
    // Strict equality on purpose. A loose `==` would let a number field match its own
    // string form, and the two engines disagree about which one they hand back (SQLite
    // REAL vs Postgres numeric-as-string), so a loose match would filter differently per
    // engine for the same data.
    items: items.filter((i) => read(i) === filter.equals),
  };
}
