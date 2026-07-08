import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, inline, mdLite, prLink, metaPieces } from "../../scripts/views/render-lib.mjs";

test("esc escapes the four HTML-significant characters", () => {
  assert.equal(esc(`a & b < c > d "e"`), "a &amp; b &lt; c &gt; d &quot;e&quot;");
});

test("inline renders bold and code", () => {
  assert.equal(inline("**b** and `c`"), "<strong>b</strong> and <code>c</code>");
});

test("mdLite marks AC-section checkboxes with data-ac-index and leaves others disabled", () => {
  const html = mdLite("## Acceptance Criteria\n- [ ] one\n- [x] two\n## Notes\n- [ ] later\n");
  assert.match(html, /data-ac-index="0"/);
  assert.match(html, /data-ac-index="1"/);
  assert.match(html, /<input type="checkbox" disabled/); // the Notes checkbox
});

test("prLink builds an anchor from a pr field, empty when no url", () => {
  assert.match(prLink("#843 — https://github.com/x/y/pull/843"), /href="https:\/\/github.com\/x\/y\/pull\/843"/);
  assert.equal(prLink("no url here"), "");
});

test("metaPieces returns escaped pieces, dropping unassigned/empty", () => {
  const pieces = metaPieces({ assignee: "ryan", estimate: 30, parent: "INF-1", project: "INF" });
  assert.ok(pieces.includes("@ryan"));
  assert.ok(pieces.some((p) => p.includes("INF-1")));
  assert.deepEqual(metaPieces({ assignee: "unassigned" }), []);
});
