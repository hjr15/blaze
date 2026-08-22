// tests/model/matrix-filter.test.mjs — BLZ-334, spec §5: "Filterable by custom field on
// BOTH axes."
//
// buildMatrix takes rows and cols as pre-filtered arrays and has no filtering of its own,
// so "filterable by custom field" existed only if the caller happened to have done it —
// and a filter applied to rows only is the common half-implementation that makes the other
// axis a lie.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { filterByField } from "../../scripts/model/matrix-filter.mjs";

// A promoted field lives in a cf_ column; a non-promoted one lives in the JSON tail
// (BLZ-332). The caller must not need to know which.
const A = (ref, o = {}) => ({ id: ref, ref, kind: "requirement", project_key: "BLZ", ...o });
const DEFS = [
  { project_key: "BLZ", applies_to_kind: "requirement", key: "risk", data_type: "number", is_filterable: true },
  { project_key: "BLZ", applies_to_kind: "requirement", key: "owner", data_type: "text", is_filterable: false },
];

describe("a filter reads a promoted column or the JSON tail, transparently", () => {
  test("a PROMOTED field matches from its cf_ column", () => {
    const items = [A("REQ-001", { cf_risk: 7 }), A("REQ-002", { cf_risk: 1 })];
    const r = filterByField({ items, definitions: DEFS, filter: { key: "risk", equals: 7 } });
    assert.deepEqual(r.items.map((i) => i.ref), ["REQ-001"]);
  });

  test("a NON-promoted field matches from custom_fields", () => {
    const items = [A("REQ-001", { custom_fields: { owner: "ryan" } }),
                   A("REQ-002", { custom_fields: { owner: "sam" } })];
    const r = filterByField({ items, definitions: DEFS, filter: { key: "owner", equals: "ryan" } });
    assert.deepEqual(r.items.map((i) => i.ref), ["REQ-001"]);
  });

  test("custom_fields stored as JSON TEXT (the SQLite shape) reads the same", () => {
    // SQLite hands back a string where Postgres hands back an object. A filter that only
    // handles one engine's shape silently matches nothing on the other.
    const items = [A("REQ-001", { custom_fields: '{"owner":"ryan"}' }),
                   A("REQ-002", { custom_fields: '{"owner":"sam"}' })];
    const r = filterByField({ items, definitions: DEFS, filter: { key: "owner", equals: "ryan" } });
    assert.deepEqual(r.items.map((i) => i.ref), ["REQ-001"]);
  });

  test("an item missing the value is excluded, not included by accident", () => {
    const items = [A("REQ-001", { cf_risk: 7 }), A("REQ-002")];
    const r = filterByField({ items, definitions: DEFS, filter: { key: "risk", equals: 7 } });
    assert.deepEqual(r.items.map((i) => i.ref), ["REQ-001"]);
  });

  test("a NUMBER field matches its own string form — the engines disagree about which they return", () => {
    // REVERSED by BLZ-335 (C5). The original assertion (strict ===, no coercion) was WRONG:
    // Postgres `numeric` arrives from node-pg as a STRING and SQLite REAL as a number, so a
    // strict comparison matched on one engine and matched nothing on the other for identical
    // data. Both sides are now canonicalised by the field's declared data_type before
    // comparing — explicit and typed, not a loose ==.
    for (const stored of [7, "7"]) {
      for (const wanted of [7, "7"]) {
        assert.equal(
          filterByField({ items: [A("REQ-001", { cf_risk: stored })], definitions: DEFS,
                          filter: { key: "risk", equals: wanted } }).items.length, 1,
          `stored ${JSON.stringify(stored)} must match wanted ${JSON.stringify(wanted)}`);
      }
    }
    assert.equal(
      filterByField({ items: [A("REQ-001", { cf_risk: 7 })], definitions: DEFS,
                      filter: { key: "risk", equals: 8 } }).items.length, 0,
      "but a different number must still not match");
  });

  test("coercion is TYPED, not loose — a text field is not matched by a number's string form", () => {
    // The guard the reversed test above used to provide, kept: canonicalising by data_type
    // must not become a general `==`.
    const items = [A("REQ-001", { custom_fields: { owner: "7" } })];
    assert.equal(filterByField({ items, definitions: DEFS, filter: { key: "owner", equals: "7" } }).items.length, 1);
    assert.equal(filterByField({ items, definitions: DEFS, filter: { key: "owner", equals: "ryan" } }).items.length, 0);
  });

  test("a MISSING value never equals a supplied one, whatever the type", () => {
    const items = [A("REQ-001")];
    for (const [key, want] of [["risk", 0], ["owner", ""]]) {
      assert.equal(filterByField({ items, definitions: DEFS, filter: { key, equals: want } }).items.length, 0,
        `absent must not match ${JSON.stringify(want)}`);
    }
  });

  test("an UNKNOWN field key is REFUSED, naming it", () => {
    // Matching nothing and returning an empty matrix reads as a real result: "no
    // requirements are high-risk" rather than "you typed the field name wrong".
    const r = filterByField({ items: [A("REQ-001")], definitions: DEFS,
                              filter: { key: "nosuchfield", equals: 1 } });
    assert.equal(r.ok, false);
    assert.match(r.error, /nosuchfield/);
  });

  test("no filter returns every item untouched", () => {
    const items = [A("REQ-001"), A("REQ-002")];
    assert.deepEqual(filterByField({ items, definitions: DEFS, filter: null }).items, items);
  });

  test("a filter is scoped to the item kind's definitions", () => {
    const defs = [{ project_key: "BLZ", applies_to_kind: "architecture", key: "risk",
                    data_type: "number", is_filterable: true }];
    const r = filterByField({ items: [A("REQ-001")], definitions: defs,
                              filter: { key: "risk", equals: 1 }, kind: "requirement" });
    assert.equal(r.ok, false, "a field defined only for architecture is unknown to a requirement filter");
  });
});

// BLZ-337 — two gaps the suite accepted silently.
describe("BLZ-337: filter scoping and the empty-filter contract", () => {
  test("a same-named definition in ANOTHER PROJECT does not satisfy this filter", () => {
    // Fixtures only ever varied `kind`, never project, so the project clause of the scoping
    // could be deleted entirely with nothing failing.
    const foreign = [{ project_key: "OTHER", applies_to_kind: "requirement", key: "risk",
                       data_type: "number", is_filterable: true }];
    const r = filterByField({ items: [A("REQ-001", { cf_risk: 7 })], definitions: foreign,
                              filter: { key: "risk", equals: 7 }, project_key: "BLZ" });
    assert.equal(r.ok, false, "a field defined only in project OTHER is unknown to a BLZ filter");
    assert.match(r.error, /risk/);
  });

  test("an EMPTY filter object means 'no filter', not a refusal", () => {
    // `{}` arrives from a UI that always sends the key. Treating it as a refusal turns a
    // blank filter box into an error; treating it as "match nothing" is worse still.
    const items = [A("REQ-001"), A("REQ-002")];
    const r = filterByField({ items, definitions: DEFS, filter: {} });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.items, items);
  });
});
