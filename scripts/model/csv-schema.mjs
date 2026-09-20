// scripts/model/csv-schema.mjs — the canonical CSV schema-of-record. BLZ-626,
// implementing design §2.2-§2.6 (docs/design/csv-import-and-export.md).
//
// This is the schema every later Phase A/B/C item (BLZ-627 export, and the
// import work this PR does not build) validates rows against — per ADR-0037,
// the mapping/import layer is a separate concern from this module, which only
// knows the 31-column shape, its per-column grammar, and the multi-valued
// encodings. It resolves NOTHING against a board: enum membership (type,
// status, priority, resolution) is the caller's resolved-per-project registry
// (design §1.2, §2.2 — "never a hardcoded list"), passed in as `opts.allowed`.
// The one exception is `links`, validated against the fixed six-member
// `LINK_TYPES` (design §1.4/§2.4), which is not per-project.
import { KEY_RE } from "../config.mjs";
import { LINK_TYPES } from "./links.mjs";

/** Constant carried on every row (design §2.2 note). A future column-set
 * change bumps this so a stale reader sees a version mismatch rather than a
 * silent misread. */
export const SCHEMA_VERSION = 1;

/**
 * The 31 canonical columns, in canonical order — design §2.2's table verbatim.
 * `required` is the per-row ● / ○ column: whether an EMPTY cell is refused
 * outright, independent of any type-specific requiredness (e.g. `likelihood`/
 * `impact` being required only for `type: risk` is a schema.mjs/rules.mjs
 * concern, not a column-level one — see design §2.2's own note on this).
 *
 * `type` names the abstract grammar (design §2.3): integer, id, project-key,
 * enum, text, markdown, date, list, pair-list, json-array.
 */
export const COLUMNS = Object.freeze([
  { name: "schema_version", type: "integer",    required: true },
  { name: "id",              type: "id",         required: true },
  { name: "project",         type: "project-key", required: true },
  { name: "type",            type: "enum",       required: true },
  { name: "status",          type: "enum",       required: true },
  { name: "title",           type: "text",       required: true },
  { name: "description",     type: "markdown",   required: true },
  { name: "priority",        type: "enum",       required: false },
  { name: "resolution",      type: "enum",       required: false },
  { name: "parent",          type: "id",         required: false },
  { name: "assignee",        type: "text",       required: false },
  { name: "labels",          type: "list",       required: false },
  { name: "components",      type: "list",       required: false },
  { name: "estimate",        type: "integer",    required: false },
  { name: "sprint",          type: "text",       required: false },
  { name: "not_before",      type: "date",       required: false },
  { name: "deadline",        type: "date",       required: false },
  { name: "start",           type: "date",       required: false },
  { name: "due",             type: "date",       required: false },
  { name: "likelihood",      type: "text",       required: false },
  { name: "impact",          type: "text",       required: false },
  { name: "ref",             type: "text",       required: false },
  { name: "category",        type: "text",       required: false },
  { name: "verification",    type: "text",       required: false },
  { name: "derived",         type: "text",       required: false },
  { name: "branch",          type: "text",       required: false },
  { name: "pr",              type: "text",       required: false },
  { name: "links",           type: "pair-list",  required: false },
  { name: "worklog",         type: "json-array", required: false },
  { name: "created",         type: "date",       required: false },
  { name: "updated",         type: "date",       required: false },
].map((c) => Object.freeze(c)));

/** Just the names, in order — the exact header a canonical file must carry
 * (design §2.1: "exactly the 31 names of §2.2 in that order"). */
export const COLUMN_NAMES = Object.freeze(COLUMNS.map((c) => c.name));

const COLUMN_BY_NAME = new Map(COLUMNS.map((c) => [c.name, c]));

/** Whether `header` (an array of cells, e.g. a parsed CSV's first row) is
 * exactly the canonical 31 names in canonical order. */
export function isCanonicalHeader(header) {
  return Array.isArray(header) && header.length === COLUMN_NAMES.length
    && header.every((h, i) => h === COLUMN_NAMES[i]);
}

/** Whether a `schema_version` CELL (always a string — CSV has no other kind
 * of value) is exactly the current constant. Distinct from `isValidInteger`:
 * "2" is a syntactically valid integer cell and a semantically wrong version. */
export function isCanonicalSchemaVersionCell(v) {
  return v === String(SCHEMA_VERSION);
}

// --- Per-type grammars, design §2.3 ------------------------------------------

