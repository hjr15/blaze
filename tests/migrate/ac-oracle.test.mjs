// tests/migrate/ac-oracle.test.mjs — BLZ-296.
//
// The oracle now checks acceptance criteria, using a matcher written independently of
// the importer's. The point is NOT that a second parser is nicer. It is that an oracle
// sharing the importer's parser agrees with it by construction — including where it is
// wrong — and the corpus has already produced two worked examples of exactly that:
//
//   153 tickets spell the heading with a lower-case c. A case-sensitive matcher drops
//   their criteria silently, and a shared-matcher oracle reports a clean migration.
//
//   54 tickets carry a template stub (`## Acceptance Criteria` + a bare `- [ ]`)
//   BEFORE the real section. findAcSection returned the first match, so the importer
//   loaded the placeholder and dropped everything real — 224 criteria — while every
//   existing test passed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { acCriteria } from "../../scripts/migrate/ac-oracle-matcher.mjs";
import { findAcSection, parseAcBlocks } from "../../scripts/model/ac-blocks.mjs";
import { zeroDiff } from "../../scripts/migrate/zero-diff.mjs";
import { memReadStorage } from "../../scripts/model/read-storage.mjs";

const rec = (id, body) => ({
  frontmatter: { id, project: "BLZ", type: "task", title: `${id} t`,
                 priority: "medium", assignee: "unassigned", links: [] },
  body, project: "BLZ", status: "defined", file: id,
});

describe("the independent matcher reads what the importer must read", () => {
  test("a lower-case heading is found — the 153-ticket defect", () => {
    const { criteria, hasSection } = acCriteria("## Acceptance criteria\n\n- [x] one\n");
    assert.equal(hasSection, true);
    assert.deepEqual(criteria.map((c) => c.head), ["one"]);
  });

  test("a suffixed heading is found, and an unrelated heading is not", () => {
    assert.equal(acCriteria("## Acceptance Criteria (mitigation)\n\n- [ ] a\n").criteria.length, 1);
    assert.equal(acCriteria("## Acceptance testing notes\n\n- [ ] a\n").criteria.length, 0);
  });

  test("the section ends at the next heading", () => {
    const { criteria } = acCriteria("## Acceptance Criteria\n\n- [x] in\n\n## Notes\n\n- [ ] out\n");
    assert.deepEqual(criteria.map((c) => c.head), ["in"]);
  });

  test("a checkbox inside a fenced block is not a criterion", () => {
    const { criteria } = acCriteria("## Acceptance Criteria\n\n```\n- [ ] not real\n```\n\n- [x] real\n");
    assert.deepEqual(criteria.map((c) => c.head), ["real"]);
  });

  test("checked state is read, both spellings of x", () => {
    const { criteria } = acCriteria("## Acceptance Criteria\n\n- [x] a\n- [X] b\n- [ ] c\n");
    assert.deepEqual(criteria.map((c) => c.checked), [true, true, false]);
  });

  test("a wrapped criterion is joined; a line at the bullet's own column is not", () => {
    const { criteria } = acCriteria(
      "## Acceptance Criteria\n\n- [x] first line\n      continues here\nnot a continuation\n");
    assert.equal(criteria[0].text, "first line continues here");
    assert.equal(criteria[0].head, "first line", "head stays the bullet's own line");
  });
});

describe("a template stub must not win over the real section", () => {
  const DOUBLED = "## Acceptance Criteria\n\n- [ ] \n\n## Notes\n\n## Acceptance Criteria\n\n- [x] real one\n- [ ] real two\n";

  test("findAcSection picks the section that says something", () => {
    const sec = findAcSection(DOUBLED);
    assert.ok(sec.lines.some((l) => l.includes("real one")),
      "the stub section was chosen — this dropped 224 criteria on 54 live tickets");
  });

  test("the importer then parses the real criteria", () => {
    // parseAcBlocks takes the BODY and does its own section selection, so this also
    // proves the fix reaches the importer's real entry point, not just findAcSection.
    const { blocks } = parseAcBlocks(DOUBLED);
    const crit = blocks.filter((b) => b.kind === "criterion").map((b) => b.text);
    assert.deepEqual(crit, ["real one", "real two"]);
  });

  test("the independent matcher agrees, by its own route", () => {
    assert.deepEqual(acCriteria(DOUBLED).criteria.map((c) => c.head), ["real one", "real two"]);
  });

  test("a single EMPTY section is still returned — absent is not the same as stubbed", () => {
    const sec = findAcSection("## Acceptance Criteria\n\n- [ ] \n");
    assert.ok(sec, "a stub-only ticket still HAS an AC section, and must report as one");
  });
});

describe("the oracle gates on loss and reports representation separately", () => {
  const BODY = "## Acceptance Criteria\n\n- [x] alpha\n- [ ] beta\n";
  const source = memReadStorage([rec("BLZ-1", BODY)]);
  const loaded = memReadStorage([rec("BLZ-1", BODY)]);

  test("a faithful migration passes", () => {
    const r = zeroDiff(source, null, loaded,
      { criteriaFor: () => [{ text: "alpha", checked: 1 }, { text: "beta", checked: 0 }] });
    assert.deepEqual(r.criteriaDiffs, []);
    assert.equal(r.criteriaChecked, 2);
    assert.equal(r.ok, true);
  });

  test("a DROPPED section is caught — the case the shared matcher could not see", () => {
    const r = zeroDiff(source, null, loaded, { criteriaFor: () => [] });
    assert.equal(r.criteriaDiffs[0].kind, "section-dropped");
    assert.equal(r.criteriaDiffs[0].expected, 2);
    assert.equal(r.ok, false, "dropped criteria must fail the gate");
  });

  test("a changed criterion is caught", () => {
    const r = zeroDiff(source, null, loaded,
      { criteriaFor: () => [{ text: "ALTERED", checked: 1 }, { text: "beta", checked: 0 }] });
    assert.equal(r.criteriaDiffs[0].kind, "text");
    assert.equal(r.ok, false);
  });

  test("a flipped checkbox is caught", () => {
    const r = zeroDiff(source, null, loaded,
      { criteriaFor: () => [{ text: "alpha", checked: 0 }, { text: "beta", checked: 0 }] });
    assert.equal(r.criteriaDiffs[0].kind, "checked");
    assert.equal(r.ok, false);
  });

  test("a missing criterion is caught by count", () => {
    const r = zeroDiff(source, null, loaded, { criteriaFor: () => [{ text: "alpha", checked: 1 }] });
    assert.equal(r.criteriaDiffs[0].kind, "count");
    assert.equal(r.ok, false);
  });

  test("extra trailing material is REPORTED but does not gate", () => {
    // The two readers can disagree about whether an indented sub-bullet continues the
    // criterion or is a separate note row. Both preserve every character.
    const r = zeroDiff(source, null, loaded,
      { criteriaFor: () => [{ text: "alpha and then some", checked: 1 }, { text: "beta", checked: 0 }] });
    assert.deepEqual(r.criteriaDiffs, [], "a representation choice is not data loss");
    assert.equal(r.criteriaShapeDiffs, 1, "...but it is still counted, not ignored");
    assert.equal(r.ok, true);
  });

  test("without criteriaFor the oracle SAYS it checked nothing", () => {
    // An unchecked oracle that reports ok:true is worse than no oracle: it is a green
    // light nobody earned.
    const r = zeroDiff(source, null, loaded);
    assert.equal(r.criteriaChecked, 0);
    assert.deepEqual(r.criteriaDiffs, []);
  });
});
