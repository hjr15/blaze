// tests/model/torn-line-parked-recovery.test.mjs — BLZ-641 T4.
//
// docs/design/csv-import-and-export.md's receipt-repair protocol (not yet built — C1 is
// filed as "gap — new ticket" in the design's own ticket breakdown; nothing under scripts/
// implements `blaze import repair` or the receipt format yet) commits to two properties for
// parking a torn line on a receipt:
//
//   1. the trailing `\n` that closes a torn fragment is appended ONLY when the receipt does
//      not already end with one — so a `repair --apply` resumed after a kill between that
//      append and the next never glues a second `\n` onto a file that already ends cleanly;
//   2. `torn-line-parked` is the outcome of every park operation on the receipt, not only a
//      last-line fragment — this test exercises the common case (a crash mid-append leaves a
//      trailing fragment), which is the one the design's own prose walks through.
//
// Since the repair verb doesn't exist yet, this test pins the documented protocol directly
// against the primitive the design names for it — `appendRegularFileSync`
// (scripts/model/regular-file.mjs) — so the eventual C1 implementation inherits an executable
// spec rather than prose alone, and a "kill mid-recovery" scenario is proven safe today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRegularFileSync } from "../../scripts/model/regular-file.mjs";
import { scratchRegistry } from "../helpers/scratch.mjs";

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

const tornLineParkedEntry = () =>
  `${JSON.stringify({ phase: "resolved", seq: null, state: "torn-line-parked" })}\n`;

// The design's protocol, park -> close -> mark, exactly as
// docs/design/csv-import-and-export.md's "A torn line on the receipt itself..." paragraph
// states it. Split into three calls so the test can kill "the process" between any two.
function parkFragment(corruptPath, fragment) {
  appendRegularFileSync(corruptPath, fragment);
}
function closeTornLine(receiptPath) {
  // Idempotent by construction: only append `\n` when the receipt doesn't already end with
  // one, so re-running this after a kill never glues a second `\n` onto a closed line.
  if (!readFileSync(receiptPath, "utf8").endsWith("\n")) appendRegularFileSync(receiptPath, "\n");
}
function markParked(receiptPath) {
  appendRegularFileSync(receiptPath, tornLineParkedEntry());
}

test("BLZ-641 T4: a kill between the receipt's \\n append and the torn-line-parked append still recovers cleanly", () => {
  const root = scratch(mkdtempSync(join(tmpdir(), "blaze-torn-receipt-")));
  const receiptPath = join(root, "2026-09-20T00-00-00-canonical.jsonl");
  const corruptPath = `${receiptPath}.corrupt`;
  const goodLine = `${JSON.stringify({ seq: 1, phase: "done", id: "BLZ-1" })}\n`;
  const fragment = '{"seq":2,"phase":"in'; // torn mid-append: no trailing newline
  writeFileSync(receiptPath, goodLine + fragment);

  // Step 1 of repair --apply: park the fragment's raw bytes. The receipt itself is never
  // truncated — it is evidence — so the fragment stays exactly where it is.
  parkFragment(corruptPath, fragment);
  assert.equal(readFileSync(corruptPath, "utf8"), fragment);

  // Step 2: close the torn line with a single `\n`.
  closeTornLine(receiptPath);
  assert.equal(readFileSync(receiptPath, "utf8"), `${goodLine}${fragment}\n`,
    "the fragment must be closed with one newline, not truncated");

  // SIMULATED KILL — the process dies here, between the `\n` append and the
  // `torn-line-parked` append, before markParked() ever runs.

  // Resume: a fresh `repair --apply` re-examines the receipt and re-runs closeTornLine
  // first, as it must (it cannot know from the receipt alone whether the previous run got
  // as far as the `\n`). Per the design this must be a no-op the second time.
  const beforeResume = readFileSync(receiptPath, "utf8");
  closeTornLine(receiptPath);
  assert.equal(readFileSync(receiptPath, "utf8"), beforeResume,
    "resuming after the kill must not append a second \\n onto an already-closed line");

  // Recovery completes: the torn-line-parked marker is appended, exactly once.
  markParked(receiptPath);
  const finalLines = readFileSync(receiptPath, "utf8").split("\n").filter(Boolean);
  assert.equal(finalLines.length, 3, "good line + closed fragment + torn-line-parked marker, no duplicates");
  assert.deepEqual(JSON.parse(finalLines[2]), { phase: "resolved", seq: null, state: "torn-line-parked" });
  assert.equal(existsSync(corruptPath), true, "the parked fragment's raw bytes remain as evidence");
});
