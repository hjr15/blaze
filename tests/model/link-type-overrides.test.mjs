// tests/model/link-type-overrides.test.mjs — BLZ-392.
//
// BLZ-388 changed the solve's node rule from `workflowFor(type) === "delivery"` to "a declared
// `Precedes` source kind". Those select the same set on this board, but they RESOLVE
// differently: the old rule read the override-merged type registry, the new one read
// `DEFAULT_LINK_TYPES`, a module constant. `resolveSchema` merged `schema.types` and
// `schema.workflows` and had no link-type branch at all.
//
// So an installation could add its own delivery type — `spike`, exactly the capability
// `tests/model/schema.test.mjs` pins — and get a type that is not a `Precedes` endpoint,
// therefore not a node, and with NO WAY to make it one. Unschedulable by construction.
//
// The decision recorded in ADR-0022 is that endpoint kinds ARE overridable, and these tests
// cover it from both ends: the merge, and the solve actually honouring the merged value.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveSchema, validateSchema } from "../../scripts/model/schema-config.mjs";
import { DEFAULT_LINK_TYPES, mergeLinkTypes } from "../../scripts/model/link-schema.mjs";
import { scheduleModel } from "../../scripts/model/schedule.mjs";

const SCHEDULE = { minutes_per_day: 480, working_days: [1, 2, 3, 4, 5] };
const MON = Date.parse("2026-08-24T00:00:00Z");
const t = (id, over = {}) => ({
  id, type: "task", status: "defined", estimate_minutes: 480,
  constraint_start_no_earlier_than: null, deadline: null,
  start_date: null, due_date: null, ...over,
});
const edge = (src, target, lag_minutes = 0) => ({ type: "Precedes", src, target, lag_minutes });
const byName = (list, n) => list.find((l) => l.name === n);

describe("BLZ-392: link types resolve through the same layering as types and workflows", () => {
  test("resolveSchema returns linkTypes, defaulting to the engine's declaration", () => {
    const { linkTypes } = resolveSchema({});
    assert.deepEqual(linkTypes, DEFAULT_LINK_TYPES,
      "with no override the resolved list must be exactly the shipped constant");
  });

  test("a top-level override replaces one entry by name and leaves the rest alone", () => {
    const { linkTypes } = resolveSchema({
      config: { schema: { linkTypes: { Precedes: {
        name: "Precedes", inverse_name: "Follows",
        source_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
        target_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
        min_card: 0, max_card: null } } } },
    });
    assert.ok(byName(linkTypes, "Precedes").source_kinds.includes("spike"));
    assert.equal(linkTypes.length, DEFAULT_LINK_TYPES.length, "replacing must not add an entry");
    // Every other entry survives untouched — this is the check BLZ-361's lesson asks for.
    for (const d of DEFAULT_LINK_TYPES.filter((l) => l.name !== "Precedes")) {
      assert.deepEqual(byName(linkTypes, d.name), d, `${d.name} was disturbed by an unrelated override`);
    }
  });

  test("an override naming a NEW link type appends it", () => {
    const { linkTypes } = resolveSchema({
      config: { schema: { linkTypes: { Spikes: {
        name: "Spikes", inverse_name: "Spiked by", source_kinds: ["spike"],
        target_kinds: ["feature"], min_card: 0, max_card: null } } } },
    });
    assert.equal(linkTypes.length, DEFAULT_LINK_TYPES.length + 1);
    assert.ok(byName(linkTypes, "Spikes"), "the new link type is missing");
  });

  test("a project override wins over a top-level one, as types and workflows already do", () => {
    const mk = (kinds) => ({ Precedes: {
      name: "Precedes", inverse_name: "Follows",
      source_kinds: kinds, target_kinds: kinds, min_card: 0, max_card: null } });
    const { linkTypes } = resolveSchema({
      config: { schema: { linkTypes: mk(["task", "top"]) } },
      project: { schema: { linkTypes: mk(["task", "proj"]) } },
    });
    assert.ok(byName(linkTypes, "Precedes").source_kinds.includes("proj"));
    assert.ok(!byName(linkTypes, "Precedes").source_kinds.includes("top"),
      "the project layer must win outright, not union with the top layer");
  });

  test("a malformed override is ignored rather than corrupting the registry", () => {
    // Same guard mergeTypes and mergeWorkflows already apply: an array or a non-object is
    // not a keyed registry, and silently producing a broken list would be worse than ignoring.
    for (const bad of [[], "nope", 3, null]) {
      assert.deepEqual(mergeLinkTypes(DEFAULT_LINK_TYPES, bad), DEFAULT_LINK_TYPES);
    }
  });

  test("validateSchema reports an endpoint kind that is not a declared type", () => {
    // Without this, a typo'd kind matches nothing and the type it was meant to schedule stays
    // silently unschedulable — the same failure BLZ-392 exists to end, reintroduced by spelling.
    const errors = validateSchema({
      types: { task: { workflow: "delivery" } },
      workflows: { delivery: { statuses: ["defined"], terminal: [] } },
      linkTypes: [{ name: "Precedes", source_kinds: ["task", "spke"], target_kinds: ["task"] }],
    });
    assert.ok(errors.some((e) => /spke/.test(e)), `no error named the bad kind: ${errors.join(" | ")}`);
  });

  test("validateSchema is quiet when every endpoint kind is declared", () => {
    const errors = validateSchema({
      types: { task: { workflow: "delivery" }, spike: { workflow: "delivery" } },
      workflows: { delivery: { statuses: ["defined"], terminal: [] } },
      linkTypes: [{ name: "Precedes", source_kinds: ["task", "spike"], target_kinds: ["task", "spike"] }],
    });
    assert.deepEqual(errors, [], `unexpected errors: ${errors.join(" | ")}`);
  });
});

