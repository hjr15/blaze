import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rollup } from "../../scripts/model/hierarchy-rollup.mjs";

const m = (hierarchyId, item_id, parent_id) => ({ hierarchy_id: hierarchyId, item_id, parent_id });

describe("rollup", () => {
  test("sums a simple subtree", () => {
    const memberships = [m("h1","root",null), m("h1","a","root"), m("h1","b","root")];
    const values = { a: 3, b: 4 };
    assert.equal(rollup({ memberships, values, hierarchyId: "h1", rootId: "root" }), 7);
  });

  test("sums to arbitrary depth", () => {
    const memberships = [m("h1","root",null), m("h1","a","root"),
                         m("h1","b","a"), m("h1","c","b")];
    assert.equal(rollup({ memberships, values: { c: 5 }, hierarchyId: "h1", rootId: "root" }), 5);
  });

  test("EXCLUDES DUPLICATES BY DEFAULT — an item reachable twice counts once", () => {
    // Structure requires an explicit 'Exclude duplicates' toggle, which means its
    // default is wrong (CS-038). A rollup that double-counts is not a number.
    const memberships = [m("h1","root",null), m("h1","a","root"), m("h1","b","root"),
                         m("h1","shared","a"), m("h1","shared","b")];
    assert.equal(rollup({ memberships, values: { shared: 10 }, hierarchyId: "h1", rootId: "root" }), 10);
  });

  test("a cycle terminates instead of hanging", () => {
    const memberships = [m("h1","a","b"), m("h1","b","a")];
    assert.equal(rollup({ memberships, values: { a: 1, b: 1 }, hierarchyId: "h1", rootId: "a" }), 2);
  });

  test("hierarchies are independent — the same items roll up differently", () => {
    const memberships = [m("h1","root",null), m("h1","x","root"),
                         m("h2","root",null)];   // x is not in h2
    assert.equal(rollup({ memberships, values: { x: 9 }, hierarchyId: "h1", rootId: "root" }), 9);
    assert.equal(rollup({ memberships, values: { x: 9 }, hierarchyId: "h2", rootId: "root" }), 0);
  });

  test("a missing value contributes zero, never NaN", () => {
    const memberships = [m("h1","root",null), m("h1","a","root")];
    assert.equal(rollup({ memberships, values: {}, hierarchyId: "h1", rootId: "root" }), 0);
  });
});
