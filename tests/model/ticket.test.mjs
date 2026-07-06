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