/** `-?[0-9]+`, no separators, no decimal point. Refuses "1,200", "240.0", "4h". */
export function isValidInteger(v) {
  return typeof v === "string" && /^-?[0-9]+$/.test(v);
}

/** Exactly `YYYY-MM-DD`, 10 characters. Refuses a full ISO datetime or a
 * differently-ordered date — the same grammar `zero-diff.mjs:148` already
 * tests against the live board. */
export function isValidDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/** `config.mjs`'s KEY_RE — refused, never normalised (ADR-0025). One shared
 * shape rather than a second copy that could drift from the config loader's. */
export function isValidProjectKey(v) {
  return typeof v === "string" && KEY_RE.test(v);
}

/** `<KEY>-<N>`, N a positive integer with no leading zero. The key half reuses
 * the same KEY_RE project-key shape `isValidProjectKey` does. */
export function isValidId(v) {
  if (typeof v !== "string") return false;
  const i = v.lastIndexOf("-");
  if (i <= 0) return false;
  const key = v.slice(0, i);
  const num = v.slice(i + 1);
  return KEY_RE.test(key) && /^[1-9][0-9]*$/.test(num);
}

// --- Multi-valued fields, design §2.4 ----------------------------------------
//
// "One rule, two shapes": labels/components/links are a compact ';'-separated
// form because every member is delimiter-free by validation; worklog is a
// JSON array because its `note` is free text and cannot be. labels/components/
// worklog preserve authored order; links are sorted (type, target) on encode,
// because that is the order both the database and `ticketValue` already treat
// as canonical (design §2.4's "Order" paragraph).

/** ';'-joined, order-preserving. Throws if a member itself contains ';' —
 * encoding such a member would be unreadable by the spreadsheet the format
 * exists for, so this is a refusal rather than an invented escape (§2.4). */
export function encodeList(members) {
  const list = members ?? [];
  for (const m of list) {
    if (String(m).includes(";")) {
      throw new Error(
        `csv-schema: list member ${JSON.stringify(m)} contains ';', the list delimiter — `
        + `cannot be encoded into a compact list cell`);
    }
  }
  return list.join(";");
}

/** Splits on ';'. An empty cell is the empty list, never `[""]`. Splitting on
 * ';' cannot itself produce a member containing ';', so there is no decode-side
 * failure mode here — refusal happens at `encodeList`, on the way in. */
export function decodeList(cell) {
  return cell === "" ? [] : cell.split(";");
}

/** `Type:TARGET` pairs, ';'-joined, sorted by (type, target) — design §2.4.
 * Throws if a pair's type is outside the fixed `LINK_TYPES` vocabulary. */
export function encodePairList(pairs) {
  const list = pairs ?? [];
  for (const p of list) {
    if (!LINK_TYPES.has(p.type)) {
      throw new Error(
        `csv-schema: link type ${JSON.stringify(p.type)} is not one of `
        + `${[...LINK_TYPES].join("/")} — the frontmatter link vocabulary (design §1.4)`);
    }
  }
  const sorted = list.slice().sort((a, b) =>
    a.type === b.type ? String(a.target).localeCompare(String(b.target)) : a.type.localeCompare(b.type));
  return sorted.map((p) => `${p.type}:${p.target}`).join(";");
}

/**
 * Decodes a pair-list cell. Refuses (rather than throwing, since this is the
 * import-facing direction and a caller needs to report a bad row rather than
 * crash) a member with anything other than exactly one ':', or a `Type`
 * outside `LINK_TYPES` — design §2.3's pair-list grammar.
 * @returns { ok: true, pairs } | { ok: false, error }
 */
export function decodePairList(cell) {
  if (cell === "") return { ok: true, pairs: [] };
  const pairs = [];
  for (const member of cell.split(";")) {
    const parts = member.split(":");
    if (parts.length !== 2) {
      return { ok: false,
        error: `links: ${JSON.stringify(member)} must have exactly one ':' separating type and target` };
    }
    const [type, target] = parts;
    if (!LINK_TYPES.has(type)) {
      return { ok: false,
        error: `links: unknown link type ${JSON.stringify(type)} (expected ${[...LINK_TYPES].join("/")})` };
    }
    pairs.push({ type, target });
  }
  return { ok: true, pairs };
}

/** A JSON array of `{date, minutes, note}` objects, keys in that fixed order
 * (design §2.4). `note` is omitted, not nulled, when absent — mirrors
 * `write-port.mjs`'s own database-read shape for a worklog entry. Empty
 * entries encode to an empty cell, per §2.6's empty-means-absent rule. */
