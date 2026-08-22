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

  test("comparison does not coerce — cf_risk 7 is not matched by the string '7'", () => {
    // A loose == would make a number field match its own string form and vice versa,
    // which then differs by engine (SQLite REAL vs Postgres numeric-as-string).
    const items = [A("REQ-001", { cf_risk: 7 })];
    assert.equal(filterByField({ items, definitions: DEFS, filter: { key: "risk", equals: "7" } }).items.length, 0);
    assert.equal(filterByField({ items, definitions: DEFS, filter: { key: "risk", equals: 7 } }).items.length, 1);
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
