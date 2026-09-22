// tests/helpers/scratch.mjs — BLZ-503.
//
// A SCRATCH DIRECTORY IS REMOVED BY THE FILE THAT MINTED IT, WHATEVER THE RUN DID.
//
// BLZ-491 fixed one suite (`tests/board-overstatement-guards.test.mjs`, 356 leftover
// `/tmp/blz-guards-board-*` directories) and, while doing it, established the shape: a
// file-level list of everything minted plus one `after()` hook that empties it. BLZ-503
// measured the rest of the corpus against a redirected `TMPDIR` — 299 directories per full
// run, from 56 call sites in 34 files — and this is that shape extracted so those files
// share one hook instead of each growing its own.
//
// WHY A REGISTRY AND NOT `t.after()` AT THE CALL SITE. Almost every leaking site is inside a
// per-file seed helper (`seedFs()`, `loaded()`, `tinyBoard()`) that no test handle reaches:
// the helper is called from the test body, so there is no `t` in scope without changing
// every caller. The registry needs nothing from the caller but the directory it just made.
//
// WHY NOT A TRAILING `rmSync` IN THE TEST. A failing assertion earlier in the test throws
// before a trailing statement runs, so cleanup written that way is skipped exactly on the
// red runs where a clean machine matters most — that is BLZ-603's finding, and
// `scripts/ci/temp-cleanup-guard.mjs` scans for it. `after()` runs either way.
//
// WHY THE WRAPPER GOES OUTSIDE `mkdtempSync`, NEVER INSIDE. `tests/tmp-scratch-attribution.test.mjs`
// requires the prefix at a `mkdtempSync` call to be a STATICALLY READABLE literal, so a
// leftover directory still names the suite that made it. Writing
// `scratch(mkdtempSync(join(tmpdir(), "seam-")))` leaves that literal exactly where the scan
// reads it; moving the prefix into a variable to shorten the line would pass locally and
// redden the attribution guard on merge.
//
//     import { scratchRegistry } from "./helpers/scratch.mjs";
//     const scratch = scratchRegistry();
//     const dir = scratch(mkdtempSync(join(tmpdir(), "seam-")));
import { after } from "node:test";
import { rmSync } from "node:fs";

/** A `scratch(dir)` function that records `dir` and returns it unchanged, plus the `after()`
 *  hook that removes everything recorded once the file's tests are done.
 *
 *  Call it ONCE per test file, at module scope — the hook is registered at call time, and a
 *  registry made inside a test would register a hook the runner has already passed.
 *
 *  Removal is `force: true` on purpose: a test that removes its own directory early, or one
 *  that never got as far as writing into it, must not turn teardown into a second failure. */
export function scratchRegistry() {
  const made = [];
  after(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
    made.length = 0;
  });
  return (dir) => {
    made.push(dir);
    return dir;
  };
}
