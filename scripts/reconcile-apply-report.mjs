// scripts/reconcile-apply-report.mjs — the one line `blaze reconcile --apply` prints for the
// writes it made.
//
// BLZ-254 (spec §5.5): reconcile no longer commits. Until then its writes went through
// `commitOrQueue` (removed by BLZ-254), and this module (as reconcile-commit-report.mjs, BLZ-404/BLZ-422)
// classified seven commit outcomes — committed, no-op, queued, locked, failed, db, none —
// each with its own wording and exit code. The board never commits now, so there is one
// outcome per store and nothing to classify: the files changed (fs, dual), or the rows did (db).
//
// The two-quantity rule is unchanged (BLZ-401, BLZ-447). This is a WRITE-RECORD surface, so
// it says "N ticket(s) updated without a status change", never the preview's "other
// update(s)", and a quantity that is zero is not stated at all.
export function appliedLine({ mode, movedCount, nonMovedCount }) {
  const suffix = nonMovedCount
    ? `, ${nonMovedCount} ticket(s) updated without a status change`
    : "";
  if (mode === "db") return `reconcile: ${movedCount} ticket(s) moved${suffix} in the database.`;
  return `reconcile: ${movedCount} ticket(s) moved${suffix} in the board's files — `
    + "reconcile makes no git commit.";
}
