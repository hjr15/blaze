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
import { planDependencyImport, DISPOSITION } from "../../scripts/model/import-deps.mjs";

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

describe("BLZ-392: a malformed override is refused by name, never silently applied", () => {
  // EVERY shape below used to collapse a working board to nothing scheduled, with no error, no
  // finding, and a scheduleFindings() result identical to a healthy board. Adversarial review
  // found all five. A silent board-wide zero is the worst failure this feature could have, and
  // it needed no exotic input — `{}` and a typo'd `name` both did it.
  for (const [label, bad] of [
    ["null", null], ["an empty object", {}], ["a string", "yes"], ["an array", []],
    ["a number in source_kinds", { source_kinds: 5, target_kinds: ["task"] }],
    ["a string in source_kinds", { source_kinds: "spike", target_kinds: ["task"] }],
  ]) {
    test(`${label} is a named refusal`, () => {
      assert.throws(
        () => resolveSchema({ config: { schema: { linkTypes: { Precedes: bad } } } }),
        /schema\.linkTypes\["Precedes"\]/,
        `${label} was accepted — it would zero the schedule with no signal`);
    });
  }

  test("a typo'd `name` field cannot orphan the entry — the KEY is the identity", () => {
    // The nastiest of the five: the operator DID declare Precedes, as the key, and merely
    // mistyped the redundant `name`. Replacement happened by key, lookup happened by name, and
    // the result was a Precedes nothing could find. Now the key wins outright.
    const { linkTypes } = resolveSchema({ config: { schema: { linkTypes: { Precedes: {
      name: "Preceeds", source_kinds: ["task", "spike"], target_kinds: ["task", "spike"],
      min_card: 0, max_card: null } } } } });
    const p = byName(linkTypes, "Precedes");
    assert.ok(p, "the override orphaned Precedes — nothing would be schedulable");
    assert.ok(p.source_kinds.includes("spike"), "the override did not take effect");
    assert.equal(linkTypes.filter((l) => l.name === "Precedes").length, 1,
      "two entries named Precedes — .find would silently pick one of them");
  });

  test("a key that is not a default appends under the KEY, shadowing nothing", () => {
    // `{ Foo: { name: "Precedes" } }` used to append a SECOND entry named Precedes that `.find`
    // never reached, silently discarding the override.
    const { linkTypes } = resolveSchema({ config: { schema: { linkTypes: { Foo: {
      name: "Precedes", source_kinds: ["spike"], target_kinds: ["spike"],
      min_card: 0, max_card: null } } } } });
    assert.equal(linkTypes.filter((l) => l.name === "Precedes").length, 1);
    assert.ok(byName(linkTypes, "Foo"), "the entry should exist under its key");
    assert.deepEqual(byName(linkTypes, "Precedes").source_kinds,
      DEFAULT_LINK_TYPES.find((l) => l.name === "Precedes").source_kinds,
      "the real Precedes must be untouched by an override filed under another key");
  });

  test("the resolved list is a COPY — a caller cannot corrupt the module constant", () => {
    // `mergeTypes`/`mergeWorkflows` return `{ ...defaults }` precisely so this is impossible;
    // this returned `defaults` bare, so resolveSchema({}).linkTypes WAS DEFAULT_LINK_TYPES and
    // pushing to it changed what every later resolve saw, process-wide.
    const first = resolveSchema({}).linkTypes;
    assert.notEqual(first, DEFAULT_LINK_TYPES, "the live module constant was handed out");
    first.push({ name: "Injected", source_kinds: [], target_kinds: [] });
    assert.equal(byName(resolveSchema({}).linkTypes, "Injected"), undefined,
      "a later resolve saw a mutation made to an earlier result");
    assert.equal(DEFAULT_LINK_TYPES.length, 6, "the module constant itself was grown");
  });
});

