// tests/model/csv-schema.test.mjs — BLZ-626: the canonical CSV schema module.
// Implements design §2.2-§2.6 (docs/design/csv-import-and-export.md). This is
// the schema-of-record every later import/export item validates rows against,
// so the column list, the validators and the version marker are each pinned
// and independently importable here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION, COLUMNS, COLUMN_NAMES,
  isCanonicalHeader, isCanonicalSchemaVersionCell,
  isValidInteger, isValidDate, isValidId, isValidProjectKey,
  encodeList, decodeList, encodePairList, decodePairList,
  encodeWorklog, decodeWorklog,
  validateCell,
} from "../../scripts/model/csv-schema.mjs";

test("the 31 canonical columns are exactly design §2.2's list, in order", () => {
  assert.deepEqual(COLUMN_NAMES, [
    "schema_version", "id", "project", "type", "status", "title", "description",
    "priority", "resolution", "parent", "assignee", "labels", "components",
    "estimate", "sprint", "not_before", "deadline", "start", "due",
    "likelihood", "impact", "ref", "category", "verification", "derived",
    "branch", "pr", "links", "worklog", "created", "updated",
  ]);
  assert.equal(COLUMN_NAMES.length, 31);
  assert.equal(COLUMNS.length, 31);
});

test("COLUMNS carries a type and a required flag for every column, and the seven ● columns match design §2.2", () => {
  const required = COLUMNS.filter((c) => c.required).map((c) => c.name);
  assert.deepEqual(required,
    ["schema_version", "id", "project", "type", "status", "title", "description"]);
  for (const c of COLUMNS) {
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.type, "string");
    assert.equal(typeof c.required, "boolean");
  }
});

test("SCHEMA_VERSION is the constant 1", () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test("isCanonicalSchemaVersionCell accepts exactly the string '1'", () => {
  assert.equal(isCanonicalSchemaVersionCell("1"), true);
  assert.equal(isCanonicalSchemaVersionCell("2"), false);
  assert.equal(isCanonicalSchemaVersionCell("01"), false);
  assert.equal(isCanonicalSchemaVersionCell(""), false);
  assert.equal(isCanonicalSchemaVersionCell(1), false); // cells are always strings
});

test("isCanonicalHeader checks the exact 31 names in exact order", () => {
  assert.equal(isCanonicalHeader(COLUMN_NAMES), true);
  assert.equal(isCanonicalHeader([...COLUMN_NAMES, "extra"]), false);
  assert.equal(isCanonicalHeader(COLUMN_NAMES.slice(0, 30)), false);
  const shuffled = [...COLUMN_NAMES]; [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  assert.equal(isCanonicalHeader(shuffled), false);
});

// --- Per-type format grammar, design §2.3 ------------------------------------

test("isValidInteger: -?[0-9]+ only", () => {
  assert.equal(isValidInteger("5"), true);
  assert.equal(isValidInteger("-5"), true);
  assert.equal(isValidInteger("0"), true);
  assert.equal(isValidInteger("1,200"), false);
  assert.equal(isValidInteger("240.0"), false);
  assert.equal(isValidInteger("4h"), false);
  assert.equal(isValidInteger(""), false);
});

test("isValidDate: exactly YYYY-MM-DD", () => {
  assert.equal(isValidDate("2026-08-20"), true);
  assert.equal(isValidDate("2026-08-20T00:00:00Z"), false);
  assert.equal(isValidDate("20/08/2026"), false);
  assert.equal(isValidDate("2026-8-20"), false);
  assert.equal(isValidDate(""), false);
});

test("isValidProjectKey: config.mjs's KEY_RE shape, refused not normalised (ADR-0025)", () => {
  assert.equal(isValidProjectKey("BLZ"), true);
  assert.equal(isValidProjectKey("BLZ2"), true);
  assert.equal(isValidProjectKey("blz"), false);
  assert.equal(isValidProjectKey("123"), false);
  assert.equal(isValidProjectKey(""), false);
});

test("isValidId: <KEY>-<N>, N a positive integer, no leading zero", () => {
  assert.equal(isValidId("BLZ-1"), true);
  assert.equal(isValidId("BLZ-9999"), true);
  assert.equal(isValidId("blz-1"), false);
  assert.equal(isValidId("BLZ1"), false);
  assert.equal(isValidId("BLZ-0"), false);
  assert.equal(isValidId("BLZ-01"), false);
  assert.equal(isValidId("BLZ--1"), false);
  assert.equal(isValidId(""), false);
});

// --- Multi-valued encodings, design §2.4 -------------------------------------

test("list: ';'-separated, order-preserving, empty means []", () => {
  assert.deepEqual(decodeList("backend;engine"), ["backend", "engine"]);
  assert.deepEqual(decodeList(""), []);
  assert.equal(encodeList(["backend", "engine"]), "backend;engine");
  assert.equal(encodeList([]), "");
});

test("list: encoding a member containing ';' is refused", () => {
  assert.throws(() => encodeList(["back;end"]), /;/);
});

test("pair list: 'Type:TARGET' separated by ';'", () => {
  const r = decodePairList("Implements:BLZ-167;Relates:BLZ-268");
  assert.equal(r.ok, true);
  assert.deepEqual(r.pairs, [{ type: "Implements", target: "BLZ-167" }, { type: "Relates", target: "BLZ-268" }]);
  assert.deepEqual(decodePairList("").pairs, []);
});

test("pair list: a Type outside LINK_TYPES is refused", () => {
  const r = decodePairList("Precedes:BLZ-1");
  assert.equal(r.ok, false);
  assert.match(r.error, /Precedes/);
});

test("pair list: a member with zero or more than one ':' is refused", () => {
  assert.equal(decodePairList("Blocks-BLZ-1").ok, false);
  assert.equal(decodePairList("Blocks:BLZ:1").ok, false);
});

test("pair list: encoding sorts by (type, target) — design §2.4", () => {
  const encoded = encodePairList([
    { type: "Relates", target: "BLZ-2" },
    { type: "Blocks", target: "BLZ-10" },
    { type: "Blocks", target: "BLZ-1" },
  ]);
  assert.equal(encoded, "Blocks:BLZ-1;Blocks:BLZ-10;Relates:BLZ-2");
});

test("pair list: encoding a link outside LINK_TYPES is refused", () => {
  assert.throws(() => encodePairList([{ type: "Precedes", target: "BLZ-1" }]), /Precedes/);
});

test("pair list: encoding a link with a type but no target is refused, not emitted as TYPE:undefined", () => {
  // BLZ-654: design §5.2 requires the export to refuse this shape ("an exporter
  // that dropped it would launder corruption into a clean-looking CSV"), and
  // §2.8 gives it the same severity as the unknown-frontmatter-key refusal —
  // the whole export refuses, nothing is silently coerced or dropped.
  assert.throws(() => encodePairList([{ type: "Relates" }]), /target/);
  assert.throws(() => encodePairList([{ type: "Relates", target: "" }]), /target/);
  assert.throws(() => encodePairList([{ type: "Relates", target: null }]), /target/);
});

test("worklog: JSON array of objects, keys in fixed order date/minutes/note", () => {
  const cell = encodeWorklog([{ date: "2026-08-20", minutes: 240, note: "x" }]);
  assert.equal(cell, '[{"date":"2026-08-20","minutes":240,"note":"x"}]');
  const r = decodeWorklog(cell);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ date: "2026-08-20", minutes: 240, note: "x" }]);
});

