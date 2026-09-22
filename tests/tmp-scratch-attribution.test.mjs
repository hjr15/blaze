// tests/tmp-scratch-attribution.test.mjs — BLZ-491.
//
// A LEAKED DIRECTORY IS ATTRIBUTABLE TO THE TEST THAT MADE IT.
//
// `tests/board-overstatement-guards.test.mjs` minted a `/tmp/blz-guards-board-*` directory in
// `tinyBoard()` on four call sites and removed none of them — 356 were on this machine when
// the fix was written, against 276 counted by the review that raised it. Cleaning one suite
// fixes one suite. What made the leak cost anything is that `/tmp` noise is indistinguishable
// from a real leak — and BLZ-485's mutation runner now asserts ZERO leftover
// `/tmp/blz-mutate-*` as the evidence its teardown works, so a corpus that litters
// anonymously trains the reader of that assertion to ignore litter.
//
// `mkdtempSync(join(tmpdir(), PREFIX))` returns PREFIX plus exactly six characters, so a
// leftover directory names its author precisely when the prefix belongs to one test file.
// `scripts/ci/tmp-scratch-attribution.mjs` scans for that and the tests below pin it, in the
// shape the oracles here use: the scan's own SIZE is asserted, every call site lands in a
// named bucket, and the bucket for "this scan could not read it" is asserted EMPTY rather
// than skipped. A scan that silently dropped what it could not parse would report a clean
// registry over a corpus it never read, which is the failure mode being closed.
//
// THE OTHER HALF OF BLZ-491 MOVED. This file also carried a hand-written proof that the
// guards suite leaves an empty `TMPDIR` behind. BLZ-503 fixed 34 more suites and BLZ-517
// extracted that proof into `tests/helpers/no-leak.mjs`; the guards suite is covered there,
// with the rest, in `tests/scratch-cleanup.test.mjs`. What remains here is the static
// property — which is what gates a NEW suite's prefix on every run.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { scanScratchSites, attributeScratch, MKDTEMP_SUFFIX, SITE_BUCKETS }
  from "../scripts/ci/tmp-scratch-attribution.mjs";

const REPO = join(import.meta.dirname, "..");
const TESTS = join(REPO, "tests");
const SCAN = scanScratchSites(TESTS);

describe("BLZ-491: a leaked scratch directory names the test file that made it", () => {
  test("every mkdtempSync call under tests/ lands in a named bucket — nothing is dropped", () => {
    // The oracle's own size, asserted before anything is concluded from it. A scan that
    // matched nothing would satisfy every other assertion in this block.
    assert.ok(SCAN.sites.length >= 450,
      `only ${SCAN.sites.length} mkdtempSync call sites found under tests/ — the scan is not reading the corpus`);
    assert.ok(SCAN.prefixes.size >= 390,
      `only ${SCAN.prefixes.size} scratch prefixes registered from ${SCAN.sites.length} call sites`);
    assert.deepEqual(SCAN.unaccounted.map((s) => `${s.file.slice(REPO.length + 1)}:${s.line}  ${s.text}`), [],
      "every mkdtempSync call must be readable by the scan. A call whose prefix cannot be " +
      "read statically — `join(tmpdir(), someVariable)` — mints a directory nothing can " +
      "attribute, so it is a failure here rather than a silent omission from the registry");
    for (const s of SCAN.sites) {
      assert.ok(SITE_BUCKETS.includes(s.bucket),
        `${s.file}:${s.line} landed in the unnamed bucket ${JSON.stringify(s.bucket)}`);
    }
    const named = SCAN.sites.filter((s) => s.bucket === "literal" || s.bucket === "template");
    assert.equal(named.length, SCAN.sites.filter((s) => s.prefix !== null).length,
      "a site carrying a prefix and a site in a prefix-bearing bucket must be the same set");
  });

  test("no scratch prefix is claimed by more than one test file", () => {
    assert.deepEqual(SCAN.ambiguous.map(([p, files]) =>
      `"${p}" ← ${files.map((f) => f.slice(REPO.length + 1)).join(" , ")}`), [],
    "a prefix two suites share makes a leak from either of them unattributable, which is " +
    "exactly the property this ticket exists to establish. Give the newer suite its own prefix");
  });

  test("every registered prefix attributes a leaked directory back to exactly one file", () => {
    // The property itself, exercised over the whole registry rather than asserted about it,
    // and with the counter bound to the registry's size so a prefix that stopped resolving
    // takes the count with it instead of quietly not being checked.
    let attributed = 0;
    for (const [prefix, { files }] of SCAN.prefixes) {
      const leak = `${prefix}${"Ab12Cd".slice(0, MKDTEMP_SUFFIX)}`;
      assert.equal(attributeScratch(leak, SCAN.prefixes), files[0],
        `/tmp/${leak} must resolve to the one suite that mints "${prefix}"`);
      attributed += 1;
    }
    assert.equal(attributed, SCAN.prefixes.size,
      "every prefix in the registry must have been exercised, not a subset of them");
  });

  test("a directory no prefix explains is reported unattributable rather than guessed", () => {
    // The other half of the same property: attribution that answered for everything would
    // name a suite for every stray file in `/tmp`, and a wrong owner is worse than none.
    assert.equal(attributeScratch("systemd-private-9f2c", SCAN.prefixes), null);
    assert.equal(attributeScratch("", SCAN.prefixes), null);
    const [prefix] = [...SCAN.prefixes.keys()];
    assert.equal(attributeScratch(prefix, SCAN.prefixes), null,
      "the prefix alone is not a mkdtemp name — the suffix is exactly six characters");
    assert.equal(attributeScratch(`${prefix}toolongtobesix`, SCAN.prefixes), null,
      "…and matching on prefix alone is what makes one registered prefix shadow another " +
      "that merely extends it");
  });

  test("a prefix that merely extends another still attributes to its own file", () => {
    // `blz-guards-` and `blz-guards-board-` are both registered, by the same suite here, and
    // the rule that keeps them apart is LENGTH. Checked on a constructed registry so it is
    // the rule under test rather than today's corpus.
    const registry = new Map([
      ["a-", { files: ["tests/one.test.mjs"], exact: true }],
      ["a-b-", { files: ["tests/two.test.mjs"], exact: true }],
    ]);
    assert.equal(attributeScratch("a-Ab12Cd", registry), "tests/one.test.mjs");
    assert.equal(attributeScratch("a-b-Ab12Cd", registry), "tests/two.test.mjs");
  });
});
