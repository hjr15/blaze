// tests/model/link-schema.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { linkDdl, DEFAULT_LINK_TYPES } from "../../scripts/model/link-schema.mjs";

describe("the default link types encode the standards document's table", () => {
  test("all five trace links are present with the right endpoints", () => {
    const by = Object.fromEntries(DEFAULT_LINK_TYPES.map(t => [t.name, t]));
    assert.deepEqual(by.Implements.source_kinds, ["feature"]);
    assert.deepEqual(by.Implements.target_kinds, ["requirement"]);
    assert.deepEqual(by.Addresses.source_kinds, ["architecture"]);
    assert.deepEqual(by.Addresses.target_kinds, ["requirement"]);
    assert.deepEqual(by.Verifies.source_kinds.sort(), ["feature", "story"]);
    assert.deepEqual(by.Supersedes.source_kinds, ["architecture"]);
    assert.deepEqual(by.Supersedes.target_kinds, ["architecture"]);
    assert.deepEqual(by.Derives.source_kinds, ["requirement"]);
  });

  test("EVERY link type carries an inverse name", () => {
    // The matrix must read correctly in both directions without a second table.
    for (const t of DEFAULT_LINK_TYPES) {
      assert.ok(t.inverse_name && t.inverse_name !== t.name, `${t.name} has no distinct inverse`);
    }
  });

  test("both dialects declare the same columns", () => {
    const cols = (sql) => [...sql.matchAll(/^\s{2}([a-z_]+)\s+/gm)].map(m => m[1]);
    assert.deepEqual(cols(linkDdl("sqlite")).sort(), cols(linkDdl("postgres")).sort());
  });
});