describe("BLZ-392: the solve honours the resolved endpoint kinds", () => {
  test("a list declaring no Precedes schedules nothing, rather than falling back", () => {
    // A stated decision in ADR-0022 with, until review pointed it out, no test: silently
    // falling back to the default would schedule a board the operator's declaration says is
    // unschedulable, behind their back. Not reachable through an override any more — the merge
    // can only replace or append — but scheduleModel is public and takes any list.
    const r = scheduleModel({
      tickets: [t("A"), t("B")], links: [edge("A", "B")],
      schedule: SCHEDULE, now: MON, linkTypes: [] });
    assert.deepEqual(r.scheduled, [], "a list with no Precedes still scheduled something");
  });

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
    // The key is `dropped_edges`. This read `r.dropped`, which is always undefined, so the
    // assertion could never fail — it passed against a result that HAD dropped the edge for
    // exactly this reason. Found by adversarial review; the test's other assertion still
    // discriminated, but the one described as the direct check was dead.
    assert.ok(!(r.dropped_edges ?? []).some((d) => d.reason === "undeclared-kind"),
      `the edge was dropped: ${JSON.stringify(r.dropped_edges)}`);
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

/** Source with `//` line comments removed, so commenting a line out cannot satisfy a grep. */
function uncommented(url) {
  return readFileSync(new URL(url, import.meta.url), "utf8")
    .split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
}

describe("BLZ-392: both production paths pass the resolved kinds, not the constant", () => {
  // Both model functions default `linkTypes` to DEFAULT_LINK_TYPES so they stay usable
  // standalone. That default is a trap for exactly the production callers, because forgetting
  // to pass the resolved value reinstates the bug with NO visible symptom.
  //
  // The first version of this guard was `/scheduleModel\(\{[\s\S]*?linkTypes:/` and adversarial
  // review defeated it seven ways out of eight — most damningly, it passed when the file
  // passed `linkTypes: DEFAULT_LINK_TYPES`, which is the exact original bug the guard names in
  // its own failure message. Two changes fix that: comments are stripped first, and the guard
  // requires the resolved EXPRESSION rather than the mere presence of the key.
  //
  // Stated plainly: no grep over source text proves runtime behaviour. What makes this one
  // load-bearing is the companion assertion that the runner does not import the constant at
  // all — with it out of scope, passing it is not expressible.
  for (const [file, fn] of [["../../scripts/audit-runner.mjs", "scheduleModel"],
                            ["../../scripts/schedule-runner.mjs", "planDependencyImport"]]) {
    test(`${file.split("/").pop()} passes ${fn} a resolved link-type list`, () => {
      const src = uncommented(file);
      assert.match(src, /linkTypes:\s*(RESOLVED_LINK_TYPES|resolveSchema\()/,
        `${file} does not pass a RESOLVED linkTypes value — a custom endpoint-kind override `
        + "would be silently ignored on a path an operator actually runs");
      assert.match(src, /resolveSchema/, `${file} must resolve the schema`);
      assert.doesNotMatch(src, /DEFAULT_LINK_TYPES/,
        `${file} imports or names DEFAULT_LINK_TYPES — while the constant is in scope, passing `
        + "it instead of the resolved list stays expressible, and that is the original bug");
    });
  }
});

describe("BLZ-392: the import planner honours the same resolved kinds as the solve", () => {
  // The capability was half-shipped: BLZ-392 made the SOLVE's endpoint kinds overridable and
  // left `import-deps.mjs` reading the constant. An operator could make `spike` a node, watch
  // it get scheduled, and then find `blaze schedule import-deps` REFUSING every edge into it —
  // the planner that CREATES the edges the solve consumes was still gated on the unoverridable
  // constant, so the feature worked right up to the point of being usable.
  const spikes = [
    { id: "S1", type: "spike", status: "defined", links: [] },
    { id: "S2", type: "spike", status: "defined", links: [] },
  ];
  const blocks = [{ type: "Blocks", src: "S1", target: "S2" }];
  const widened = () => resolveSchema({ config: { schema: { linkTypes: { Precedes: {
    inverse_name: "Follows",
    source_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
    target_kinds: ["feature", "story", "task", "bug", "subtask", "spike"],
    min_card: 0, max_card: null } } } } }).linkTypes;

  test("without an override the planner refuses a spike edge", () => {
    // The control. Without it the next test could pass for any reason at all.
    const plan = planDependencyImport({ tickets: spikes, links: blocks });
    assert.equal(plan.edges[0].disposition, DISPOSITION.REFUSED);
    assert.match(plan.edges[0].reason, /declares no such endpoint/);
  });

  test("with the resolved override the planner PROPOSES it", () => {
    const plan = planDependencyImport({ tickets: spikes, links: blocks, linkTypes: widened() });
    assert.equal(plan.edges[0].disposition, DISPOSITION.PROPOSED,
      `the planner still refuses the edge: ${plan.edges[0].reason} — the override reaches the `
      + "solve but not the planner, so the type is schedulable but undependable");
  });

  test("the planner and the solve agree on the same list", () => {
    // The invariant that matters across modules, not just within schedule.mjs: one resolved
    // list, both readers. If they disagreed, an operator could import an edge the solve then
    // drops, or vice versa — and neither would report anything.
    const linkTypes = widened();
    const plan = planDependencyImport({ tickets: spikes, links: blocks, linkTypes });
    const solved = scheduleModel({
      tickets: spikes.map((t) => ({ ...t, estimate_minutes: 480,
        constraint_start_no_earlier_than: null, deadline: null, start_date: null, due_date: null })),
      links: [edge("S1", "S2")], schedule: SCHEDULE, now: MON, linkTypes });
    assert.equal(plan.edges[0].disposition, DISPOSITION.PROPOSED);
    assert.equal(solved.scheduled.length, 2, "the solve did not schedule what the planner proposed");
    assert.deepEqual(solved.dropped_edges ?? [], [],
      "the solve dropped an edge the planner proposed — the two readers disagree");
  });
});
