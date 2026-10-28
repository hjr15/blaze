// tests/ticket-body.test.mjs — BLZ-729 (E3): the ticket body and acceptance-criteria model.
// Pure: no board, no server. `/api/new` (and, later, `/api/body` and `/api/ac/add`) validate a
// caller's body and AC list through these, before any id is allocated or any row is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCAFFOLD_BODY, AC_HEADING_RE, BODY_MAX_BYTES, AC_ITEM_MAX, AC_MAX_ITEMS,
  bodyOrErrors, acItemsOrErrors, withAcSection, withAcAppended, acItemCount,
} from "../scripts/model/ticket-body.mjs";

test("BLZ-729: the limits and the scaffold are the values the plan fixes", () => {
  assert.equal(SCAFFOLD_BODY, "## Context\n\n## Acceptance Criteria\n\n- [ ] \n\n## Notes\n");
  assert.equal(BODY_MAX_BYTES, 131072);
  assert.equal(AC_ITEM_MAX, 2000);
  assert.equal(AC_MAX_ITEMS, 100);
  assert.equal(AC_HEADING_RE.test("## Acceptance Criteria"), true);
  assert.equal(AC_HEADING_RE.test("   ###### acceptance criteria  "), true);
  assert.equal(AC_HEADING_RE.test("## AC"), false);
});

test("BLZ-729: bodyOrErrors refuses non-strings, blanks, NUL and oversize, and normalises CRLF", () => {
  assert.deepEqual(bodyOrErrors("a\r\nb"), { body: "a\nb\n" });
  assert.deepEqual(bodyOrErrors("a\n\n\n"), { body: "a\n" }, "exactly one trailing newline");
  assert.deepEqual(bodyOrErrors(" \n"), { errors: ["body must not be blank"] });
  assert.deepEqual(bodyOrErrors(7), { errors: ["body must be a string"] });
  assert.deepEqual(bodyOrErrors(null), { errors: ["body must be a string"] });
  assert.deepEqual(bodyOrErrors("a\0b"), { errors: ["body must not contain a NUL byte"] });
  const over = bodyOrErrors("x".repeat(131073));
  assert.equal(over.body, undefined);
  assert.match(over.errors.join(" "), /131073 bytes; the limit is 131072/);
  assert.equal(bodyOrErrors("x".repeat(131072)).body, `${"x".repeat(131072)}\n`, "the cap itself is accepted");
  // Bytes, not characters: 32769 four-byte code points are 131076 bytes.
  assert.match(bodyOrErrors("\u{1F600}".repeat(32769)).errors.join(" "), /131076 bytes; the limit is 131072/);
});

test("BLZ-729: acItemsOrErrors parses checkbox prefixes and names the bad item", () => {
  assert.deepEqual(acItemsOrErrors(["- [x] done", "todo", "- plain"]),
    { items: [{ text: "done", checked: true }, { text: "todo", checked: false }, { text: "plain", checked: false }] });
  assert.deepEqual(acItemsOrErrors(["  - [X] upper  ", "- [ ] open"]),
    { items: [{ text: "upper", checked: true }, { text: "open", checked: false }] });
  assert.deepEqual(acItemsOrErrors(["ok", " "]), { errors: ["ac item 2 is blank"] });
  assert.deepEqual(acItemsOrErrors(["ok", "- [ ] "]), { errors: ["ac item 2 is blank"] }, "a bare checkbox is blank");
  assert.deepEqual(acItemsOrErrors([]), { errors: ["ac takes 1 to 100 items"] });
  assert.deepEqual(acItemsOrErrors(Array(101).fill("a")), { errors: ["ac takes 1 to 100 items"] });
  assert.equal(acItemsOrErrors(Array(100).fill("a")).items.length, 100);
  assert.deepEqual(acItemsOrErrors("one"), { errors: ["ac must be an array of strings"] });
  assert.deepEqual(acItemsOrErrors(["one", 2]), { errors: ["ac must be an array of strings"] });
  assert.deepEqual(acItemsOrErrors(["a", "b", "x\ny"]), { errors: ["ac item 3 spans more than one line"] });
  assert.deepEqual(acItemsOrErrors(["a", "b", "x\ry"]), { errors: ["ac item 3 spans more than one line"] });
  assert.deepEqual(acItemsOrErrors(["a", "b", "é".repeat(1001)]), { errors: ["ac item 3 is over 2000 bytes"] });
  assert.equal(acItemsOrErrors(["x".repeat(2000)]).items[0].text.length, 2000);
  assert.deepEqual(acItemsOrErrors(["a\0b"]), { errors: ["ac item 1 must not contain a NUL byte"] });
  assert.deepEqual(acItemsOrErrors([" ", "a\nb"]), { errors: ["ac item 1 is blank", "ac item 2 spans more than one line"] },
    "every bad item is named, not only the first");
});