test("worklog: empty entries encode to an empty cell and decode back to []", () => {
  assert.equal(encodeWorklog([]), "");
  const r = decodeWorklog("");
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, []);
});

test("worklog: a note is optional and omitted rather than null", () => {
  const cell = encodeWorklog([{ date: "2026-08-20", minutes: 60 }]);
  assert.equal(cell, '[{"date":"2026-08-20","minutes":60}]');
});

test("worklog: anything that does not parse as JSON is refused", () => {
  const r = decodeWorklog("not json");
  assert.equal(r.ok, false);
});

test("worklog: a JSON value that is not an array is refused", () => {
  assert.equal(decodeWorklog("{}").ok, false);
  assert.equal(decodeWorklog("42").ok, false);
});

test("worklog: an array element that is not an object is refused", () => {
  assert.equal(decodeWorklog("[1,2]").ok, false);
  assert.equal(decodeWorklog('["x"]').ok, false);
  assert.equal(decodeWorklog("[null]").ok, false);
  assert.equal(decodeWorklog("[[1]]").ok, false);
});

// --- The unified per-column dispatcher ---------------------------------------

test("validateCell: an empty cell on a required column is refused", () => {
  const r = validateCell("id", "");
  assert.equal(r.ok, false);
  assert.match(r.error, /required/i);
});

test("validateCell: an empty cell on an optional column means absent, value null — design §2.6", () => {
  const r = validateCell("priority", "");
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});

test("validateCell: integer column round-trips the parsed number", () => {
  const r = validateCell("estimate", "60");
  assert.equal(r.ok, true);
  assert.equal(r.value, 60);
  assert.equal(validateCell("estimate", "4h").ok, false);
});

test("validateCell: date, id and project-key columns dispatch to their grammars", () => {
  assert.equal(validateCell("created", "2026-08-20").ok, true);
  assert.equal(validateCell("created", "not-a-date").ok, false);
  assert.equal(validateCell("parent", "BLZ-1").ok, true);
  assert.equal(validateCell("parent", "nope").ok, false);
  assert.equal(validateCell("project", "BLZ").ok, true);
  assert.equal(validateCell("project", "blz").ok, false);
});

test("validateCell: text/markdown columns accept any string", () => {
  assert.equal(validateCell("title", "anything, \"goes\"\nhere").ok, true);
  assert.equal(validateCell("description", "# heading\n\nbody").ok, true);
});

test("validateCell: an enum column requires the caller to pass the resolved registry, never a hardcoded list", () => {
  assert.throws(() => validateCell("type", "task"), /allowed/);
  const r = validateCell("type", "task", { allowed: new Set(["task", "story"]) });
  assert.equal(r.ok, true);
  const bad = validateCell("type", "widget", { allowed: new Set(["task", "story"]) });
  assert.equal(bad.ok, false);
});

test("validateCell: list and pair-list columns decode through the shared encoders", () => {
  assert.deepEqual(validateCell("labels", "a;b").value, ["a", "b"]);
  assert.deepEqual(validateCell("links", "Blocks:BLZ-1").value, [{ type: "Blocks", target: "BLZ-1" }]);
  assert.equal(validateCell("links", "Precedes:BLZ-1").ok, false);
});

test("validateCell: worklog column decodes through decodeWorklog", () => {
  const r = validateCell("worklog", '[{"date":"2026-08-20","minutes":60}]');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, [{ date: "2026-08-20", minutes: 60 }]);
  assert.equal(validateCell("worklog", "not json").ok, false);
});

test("validateCell: an unknown column name throws — a programmer error, not a data error", () => {
  assert.throws(() => validateCell("nonexistent", "x"), /unknown column/i);
});
