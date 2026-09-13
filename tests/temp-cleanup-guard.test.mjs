// tests/temp-cleanup-guard.test.mjs — BLZ-603.
//
// Pins two things, and is careful about which is which.
//
//  1. THE SCANNER DISCRIMINATES. `scripts/ci/temp-cleanup-guard.mjs` reports a cleanup call
//     that a failing assertion would skip, and does NOT report the same call once it is in
//     an `after` hook or a `finally`. A scanner that reported everything, or nothing, would
//     hold the ratchet below at a number that means nothing.
//
//  2. THE TWO FILES THIS TICKET FIXED STAY FIXED, AND NOTHING ELSE GETS WORSE. The corpus
//     carries hundreds of pre-existing sites of this shape; they are recorded per file in
//     `scripts/ci/temp-cleanup-debt.json` and held to EQUALITY here.
//
// WHAT IS NOT PINNED. The scanner is a line scanner. Cleanup performed inside a helper
// function that a test calls is invisible to it, and so is a cleanup call written across
// several lines. Those are not counted, are not claimed to be counted, and the last test
// in this file proves the blind spot is real rather than leaving the number looking total.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TESTS_DIR, compareToDebt, readDebt, scanCorpus, scanSource,
} from "../scripts/ci/temp-cleanup-guard.mjs";

const UNGUARDED = `
import { test } from "node:test";
test("a", () => {
  const root = mkdtempSync(join(tmpdir(), "x-"));
  assert.equal(1, 1);
  rmSync(root, { recursive: true, force: true });
});
`;

test("BLZ-603: cleanup as the last statement of a test is reported", () => {
  const found = scanSource(UNGUARDED);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].text, /rmSync/);
});

test("BLZ-603: the same cleanup in t.after() is not reported", () => {
  const guarded = UNGUARDED
    .replace('  rmSync(root, { recursive: true, force: true });\n', "")
    .replace('test("a", () => {', 'test("a", (t) => {\n  t.after(() => rmSync(root, { recursive: true, force: true }));');
  assert.deepEqual(scanSource(guarded), []);
});

test("BLZ-603: the same cleanup in a finally block is not reported", () => {
  const guarded = `
import { test } from "node:test";
test("a", () => {
  const root = mkdtempSync(join(tmpdir(), "x-"));
  try {
    assert.equal(1, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
`;
  assert.deepEqual(scanSource(guarded), []);
});

test("BLZ-603: cleanup BEFORE the first assertion is not reported — no assertion can skip it", () => {
  const setup = `
import { test } from "node:test";
test("a", () => {
  rmSync(stale, { recursive: true, force: true });
  assert.equal(1, 1);
});
`;
  assert.deepEqual(scanSource(setup), []);
});

test("BLZ-534/603: a trailing await s.close?.() is the same defect and is reported", () => {
  // This is the shape that hung the suite: the trailing call released a Postgres client,
  // and a `node --test` child holding a live socket cannot exit.
  const src = `
import { test } from "node:test";
test("a", async () => {
  const s = await openPostgresRead(PG);
  assert.equal(1, 1);
  await s.close?.();
});
`;
  assert.equal(scanSource(src).length, 1);
});

test("BLZ-603: tests/commit-settled-drain.test.mjs — the file the ticket names — has none left", () => {
  const src = readFileSync(join(TESTS_DIR, "commit-settled-drain.test.mjs"), "utf8");
  assert.deepEqual(scanSource(src), [],
    "every scratch repo and linked worktree in this file must be removed by a hook, not by "
    + "a statement a failing assertion skips");
});

test("BLZ-534: tests/model/driver-conformance.test.mjs closes its drivers from a hook", () => {
  const src = readFileSync(join(TESTS_DIR, "model", "driver-conformance.test.mjs"), "utf8");
  assert.deepEqual(scanSource(src), [],
    "a Postgres client left open by a failing assertion is BLZ-534's hang, reproducible on "
    + "demand with BLAZE_TEST_PG_URL set");
});

test("BLZ-603: the recorded debt is exactly what the corpus has — no new site, no stale entry", () => {
  const { regressions, fixed } = compareToDebt(scanCorpus(), readDebt());
  assert.deepEqual(regressions, [],
    "a test gained cleanup that a failing assertion would skip. Put it in t.after() or a "
    + "finally. If it genuinely belongs where it is, re-record with "
    + "`node scripts/ci/temp-cleanup-guard.mjs --write` and say why in the commit.");
  assert.deepEqual(fixed, [],
    "a file was cleaned up but scripts/ci/temp-cleanup-debt.json still claims the old count "
    + "— re-record it with `node scripts/ci/temp-cleanup-guard.mjs --write`");
});

test("BLZ-603: the debt is a real backlog, not an empty gesture", () => {
  // If this ever reaches zero the ratchet has done its job and the file can go. Until then
  // a debt file that had quietly emptied itself would mean the scanner had stopped working,
  // which is the failure this asserts against.
  const debt = readDebt();
  const total = Object.values(debt).reduce((a, b) => a + b, 0);
  assert.ok(total > 0 && Object.keys(debt).length > 0,
    "an empty debt file means either the corpus is clean — delete this guard and say so — "
    + "or the scanner stopped finding anything, which is the same as no guard at all");
});

test("BLZ-603: STATED LIMIT — cleanup inside a helper the test calls is NOT detected", () => {
  // Not a defect to fix here, but it must not be discovered later as a surprise: the count
  // above is a floor, not a total.
  const viaHelper = `
import { test } from "node:test";
function teardown(root) { rmSync(root, { recursive: true, force: true }); }
test("a", () => {
  const root = mkdtempSync(join(tmpdir(), "x-"));
  assert.equal(1, 1);
  teardown(root);
});
`;
  assert.deepEqual(scanSource(viaHelper), [],
    "if this ever starts reporting, the scanner grew reach and the debt file must be "
    + "re-recorded — the number would no longer mean what it meant when it was written");
});