test("BLZ-729: withAcSection replaces the section and keeps the rest", () => {
  assert.equal(withAcSection(SCAFFOLD_BODY, [{ text: "a" }, { text: "b", checked: true }]),
    "## Context\n\n## Acceptance Criteria\n\n- [ ] a\n- [x] b\n\n## Notes\n");
  // Everything up to the NEXT heading of any level goes — prose included — and nothing after it.
  assert.equal(
    withAcSection("## Context\nwhy\n### Acceptance criteria\nold prose\n- [x] old\n#### Sub\nkept\n", [{ text: "new" }]),
    "## Context\nwhy\n### Acceptance criteria\n\n- [ ] new\n\n#### Sub\nkept\n");
  // Only the FIRST AC heading's section is replaced.
  assert.equal(withAcSection("## Acceptance Criteria\n- [ ] x\n## Acceptance Criteria\n- [ ] y\n", [{ text: "z" }]),
    "## Acceptance Criteria\n\n- [ ] z\n\n## Acceptance Criteria\n- [ ] y\n");
  // An AC section that ends the body leaves exactly one trailing newline.
  assert.equal(withAcSection("## Acceptance Criteria\n- [ ] x\n", [{ text: "z" }]), "## Acceptance Criteria\n\n- [ ] z\n");
});

test("BLZ-729: withAcSection inserts before Notes when there is no AC heading", () => {
  assert.equal(withAcSection("## Context\n\nwhy\n\n## Notes\nn\n", [{ text: "a" }]),
    "## Context\n\nwhy\n\n## Acceptance Criteria\n\n- [ ] a\n\n## Notes\nn\n");
  assert.equal(withAcSection("## AC\n- [ ] not counted\n## Notes\n", [{ text: "a", checked: true }]),
    "## AC\n- [ ] not counted\n## Acceptance Criteria\n\n- [x] a\n\n## Notes\n");
});

test("BLZ-729: withAcSection appends at the end when there is no Notes heading either", () => {
  assert.equal(withAcSection("## Context\n\nwhy\n", [{ text: "a" }, { text: "b" }]),
    "## Context\n\nwhy\n\n## Acceptance Criteria\n\n- [ ] a\n- [ ] b\n");
  assert.equal(withAcSection("why", [{ text: "a" }]), "why\n\n## Acceptance Criteria\n\n- [ ] a\n");
});

test("BLZ-729: withAcAppended replaces the scaffold's empty checkbox", () => {
  const one = withAcAppended(SCAFFOLD_BODY, "first");
  assert.equal(one.index, 0);
  assert.equal(one.body, "## Context\n\n## Acceptance Criteria\n\n- [ ] first\n\n## Notes\n");
  assert.equal(one.body.match(/- \[[ xX]\]/g).length, 1, "exactly one checkbox");
  const two = withAcAppended(one.body, "second");
  assert.equal(two.index, 1);
  assert.equal(two.body, "## Context\n\n## Acceptance Criteria\n\n- [ ] first\n- [ ] second\n\n## Notes\n");
  assert.equal(acItemCount(two.body), 2);
});

test("BLZ-729: withAcAppended appends after the last checkbox, or opens the section", () => {
  // After the LAST checkbox of the section, even when prose sits between items.
  assert.deepEqual(withAcAppended("## Acceptance Criteria\n- [x] a\nnote\n- [ ] b\ntrailing prose\n## Notes\n", "c"),
    { body: "## Acceptance Criteria\n- [x] a\nnote\n- [ ] b\n- [ ] c\ntrailing prose\n## Notes\n", index: 2 });
  // An empty checkbox beside a real one is NOT a lone scaffold: it is kept.
  assert.deepEqual(withAcAppended("## Acceptance Criteria\n- [ ] \n- [ ] real\n", "c"),
    { body: "## Acceptance Criteria\n- [ ] \n- [ ] real\n- [ ] c\n", index: 2 });
  // A section with no checkbox gets the item as its first line.
  assert.deepEqual(withAcAppended("## Acceptance Criteria\n\nsome prose\n\n## Notes\n", "c"),
    { body: "## Acceptance Criteria\n\n- [ ] c\n\nsome prose\n\n## Notes\n", index: 0 });
  assert.deepEqual(withAcAppended("## Acceptance Criteria\n", "c"), { body: "## Acceptance Criteria\n\n- [ ] c\n", index: 0 });
  // No section at all: created as withAcSection creates one.
  assert.deepEqual(withAcAppended("## Context\n\n## Notes\n", "c"),
    { body: "## Context\n\n## Acceptance Criteria\n\n- [ ] c\n\n## Notes\n", index: 0 });
  assert.deepEqual(withAcAppended("why\n", "c"), { body: "why\n\n## Acceptance Criteria\n\n- [ ] c\n", index: 0 });
});

test("BLZ-729: acItemCount counts by applyToggleAc's heading rule", () => {
  assert.equal(acItemCount(SCAFFOLD_BODY), 1, "the scaffold's empty box is a checkbox");
  assert.equal(acItemCount("## AC\n- [ ] a\n- [x] b\n"), 0, "applyToggleAc does not match `## AC`");
  assert.equal(acItemCount("- [ ] decoy\n## Acceptance Criteria\n- [ ] a\n  - [X] b\nprose\n## Notes\n- [ ] after\n"), 2);
  assert.equal(acItemCount("no heading at all\n"), 0);
});
