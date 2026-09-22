// tests/model/import-mapping.test.mjs — BLZ-634, design §4.2 and §5.3
// (docs/design/csv-import-and-export.md).
//
// The MAPPING FILE and the durable `source-ids/<name>.jsonl` map. No model
// runs anywhere in this file or in the module it tests: `import-mapping.mjs`
// only ever reads a mapping a PERSON has already accepted (ADR-0037 §2), and
// the proposer that writes one is a different module reached by a different
// verb.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  MAPPING_DIR, SOURCE_IDS_DIR, TRANSFORM_NAMES, CANONICAL_MAPPING_NAME,
  mappingPathFor, sourceIdsPathFor, headerDigest,
  loadMapping, bindMapping, mapRows, applyTransform,
  readSourceIds, openSourceIds, appendPair, nameFromReceiptPath,
} from "../../scripts/model/import-mapping.mjs";
import { scratchRegistry } from "../helpers/scratch.mjs";

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

const HEADER = ["Issue key", "Summary", "Issue Type", "Status", "Priority", "Story Points", "Reporter"];

function tmp(t) {
  const root = scratch(mkdtempSync(join(tmpdir(), "blaze-mapping-")));
  t.after(() => { try { chmodSync(join(root, SOURCE_IDS_DIR), 0o755); } catch { /* not there */ } });
  return root;
}

/** A complete, valid mapping for HEADER. Overrides are shallow-merged. */
function mapping(overrides = {}) {
  return {
    mappingVersion: 1,
    schemaVersion: 1,
    name: "acme",
    source: { columns: HEADER.slice(), sha256: headerDigest(HEADER) },
    sourceIdColumn: "Issue key",
    columns: {
      id: { from: "Issue key" },
      title: { from: "Summary" },
      type: { from: "Issue Type" },
      status: { from: "Status" },
      priority: { from: "Priority" },
      estimate: { from: "Story Points", transform: "hours-to-minutes" },
      project: { constant: "BLZ" },
    },
    values: {
      type: { Story: "story", Task: "task" },
      status: { "To Do": "defined", Done: "done" },
      priority: { P1: "high", P2: "medium" },
    },
    unmapped: ["Reporter"],
    confirmedBy: "ryan",
    confirmedAt: "2026-09-22",
    ...overrides,
  };
}

/** Write a mapping file at `import-mappings/<basename>.json`. */
function writeMapping(root, obj, basename = obj.name) {
  mkdirSync(join(root, MAPPING_DIR), { recursive: true });
  const p = join(root, MAPPING_DIR, `${basename}.json`);
  writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
  return p;
}

// =============================================================================
// §4.2 — the mapping file format
// =============================================================================

test("a well-formed mapping loads, and its name, transforms and unmapped set survive", (t) => {
  const root = tmp(t);
  const r = loadMapping(writeMapping(root, mapping()));
  assert.equal(r.ok, true, r.errors?.join("\n"));
  assert.equal(r.mapping.name, "acme");
  assert.equal(r.mapping.sourceIdColumn, "Issue key");
  assert.deepEqual(r.mapping.unmapped, ["Reporter"]);
});

test("`name` must equal the file's basename — a mapping with two names has two histories", (t) => {
  const root = tmp(t);
  const r = loadMapping(writeMapping(root, mapping({ name: "elsewhere" }), "acme"));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3, "§5.2: a name that is not its basename is a mapping refusal, not a data one");
  assert.match(r.errors.join("\n"), /acme/);
});

test("`canonical` is RESERVED as a mapping name", (t) => {
  const root = tmp(t);
  const r = loadMapping(writeMapping(root, mapping({ name: CANONICAL_MAPPING_NAME })));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.errors.join("\n"), /canonical/,
    "§4.2: `canonical` is the <name> a mapping-less import uses for its receipt");
});

test("a transform outside the closed vocabulary is refused — this is not an expression language", (t) => {
  const root = tmp(t);
  const m = mapping();
  m.columns.estimate = { from: "Story Points", transform: "eval(...)" };
  const r = loadMapping(writeMapping(root, m));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.errors.join("\n"), /hours-to-minutes/,
    "the refusal names the closed vocabulary, which is what the operator acts on");
});

test("the closed vocabulary is exactly design §4.2's ten transforms", () => {
  assert.deepEqual([...TRANSFORM_NAMES].sort(), [
    "days-to-minutes", "dmy-date", "hours-to-minutes", "identity", "iso-date",
    "mdy-date", "seconds-to-minutes", "split-comma", "split-semicolon", "trim",
  ].sort());
});

test("a mapping naming a non-canonical target column is refused", (t) => {
  const root = tmp(t);
  const m = mapping();
  m.columns.wibble = { from: "Reporter" };
  m.unmapped = [];
  const r = loadMapping(writeMapping(root, m));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
});

test("a mapping file that is not JSON is exit 2 — the file is not the format it claims", (t) => {
  const root = tmp(t);
  mkdirSync(join(root, MAPPING_DIR), { recursive: true });
  const p = join(root, MAPPING_DIR, "acme.json");
  writeFileSync(p, "{ not json");
  const r = loadMapping(p);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
});

