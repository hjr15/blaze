// scripts/model/field-validation.mjs — spec §4.1's third write-time block: required-field
// presence, closed-enum validity, type and range (BLZ-328).
//
// `field_definition` has carried is_required / enum_values / min_value / max_value since
// BLZ-321 and nothing has ever read them. A constraint nobody enforces is worse than no
// constraint at all: it reads as protection on the schema diagram while every write walks
// straight past it. This module is the reader.
//
// PURE and SYNCHRONOUS, like every other decision function here (checkLink, checkGate,
// promotionPlan, evaluateCoverage, lintStatement). The API layer composes it; it decides.
import { DATA_TYPES } from "./field-schema.mjs";

/**
 * `enum_values` is a TEXT column. The comma-separated form is the one already established
 * by field-schema.test.mjs ("low,medium,high"), so that is what this reads — an array is
 * also accepted for the in-memory path, where nothing has been through a column yet.
 */
export function parseEnumValues(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x));
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

// Absence, defined once. `false` and `0` are VALUES: a required boolean that can never be
// false and a required number that can never be zero are both useless fields, and a plain
// falsy check produces exactly those.
const isAbsent = (v) => v == null || (typeof v === "string" && v.trim() === "");

// A real calendar date, not a shape. /\d{4}-\d{2}-\d{2}/ passes 2026-02-30, which is the
// exact class of bug §7's testing rule 1 was written about — a date test that asserted the
// shape and passed against the off-by-one-day bug it existed to catch.
function parseDate(v) {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}

// Number(true) is 1 and Number("") is 0 — both would silently pass a naive check, so a
// boolean and an empty string are refused before the coercion ever happens.
function parseNumber(v) {
  if (typeof v === "boolean") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Only number and date have an ordering the user declared. Applying a bound to text would
// compare "9" > "10" lexicographically and be silently wrong.
const ORDERED = { number: parseNumber, date: parseDate };

function checkValue(d, value) {
  const type = d.data_type ?? "text";
  if (!DATA_TYPES.includes(type)) {
    return `has an unknown data_type ${JSON.stringify(type)}`;
  }

  if (type === "enum") {
    const legal = parseEnumValues(d.enum_values);
    if (!legal.includes(value)) {
      return `${JSON.stringify(value)} is not one of the declared values: ${legal.join(", ")}`;
    }
    return null;
  }
  if (type === "boolean" && typeof value !== "boolean") {
    return `${JSON.stringify(value)} is not a boolean`;
  }
  if (type === "text" && typeof value !== "string") {
    return `${JSON.stringify(value)} is not text`;
  }

  const parse = ORDERED[type];
  if (!parse) return null;
  const n = parse(value);
  if (n === null) return `${JSON.stringify(value)} is not a valid ${type}`;

  // A bound is only a bound when it was SET. `min_value ?? 0` would make every unbounded
  // number field silently reject negatives.
  for (const [bound, cmp, word] of [["min_value", -1, "at least"], ["max_value", 1, "at most"]]) {
    if (isAbsent(d[bound])) continue;
    const limit = parse(d[bound]);
    if (limit === null) continue;   // an unparseable bound constrains nothing, loudly-lenient
    if (Math.sign(n - limit) === cmp) {
      return `${JSON.stringify(value)} is out of range — must be ${word} ${d[bound]}`;
    }
  }
  return null;
}

/**
 * @param definitions  every field_definition the caller knows about, unfiltered — scoping
 *   to (project_key, applies_to_kind) happens HERE so no call site can forget it.
 * @param values       the caller-supplied custom field values, keyed by field `key`.
 * @returns { ok, error, violations: [{ key, why }] } — EVERY violation, never the first.
 *   A refusal the person cannot act on in one pass is a defect (§4.2's rule, for the same
 *   reason): three round-trips to learn three missing fields is exactly that.
 */
export function validateFieldValues({ definitions = [], values = {}, project_key, kind }) {
  const scoped = definitions.filter(
    (d) => d.project_key === project_key && d.applies_to_kind === kind);
  const byKey = new Map(scoped.map((d) => [d.key, d]));
  const violations = [];

  // Default deny (§4.1): a value for a field nobody defined is refused, not dropped. A
  // typo'd key that is quietly discarded is a value the user believes they set.
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) {
      violations.push({ key, why: `no field named ${JSON.stringify(key)} is defined for ${kind} in ${project_key}` });
    }
  }

  for (const d of scoped) {
    const value = values[d.key];
    if (isAbsent(value)) {
      if (d.is_required) violations.push({ key: d.key, why: "is required and was not supplied" });
      continue;
    }
    const why = checkValue(d, value);
    if (why) violations.push({ key: d.key, why });
  }

  if (!violations.length) return { ok: true, error: null, violations: [] };
  return {
    ok: false,
    error: "field validation failed: "
      + violations.map((v) => `${v.key} ${v.why}`).join("; "),
    violations,
  };
}

/**
 * §3.4's two homes for a custom field value, split once (BLZ-332).
 *
 * `is_filterable` at definition time promoted the field to a real `cf_<key>` column; every
 * other value lives in the `custom_fields` JSON tail. A value must never be in both:
 * promotion is "decided once, at definition", so two copies are two answers that can
 * disagree, and nothing would say which one a filter should trust.
 *
 * Scoped the same way validateFieldValues is, and by the same rule — a call site that has
 * to remember to scope is a call site that eventually will not.
 *
 * @returns { custom_fields, ...cf_<key> } — ONE shape, deliberately flat (BLZ-335 C2). The
 *   first version returned `{ custom_fields, promoted }` and the caller spread it onto the
 *   artifact, so a promoted value sat at `artifact.promoted.cf_risk` while the table column
 *   and every reader used `artifact.cf_risk`. matrix-filter returned zero rows for the one
 *   artifact that matched, and its tests passed only because their fixtures hand-built the
 *   flat shape the API never produced. `custom_fields` is always an object, never null, so
 *   the NOT NULL column never has to be special-cased.
 */
export function splitCustomFields({ definitions = [], values = {}, project_key, kind }) {
  const scoped = definitions.filter(
    (d) => d.project_key === project_key && d.applies_to_kind === kind);
  const filterable = new Set(scoped.filter((d) => d.is_filterable).map((d) => d.key));

  const out = { custom_fields: {} };
  for (const [key, value] of Object.entries(values)) {
    if (filterable.has(key)) out[`cf_${key}`] = value;
    else out.custom_fields[key] = value;
  }
  return out;
}

/** The column a key promotes to, or null if it lives in the tail. One definition, so the
 *  writer and every reader cannot disagree about where a value is. */
export function promotedColumn({ definitions = [], key, project_key, kind }) {
  const def = definitions.find(
    (d) => d.key === key && d.project_key === project_key && d.applies_to_kind === kind);
  return def?.is_filterable ? `cf_${key}` : null;
}
