import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicket, serializeTicket } from "../../scripts/model/ticket.mjs";

// Simulate a v1 engine: FIELD_ORDER as it was before BLZ-110 (no sprint/start/due).
const V1_FIELD_ORDER = ["id", "title", "type", "project", "priority", "resolution", "parent",
  "assignee", "labels", "components", "estimate", "worklog", "links", "likelihood", "impact",
  "branch", "pr", "created", "updated"];

function serializeV1({ frontmatter, body }) {
  const keys = [
    ...V1_FIELD_ORDER.filter((k) => k in frontmatter),
    ...Object.keys(frontmatter).filter((k) => !V1_FIELD_ORDER.includes(k)),
  ];
  const fm = keys.map((k) => `${k}: ${frontmatter[k]}`).join("\n");
  return `---\n${fm}\n---\n${body}`;
}
// NOTE: this shim faithfully replicates only the KEY-ORDERING logic (the load-bearing
// part — FIELD_ORDER keys first, then the unknown-key tail). It does NOT replicate the real
// serializeTicket's value formatting (dumpScalar null/array/quoting), so keep the fixture
// all-non-null-scalars. tests/compat-legacy.test.mjs is the check that the REAL serializer
// round-trips legacy boards; this shim's job is narrower: prove the unknown-key tail-append
// survives, i.e. a v1 engine that has never heard of sprint/start/due still preserves them.

test("a v1 engine round-trips sprint/start/due byte-for-byte in VALUE", () => {
  const fm = {
    id: "OBA-1", title: "t", type: "task", project: "OBA", estimate: 60,
    sprint: "S1", start: "2026-07-20", due: "2026-07-24", created: "2026-07-15", updated: "2026-07-15",
  };
  const text = serializeV1({ frontmatter: fm, body: "body" });
  const back = parseTicket(text).frontmatter;
  assert.equal(back.sprint, "S1");
  assert.equal(back.start, "2026-07-20");
  assert.equal(back.due, "2026-07-24");
});

// A v1 engine's serializer places the (to-it-unknown) keys in its unknown-key tail, whereas
// a v2 engine places them in FIELD_ORDER position. The two agree on VALUE; only key ORDER
// differs, and that difference converges on the next v2 write. This asserts the v2 serializer
// preserves the same values a v1 engine would, so a round-trip through either survives.
test("v1-tail and v2-ordered serializations agree on parsed values", () => {
  const fm = {
    id: "OBA-2", title: "u", type: "task", project: "OBA", estimate: 30,
    sprint: "S2", start: "2026-08-01", due: "2026-08-14", created: "2026-07-15", updated: "2026-07-15",
  };
  const v1 = parseTicket(serializeV1({ frontmatter: fm, body: "b" })).frontmatter;
  const v2 = parseTicket(serializeTicket({ frontmatter: fm, body: "b" })).frontmatter;
  assert.equal(v1.sprint, v2.sprint);
  assert.equal(v1.start, v2.start);
  assert.equal(v1.due, v2.due);
});