describe("BLZ-392: the solve honours the resolved endpoint kinds", () => {
  test("a custom delivery type is NOT a node under the shipped defaults", () => {
    // The behaviour BLZ-388 introduced, preserved. `spike` is not a declared Precedes source
    // kind, so it is not scheduled — and this test is what proves the next one is not vacuous.
    const r = scheduleModel({
      tickets: [t("S", { type: "spike" })], links: [], schedule: SCHEDULE, now: MON });
    assert.equal(r.scheduled.find((s) => s.id === "S"), undefined,
      "spike was scheduled without an override — the default endpoint kinds are not being applied");
  });

  test("passing resolved linkTypes that name it MAKES a custom delivery type schedulable", () => {
    // The whole point of the ticket: an operator can now make their own type a node.
    const { linkTypes } = resolveSchema({
      config: { schema: { linkTypes: { Precedes: {
        name: "Precedes", inverse_name: "Follows",
        source_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
        target_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
        min_card: 0, max_card: null } } } },
    });
    const r = scheduleModel({
      tickets: [t("S", { type: "spike" })], links: [], schedule: SCHEDULE, now: MON, linkTypes });
    const s = r.scheduled.find((x) => x.id === "S");
    assert.ok(s, "spike is still not a node despite being a declared Precedes source kind");
    assert.ok(s.start_date && s.due_date, `spike was a node but got no dates: ${JSON.stringify(s)}`);
    assert.equal(s.duration_minutes, 480, "the spike's own estimate must drive its duration");
  });

  test("ONE source feeds both the node set and the edge set", () => {
    // The invariant BLZ-388 took the constant for in the first place. If the node rule read the
    // override while the edge filter read the constant, an edge between two spikes would be
    // dropped as an illegal kind even though both endpoints are nodes — and the schedule would
    // silently lose the dependency rather than fail.
    const kinds = ["feature", "story", "task", "bug", "subtask", "spike"];
    const { linkTypes } = resolveSchema({
      config: { schema: { linkTypes: { Precedes: {
        name: "Precedes", inverse_name: "Follows",
        source_kinds: kinds, target_kinds: kinds, min_card: 0, max_card: null } } } },
    });
    const r = scheduleModel({
      tickets: [t("A", { type: "spike" }), t("B", { type: "spike" })],
      links: [edge("A", "B")], schedule: SCHEDULE, now: MON, linkTypes });
    const a = r.scheduled.find((x) => x.id === "A");
    const b = r.scheduled.find((x) => x.id === "B");
    assert.ok(a && b, "both spikes must be nodes");
    assert.ok(b.es >= a.ef,
      `the Precedes edge between two spikes was dropped — B's early start is ${b.es}, A's early finish is ${a.ef}`);
    // And the edge must not have been recorded as dropped for an undeclared kind.
    assert.ok(!(r.dropped ?? []).some((d) => d.reason === "undeclared-kind"),
      `the edge was dropped: ${JSON.stringify(r.dropped)}`);
  });

  test("narrowing the endpoint kinds removes a type from the node set", () => {
    // The override cuts both ways, which is what makes it an override rather than an allowlist.
    const { linkTypes } = resolveSchema({
      config: { schema: { linkTypes: { Precedes: {
        name: "Precedes", inverse_name: "Follows",
        source_kinds: ["feature"], target_kinds: ["feature"], min_card: 0, max_card: null } } } },
    });
    const r = scheduleModel({
      tickets: [t("T", { type: "task" })], schedule: SCHEDULE, now: MON, linkTypes });
    assert.equal(r.scheduled.find((s) => s.id === "T"), undefined,
      "task stayed a node after being removed from the declared source kinds");
  });
});

describe("BLZ-392: the production path passes the resolved kinds, not the constant", () => {
  test("audit-runner hands scheduleModel its resolved linkTypes", () => {
    // `scheduleModel` defaults `linkTypes` to DEFAULT_LINK_TYPES so the pure model stays usable
    // standalone. That default is a trap for exactly one caller — the production one — because
    // forgetting to pass the resolved value reinstates the bug with no visible symptom. This
    // grep is the guard, in the style tests/config.test.mjs already uses on scripts/.
    const src = readFileSync(new URL("../../scripts/audit-runner.mjs", import.meta.url), "utf8");
    assert.match(src, /scheduleModel\(\{[\s\S]*?linkTypes:/,
      "audit-runner.mjs calls scheduleModel without passing linkTypes — a custom endpoint-kind "
      + "override would be silently ignored on the only path an operator actually runs");
    assert.match(src, /resolveSchema/,
      "audit-runner.mjs must resolve the schema rather than importing DEFAULT_LINK_TYPES directly");
  });
});
