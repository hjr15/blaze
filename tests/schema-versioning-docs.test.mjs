// tests/schema-versioning-docs.test.mjs — BLZ-356.
//
// `docs/schema-versioning.md` is the document the engine's own error message points users at:
// `checkSchemaVersion`'s refusal embeds a link to it. So when a board is rejected, the operator
// follows that link to learn which versions this engine speaks — which is exactly the case where
// the number has to be right.
//
// It was not. BLZ-298 bumped SCHEMA_VERSION to 2 (it removed three config keys, a breaking
// contract change) and the doc's constants table was never updated, so the doc claimed 1 while
// the live error message printed "(supported: 1..2)" beside it.
//
// A prose fix alone would drift again on the next bump. This test makes the doc a checked
// artefact: the table is parsed and asserted against the imported constants, so the two cannot
// disagree without a red test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, MIN_SCHEMA_VERSION } from "../scripts/model/schema-version.mjs";
import { DB_SCHEMA_VERSION, MIN_DB_SCHEMA_VERSION } from "../scripts/model/db-schema-version.mjs";

const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "schema-versioning.md");

/** The value cell of a `| \`NAME\` | \`n\` | ... |` row in the constants table. */
function documentedValue(text, name) {
  const row = new RegExp(`^\\|\\s*\`${name}\`\\s*\\|\\s*\`(\\d+)\`\\s*\\|`, "m").exec(text);
  return row ? Number(row[1]) : null;
}

test("BLZ-356: the documented SCHEMA_VERSION matches the constant", () => {
  const documented = documentedValue(readFileSync(DOC, "utf8"), "SCHEMA_VERSION");
  assert.notEqual(documented, null, "the constants table must carry a SCHEMA_VERSION row");
  assert.equal(documented, SCHEMA_VERSION,
    `docs/schema-versioning.md says SCHEMA_VERSION is ${documented}, the code says ${SCHEMA_VERSION}`);
});

test("BLZ-356: the documented MIN_SCHEMA_VERSION matches the constant", () => {
  const documented = documentedValue(readFileSync(DOC, "utf8"), "MIN_SCHEMA_VERSION");
  assert.notEqual(documented, null, "the constants table must carry a MIN_SCHEMA_VERSION row");
  assert.equal(documented, MIN_SCHEMA_VERSION,
    `docs says MIN_SCHEMA_VERSION is ${documented}, the code says ${MIN_SCHEMA_VERSION}`);
});

test("BLZ-356: the doc does not claim there is nothing to migrate once past version 1", () => {
  // The Policy section said "at version 1 there is nothing to migrate". That was true when it
  // was written and false from BLZ-298 onward. Pinned because it is the sentence an operator
  // reads to decide whether a bump needs a migration path.
  const text = readFileSync(DOC, "utf8");
  if (SCHEMA_VERSION > 1) {
    assert.doesNotMatch(text, /at version 1 there is nothing\s+to migrate/,
      "SCHEMA_VERSION is past 1, so this claim is stale");
  }
});

// --- BLZ-377 -----------------------------------------------------------------
// The section below "The DATABASE schema is a different number" carried its version in
// PROSE — "Both are 3 as of BLZ-390" — with nothing checking it. That is the same gap
// BLZ-356 closed for the config version's constants table, one section higher in the same
// document, and it went stale the moment this ticket bumped the number. An operator reads
// this section after a refusal, which is exactly when it has to be right.

test("BLZ-377: the doc's DB schema version matches the constant", () => {
  const text = readFileSync(DOC, "utf8");
  const m = /\*\*Both are (\d+) as of ([A-Z]+-\d+)\.\*\*/.exec(text);
  assert.notEqual(m, null,
    'the DB-schema section must carry a "**Both are N as of TICKET.**" sentence');
  assert.equal(Number(m[1]), DB_SCHEMA_VERSION,
    `docs/schema-versioning.md says the DB schema version is ${m[1]}, the code says ${DB_SCHEMA_VERSION}`);
  assert.equal(DB_SCHEMA_VERSION, MIN_DB_SCHEMA_VERSION,
    'the doc says "both are N", so this claim only holds while the two constants agree — '
    + `they are ${DB_SCHEMA_VERSION} and ${MIN_DB_SCHEMA_VERSION}`);
});

test("BLZ-377: the doc names every version an operator can actually be refused for", () => {
  // The refusal message enumerates the stranded versions by number. A doc that stops naming
  // one leaves the operator who hit it with no entry to look up.
  const text = readFileSync(DOC, "utf8");
  for (let v = 1; v < MIN_DB_SCHEMA_VERSION; v++) {
    assert.ok(new RegExp(`\\b${v}\\b`).test(text),
      `version ${v} is below the floor and can be refused, but the doc never names it`);
  }
});