export function encodeWorklog(entries) {
  const list = entries ?? [];
  if (list.length === 0) return "";
  const ordered = list.map((w) => {
    const out = { date: w.date, minutes: w.minutes };
    if (w.note !== undefined && w.note !== null) out.note = w.note;
    return out;
  });
  return JSON.stringify(ordered);
}

/**
 * Decodes a worklog cell. Refuses anything that does not parse as JSON, a
 * parsed value that is not an array, or an array element that is not a plain
 * object — design §2.3's "JSON array" grammar ("RFC 8259 array of objects").
 * @returns { ok: true, value } | { ok: false, error }
 */
export function decodeWorklog(cell) {
  if (cell === "") return { ok: true, value: [] };
  let parsed;
  try {
    parsed = JSON.parse(cell);
  } catch (e) {
    return { ok: false, error: `worklog: ${JSON.stringify(cell)} is not valid JSON (${e.message})` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: `worklog: expected a JSON array, got ${typeof parsed}` };
  }
  for (const [i, el] of parsed.entries()) {
    if (el === null || typeof el !== "object" || Array.isArray(el)) {
      return { ok: false, error: `worklog[${i}]: expected an object, got ${JSON.stringify(el)}` };
    }
  }
  return { ok: true, value: parsed };
}

// --- The unified per-column validator ----------------------------------------

/**
 * Validates and decodes one cell against its column's declared type.
 *
 * An empty cell on a required column is refused; an empty cell on an optional
 * column means absent (design §2.6) and decodes to `null` without reaching
 * the type grammar at all — so, e.g., an empty `priority` is never asked to
 * satisfy the enum check.
 *
 * `opts.allowed` (a `Set`) is REQUIRED for an `enum` column and is never
 * defaulted here — design §2.2/§1.2 are explicit that `type`/`status`/
 * `priority`/`resolution` validate against the resolved-per-project registry,
 * not a hardcoded list, and defaulting one in here would be exactly that.
 *
 * @returns { ok: true, value } | { ok: false, error }
 */
export function validateCell(columnName, rawValue, opts = {}) {
  const col = COLUMN_BY_NAME.get(columnName);
  if (!col) throw new Error(`csv-schema: unknown column ${JSON.stringify(columnName)}`);

  if (rawValue === "") {
    if (col.required) {
      return { ok: false, error: `${columnName} is required and cannot be empty (design §2.2)` };
    }
    return { ok: true, value: null };
  }

  switch (col.type) {
    case "integer":
      return isValidInteger(rawValue)
        ? { ok: true, value: Number(rawValue) }
        : { ok: false, error: `${columnName}: ${JSON.stringify(rawValue)} is not an integer (expected -?[0-9]+)` };
    case "date":
      return isValidDate(rawValue)
        ? { ok: true, value: rawValue }
        : { ok: false, error: `${columnName}: ${JSON.stringify(rawValue)} is not a date (expected YYYY-MM-DD)` };
    case "id":
      return isValidId(rawValue)
        ? { ok: true, value: rawValue }
        : { ok: false, error: `${columnName}: ${JSON.stringify(rawValue)} is not a valid id (expected <KEY>-<N>)` };
    case "project-key":
      return isValidProjectKey(rawValue)
        ? { ok: true, value: rawValue }
        : { ok: false, error: `${columnName}: ${JSON.stringify(rawValue)} is not a valid project key` };
    case "text":
    case "markdown":
      return { ok: true, value: rawValue };
    case "list":
      return { ok: true, value: decodeList(rawValue) };
    case "pair-list": {
      const r = decodePairList(rawValue);
      return r.ok ? { ok: true, value: r.pairs } : { ok: false, error: r.error };
    }
    case "json-array": {
      const r = decodeWorklog(rawValue);
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
    }
    case "enum": {
      if (!opts.allowed) {
        throw new Error(
          `csv-schema: validating enum column ${JSON.stringify(columnName)} requires opts.allowed `
          + `— the resolved per-project registry (design §1.2/§2.2), never a hardcoded list`);
      }
      return opts.allowed.has(rawValue)
        ? { ok: true, value: rawValue }
        : { ok: false, error: `${columnName}: ${JSON.stringify(rawValue)} is not one of ${[...opts.allowed].join("/")}` };
    }
    default:
      // Unreachable while COLUMNS above only names the ten grammars design §2.3
      // declares — kept as a named failure rather than an undefined return.
      throw new Error(`csv-schema: column ${JSON.stringify(columnName)} has unknown type ${JSON.stringify(col.type)}`);
  }
}
