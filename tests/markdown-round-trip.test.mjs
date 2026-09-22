// tests/markdown-round-trip.test.mjs — BLZ-633: the markdown medium's own
// round trip. Design §4.5.
//
//     A  ──exportMarkdownDocs──▶  M   (a directory of ticket documents)
//     M  ──blaze import --apply──▶  B   (an empty board)
//     B  ──blaze export --format csv──▶  Y
//     A  ──blaze export --format csv──▶  X
//
// WHAT IS ASSERTED, AND WHY IT IS NARROWER THAN BLZ-630'S THREE GATES.
// §4.5 specifies a markdown READER and says nothing about a markdown export at
// all, so there is no second exporter here whose defects could cancel in a
// diff — the failure mode BLZ-630's gate 2 exists for. One side of every
// comparison below is the CANONICAL CSV exporter, which BLZ-630 and BLZ-631
// already hold to gates 1, 2 and 3 against this very fixture. So the markdown
// medium needs exactly two things of its own:
//
//   MG1 — every document of M, read back, classifies as `skip` AGAINST A.
//         `skip` is `planImport`'s own definition of identical — all 31
//         canonical columns, `status` and `description` included, compared
//         through `exportRows` — so this says "the markdown medium loses
//         nothing the canonical schema can express" in the planner's words
//         rather than in a second comparator's.
//   MG2 — importing M into an empty board B yields `exportCsv(B)` byte-equal
//         to `exportCsv(A)`. The whole loop, and the one that catches a reader
//         that plans correctly and then hands the wrong record to the writer.
//
//   plus the gate-3 analogue: every one of the 31 columns is non-empty in at
//   least one row READ BACK FROM M. Without it, MG1 and MG2 both compare
//   corpora and neither notices a column the markdown medium drops
//   EVERYWHERE — the exact hole BLZ-630's gate 3 was added for.
//
// The revert that proves MG1 and MG2 discriminate is at the bottom of this
// file rather than in a separate suite: it is three lines, and BLZ-631's
// reason for living apart (a 346-line gate) does not apply.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { exportCsv } from "../scripts/model/export-rows.mjs";
import { runImport, loadBoard } from "../scripts/model/import-apply.mjs";
import { planImport } from "../scripts/model/import-plan.mjs";
import { COLUMN_NAMES } from "../scripts/model/csv-schema.mjs";
import { exportMarkdownDocs, readMarkdownRows } from "../scripts/model/import-markdown.mjs";
import { FIXTURE, FIXTURE_PROJECTS, cleanUp } from "./helpers/csv-round-trip.mjs";

const cleanup = [];
process.on("exit", () => cleanUp(cleanup));

/** A ──export──▶ M, on disk. `mutate` lets the revert test below hand the
 *  identical loop a DEFECTIVE M. */
function markdownExportDir({ mutate = (d) => d } = {}) {
  const M = mkdtempSync(join(tmpdir(), "blaze-md-export-"));
  cleanup.push(M);
  const { docs } = exportMarkdownDocs(FIXTURE_PROJECTS);
  for (const doc of docs.map(mutate)) {
    const abs = join(M, doc.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, doc.text);
  }
  return { M, docs };
}

function emptyBoard() {
  const B = mkdtempSync(join(tmpdir(), "blaze-md-round-trip-"));
  cleanup.push(B);
  mkdirSync(join(B, "projects"), { recursive: true });
  // Same reason as the CSV harness: the importer validates `sprint` against
  // the TARGET board's registry, and a registry is not a ticket.
  writeFileSync(join(B, "sprints.json"), readFileSync(join(FIXTURE, "sprints.json")));
  return B;
}

function importMarkdownInto(M, B) {
  return runImport({
    file: M,
    projectsDir: join(B, "projects"),
    dataRoot: B,
    apply: true,
    readRows: () => readMarkdownRows([M], { dataRoot: B }),
    // Staging is §5.4's concern; a git tree here would only add a failure mode
    // to a gate about data.
    stage: () => ({ ok: true, committed: false, queued: true }),
  });
}

let X; let M; let docs; let readBack;

before(() => {
  X = exportCsv(FIXTURE_PROJECTS).text;
  ({ M, docs } = markdownExportDir());
  readBack = readMarkdownRows([M], { dataRoot: M });
  assert.equal(readBack.ok, true,
    `the markdown export must read back at all before any gate means anything: `
    + `${(readBack.errors ?? []).join("\n")}`);
});