test("an absent mapping file is exit 3, naming the file", (t) => {
  const root = tmp(t);
  const r = loadMapping(mappingPathFor(root, "gone"));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.errors.join("\n"), /gone\.json/);
});

// --- binding a mapping to an actual file's header ----------------------------

test("a header whose digest does not match is a REFUSAL, never a best-effort re-map", () => {
  const r = bindMapping(mapping(), HEADER.slice(), { sha256: headerDigest(["Key", "Summary"]) });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.errors.join("\n"), /sha256|digest/i);
});

test("a header that GAINED a column is refused, and the refusal names it", () => {
  const changed = [...HEADER, "Watchers"];
  const r = bindMapping(mapping(), changed);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.errors.join("\n"), /Watchers/, "§5.2: name the columns added and removed");
});

test("`unmapped` must be COMPLETE — a column in neither place is refused, naming both places", () => {
  const m = mapping({ unmapped: [] });
  const r = bindMapping(m, HEADER.slice());
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  const msg = r.errors.join("\n");
  assert.match(msg, /Reporter/);
  assert.match(msg, /columns/);
  assert.match(msg, /unmapped/,
    "§5.2: name the column and BOTH places it could be declared, so a column cannot be dropped by omission");
});

test("a mapping whose `from` names a column the header does not have is refused", () => {
  const m = mapping();
  m.columns.description = { from: "Description" };
  const r = bindMapping(m, HEADER.slice());
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.errors.join("\n"), /Description/);
});

test("a complete mapping binds cleanly", () => {
  assert.equal(bindMapping(mapping(), HEADER.slice()).ok, true);
});

test("`sourceIdColumn` is a THIRD declaration site — it is used, not discarded", () => {
  // A tracker "whose keys do not parse as <KEY>-<N> uses `sourceIdColumn`
  // alone" (§4.2), so the column is in neither `columns` nor `unmapped`.
  // Listing it under `unmapped` would be a lie — §4.4 renders that list as
  // "will be DISCARDED", and this column is the one thing that survives to
  // make the next import a no-op.
  const m = mapping();
  delete m.columns.id;
  assert.equal(bindMapping(m, HEADER.slice()).ok, true);
  // ...and it is not a hole: a column that is neither mapped, nor unmapped,
  // nor the source key is still refused.
  const hole = mapping({ unmapped: [] });
  delete hole.columns.id;
  assert.equal(bindMapping(hole, HEADER.slice()).ok, false);
});

// --- the transforms ----------------------------------------------------------

test("every transform in the vocabulary converts, and a value it cannot convert is refused", () => {
  assert.deepEqual(applyTransform("identity", " x "), { ok: true, value: " x " });
  assert.deepEqual(applyTransform("trim", " x "), { ok: true, value: "x" });
  assert.deepEqual(applyTransform("hours-to-minutes", "2"), { ok: true, value: "120" });
  assert.deepEqual(applyTransform("seconds-to-minutes", "1800"), { ok: true, value: "30" });
  assert.deepEqual(applyTransform("days-to-minutes", "1"), { ok: true, value: "1440" });
  assert.deepEqual(applyTransform("split-semicolon", "a;b"), { ok: true, value: "a;b" });
  assert.deepEqual(applyTransform("split-comma", "a, b"), { ok: true, value: "a;b" });
  assert.deepEqual(applyTransform("iso-date", "2026-09-22"), { ok: true, value: "2026-09-22" });
  assert.deepEqual(applyTransform("dmy-date", "22/09/2026"), { ok: true, value: "2026-09-22" });
  assert.deepEqual(applyTransform("mdy-date", "09/22/2026"), { ok: true, value: "2026-09-22" });
  assert.equal(applyTransform("hours-to-minutes", "two").ok, false);
  assert.equal(applyTransform("dmy-date", "22 September").ok, false);
  // An empty cell is absent, never a converted zero (§2.6).
  assert.deepEqual(applyTransform("hours-to-minutes", ""), { ok: true, value: "" });
});

// --- mapping rows ------------------------------------------------------------

const GRID = [
  HEADER.slice(),
  ["ACME-1", "first", "Story", "To Do", "P1", "2", "someone"],
  ["ACME-2", "second", "Task", "Done", "P2", "1", "other"],
];

test("mapRows produces the canonical row shape planImport takes, with the source key on it", () => {
  const r = mapRows(mapping({ columns: { ...mapping().columns, id: { constant: "" } } }), GRID);
  assert.equal(r.ok, true, r.errors?.join("\n"));
  assert.equal(r.rows.length, 2);
  const first = r.rows[0];
  assert.equal(first.row, 1);
  assert.equal(first.source, "ACME-1", "`sourceIdColumn`'s value rides on the row, for the receipt and the map");
  assert.equal(first.cells.title, "first");
  assert.equal(first.cells.type, "story", "`values` translates the source's vocabulary");
  assert.equal(first.cells.status, "defined");
  assert.equal(first.cells.priority, "high");
  assert.equal(first.cells.estimate, "120", "the transform ran");
  assert.equal(first.cells.project, "BLZ", "a `constant` column needs no source column");
  assert.equal(first.cells.description, "", "every canonical column is present; an unfilled one is empty");
  assert.equal(first.cells.id, "", "an id-less row is empty, not absent — --allocate-ids decides it later");
});

