// tests/model/frontmatter-injection.test.mjs — BLZ-386, found by adversarial review.
//
// `dumpScalar` quoted a string only when it contained a COMMA, because an unquoted comma
// breaks re-parse of a flow array. A NEWLINE was passed through raw — and `serializeTicket`
// emits `${key}: ${value}`, so a newline in any value opened a new frontmatter line that
// `parseTicket` read back as a genuine key.
//
// That is a full bypass of `EDITABLE_FIELDS`, which is checked on patch KEYS only. It refutes
// BLZ-386's central claim directly: `start` and `due` are refused by name on both the CLI and
// `/api/edit`, and could still be written through `title`. It is not limited to dates —
// `resolution`, `parent` and `id` were reachable the same way, on the HTTP surface.
//
// The parser already decodes JSON-quoted strings (coerceScalar), so quoting is a complete fix
// and round-trips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicket, serializeTicket } from "../../scripts/model/ticket.mjs";

const round = (fm) => parseTicket(serializeTicket({ frontmatter: fm, body: "b" }));

test("a newline in a value CANNOT open a new frontmatter key", () => {
  const r = round({ id: "T-1", title: "injected\nstart: 2026-01-01\ndue: 2026-12-31", type: "task" });
  assert.equal(r.frontmatter.title, "injected\nstart: 2026-01-01\ndue: 2026-12-31",
    "the newline stays INSIDE the title");
  assert.equal(r.frontmatter.start, undefined, "start was not created");
  assert.equal(r.frontmatter.due, undefined, "due was not created");
});

test("the derived date fields specifically cannot be injected — BLZ-386's actual claim", () => {
  for (const field of ["start", "due"]) {
    const r = round({ id: "T-1", title: `x\n${field}: 2030-01-01`, type: "task" });
    assert.equal(r.frontmatter[field], undefined, `${field} was injected through title`);
  }
});

test("neither can any other field the write path gates — this was never only about dates", () => {
  const r = round({ id: "T-1", title: "x\nresolution: done\nparent: EVIL-1", type: "task" });
  assert.equal(r.frontmatter.resolution, undefined);
  assert.equal(r.frontmatter.parent, undefined);
});

test("a carriage return cannot either — CR is a line terminator to the parser too", () => {
  const r = round({ id: "T-1", title: "x\rstart: 2030-01-01", type: "task" });
  assert.equal(r.frontmatter.start, undefined);
  assert.equal(r.frontmatter.title, "x\rstart: 2030-01-01");
});

test("a value that merely LOOKS quoted is preserved, not silently unwrapped", () => {
  const r = round({ id: "T-1", title: '"already quoted"', type: "task" });
  assert.equal(r.frontmatter.title, '"already quoted"');
});

test("the comma rule the quoting existed for still holds", () => {
  const r = round({ id: "T-1", title: "a, b", labels: ["x, y", "z"], type: "task" });
  assert.equal(r.frontmatter.title, "a, b");
  assert.deepEqual(r.frontmatter.labels, ["x, y", "z"]);
});

test("an ordinary value is still emitted unquoted, so no existing ticket churns", () => {
  // The whole corpus round-trips through this. Quoting everything would rewrite 2,635 files.
  const text = serializeTicket({ frontmatter: { id: "T-1", title: "a normal title", type: "task" }, body: "b" });
  assert.match(text, /^title: a normal title$/m);
});

test("a colon in a value is still fine — colons were never the hazard", () => {
  const r = round({ id: "T-1", title: "ratio 3:1 and a note", type: "task" });
  assert.equal(r.frontmatter.title, "ratio 3:1 and a note");
});
