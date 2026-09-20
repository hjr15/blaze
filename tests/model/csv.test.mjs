// tests/model/csv.test.mjs — BLZ-625: RFC 4180 reader/writer, format layer only.
// No board semantics here — csv-schema.mjs (BLZ-626) owns column meaning. This file
// pins the quoting/escaping rules of design §2.1 and the CRLF/empty-field round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, writeCsv } from "../../scripts/model/csv.mjs";

test("writeCsv quotes a field containing a comma", () => {
  assert.equal(writeCsv([["a, b", "c"]]), '"a, b",c\n');
});

test("writeCsv doubles an embedded double quote and wraps the field", () => {
  assert.equal(writeCsv([['he said "no"']]), '"he said ""no"""\n');
});

test("writeCsv quotes a field containing an embedded newline", () => {
  assert.equal(writeCsv([["line one\nline two", "x"]]), '"line one\nline two",x\n');
});

test("writeCsv does not quote a field with nothing hostile in it", () => {
  // design §2.5 example: an em-dash and a URL are not CSV hazards.
  assert.equal(writeCsv([["#63 — https://x/pull/63"]]), "#63 — https://x/pull/63\n");
});

test("writeCsv leaves an empty field as an empty cell, not a quoted empty string", () => {
  assert.equal(writeCsv([["a", "", "c"]]), "a,,c\n");
});

test("parseCsv reads a plain unquoted row", () => {
  assert.deepEqual(parseCsv("a,b,c\n"), [["a", "b", "c"]]);
});

test("parseCsv reads a quoted field containing a comma", () => {
  assert.deepEqual(parseCsv('"a, b",c\n'), [["a, b", "c"]]);
});

test("parseCsv un-doubles an embedded quote inside a quoted field", () => {
  assert.deepEqual(parseCsv('"he said ""no"""\n'), [['he said "no"']]);
});

test("parseCsv reads a quoted field containing an embedded newline", () => {
  assert.deepEqual(parseCsv('"line one\nline two",x\n'), [["line one\nline two", "x"]]);
});

test("parseCsv treats a CRLF outside a quoted cell as the record separator", () => {
  assert.deepEqual(parseCsv("a,b\r\nc,d\r\n"), [["a", "b"], ["c", "d"]]);
});

test("parseCsv reads an empty field as an empty string, never undefined or null", () => {
  const rows = parseCsv("a,,c\n");
  assert.deepEqual(rows, [["a", "", "c"]]);
  assert.equal(rows[0][1], "");
  assert.notEqual(rows[0][1], undefined);
  assert.notEqual(rows[0][1], null);
});

test("parseCsv of empty text yields no rows", () => {
  assert.deepEqual(parseCsv(""), []);
});

test("parseCsv does not emit a phantom trailing row for a trailing newline", () => {
  assert.deepEqual(parseCsv("a,b\n"), [["a", "b"]]);
});

test("parseCsv reads a row with no trailing newline at all", () => {
  assert.deepEqual(parseCsv("a,b"), [["a", "b"]]);
});

test("parseCsv reads a blank line as a single empty-field row", () => {
  assert.deepEqual(parseCsv("a,b\n\nc,d\n"), [["a", "b"], [""], ["c", "d"]]);
});

test("parseCsv reads multiple rows", () => {
  assert.deepEqual(parseCsv("a,b\nc,d\ne,f\n"), [["a", "b"], ["c", "d"], ["e", "f"]]);
});

test("parseCsv refuses an unterminated quoted field", () => {
  assert.throws(() => parseCsv('"unterminated,x\n'), /unterminated/i);
});

// --- The round trip: writeCsv(rows) then parseCsv(...) must recover the same
// cell values, for every hazard the design names (§2.1, §2.5) and every
// combination of them. This is the property test the ticket calls for, written
// as an exhaustive table over the hazard set rather than a randomised generator
// (no property-testing library is already a dependency of this repo).
const HAZARD_VALUES = [
  "",                          // empty field
  "plain",                     // nothing hostile
  "a,b",                       // comma
  'a"b',                       // quote
  "a\nb",                      // newline
  "a\r\nb",                    // embedded CRLF
  "a\rb",                      // lone CR
  ",",                         // comma alone
  '"',                         // quote alone
  "\n",                        // newline alone
  '",\n"',                     // every hazard character together
  "  leading and trailing space  ",
  "a, b, \"c\"\nd",            // combined
  "1,200",                     // looks numeric but has a comma
  "#63 — https://example.com/pull/63",
];

test("round trip: every hazard value, alone in a single-cell row, survives write+read", () => {
  for (const v of HAZARD_VALUES) {
    const rows = [[v]];
    const back = parseCsv(writeCsv(rows));
    assert.deepEqual(back, rows, `hazard value ${JSON.stringify(v)} did not round-trip`);
  }
});

test("round trip: every pairwise combination of hazard values across a two-column, two-row grid survives write+read", () => {
  for (const a of HAZARD_VALUES) {
    for (const b of HAZARD_VALUES) {
      const rows = [[a, b], [b, a]];
      const back = parseCsv(writeCsv(rows));
      assert.deepEqual(back, rows,
        `pair (${JSON.stringify(a)}, ${JSON.stringify(b)}) did not round-trip`);
    }
  }
});

test("round trip: a CRLF-terminated file re-emits with the same field content (record separator normalises to LF)", () => {
  const rows = [["a", "b"], ["c", "e"]];
  // Construct the CRLF file directly, as an external tool (Excel) would write
  // it — only the RECORD separator is CRLF here, not any in-cell data.
  const crlfText = "a,b\r\nc,e\r\n";
  assert.deepEqual(parseCsv(crlfText), rows);
  // Re-emitting normalises the record separator to LF, per design §2.1.
  assert.ok(!writeCsv(parseCsv(crlfText)).includes("\r\n"));
  assert.equal(writeCsv(parseCsv(crlfText)), "a,b\nc,e\n");
});

test("round trip: CRLF as the record separator is distinguished from a CR that is genuine cell data inside a quoted field", () => {
  // A quoted cell may carry a literal CR (e.g. copy-pasted from a CRLF source
  // into one field) without that CR being mistaken for a row terminator, so
  // long as it is not immediately followed by the closing quote + LF shape of
  // an actual record boundary.
  const rows = [["a\rb", "c"], ["d", "e"]];
  assert.deepEqual(parseCsv(writeCsv(rows)), rows);
});

test("round trip: a multi-row, multi-column grid with mixed empty and hostile fields", () => {
  const rows = [
    ["id", "title", "description"],
    ["BLZ-1", "simple", ""],
    ["BLZ-2", "a, comma title", "line one\nline two"],
    ["BLZ-3", "", 'quote "here"'],
  ];
  assert.deepEqual(parseCsv(writeCsv(rows)), rows);
});

test("writeCsv of no rows produces an empty string", () => {
  assert.equal(writeCsv([]), "");
});
