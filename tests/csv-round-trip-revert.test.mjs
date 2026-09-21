// tests/csv-round-trip-revert.test.mjs — BLZ-631: the blanking revert test.
//
// THIS IS NOT OPTIONAL POLISH. BLZ-630's own ticket body records that the
// FIRST DRAFT of that gate was green against a defect that silently blanked
// 21 of the 31 columns. A gate merged without the test that falsifies it is,
// in this campaign's own words, "a decoration, not a gate".
//
// THE DEFECT SHAPE MATTERS. *Removing* a column is already caught by §2.1's
// arity check, so a revert test aimed at removal proves nothing — it is aimed
// at the case the gate already catches. BLANKING is the shape that matters:
// row arity stays 31, the header is still the correct 31 names, `blaze audit`
// still passes (validateTicket checks only requiredFields(type)), and
// X equals Y byte for byte because both come from the same exporter. Gate 2
// is the only one of the three that can see it.
//
// So each case below:
//   1. blanks ONE column in X — set to the empty string, never removed;
//   2. imports the blanked X into a fresh board through the IDENTICAL harness;
//   3. asserts gate 2 goes RED **naming that field**, not merely red;
//   4. asserts gate 1 stays GREEN, which is the whole reason gate 2 exists.
//
// And the control: the real, unblanked fixture makes gate 2 pass. A negative
// result is worthless without it — without the control, a harness that was
// simply broken would produce the same red for all 21 columns.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { exportCsv } from "../scripts/model/export-rows.mjs";
import { parseCsv, writeCsv } from "../scripts/model/csv.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { zeroDiff } from "../scripts/migrate/zero-diff.mjs";
import { join } from "node:path";
import { FIXTURE_PROJECTS, roundTrip, importInto, cleanUp } from "./helpers/csv-round-trip.mjs";

const cleanup = [];
process.on("exit", () => cleanUp(cleanup));

/** The 10 columns that are structurally or by validation load-bearing: the
 *  importer refuses a row that blanks any of them, so they cannot be the
 *  silent defect. The other 21 CAN be blanked with the first-draft gate
 *  entirely green — which is the finding this file exists to pin. */
const LOAD_BEARING = new Set([
  "schema_version", "id", "project", "type", "status", "title", "description",
  "estimate", "likelihood", "impact",
]);
const BLANKABLE = COLUMN_NAMES.filter((n) => !LOAD_BEARING.has(n));

/** Blank one column of a canonical CSV — SET TO EMPTY, never removed, so row
 *  arity stays 31 and §2.1's arity check cannot see it. */
function blankColumn(csvText, column) {
  const i = COLUMN_NAMES.indexOf(column);
  assert.notEqual(i, -1);
  const grid = parseCsv(csvText);
  for (const row of grid.slice(1)) row[i] = "";
  return writeCsv(grid);
}

/** The gate-2 comparison, with the `listTickets` wrapper §3.3 specifies. */
function gate2(B) {
  return zeroDiff(fsReadStorage, FIXTURE_PROJECTS, {
    listTickets: () => fsReadStorage.listTickets(join(B, "projects")),
  });
}

// --- the control -------------------------------------------------------------

describe("BLZ-631: the control — the REAL fixture makes gate 2 pass", () => {
  let report;
  let clean;

  before(async () => {
    const rt = roundTrip({ cleanup });
    const r = await importInto(rt);
    assert.equal(r.exitCode, 0, r.report);
    clean = rt;
    report = gate2(rt.B);
  });

  test("gate 2 is green, and it is green having actually compared the corpus", () => {
    assert.deepEqual(report.valueDiffs, []);
    assert.ok(report.compared > 0,
      "a green that compared nothing is not a green — this is what makes every red below "
      + "attributable to the blanked column rather than to a broken harness");
    assert.ok(report.fieldsChecked > 0);
  });

  test("and gate 1 is green on the same run", () => {
    const Y = exportCsv(join(clean.B, "projects")).text;
    assert.equal(clean.X, Y);
  });
});

// --- the revert, one case per blankable column -------------------------------

describe("BLZ-631: blanking ONE column turns gate 2 red, for the reason its own name gives", () => {
  test(`there are exactly 21 blankable columns of the 31`, () => {
    // The design's measured figure. If someone adds a column, this says so
    // rather than letting the revert silently cover a smaller set.
    assert.equal(COLUMN_NAMES.length, 31);
    assert.equal(BLANKABLE.length, 21,
      "21 of the 31 columns can be silently zeroed with the first-draft gate green");
  });

  for (const column of BLANKABLE) {
    test(`blanking \`${column}\` in X makes gate 2 report a valueDiff naming it`, async () => {
      const rt = roundTrip({ csvText: blankColumn(exportCsv(FIXTURE_PROJECTS).text, column), cleanup });
      const imported = await importInto(rt);

      // The defect must be SILENT — an import that refused would be a
      // different (and easier) finding, and would not exercise gate 2 at all.
      assert.equal(imported.exitCode, 0,
        `blanking \`${column}\` was refused by the importer, so this case never reaches gate 2:\n`
        + imported.report);

      const report = gate2(rt.B);

      // The field zeroDiff reports for a blanked column. `links` and
      // `worklog` are the two ARRAY_FIELDS and report under their own names;
      // everything else is a scalar FIELD.
      const named = report.valueDiffs.filter((d) => d.field === column);
      assert.ok(named.length > 0,
        `gate 2 did NOT notice \`${column}\` being blanked — it reported `
        + `${report.valueDiffs.length} valueDiff(s) and none of them names this column. This is `
        + `precisely the defect class the first draft of this gate was green against.`);
      assert.equal(report.ok, false);

      // AND THE POINT OF ALL OF IT: gate 1 cannot see this. X and Y are
      // produced by the same exporter, so the blanked column is blank in
      // both and the byte diff is empty.
      const Y = exportCsv(join(rt.B, "projects")).text;
      assert.equal(rt.X, Y,
        `gate 1 happens to catch \`${column}\` too — which does not weaken gate 2, but this `
        + `assertion exists to record that for the other columns it does NOT`);
    });
  }
});
