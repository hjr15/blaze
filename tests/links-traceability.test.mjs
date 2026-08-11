// tests/links-traceability.test.mjs — BLZ-237.
//
// blaze-pm ADR-0015 puts traceability on SEMANTIC LINKS rather than a multi-valued `parent`,
// and the engine rejected the two types that carry it. So every trace on the board was prose
// — a `## Traceability` bullet, parsed by a regular expression in build_matrices.py.
//
// Prose traces are unvalidated (a pointer at a non-existent id still matches the pattern),
// one-directional, invisible to the link graph, and hostage to a bullet's wording: change
// the wording and traceability silently empties while the derived view still looks correct.
//
// The link vocabulary is directional and its direction is load-bearing:
//   feature      --Implements--> requirement
//   architecture --Addresses---> requirement
import { test } from "node:test";
import assert from "node:assert/strict";
import { LINK_TYPES, lintLinks, addLink, TRACE_LINK_TYPES, traceEndpointsFor } from "../scripts/model/links.mjs";

const ids = (...xs) => new Set(xs);

test("Implements and Addresses are part of the vocabulary", () => {
  assert.ok(LINK_TYPES.has("Implements"), "a delivery bundle must be able to say what it implements");
  assert.ok(LINK_TYPES.has("Addresses"), "a decision must be able to say what it answers");
});

test("the traceability types are named separately from the delivery ones", () => {
  // Callers that build a matrix need the traceability subset, not every link type.
  assert.deepEqual([...TRACE_LINK_TYPES].sort(), ["Addresses", "Implements"]);
  for (const t of TRACE_LINK_TYPES) assert.ok(LINK_TYPES.has(t), `${t} must also be a valid link type`);
});

test("a traceability link to a real id lints clean", () => {
  const fm = { id: "OBA-2", type: "feature", links: [{ type: "Implements", target: "OBA-743" }] };
  assert.deepEqual(lintLinks(fm, ids("OBA-2", "OBA-743")), []);
});

test("a traceability link to a non-existent id is reported — the thing prose could not do", () => {
  const fm = { id: "OBA-2", type: "feature", links: [{ type: "Implements", target: "OBA-9999" }] };
  const w = lintLinks(fm, ids("OBA-2"));
  assert.equal(w.length, 1);
  assert.match(w[0], /dangling/);
});

test("an unknown link type is still rejected — the vocabulary widened, it did not open", () => {
  const fm = { id: "OBA-2", links: [{ type: "Traces", target: "OBA-1" }] };
  const w = lintLinks(fm, ids("OBA-1", "OBA-2"));
  assert.equal(w.length, 1);
  assert.match(w[0], /unknown link type/);
});

test("addLink is idempotent for a traceability link", () => {
  let l = addLink([], "Implements", "OBA-743");
  l = addLink(l, "Implements", "OBA-743");
  assert.equal(l.length, 1);
});

test("one ticket can implement several requirements", () => {
  let l = addLink([], "Implements", "OBA-743");
  l = addLink(l, "Implements", "OBA-744");
  assert.deepEqual(l.map((x) => x.target), ["OBA-743", "OBA-744"]);
});

test("traceEndpointsFor reads a requirement's implementers from the OTHER end", () => {
  // The property prose could not provide: the trace is discoverable from the delivery
  // ticket, and the requirement's view of it is derived rather than separately maintained.
  const corpus = [
    { id: "OBA-743", type: "requirement", links: [] },
    { id: "OBA-2", type: "feature", links: [{ type: "Implements", target: "OBA-743" }] },
    { id: "OBA-4", type: "feature", links: [{ type: "Implements", target: "OBA-743" }] },
    { id: "OBA-758", type: "architecture", links: [{ type: "Addresses", target: "OBA-743" }] },
    { id: "OBA-9", type: "feature", links: [{ type: "Implements", target: "OBA-999" }] },
  ];
  const t = traceEndpointsFor("OBA-743", corpus);
  assert.deepEqual(t.implementedBy.sort(), ["OBA-2", "OBA-4"]);
  assert.deepEqual(t.addressedBy, ["OBA-758"]);
});

test("traceEndpointsFor returns empty lists for an untraced requirement", () => {
  const t = traceEndpointsFor("OBA-750", [{ id: "OBA-750", type: "requirement", links: [] }]);
  assert.deepEqual(t.implementedBy, []);
  assert.deepEqual(t.addressedBy, []);
});
