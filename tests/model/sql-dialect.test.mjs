// tests/model/sql-dialect.test.mjs — BLZ-331.
//
// The extraction's value is that two defect classes become unrepresentable. These tests
// assert exactly those, plus the one guard that only a shared table can enforce: EVERY
// schema module's SQLite DDL actually carries STRICT, including one added tomorrow.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dialect } from "../../scripts/model/sql-dialect.mjs";
import { artifactDdl, revisionDdl } from "../../scripts/model/artifact-schema.mjs";
import { baselineDdl } from "../../scripts/model/baseline-schema.mjs";
import { coverageDdl } from "../../scripts/model/coverage.mjs";
import { documentDdl } from "../../scripts/model/document-schema.mjs";
import { fieldDdl } from "../../scripts/model/field-schema.mjs";
import { hierarchyDdl } from "../../scripts/model/hierarchy-schema.mjs";
import { linkDdl } from "../../scripts/model/link-schema.mjs";
import { refClaimDdl } from "../../scripts/model/ref-claim-schema.mjs";

describe("the token table", () => {
  test("an unknown dialect throws rather than silently defaulting to sqlite", () => {
    assert.throws(() => dialect("mysql"), /unknown dialect "mysql"/);
    assert.throws(() => dialect(undefined), /unknown dialect/);
  });

  test("Postgres boolean literals are `true`/`false`, NEVER 1/0 — the defect that shipped 3x", () => {
    // `boolean NOT NULL DEFAULT 0` is rejected by Postgres: an untyped integer literal
    // does not implicitly cast to boolean. It passes every SQLite test, so it only ever
    // fails against a real database.
    const pg = dialect("postgres");
    assert.equal(pg.bool, "boolean");
    assert.equal(pg.true_, "true");
    assert.equal(pg.false_, "false");
    assert.notEqual(pg.true_, "1");
    assert.notEqual(pg.false_, "0");
  });

  test("SQLite has no boolean type, so its literals ARE 1/0", () => {
    const lite = dialect("sqlite");
    assert.equal(lite.bool, "INTEGER");
    assert.equal(lite.true_, "1");
    assert.equal(lite.false_, "0");
  });

  test("sqlite's table suffix is STRICT and postgres's is empty", () => {
    assert.equal(dialect("sqlite").tbl, " STRICT");
    assert.equal(dialect("postgres").tbl, "");
  });

  test("the returned table is not shared mutable state between callers", () => {
    // Two modules holding one object would let a stray assignment in module A change
    // module B's generated DDL.
    const a = dialect("sqlite");
    a.tbl = " NOT STRICT AT ALL";
    assert.equal(dialect("sqlite").tbl, " STRICT");
  });
});

// The guard that only a shared table can enforce. Omitting STRICT fails SILENTLY: without
// it a SQLite REAL column accepts the string 'oops' (ADR-0018's benchmark measured this),
// so nothing breaks until data is already wrong.
const V4_SCHEMAS = [
  ["artifactDdl", artifactDdl], ["revisionDdl", revisionDdl], ["baselineDdl", baselineDdl],
  ["coverageDdl", coverageDdl], ["documentDdl", documentDdl], ["fieldDdl", fieldDdl],
  ["hierarchyDdl", hierarchyDdl], ["linkDdl", linkDdl], ["refClaimDdl", refClaimDdl],
];

describe("every v4 schema module carries STRICT on every SQLite table", () => {
  for (const [name, fn] of V4_SCHEMAS) {
    test(`${name} — every CREATE TABLE is STRICT`, () => {
      const sql = fn("sqlite");
      const creates = sql.match(/CREATE TABLE[\s\S]*?;/g) ?? [];
      assert.ok(creates.length > 0, `${name} produced no CREATE TABLE to check`);
      for (const stmt of creates) {
        assert.match(stmt, /\)\s*STRICT;/, `${name}: a CREATE TABLE without STRICT — a REAL column would accept 'oops'`);
      }
    });

    test(`${name} — the Postgres form carries no STRICT`, () => {
      // The table SUFFIX specifically, not the word anywhere. `ON DELETE RESTRICT`
      // contains the substring, and hierarchy-schema.mjs has a comment explaining STRICT
      // — both are false alarms, not findings. What must never appear is the construct.
      assert.equal(/\)\s*STRICT\s*;/.test(fn("postgres")), false,
        `${name}: Postgres has no STRICT table suffix`);
    });

    test(`${name} — no Postgres boolean column defaults to a bare 0 or 1`, () => {
      assert.equal(/boolean NOT NULL DEFAULT [01]\b/.test(fn("postgres")), false,
        `${name}: Postgres rejects an untyped integer default on a boolean`);
    });
  }
});
