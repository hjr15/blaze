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
import { promotedColumn } from "./field-validation.mjs";

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

  // Which home this key uses is decided by the SAME resolver the write path uses, so a
  // filter can never disagree with where the value was actually put.
  const column = promotedColumn({ definitions: scoped, key: filter.key, project_key, kind });
  const read = (item) => (column ? item[column] : tailOf(item)[filter.key]);

  // BLZ-335 (C5). A promoted value comes back in a DIFFERENT JS type depending on the
  // engine, so a raw `===` matched on one and matched nothing on the other for identical
  // data — the worst kind of divergence, because both answers look like results:
  //   boolean  SQLite stores 1/0 (there is no boolean type); Postgres returns a real boolean
  //   number   Postgres `numeric` arrives from node-pg as a STRING; SQLite REAL as a number
  //   date     Postgres `date` arrives as a Date object; SQLite TEXT as an ISO string
  // Both sides are normalised to one canonical form BEFORE comparing, using the field's
  // declared data_type — the only thing that knows which of these applies. Comparison stays
  // strict; the coercion is explicit and typed, not a loose `==` that would also let a text
  // field match a number.
  const canon = canonical(def.data_type);
  const want = canon(filter.equals);
  return { ok: true, error: null, items: items.filter((i) => canon(read(i)) === want) };
}

function canonical(data_type) {
  if (data_type === "boolean") {
    return (v) => (v == null ? null
      : v === true || v === 1 || v === "1" || v === "true" ? true
      : v === false || v === 0 || v === "0" || v === "false" ? false
      : null);
  }
  if (data_type === "number") {
    return (v) => {
      if (v == null || typeof v === "boolean" || (typeof v === "string" && v.trim() === "")) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
  }
  if (data_type === "date") {
    // To a calendar DAY, not an instant: a `date` column has no time, and a Date object from
    // node-pg carries a midnight that would never equal the string a caller filters with.
    return (v) => {
      if (v == null) return null;
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
      const s = String(v).trim();
      return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
    };
  }
  // text and enum: compare as strings, so an engine returning a number for a text column
  // cannot silently miss. `null` stays null so a missing value never equals a supplied one.
  return (v) => (v == null ? null : String(v));
}
