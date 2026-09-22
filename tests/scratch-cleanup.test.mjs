// tests/scratch-cleanup.test.mjs — BLZ-503, generalised by BLZ-517.
//
// THE CORPUS REMOVES THE SCRATCH DIRECTORIES IT MINTS, SUITE BY NAMED SUITE.
//
// BLZ-491 fixed one suite and measured that the rest of the corpus did not. That
// measurement, taken against c355b9c with `TMPDIR` pointed at an empty directory and the
// whole suite run once: **299 leftover directories, from 56 `mkdtempSync` call sites in 34
// test files.** The same run after BLZ-503 leaves zero.
//
// Nothing about 299 directories is dangerous on its own. What it costs is the ability to
// read `/tmp` at all: BLZ-485's mutation runner asserts ZERO leftover `/tmp/blz-mutate-*` as
// the evidence its teardown works, and a corpus that litters 299 a run trains everyone
// reading that assertion to treat litter as background noise.
//
// THE COVERED LIST BELOW IS THE CLAIM. It is written out, not globbed: a list that
// discovered its own members could shrink to nothing and still pass, and the point of this
// file is to be able to say exactly which suites are held to the property. It is the 34
// files BLZ-503 fixed plus `board-overstatement-guards.test.mjs`, which BLZ-491 fixed and
// proved with its own hand-written copy of this proof — that copy is gone now, and the suite
// is covered here with the rest.
//
// Adding a suite to this list is how a suite opts in. Nothing here polices a suite that is
// not on it; the corpus-wide gate is the run-level scan in CI, which sees every suite.
import { proveNoLeak } from "./helpers/no-leak.mjs";

/** Every suite held to "mints nothing it does not remove", named one per line so a removal
 *  from this list is a visible line in a diff rather than a pattern that stopped matching. */
export const COVERED = [
  "tests/audit-terminal-goal-unverified.test.mjs",
  "tests/board-overstatement-guards.test.mjs", // BLZ-491's suite, 356 directories when found
  "tests/config.test.mjs",
  "tests/db-runner.test.mjs",
  "tests/edit.test.mjs",
  "tests/event-actor.test.mjs",
  "tests/identity-resilience.test.mjs",
  "tests/init.test.mjs", //                       20 × "blaze-init-"
  "tests/live-unreadable-on-the-seam.test.mjs",
  "tests/migrate/date-migration-oracle.test.mjs",
  "tests/migrate/load-corpus.test.mjs",
  "tests/migrate/oracle-field-coverage.test.mjs", // 23 × "ofc-"
  "tests/migrate/transitions-and-oracle.test.mjs",
  "tests/model/db-schema-version.test.mjs",
  "tests/model/derived-dates-not-editable.test.mjs",
  "tests/model/graph.test.mjs",
  "tests/model/import-mapping.test.mjs",
  "tests/model/index-cache.test.mjs",
  "tests/model/index-fs-hatches.test.mjs",
  "tests/model/read-seam-projection.test.mjs", //    29 × "seam-" and four siblings
  "tests/model/read-seam.test.mjs", //               22 × "blaze-readseam-" and two siblings
  "tests/model/storage.test.mjs",
  "tests/model/torn-line-parked-recovery.test.mjs",
  "tests/model/write-port.test.mjs",
  "tests/schedule-runner.test.mjs",
  "tests/serve-endpoints.test.mjs",
  "tests/serve-host.test.mjs",
  "tests/serve-identity.test.mjs", //                18 × "blaze-identity-"
  "tests/serve-standalone-entry.test.mjs",
  "tests/user-add.test.mjs",
  "tests/verbs-dual-write.test.mjs",
  "tests/views/data.test.mjs",
  "tests/views/page-golden.test.mjs",
  "tests/views/page.test.mjs",
  "tests/write-port-resolve.test.mjs",
];

// The floor is well under the ~580 these suites carry between them, so it catches a run that
// did not happen without pinning a count that ordinary work moves.
proveNoLeak({
  label: "BLZ-503/517: a suite removes every scratch directory it mints",
  suites: COVERED,
  minTests: 400,
});
