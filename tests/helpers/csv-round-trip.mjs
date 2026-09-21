// tests/helpers/csv-round-trip.mjs — the shared harness for the CSV
// round-trip gate (BLZ-630) and the blanking revert test that proves it
// discriminates (BLZ-631).
//
// NOT a `.test.mjs` file on purpose: `node --test` globs test files, and
// importing one test file from another would register and re-run its whole
// suite inside the second file's process. The harness lives here so both
// suites drive the IDENTICAL loop — which is the only way the revert test's
// red can be attributed to the blanked column rather than to a second,
// slightly different harness.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportCsv } from "../../scripts/model/export-rows.mjs";
import { runImport } from "../../scripts/model/import-apply.mjs";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURE = join(REPO, "tests", "fixtures", "csv-round-trip");
export const FIXTURE_PROJECTS = join(FIXTURE, "projects");

/**
 * A ──export──▶ X, and a fresh empty board B ready to import X into.
 *
 * `csvText` lets BLZ-631 substitute a DEFECTIVE X — a column blanked exactly
 * as a broken exporter would blank it — and run the identical import and
 * comparison against it.
 */
export function roundTrip({ csvText = null, cleanup = [] } = {}) {
  const X = csvText ?? exportCsv(FIXTURE_PROJECTS).text;

  const B = mkdtempSync(join(tmpdir(), "blaze-round-trip-"));
  cleanup.push(B);
  mkdirSync(join(B, "projects"), { recursive: true });
  // The importer validates `sprint` against the TARGET board's registry, so
  // the fixture's registry travels with the corpus. It is not a ticket and
  // CSV cannot carry it — design §2.8's "board state that is not a ticket",
  // which import refuses rather than invents.
  copyFileSync(join(FIXTURE, "sprints.json"), join(B, "sprints.json"));

  const csvPath = join(B, "X.csv");
  writeFileSync(csvPath, X);

  return { X, B, csvPath, cleanup };
}

export async function importInto({ csvPath, B }) {
  return runImport({
    file: csvPath,
    projectsDir: join(B, "projects"),
    dataRoot: B,
    apply: true,
    // Staging is §5.4's concern and is tested in tests/model/import-apply.test.mjs;
    // a git tree here would only add a failure mode to a gate about data.
    stage: () => ({ ok: true, committed: false, queued: true }),
  });
}

export function cleanUp(dirs) {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
}
