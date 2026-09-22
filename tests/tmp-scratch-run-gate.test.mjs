// tests/tmp-scratch-run-gate.test.mjs — BLZ-516.
//
// THE RUN-LEVEL SCAN GATES SOMETHING, OR IT SHOULD NOT EXIST.
//
// `scripts/ci/tmp-scratch-attribution.mjs` came out of BLZ-491 carrying two halves. The
// STATIC half — every `mkdtempSync` prefix is a readable literal, and no two suites share
// one — is asserted on every run by `tests/tmp-scratch-attribution.test.mjs`. The DYNAMIC
// half, the count of directories actually left on a machine, was a CLI nobody ran. A number
// nothing reads is not a gate; it is a number.
//
// BLZ-516's choice was to gate it rather than delete it, because the two checks that do
// gate leave a real hole between them. The static property says a leak would be
// ATTRIBUTABLE, not that there is none. The per-suite proof (BLZ-517) covers 35 suites BY
// NAME, and a suite added tomorrow is on neither list — it leaks, attributably, past both.
// The run-level count is the only check that sees a suite nobody opted in.
//
// WHAT MADE IT GATEABLE. The objection to gating it was `/tmp` noise: a shared `/tmp` holds
// other programs' directories, and a gate that counted those would fail on a machine's
// housekeeping. The answer is not a cleverer filter, it is a different directory — CI points
// `TMPDIR` at a fresh empty box, so everything in it arrived during the run. The
// attributed/unattributed split the scan already reports then means something precise:
// ATTRIBUTED entries are this corpus's leaks and count against the budget; UNATTRIBUTED ones
// are not this repo's business and are reported without counting. Both halves of that
// distinction are pinned below, because a gate that counted noise would be turned off within
// a week and a gate that counted nothing would never be noticed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { scanScratchSites, leftoverGate, MKDTEMP_SUFFIX }
  from "../scripts/ci/tmp-scratch-attribution.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const REPO = join(import.meta.dirname, "..");
const SCAN = scanScratchSites(join(REPO, "tests"));

// BLZ-503: every scratch directory this file mints, removed when the file is done with
// it. Registered rather than written as a test's trailing statement, so a failing
// assertion earlier in the test cannot skip it.
const scratch = scratchRegistry();

/** A box holding `names`, each an empty directory. */
function box(names) {
  const dir = scratch(mkdtempSync(join(tmpdir(), "blz516-box-")));
  for (const n of names) mkdirSync(join(dir, n));
  return dir;
}

/** A directory name a real leak from the first registered prefix would carry. */
const [FIRST_PREFIX] = [...SCAN.prefixes.keys()];
const leakName = (prefix) => `${prefix}${"Ab12Cd".slice(0, MKDTEMP_SUFFIX)}`;

describe("BLZ-516: the run-level leftover count is a gate, not a report", () => {
  test("a leftover a suite is responsible for fails the gate", () => {
    const where = box([leakName(FIRST_PREFIX)]);
    const v = leftoverGate({ where, registry: SCAN.prefixes, max: 0 });
    assert.equal(v.owned, 1, "the leak must be counted against the corpus, not shrugged off");
    assert.equal(v.failed, true);
    assert.equal(v.byOwner.size, 1, "…and the failure must name the suite that made it");
  });

  test("ordinary /tmp noise no registered prefix explains does NOT fail the gate", () => {
    // The whole objection to gating this scan. These are the shapes a real machine's
    // temp directory carries, and a gate that counted them would be switched off.
    const where = box(["systemd-private-9f2c", "node-compile-cache", ".X11-unix", "snap.firefox"]);
    const v = leftoverGate({ where, registry: SCAN.prefixes, max: 0 });
    assert.equal(v.owned, 0);
    assert.equal(v.failed, false, "unattributable entries are other programs' business");
    assert.deepEqual(v.orphans.sort(),
      [".X11-unix", "node-compile-cache", "snap.firefox", "systemd-private-9f2c"],
      "…but they are REPORTED, not silently discarded — a scan that dropped what it could " +
      "not place would look clean over a directory it never explained");
  });

  test("a plain file is not a scratch directory, whatever it is called", () => {
    const where = box([]);
    writeFileSync(join(where, leakName(FIRST_PREFIX)), "not a directory");
    const v = leftoverGate({ where, registry: SCAN.prefixes, max: 0 });
    assert.equal(v.owned, 0, "mkdtempSync makes directories; a file by that name is not its leak");
    assert.equal(v.failed, false);
  });

  test("the budget is a number the gate actually compares against", () => {
    const two = box([leakName(FIRST_PREFIX), `${FIRST_PREFIX}Zz99Yx`]);
    assert.equal(leftoverGate({ where: two, registry: SCAN.prefixes, max: 2 }).failed, false);
    assert.equal(leftoverGate({ where: two, registry: SCAN.prefixes, max: 1 }).failed, true);
    // No budget at all is a report, which is what the CLI did before this ticket.
    assert.equal(leftoverGate({ where: two, registry: SCAN.prefixes, max: null }).failed, false);
  });

  test("an empty box passes, which is the state CI asserts", () => {
    const v = leftoverGate({ where: box([]), registry: SCAN.prefixes, max: 0 });
    assert.equal(v.owned, 0);
    assert.equal(v.failed, false);
  });
});

describe("BLZ-516: the CLI is what CI runs, so the CLI is what is pinned", () => {
  const cli = join(REPO, "scripts", "ci", "tmp-scratch-attribution.mjs");

  test("--max 0 over a clean box exits 0", () => {
    const res = spawnSync(process.execPath, [cli, "--tmp", box([]), "--max", "0"],
      { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /budget/, "the run must say what budget it was held to");
  });

  test("--max 0 over a box holding one attributed leak exits 1 and names the suite", () => {
    const where = box([leakName(FIRST_PREFIX)]);
    const res = spawnSync(process.execPath, [cli, "--tmp", where, "--max", "0"],
      { encoding: "utf8" });
    assert.equal(res.status, 1, `the gate must FAIL the run:\n${res.stdout}`);
    assert.match(res.stdout, /1 leftover director/);
    const owner = SCAN.prefixes.get(FIRST_PREFIX).files[0].slice(REPO.length + 1);
    assert.ok(res.stdout.includes(owner),
      `the failure must name ${owner}, or the reader is back to guessing:\n${res.stdout}`);
  });

  test("without --max the CLI still just reports, and exits 0", () => {
    // Deliberate: run by hand on a real `/tmp`, this is a diagnostic, and a diagnostic that
    // exits nonzero over another program's directories is one nobody runs twice.
    const res = spawnSync(process.execPath, [cli, "--tmp", box([leakName(FIRST_PREFIX)])],
      { encoding: "utf8" });
    assert.equal(res.status, 0, res.stdout + res.stderr);
  });
});

describe("BLZ-516: CI runs the gate, against a box and not against /tmp", () => {
  const workflow = join(REPO, ".github", "workflows", "test.yml");

  test("the tests workflow points TMPDIR at a fresh box and runs the gate over it", () => {
    const src = readFileSync(workflow, "utf8");
    assert.match(src, /tmp-scratch-attribution\.mjs/,
      "the run-level scan must be wired into the tests workflow — an ungated scan is what " +
      "this ticket was opened about");
    assert.match(src, /--max 0/, "…with a budget, or it is a report again");
    assert.match(src, /TMPDIR/,
      "…and against a redirected TMPDIR, because on a shared /tmp the count is not this " +
      "repo's to answer for");
  });
});