test("a value with no translation passes through — the planner refuses it with the legal set", () => {
  const grid = [HEADER.slice(), ["ACME-9", "x", "Story", "Blocked", "P1", "2", "r"]];
  const r = mapRows(mapping(), grid);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].cells.status, "Blocked",
    "the mapping layer does not invent a translation; §5.2's refusal names the legal set");
});

test("a row whose transform cannot convert is refused, exit 1, without echoing the cell", () => {
  const grid = [HEADER.slice(), ["ACME-9", "x", "Story", "To Do", "P1", "banana", "r"]];
  const r = mapRows(mapping(), grid);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1, "a cell that will not convert is DATA refused, not a mapping refusal");
  const msg = r.errors.join("\n");
  assert.match(msg, /row 1/);
  assert.match(msg, /hours-to-minutes/);
  assert.doesNotMatch(msg, /banana/, "§5.2's echo rule: a value is echoed only after it passes a shape check");
});

test("a source row with the wrong cell count is exit 2 — the file is not the format it claims", () => {
  const r = mapRows(mapping(), [HEADER.slice(), ["ACME-1", "short"]]);
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 2);
});

// =============================================================================
// §4.2 — the durable `source-ids/<name>.jsonl` map
// =============================================================================

test("the map is append-only and the lookup takes the FIRST occurrence", (t) => {
  const root = tmp(t);
  const p = sourceIdsPathFor(root, "acme");
  openSourceIds(p);
  appendPair(p, { source: "ACME-1", id: "BLZ-1", seq: 1 });
  appendPair(p, { source: "ACME-1", id: "BLZ-999", seq: 7 });
  const r = readSourceIds(p);
  assert.equal(r.torn, null);
  assert.equal(r.pairs.get("ACME-1").id, "BLZ-1",
    "a later accidental duplicate line can never remap a row (§4.2)");
});

test("a torn last line is DETECTED and reported with its line number, read-only", (t) => {
  const root = tmp(t);
  const p = sourceIdsPathFor(root, "acme");
  openSourceIds(p);
  appendPair(p, { source: "ACME-1", id: "BLZ-1", seq: 1 });
  appendPair(p, { source: "ACME-2", id: "BLZ-2", seq: 2 });
  writeFileSync(p, `${readFileSync(p, "utf8")}{"source":"ACME-3","id":"BL`);
  const r = readSourceIds(p);
  assert.notEqual(r.torn, null, "§5.2: a torn line in the map is a refusal — exit 5, nothing written");
  assert.equal(r.torn.line, 3);
  assert.equal(r.pairs.size, 2, "the complete lines are still readable");
  assert.equal(existsSync(`${p}.corrupt`), false,
    "the LOOKUP never parks: parking is a write, and only `repair --apply` does it (§4.2)");
});

test("an unparseable complete line is torn too", (t) => {
  const root = tmp(t);
  const p = sourceIdsPathFor(root, "acme");
  openSourceIds(p);
  writeFileSync(p, `{"source":"A","id":"BLZ-1","seq":1}\nnot json at all\n`);
  assert.notEqual(readSourceIds(p).torn, null);
});

test("an absent map reads as empty rather than throwing", (t) => {
  const r = readSourceIds(sourceIdsPathFor(tmp(t), "nobody"));
  assert.equal(r.exists, false);
  assert.equal(r.pairs.size, 0);
  assert.equal(r.torn, null);
});

test("openSourceIds THROWS when the map cannot be opened for append — the caller's exit 5", (t) => {
  const root = tmp(t);
  mkdirSync(join(root, SOURCE_IDS_DIR), { recursive: true });
  chmodSync(join(root, SOURCE_IDS_DIR), 0o500);
  assert.throws(() => openSourceIds(sourceIdsPathFor(root, "acme")));
});

test("headerDigest is stable, and quoting differences in the source do not change it", () => {
  assert.equal(headerDigest(HEADER), headerDigest(HEADER.slice()));
  assert.notEqual(headerDigest(HEADER), headerDigest([...HEADER, "More"]));
  assert.equal(headerDigest(HEADER).length, createHash("sha256").update("x").digest("hex").length);
});

test("`<name>` is recoverable from a receipt's filename", () => {
  assert.equal(nameFromReceiptPath("/d/import-receipts/2026-09-22T08-28-40.123Z-acme.jsonl"), "acme");
  assert.equal(nameFromReceiptPath("/d/import-receipts/2026-09-22T08-28-40.123Z-canonical.jsonl"), "canonical");
  assert.equal(nameFromReceiptPath("/d/import-receipts/nonsense.jsonl"), null);
});
