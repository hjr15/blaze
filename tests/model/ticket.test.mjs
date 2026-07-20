// tests/model/ticket.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTicket, serializeTicket } from "../../scripts/model/ticket.mjs";

const SAMPLE = `---
id: OBA-373
title: Wire the gateway timeout
type: task
project: OBA
priority: medium
resolution:
parent: OBA-360
assignee: ryan
labels: [deferred:launch, infra]
components: [gateway]
estimate: 90
worklog:
  - { date: 2026-06-28, minutes: 60, note: first pass }
  - { date: 2026-06-29, minutes: 30, note: review fixes }
links:
  - { type: Blocks, target: OBA-374 }
created: 2026-06-28
updated: 2026-06-29
---

## Context

The gateway drops slow upstreams.

## Acceptance Criteria

- [ ] Timeout configurable
`;

test("parses scalars, null, flow arrays, and block lists of inline objects", () => {
  const { frontmatter: fm, body } = parseTicket(SAMPLE);
  assert.equal(fm.id, "OBA-373");
  assert.equal(fm.type, "task");
  assert.equal(fm.resolution, null);
  assert.equal(fm.estimate, 90);                          // coerced to number
  assert.deepEqual(fm.labels, ["deferred:launch", "infra"]);
  assert.deepEqual(fm.components, ["gateway"]);
  assert.equal(fm.worklog.length, 2);
  assert.equal(fm.worklog[0].minutes, 60);
  assert.equal(fm.worklog[1].note, "review fixes");
  assert.deepEqual(fm.links[0], { type: "Blocks", target: "OBA-374" });
  assert.match(body, /## Context/);
});

test("round-trips: parse(serialize(parse(x))) deep-equals parse(x)", () => {
  const once = parseTicket(SAMPLE);
  const twice = parseTicket(serializeTicket(once));
  assert.deepEqual(twice.frontmatter, once.frontmatter);
  assert.equal(twice.body.trim(), once.body.trim());
});

test("throws when frontmatter delimiter is missing", () => {
  assert.throws(() => parseTicket("id: X\n"), /missing frontmatter/);
});

test("round-trips a value containing a comma (forces quoting)", () => {
  const once = { frontmatter: { id: "X", type: "task", worklog: [{ minutes: 30, note: "review, fixes" }] }, body: "b" };
  const back = parseTicket(serializeTicket(once));
  assert.equal(back.frontmatter.worklog[0].note, "review, fixes");
});

// ── block-style (multi-line) mapping items ───────────────────────────────────
// The serializer emits inline `- { k: v }` items, but hand-authored and
// migrated tickets commonly use YAML's block form. Both must round-trip.

const BLOCK_LINKS = `---
id: PROJ-596
title: Block-style links
type: task
project: PROJ
links:
  - type: Blocks
    target: PROJ-432
  - type: Relates
    target: PROJ-592
created: 2026-07-20
---

## Context

Body.
`;

test("parses block-style mapping items into objects", () => {
  const { frontmatter } = parseTicket(BLOCK_LINKS);
  assert.deepEqual(frontmatter.links, [
    { type: "Blocks", target: "PROJ-432" },
    { type: "Relates", target: "PROJ-592" },
  ]);
});

test("block-style links survive a parse → serialize → parse round-trip", () => {
  const once = parseTicket(BLOCK_LINKS);
  const twice = parseTicket(serializeTicket(once));
  assert.deepEqual(twice.frontmatter.links, once.frontmatter.links);
  assert.equal(twice.frontmatter.links.length, 2);
  assert.equal(twice.frontmatter.links[0].target, "PROJ-432");
});

test("a scalar list item keeps its colon — `- a:b` is not a mapping", () => {
  // YAML requires whitespace after the colon for a mapping. Without it this is
  // a plain scalar, and namespaced labels rely on that.
  const { frontmatter } = parseTicket(`---
id: PROJ-1
labels:
  - compliance:privacy
  - risk:data
---

Body.
`);
  assert.deepEqual(frontmatter.labels, ["compliance:privacy", "risk:data"]);
});

test("block and inline items can be mixed in one list", () => {
  const { frontmatter } = parseTicket(`---
id: PROJ-2
links:
  - { type: Blocks, target: PROJ-3 }
  - type: Relates
    target: PROJ-4
---

Body.
`);
  assert.deepEqual(frontmatter.links, [
    { type: "Blocks", target: "PROJ-3" },
    { type: "Relates", target: "PROJ-4" },
  ]);
});
