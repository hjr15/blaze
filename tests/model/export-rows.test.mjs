// tests/model/export-rows.test.mjs — BLZ-627: corpus → canonical CSV rows.
// Implements design §2.7-§2.8 (docs/design/csv-import-and-export.md): canonical
// row/column order, the unknown-frontmatter-key refusal, and the hostile-cell
// warning (never a mutation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportRows, exportCsv, UnknownFrontmatterKeyError } from "../../scripts/model/export-rows.mjs";
import { parseCsv } from "../../scripts/model/csv.mjs";
import { COLUMN_NAMES } from "../../scripts/model/csv-schema.mjs";

// Cleanup registered via t.after(), never as the test's own trailing
// statement — a failing assertion earlier in the test must not skip it
// (tests/temp-cleanup-guard.test.mjs, BLZ-603).
function board(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-export-rows-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTicket(root, project, status, id, fm, body = "body text") {
  const dir = join(root, "projects", project, status);
  mkdirSync(dir, { recursive: true });
  const lines = ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", body, ""];
  writeFileSync(join(dir, `${id}.md`), lines.join("\n"));
}

test("exportRows header order matches the 31 canonical columns exactly", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 30 });
  const { rows } = exportRows(join(root, "projects"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].length, COLUMN_NAMES.length);
});

test("exportCsv emits the header row as the exact 31 names, and blaze export can round-trip through csv.mjs", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 30 });
  const { text } = exportCsv(join(root, "projects"));
  const parsed = parseCsv(text);
  assert.deepEqual(parsed[0], COLUMN_NAMES);
  assert.equal(parsed.length, 2); // header + 1 ticket
});

test("rows are ordered (project ascending, numeric id ascending) — not lexicographic", (t) => {
  const root = board(t);
  writeTicket(root, "ZZZ", "defined", "ZZZ-1", { id: "ZZZ-1", title: "z", type: "task", project: "ZZZ", estimate: 5 });
  writeTicket(root, "BLZ", "defined", "BLZ-10", { id: "BLZ-10", title: "ten", type: "task", project: "BLZ", estimate: 5 });
  writeTicket(root, "BLZ", "defined", "BLZ-9", { id: "BLZ-9", title: "nine", type: "task", project: "BLZ", estimate: 5 });
  writeTicket(root, "ACA", "defined", "ACA-1", { id: "ACA-1", title: "a", type: "task", project: "ACA", estimate: 5 });
  const { rows } = exportRows(join(root, "projects"));
  const idIdx = COLUMN_NAMES.indexOf("id");
  assert.deepEqual(rows.map((r) => r[idIdx]), ["ACA-1", "BLZ-9", "BLZ-10", "ZZZ-1"]);
});

test("status comes from the directory, and description is the ticket body", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "in-progress", "BLZ-1",
    { id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 5 }, "the body\ncontent");
  const { rows } = exportRows(join(root, "projects"));
  const statusIdx = COLUMN_NAMES.indexOf("status");
  const descIdx = COLUMN_NAMES.indexOf("description");
  assert.equal(rows[0][statusIdx], "in-progress");
  // parseTicket preserves the body verbatim, trailing newline included —
  // matching serializeTicket's own on-disk convention.
  assert.equal(rows[0][descIdx], "the body\ncontent\n");
});

test("labels/components/links/worklog encode through the shared csv-schema encoders", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1", {
    id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 5,
    labels: "[backend, engine]",
    components: "[api]",
    links: "\n  - { type: Blocks, target: BLZ-2 }\n  - { type: Relates, target: BLZ-3 }",
    worklog: "\n  - { date: 2026-08-20, minutes: 240, note: \"a note\" }",
  });
  writeTicket(root, "BLZ", "defined", "BLZ-2", { id: "BLZ-2", title: "t2", type: "task", project: "BLZ", estimate: 5 });
  writeTicket(root, "BLZ", "defined", "BLZ-3", { id: "BLZ-3", title: "t3", type: "task", project: "BLZ", estimate: 5 });
  const { rows } = exportRows(join(root, "projects"));
  const row = rows.find((r) => r[COLUMN_NAMES.indexOf("id")] === "BLZ-1");
  assert.equal(row[COLUMN_NAMES.indexOf("labels")], "backend;engine");
  assert.equal(row[COLUMN_NAMES.indexOf("components")], "api");
  // links sorted by (type, target) on export — design §2.4.
  assert.equal(row[COLUMN_NAMES.indexOf("links")], "Blocks:BLZ-2;Relates:BLZ-3");
  assert.equal(row[COLUMN_NAMES.indexOf("worklog")],
    '[{"date":"2026-08-20","minutes":240,"note":"a note"}]');
});

test("a comma and a quote in a title flow through csv.mjs's writer and round-trip", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: '"a, title with \\"quotes\\""', type: "task", project: "BLZ", estimate: 5 });
  const { text } = exportCsv(join(root, "projects"));
  const parsed = parseCsv(text);
  const titleIdx = COLUMN_NAMES.indexOf("title");
  assert.equal(parsed[1][titleIdx], 'a, title with "quotes"');
});

test("refuses the whole export when a ticket carries a frontmatter key outside the declared 28, naming the ticket and the key", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 5, custom_field: "surprise" });
  assert.throws(() => exportRows(join(root, "projects")), (e) => {
    assert.ok(e instanceof UnknownFrontmatterKeyError);
    assert.match(e.message, /BLZ-1/);
    assert.match(e.message, /custom_field/);
    return true;
  });
});

