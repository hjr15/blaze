import { test } from "node:test";
import assert from "node:assert/strict";
import { searchText } from "../../scripts/model/search.mjs";

test("searchText joins id, title, labels and assignee, lowercased", () => {
  const t = { meta: { id: "ENG-42", title: "Search Bar", labels: ["Frontend", "UX"], assignee: "Ryan" } };
  assert.equal(searchText(t), "eng-42 search bar frontend ux ryan");
});

test("searchText drops missing/empty fields without crashing", () => {
  assert.equal(searchText({ meta: { id: "ENG-1" } }), "eng-1");
  assert.equal(searchText({ meta: {} }), "");
  assert.equal(searchText({}), "");
  assert.equal(searchText(undefined), "");
});

test("searchText accepts a bare frontmatter object (not just {meta})", () => {
  assert.equal(searchText({ id: "OBA-9", title: "Fix", assignee: "sam" }), "oba-9 fix sam");
});

test("searchText handles a non-array labels field defensively", () => {
  assert.equal(searchText({ meta: { id: "X-1", labels: "solo" } }), "x-1 solo");
});
