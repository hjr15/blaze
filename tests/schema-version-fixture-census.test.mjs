// tests/schema-version-fixture-census.test.mjs — BLZ-487.
//
// BLZ-479 recorded a removed-key census inside `scripts/model/schema-version.mjs` as a
// comment — "24 files / 0 null-valued / 10 string-valued" — over every `blaze.config.json`
// on the author's disk. It was stale before the review finished: a reviewer with extra
// review worktrees checked out counted 34, because each additional `blaze` checkout adds
// this repo's whole fixture corpus to the population again. Neither figure is wrong; the
// figure is simply not a property of anything, which is what ADR-0024 rules against —
// a number that self-invalidates has to name a basis that reproduces, or say plainly that
// it is one machine at one moment.
//
// That census splits into two halves with different standing, and this file exists to
// separate them:
//
//   - the WHOLE-FILESYSTEM total is unreproducible by construction. Its population is the
//     reader's checkout layout. It stays in the comment as a dated observation with the
//     command that produced it, and nothing here pins it — a test that asserted "24 files
//     under ~/Documents/Code" would fail on any other machine, including CI, and would be
//     asserting something about a directory the repository does not own.
//   - the PER-CHECKOUT contribution is a property of THIS repository, is derived from the
//     fixture corpus, and is pinned here. It is also what makes the total re-derivable:
//     every blaze checkout contributes exactly this, so a reader who counts 34 rather than
//     24 can account for the difference instead of concluding the record is wrong.
//
// The assertions run in both directions. The counts are derived from the fixture files, and
// the comment in `schema-version.mjs` is then read back and required to state the derived
// numbers — so the half of BLZ-479's census that CAN be kept honest is kept honest by the
// suite rather than by whoever next remembers to re-run the find.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { REMOVED_KEYS } from "../scripts/model/schema-version.mjs";

const REPO = join(import.meta.dirname, "..");
const FIXTURES = join(REPO, "tests", "fixtures");

/** Every checked-in fixture board's config, by fixture directory name. */
function fixtureConfigs() {
  const out = [];
  for (const name of readdirSync(FIXTURES).sort()) {
    const file = join(FIXTURES, name, "blaze.config.json");
    if (!existsSync(file)) continue;
    out.push({ name, cfg: JSON.parse(readFileSync(file, "utf8")) });
  }
  return out;
}

/** The same predicate `checkSchemaVersion` uses: `!== undefined`, so an explicit JSON
 *  `null` counts as SET. Deliberately not imported from the guard — reading the subject
 *  under test for the ground truth is the defect ADR-0026's round 1 is about — but it is
 *  the same rule, and the test below pins that the two agree on the corpus. */
const setKeys = (cfg) => Object.keys(REMOVED_KEYS).filter((k) => cfg && cfg[k] !== undefined);

describe("BLZ-487: this repository's own contribution to the removed-key census, derived", () => {
  test("exactly one fixture board sets a removed key, and it is board-gate-removed-key", () => {
    const fixtures = fixtureConfigs();
    assert.ok(fixtures.length > 0, "no fixture configs were found — this census is vacuous");
    const carriers = fixtures.filter((f) => setKeys(f.cfg).length);
    assert.deepEqual(carriers.map((f) => f.name), ["board-gate-removed-key"],
      "the fixture corpus's removed-key population changed. That is fine, but the census in "
      + "scripts/model/schema-version.mjs is derived from it and must be updated with it");
  });

  test("its value is a STRING, not a null — the null spelling has no example on disk", () => {
    // BLZ-429's change was to the `null` SPELLING. The census exists to say what that
    // spelling newly refuses, and the answer is: nothing on this corpus, because nothing on
    // this corpus is spelled that way. Asserted rather than assumed, because "0 null-valued"
    // is the load-bearing figure of the whole census and the one a reader is most likely to
    // read as "0 affected".
    const nulls = fixtureConfigs()
      .filter((f) => Object.keys(REMOVED_KEYS).some((k) => f.cfg && f.cfg[k] === null));
    assert.deepEqual(nulls.map((f) => f.name), [],
      "a fixture now sets a removed key to null — the census's `0 null-valued` is stale");
    const carrier = fixtureConfigs().find((f) => f.name === "board-gate-removed-key");
    assert.equal(typeof carrier.cfg.provider, "string",
      "board-gate-removed-key's `provider` is no longer a string");
  });

  test("the census comment states the numbers derived here, so it cannot silently go stale", () => {
    const fixtures = fixtureConfigs();
    const carriers = fixtures.filter((f) => setKeys(f.cfg).length).length;
    const src = readFileSync(join(REPO, "scripts", "model", "schema-version.mjs"), "utf8");
    const m = /(\d+) fixture boards, of which (\d+) sets? a removed key\b.*?and (\d+) sets? one to null/s
      .exec(src);
    assert.ok(m, "the per-checkout census sentence is missing from schema-version.mjs — it is "
      + "the half of BLZ-479's figure that reproduces, and it must be stated where the guard is");
    assert.equal(Number(m[1]), fixtures.length, "the comment's fixture-board count is stale");
    assert.equal(Number(m[2]), carriers, "the comment's removed-key fixture count is stale");
    assert.equal(Number(m[3]), 0, "the comment claims a null-valued fixture; there is none");
  });

  test("the comment dates its unreproducible half and gives the command that reproduces it", () => {
    // What ADR-0024 actually requires of a figure that self-invalidates: not that it be
    // suppressed, but that it name its basis. A sha is the basis for a board measurement;
    // for a measurement of somebody's home directory the basis is a date and a command.
    const src = readFileSync(join(REPO, "scripts", "model", "schema-version.mjs"), "utf8");
    assert.match(src, /NOT REPRODUCIBLE/,
      "the whole-disk figure must be labelled as such — it is a count of the reader's "
      + "checkout layout, and BLZ-487 exists because it was read as a fixed property");
    assert.match(src, /\bfind\b[^\n]*-name blaze\.config\.json/,
      "the comment must carry the command that produced the whole-disk figure, so a reader "
      + "who gets a different number can tell a changed disk from a changed engine");
    assert.match(src, /\b20\d\d-\d\d-\d\d\b/, "the observation must carry its date");
  });
});
