import { test } from "node:test";
import assert from "node:assert/strict";
import { LINK_TYPES, lintLinks, addLink, removeLink } from "../../scripts/model/links.mjs";

const known = new Set(["OBA-1", "OBA-2"]);

test("flags a link using `to:` instead of `target:`", () => {
  const w = lintLinks({ id: "OBA-1", links: [{ type: "Blocks", to: "OBA-2" }] }, known);
  assert.equal(w.length, 1);
  assert.match(w[0], /target:/);
});

test("flags an unknown link type", () => {
  const w = lintLinks({ id: "OBA-1", links: [{ type: "Bogus", target: "OBA-2" }] }, known);
  assert.ok(w.some((m) => /unknown link type/i.test(m)));
});

test("flags a dangling target", () => {
  const w = lintLinks({ id: "OBA-1", links: [{ type: "Relates", target: "OBA-999" }] }, known);
  assert.ok(w.some((m) => /OBA-999/.test(m)));
});

test("valid {type,target} entry passes", () => {
  assert.deepEqual(lintLinks({ id: "OBA-1", links: [{ type: "Relates", target: "OBA-2" }] }, known), []);
});

test("no links → no warnings", () => {
  assert.deepEqual(lintLinks({ id: "OBA-1" }, known), []);
});

// coverage: the badKey-undefined arm (a link with only a type, no target, no other key)
test("flags a link entry missing target entirely", () => {
  const w = lintLinks({ id: "OBA-1", links: [{ type: "Blocks" }] }, known);
  assert.equal(w.length, 1);
  assert.match(w[0], /missing 'target:'/);
  assert.doesNotMatch(w[0], /found/); // no bad-key clause when there is no other key
});

// coverage: the non-object guard
test("flags a malformed (non-object) link entry", () => {
  const w = lintLinks({ id: "OBA-1", links: [null] }, known);
  assert.equal(w.length, 1);
  assert.match(w[0], /malformed/);
});

test("addLink appends a typed link", () => {
  assert.deepEqual(addLink([], "Blocks", "OBA-2"), [{ type: "Blocks", target: "OBA-2" }]);
});
test("addLink is idempotent (no duplicate)", () => {
  const once = addLink([], "Blocks", "OBA-2");
  assert.deepEqual(addLink(once, "Blocks", "OBA-2"), [{ type: "Blocks", target: "OBA-2" }]);
});
test("addLink treats undefined links as empty", () => {
  assert.deepEqual(addLink(undefined, "Relates", "OBA-3"), [{ type: "Relates", target: "OBA-3" }]);
});
test("removeLink drops the matching entry only", () => {
  const links = [{ type: "Blocks", target: "OBA-2" }, { type: "Relates", target: "OBA-3" }];
  assert.deepEqual(removeLink(links, "Blocks", "OBA-2"), [{ type: "Relates", target: "OBA-3" }]);
});
test("removeLink on undefined links returns []", () => {
  assert.deepEqual(removeLink(undefined, "Blocks", "OBA-2"), []);
});