describe("BLZ-633: the export is a document per ticket, in the board's own layout", () => {
  test("one document per fixture ticket, and every one parses back", () => {
    const csvRows = exportCsv(FIXTURE_PROJECTS).text.split("\n").length;
    assert.ok(docs.length > 1, "the fixture must carry more than one ticket");
    assert.equal(readBack.rows.length, docs.length,
      `every document written must be read back — ${docs.length} written, `
      + `${readBack.rows.length} read (${csvRows} CSV lines)`);
  });

  test("the layout is <project>/<status>/<file>.md — `status` is the directory, not a field", () => {
    for (const doc of docs) {
      const parts = doc.path.split("/");
      assert.equal(parts.length, 3, `${doc.path} must be <project>/<status>/<file>.md`);
      assert.match(parts[2], /\.md$/);
      assert.doesNotMatch(doc.text, /^status:/m,
        "design §1.1: `status` is the DIRECTORY, not a frontmatter key. Writing it as a field "
        + "would invent a 29th key and the reader would then have two sources for it");
    }
  });

  test("every document carries `project` in frontmatter, stamped from the walk", () => {
    // `exportRows` reads `project` off the WALK because "frontmatter .project
    // is NOT a substitute: it is absent on some boards" (index.mjs, BLZ-271).
    // A markdown document has no walk to be read off once it leaves the
    // corpus, so the export stamps it — otherwise every re-import of a board
    // whose tickets omit the key would refuse on a required column.
    for (const doc of docs) assert.match(doc.text, /^project: \S+$/m);
  });
});

describe("BLZ-633 the gate-3 analogue: no column is dropped EVERYWHERE", () => {
  for (const name of COLUMN_NAMES) {
    test(`column \`${name}\` is non-empty in at least one row read back from M`, () => {
      assert.ok(readBack.rows.some((r) => r.cells[name] !== ""),
        `every markdown row has an empty \`${name}\` — MG1 and MG2 compare corpora and neither `
        + `notices a column the markdown medium drops everywhere`);
    });
  }
});

describe("BLZ-633 MG1: every document of M classifies as `skip` against A", () => {
  test("no create, no update, no refuse — the planner's own definition of identical", () => {
    const board = loadBoard(FIXTURE_PROJECTS, { dataRoot: FIXTURE });
    const plan = planImport(readBack.rows, board, {});
    assert.deepEqual(plan.refusals.map((r) => r.message), [],
      "a refusal here means the markdown medium produced a row the board would not accept");
    assert.deepEqual(
      { ...plan.counts, skip: 0 }, { create: 0, update: 0, skip: 0, refuse: 0 },
      `every row must be a skip; got ${JSON.stringify(plan.counts)} — an \`update\` means the `
      + `31 canonical columns differ, which is the markdown medium losing or changing a value`);
    assert.equal(plan.counts.skip, readBack.rows.length);
  });
});

describe("BLZ-633 MG2: M imported into an empty board exports to the SAME canonical CSV", () => {
  test("exportCsv(B) is byte-equal to exportCsv(A)", async () => {
    const B = emptyBoard();
    const r = await importMarkdownInto(M, B);
    assert.equal(r.exitCode, 0, `the import of M must succeed:\n${r.report}`);
    const Y = exportCsv(join(B, "projects")).text;
    assert.equal(Y, X,
      "A → markdown → B → CSV must be the same bytes as A → CSV. One side of this comparison "
      + "is the canonical exporter BLZ-630/631 already hold to three gates, so a difference "
      + "here is the markdown medium's");
  });
});

/** One field lost, the way a broken reader or writer loses one. */
const blankPr = (d) => ({ ...d, text: d.text.replace(/^pr: .*$\n?/m, "") });

describe("BLZ-633: the gates DISCRIMINATE — the revert BLZ-631 is to BLZ-630", () => {
  test("blanking one exported field turns MG1 red, for the reason its name gives", () => {
    // Exactly what a broken exporter or a broken reader would do: lose one
    // field. `pr` is chosen deliberately: it is optional at the COLUMN level
    // (csv-schema.mjs) AND carries no model rule of its own (rules.mjs), so a
    // blank trips neither a required-column refusal nor a model refusal. The
    // row stays well-formed and the only thing left to catch it is the
    // 31-column comparison, which is the property under test. `estimate` would
    // not do: it is column-optional but model-REQUIRED, so its blank reddens
    // the gate for a reason MG1 is not about.
    const { M: bad } = markdownExportDir({ mutate: blankPr });
    const read = readMarkdownRows([bad], { dataRoot: bad });
    assert.equal(read.ok, true);
    const plan = planImport(read.rows, loadBoard(FIXTURE_PROJECTS, { dataRoot: FIXTURE }), {});
    assert.ok(plan.counts.skip < read.rows.length,
      "MG1 must not be green against a markdown export that dropped a field");
    const named = plan.refusals.some((m) => /differs in .*\bpr\b/.test(m.message));
    assert.ok(named,
      `the refusal must NAME the dropped column, or the gate is red for an unknown reason: `
      + `${plan.refusals.map((r) => r.message).join(" | ") || "(no refusals at all)"}`);
  });

  test("blanking one exported field turns MG2 red too", async () => {
    const { M: bad } = markdownExportDir({ mutate: blankPr });
    const B = emptyBoard();
    const r = await importMarkdownInto(bad, B);
    // Into an EMPTY board every row is a create, so the defect does not refuse
    // — it lands, and the exported CSV differs. That is the arm MG2 owns and
    // MG1 cannot see.
    assert.equal(r.exitCode, 0, r.report);
    assert.notEqual(exportCsv(join(B, "projects")).text, X,
      "MG2 must not be green against a markdown export that dropped a field");
  });
});