test("refuses the whole export when a ticket carries a link with a type but no target, naming the ticket, not emitting 'Relates:undefined'", (t) => {
  // BLZ-654: design §5.2 requires this refusal at export time, "naming the
  // ticket" verbatim — an exporter that dropped it would launder corruption
  // into a clean-looking CSV, and an unnamed refusal on a 2000+ ticket board
  // is unactionable (round-1 review finding on this same ticket).
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1", {
    id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 5,
    links: "\n  - { type: Relates }",
  });
  assert.throws(() => exportRows(join(root, "projects")), (e) => {
    assert.match(e.message, /target/);
    assert.match(e.message, /BLZ-1/);
    return true;
  });
});

test("a hostile cell (leading '=' or '@' after stripping whitespace) is warned about, never mutated", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: '"=cmd|\' /C calc\'!A0"', type: "task", project: "BLZ", estimate: 5 });
  const { rows, warnings } = exportRows(join(root, "projects"));
  const titleIdx = COLUMN_NAMES.indexOf("title");
  assert.equal(rows[0][titleIdx], "=cmd|' /C calc'!A0"); // unmutated
  assert.ok(warnings.some((w) => w.includes("BLZ-1") && w.includes("title")));
});

test("a leading tab before '=' is still detected as hostile — stripping happens before the check", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: '"\t=cmd|\' /C calc\'!A0"', type: "task", project: "BLZ", estimate: 5 });
  const { warnings } = exportRows(join(root, "projects"));
  assert.ok(warnings.some((w) => w.includes("BLZ-1")));
});

test("a leading '+' or '-' is NOT hostile — design §2.5 deliberately excludes them", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: "+1 priority ticket", type: "task", project: "BLZ", estimate: 5 });
  writeTicket(root, "BLZ", "defined", "BLZ-2",
    { id: "BLZ-2", title: "-1 priority ticket", type: "task", project: "BLZ", estimate: 5 });
  const { warnings } = exportRows(join(root, "projects"));
  assert.deepEqual(warnings, []);
});

test("start/due (scheduler outputs) are exported verbatim — design §2.7", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1", {
    id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 5,
    start: "2026-09-01", due: "2026-09-05",
  });
  const { rows } = exportRows(join(root, "projects"));
  assert.equal(rows[0][COLUMN_NAMES.indexOf("start")], "2026-09-01");
  assert.equal(rows[0][COLUMN_NAMES.indexOf("due")], "2026-09-05");
});

test("schema_version is the constant '1' on every row", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1", { id: "BLZ-1", title: "t", type: "task", project: "BLZ", estimate: 5 });
  writeTicket(root, "BLZ", "defined", "BLZ-2", { id: "BLZ-2", title: "t2", type: "task", project: "BLZ", estimate: 5 });
  const { rows } = exportRows(join(root, "projects"));
  const svIdx = COLUMN_NAMES.indexOf("schema_version");
  for (const r of rows) assert.equal(r[svIdx], "1");
});

test("an empty corpus exports a header-only CSV, not an error", (t) => {
  const root = board(t);
  mkdirSync(join(root, "projects"), { recursive: true });
  const { text } = exportCsv(join(root, "projects"));
  const parsed = parseCsv(text);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], COLUMN_NAMES);
});

test("a ticket whose id has no parseable numeric part sorts after ones that do", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-x", { id: "BLZ-x", title: "weird", type: "task", project: "BLZ", estimate: 5 });
  writeTicket(root, "BLZ", "defined", "BLZ-1", { id: "BLZ-1", title: "normal", type: "task", project: "BLZ", estimate: 5 });
  const { rows } = exportRows(join(root, "projects"));
  const idIdx = COLUMN_NAMES.indexOf("id");
  assert.deepEqual(rows.map((r) => r[idIdx]), ["BLZ-1", "BLZ-x"]);
});

test("a long hostile cell is excerpted in the warning rather than dumped in full", (t) => {
  const root = board(t);
  const long = "=" + "x".repeat(80);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { id: "BLZ-1", title: `"${long}"`, type: "task", project: "BLZ", estimate: 5 });
  const { warnings } = exportRows(join(root, "projects"));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("…"), "warning should mark the excerpt as truncated");
  assert.ok(!warnings[0].includes(long), "warning should not dump the full hostile value");
});

test("an unknown-key refusal still names the key when the ticket itself carries no id", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1",
    { title: "t", type: "task", project: "BLZ", estimate: 5, surprise_key: "x" });
  assert.throws(() => exportRows(join(root, "projects")), /surprise_key/);
});

test("an absent optional field is an empty cell, never the literal string 'undefined' or 'null'", (t) => {
  const root = board(t);
  writeTicket(root, "BLZ", "defined", "BLZ-1", { id: "BLZ-1", title: "t", type: "task", project: "BLZ" });
  const { rows } = exportRows(join(root, "projects"));
  assert.equal(rows[0][COLUMN_NAMES.indexOf("priority")], "");
  assert.equal(rows[0][COLUMN_NAMES.indexOf("assignee")], "");
  assert.equal(rows[0][COLUMN_NAMES.indexOf("labels")], "");
  assert.equal(rows[0][COLUMN_NAMES.indexOf("worklog")], "");
});
