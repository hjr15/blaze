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
import { resolveSchema, validateSchema } from "../../scripts/model/schema-config.mjs";
import { DEFAULT_LINK_TYPES, mergeLinkTypes } from "../../scripts/model/link-schema.mjs";
import { DEFAULT_TYPES } from "../../scripts/model/schema.mjs";
import { readFileSync } from "node:fs";
import { scheduleModel } from "../../scripts/model/schedule.mjs";
import { scheduleFindings, auditCorpus, groupScheduleFindings, SCHEDULE_KINDS, SOFT_KINDS, HARD_KINDS }
  from "../../scripts/model/audit.mjs";
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
    // A NON-EMPTY array is the discriminating case: `Object.entries([])` is `[]`, so an empty
    // one reaches the same answer by a different route and passes even without the guard.
    for (const bad of [[{ name: "Precedes", source_kinds: [], target_kinds: [] }], [], "nope", 3, null]) {
      assert.deepEqual(mergeLinkTypes(DEFAULT_LINK_TYPES, bad), DEFAULT_LINK_TYPES);
    }
  });

  test("validateSchema reports an endpoint kind that is not a declared type", () => {
    // Without this, a typo'd kind matches nothing and the type it was meant to schedule stays
    // silently unschedulable — the same failure BLZ-392 exists to end, reintroduced by spelling.
    const errors = validateSchema({
      types: { task: { workflow: "delivery" } },
      workflows: { delivery: { statuses: ["defined"], terminal: [],
                               transitions: [], resolutionOnTerminal: {} } },
      linkTypes: [{ name: "Precedes", source_kinds: ["task", "spke"], target_kinds: ["task"] }],
    });
    assert.ok(errors.some((e) => /spke/.test(e)), `no error named the bad kind: ${errors.join(" | ")}`);
  });

  test("validateSchema is quiet when every endpoint kind is declared", () => {
    const errors = validateSchema({
      // BLZ-56 added shape checks, so these fixtures carry COMPLETE type records now.
      // They were minimal because this file is about link types — but a partial record is
      // genuinely invalid on a real board: `mergeTypes` replaces a whole entry, so an
      // override naming only `workflow` silently drops `level` and the hierarchy stops
      // comparing. Completing them keeps this file testing what it is about.
      types: {
        task: { level: 0, workflow: "delivery", parentTypes: [], required: [] },
        spike: { level: 0, workflow: "delivery", parentTypes: [], required: [] },
      },
      workflows: { delivery: { statuses: ["defined"], terminal: [],
                               transitions: [], resolutionOnTerminal: {} } },
      linkTypes: [{ name: "Precedes", source_kinds: ["task", "spike"], target_kinds: ["task", "spike"] }],
    });
    assert.deepEqual(errors, [], `unexpected errors: ${errors.join(" | ")}`);
  });
});

describe("BLZ-392: a malformed override is ignored AND reported, never silently applied", () => {
  // Every shape below used to collapse a working board to nothing scheduled, with no error and
  // no finding. A first fix made them THROW — which was worse than the bug: the throw escaped
  // audit-runner's deliberate config tolerance and `blaze audit` died with a raw stack trace and
  // NO REPORT, from inside auditCorpus, so the whole hygiene report was lost. It also inverted
  // the tolerance: an unparseable config still audited, a valid one with one bad field was fatal.
  //
  // So: the merge is TOTAL and keeps the default, and validateSchema reports the block — which
  // auditCorpus now actually calls.
  for (const [label, bad] of [
    ["null", null], ["an empty object", {}], ["a string", "yes"], ["an array", []],
    ["a number in source_kinds", { source_kinds: 5, target_kinds: ["task"] }],
    ["a string in source_kinds", { source_kinds: "spike", target_kinds: ["task"] }],
  ]) {
    test(`${label} does not throw, and leaves the shipped declaration in force`, () => {
      const cfg = { schema: { linkTypes: { Precedes: bad } } };
      let resolved;
      assert.doesNotThrow(() => { resolved = resolveSchema({ config: cfg }); },
        `${label} threw — that takes \`blaze audit\` down with a stack trace and no report`);
      assert.deepEqual(byName(resolved.linkTypes, "Precedes").source_kinds,
        DEFAULT_LINK_TYPES.find((l) => l.name === "Precedes").source_kinds,
        "a malformed override must leave the shipped kinds in force, not half-apply");
    });

    test(`${label} is REPORTED, so the operator learns the block did nothing`, () => {
      const cfg = { schema: { linkTypes: { Precedes: bad } } };
      const errors = validateSchema({ ...resolveSchema({ config: cfg }), config: cfg });
      assert.ok(errors.some((e) => /schema\.linkTypes\["Precedes"\]/.test(e)),
        `${label} was accepted in silence: ${errors.join(" | ") || "(no errors at all)"}`);
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

  for (const [label, block] of [["an array", ["Precedes"]], ["a string", "Precedes"], ["a number", 7]]) {
    test(`a BLOCK that is ${label} is reported, not silently dropped`, () => {
      // The merge ignores these, and the error function returned [] for exactly them — so the
      // silent drop this pair exists to end survived one level up, at the block rather than
      // the entry. Round 2's own test used a non-empty array as "the discriminating case" for
      // the merge and never checked that it was reported.
      const cfg = { schema: { linkTypes: block } };
      assert.deepEqual(resolveSchema({ config: cfg }).linkTypes, DEFAULT_LINK_TYPES,
        "a malformed block must leave the shipped declaration in force");
      const errors = validateSchema({ ...resolveSchema({ config: cfg }), config: cfg });
      assert.ok(errors.some((e) => /schema\.linkTypes must be an object/.test(e)),
        `a ${label} block was accepted in silence: ${errors.join(" | ") || "(no errors)"}`);
    });
  }

  test("a well-formed PER-PROJECT block is reported as inert, not as working", () => {
    // It resolves correctly and reaches nothing: both production callers pass `config` alone,
    // because a CPM solve spans the installation. Saying "the override was ignored" implied a
    // shape fix would make it work.
    const project = { schema: { linkTypes: { Precedes: {
      source_kinds: ["task"], target_kinds: ["task"], min_card: 0, max_card: null } } } };
    const errors = validateSchema({ ...resolveSchema({ config: null, project }), project });
    assert.ok(errors.some((e) => /does not reach the scheduler/.test(e)),
      `an inert per-project block was not reported: ${errors.join(" | ") || "(none)"}`);
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

    // The ENTRIES too. A first fix copied only the array, so this still corrupted the constant
    // process-wide — and the test above passed, because `.push` on the array is not the
    // reach a caller would actually make.
    resolveSchema({}).linkTypes.find((l) => l.name === "Precedes").source_kinds.push("PWNED");
    assert.ok(!DEFAULT_LINK_TYPES.find((l) => l.name === "Precedes").source_kinds.includes("PWNED"),
      "mutating a resolved entry's source_kinds corrupted DEFAULT_LINK_TYPES for every later caller");
    assert.ok(!resolveSchema({}).linkTypes.find((l) => l.name === "Precedes").source_kinds.includes("PWNED"),
      "a later resolve saw an entry mutation made to an earlier result");
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

// The source-grep guard that used to live here has been DELETED, and the reasoning is worth
// keeping because it took four review rounds to reach.
//
// It tried to prove, by scanning `audit-runner.mjs` and `schedule-runner.mjs`, that each passes
// scheduleModel/planDependencyImport a RESOLVED link-type list. Every version leaked:
//
//   round 1  a bare `linkTypes:` match passed even when the file passed the constant
//   round 2  a `//` comment satisfied it; the fix's own claim was that banning the identifier
//            made the bug "not expressible"
//   round 3  a `/*` inside a `//` comment swallowed 39 lines including the import block
//   round 4  `resolveSchema({})` reinstates the bug WITHOUT naming the constant, and one
//            ordinary regex literal collapsed the scanned file from 217 lines to 14
//
// Each fix was a better scanner. The mistake was scanning at all: the property is about what
// the runner DOES, and no amount of lexing a source file establishes that. The replacement is
// in `tests/audit-malformed-linktypes.test.mjs` — the real runners, on real boards, asserting
// that a custom type declared schedulable actually gets scheduled and that a broken override
// actually gets reported. Those cannot be satisfied by a comment, a regex literal, or an
// argument-less call.

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

describe("BLZ-392: nothing-is-schedulable is a FINDING, not a silent board-wide zero", () => {
  // The override that makes a custom type schedulable can equally make EVERYTHING
  // unschedulable, and every way of doing it is silent: the node set empties, every schedule
  // finding disappears with it, and the report is byte-identical to a healthy board — a
  // `deadline-unreachable` that fired yesterday simply stops.
  //
  // An OUTCOME check, deliberately, not a catalogue of causes. The first attempt enumerated
  // malformed shapes and missed the two most plausible operator typos precisely because they
  // are well-formed arrays.
  const dated = [t("A", { deadline: "2026-08-01" })];
  const kinds = (k) => resolveSchema({ config: { schema: { linkTypes: { Precedes: {
    inverse_name: "Follows", source_kinds: k, target_kinds: k, min_card: 0, max_card: null,
  } } } } }).linkTypes;
  const findingsFor = (linkTypes) => scheduleFindings(
    scheduleModel({ tickets: dated, links: [], schedule: SCHEDULE, now: MON, ...(linkTypes ? { linkTypes } : {}) }))
    .map((f) => f.kind);

  test("a healthy board reports its real finding and NOT schedule-empty", () => {
    // The control. Without it, a schedule-empty that fired always would look like a pass.
    const got = findingsFor(null);
    assert.ok(got.includes("deadline-unreachable"), `expected the real finding, got: ${got.join(",")}`);
    assert.ok(!got.includes("schedule-empty"), "schedule-empty fired on a healthy board");
  });

  for (const [label, k] of [["an empty source_kinds", []], ["a single typo'd kind", ["taks"]]]) {
    test(`${label} raises schedule-empty instead of vanishing`, () => {
      const got = findingsFor(kinds(k));
      assert.ok(got.includes("schedule-empty"),
        `${label} silently zeroed the board — findings were: ${got.join(",") || "(none)"}`);
      assert.ok(!got.includes("deadline-unreachable"),
        "the premise of this test is that the real finding disappears; it did not");
    });
  }

  test("a list with no Precedes at all raises it too", () => {
    assert.ok(findingsFor([]).includes("schedule-empty"));
  });

  test("an EMPTY board does not raise it — nothing scheduled is correct there", () => {
    // The denominator. Without `candidates` this fires on every empty project.
    const r = scheduleModel({ tickets: [], links: [], schedule: SCHEDULE, now: MON });
    assert.deepEqual(scheduleFindings(r).map((f) => f.kind), []);
  });

  test("a board that is all ONE DEPENDENCY CYCLE does not raise it", () => {
    // The regression the existing SCC test caught. Nothing schedules, but every ticket IS a
    // node — the board is schedulable and `dependency-cycle` already explains the outcome.
    // Keying on `scheduled.length` instead of the node count conflated the two.
    const r = scheduleModel({
      tickets: [t("A"), t("B")], links: [edge("A", "B"), edge("B", "A")],
      schedule: SCHEDULE, now: MON });
    const kinds = scheduleFindings(r).map((f) => f.kind);
    assert.ok(kinds.includes("dependency-cycle"), `expected the cycle finding, got: ${kinds.join(",")}`);
    assert.ok(!kinds.includes("schedule-empty"),
      "schedule-empty fired on a cyclic board, where dependency-cycle is the real answer");
  });

  // R3-2: the denominator. Counting EVERY non-terminal ticket fired this on ordinary boards
  // under a DEFAULT schema, because goal/risk/requirement/architecture/epic are excluded from
  // the schedule by design — a requirements-first board was told to "check schema.linkTypes"
  // when it had none.
  for (const [label, tickets] of [
    ["a goal and a requirement", [t("G", { type: "goal" }), t("R", { type: "requirement", status: "proposed" })]],
    ["an open goal beside a finished task", [t("G", { type: "goal" }), t("T", { status: "done" })]],
    ["a lone epic", [t("E", { type: "epic" })]],
  ]) {
    test(`${label} does NOT raise it — nothing there was ever schedulable`, () => {
      const r = scheduleModel({ tickets, links: [], schedule: SCHEDULE, now: MON });
      assert.equal(r.candidates, 0,
        `the denominator counted ${r.candidates} — it must count only what the SHIPPED kinds would schedule`);
      assert.ok(!scheduleFindings(r).map((f) => f.kind).includes("schedule-empty"),
        `schedule-empty fired on ${label} under a default schema`);
    });
  }

  // R5: the denominator's third attempt. Counting every UNDECLARED type reopened the first
  // fault, because `terminalOf` swallows `workflowFor`'s throw — so a typo, a missing `type:`
  // key and an empty string all counted as "a type the operator added", and each board was
  // told to check a `schema.linkTypes` it does not have.
  for (const [label, type] of [["a typo'd type", "taks"], ["an empty type", ""],
                               ["a missing type", null], ["an unknown type", "widget"]]) {
    test(`${label} is not a schedulable candidate`, () => {
      const r = scheduleModel({
        tickets: [t("X", { type, deadline: "2026-08-01" })], links: [],
        schedule: SCHEDULE, now: MON });
      assert.equal(r.candidates, 0,
        `${label} counted as a candidate — schedule-empty will fire on a board with no override`);
      assert.ok(!scheduleFindings(r).map((f) => f.kind).includes("schedule-empty"),
        `schedule-empty fired for ${label}`);
    });
  }

  test("a board of only TERMINAL tickets does not raise it either", () => {
    const r = scheduleModel({
      tickets: [t("D", { status: "done" })], links: [], schedule: SCHEDULE, now: MON });
    assert.ok(!scheduleFindings(r).map((f) => f.kind).includes("schedule-empty"),
      "a finished board is not an unschedulable one");
  });
});

describe("BLZ-392: validateSchema reports malformed kinds rather than throwing", () => {
  // This guard shipped with NO test: the whole 2234-test suite stayed green with it removed,
  // and both original symptoms came straight back — a throw on a number (contradicting the
  // contract stated in the comment beside it) and five bogus errors for `"spike"`, one per
  // character, because `for...of` iterates a string.
  const base = {
    // Complete type record — see the BLZ-56 note above. These tests assert an error
    // COUNT, so a fixture that is itself invalid would add errors and hide the one they
    // are actually about.
    types: { task: { level: 0, workflow: "delivery", parentTypes: [], required: [] } },
    workflows: { delivery: { statuses: ["defined"], terminal: [],
                               transitions: [], resolutionOnTerminal: {} } },
  };
  for (const [label, kinds] of [["a number", 5], ["an object", {}], ["a string", "spike"], ["null", null]]) {
    test(`${label} in source_kinds is ONE reported error, never a throw`, () => {
      let errors;
      assert.doesNotThrow(() => {
        errors = validateSchema({ ...base,
          linkTypes: [{ name: "Precedes", source_kinds: kinds, target_kinds: ["task"] }] });
      }, `${label} threw — validateSchema's contract is to return errors, not to refuse`);
      assert.equal(errors.length, 1,
        `expected exactly one error for ${label}, got ${errors.length}: ${errors.join(" | ")}`);
      assert.match(errors[0], /not an array/);
    });
  }

  test("a string is not iterated per character", () => {
    const errors = validateSchema({ ...base,
      linkTypes: [{ name: "Precedes", source_kinds: "spike", target_kinds: ["task"] }] });
    assert.ok(!errors.some((e) => /"s"|"p"|"i"|"k"|"e"/.test(e)),
      `the string was iterated per character: ${errors.join(" | ")}`);
  });
});

describe("BLZ-392: auditCorpus surfaces schema findings per layer", () => {
  // The restructure that reports the top layer once and each project separately shipped with
  // NO test: dropping the top-layer suppression AND making the per-project loop never run both
  // left the full suite green. Only a subprocess test touched `schema-invalid`, and only via
  // the top-level config.
  const ticket = (key, n) => ({
    frontmatter: { id: `${key}-${n}`, type: "task", project: key, estimate: 480 },
    status: "defined",
  });
  const badBlock = { schema: { linkTypes: { Precedes: {} } } };
  const kinds = (f) => f.filter((x) => x.kind === "schema-invalid");

  test("a top-level block is reported ONCE, not once per project", () => {
    const { findings } = auditCorpus({
      tickets: [ticket("AAA", 1), ticket("BBB", 1)],
      projects: { AAA: {}, BBB: {} },
      config: { ...badBlock, projects: ["AAA", "BBB"] },
    });
    const got = kinds(findings);
    assert.ok(got.length > 0, "the malformed top-level block was not reported at all");
    assert.deepEqual([...new Set(got.map((f) => f.ticket))], ["-"],
      `the top layer must be attributed to "-", got: ${got.map((f) => f.ticket).join(",")}`);
    // Two projects, one block: two copies would be noise that hides the signal.
    assert.equal(new Set(got.map((f) => f.detail)).size, got.length,
      `duplicate findings for one block: ${got.map((f) => f.detail).join(" | ")}`);
  });

  test("two projects with their OWN broken block are reported separately", () => {
    // Deduping by message collapsed these to one, attributed to whichever sorted first — an
    // operator fixes it, re-runs, and discovers the next.
    const { findings } = auditCorpus({
      tickets: [ticket("AAA", 1), ticket("BBB", 1)],
      projects: { AAA: badBlock, BBB: badBlock },
      config: { projects: ["AAA", "BBB"] },
    });
    const owners = kinds(findings).map((f) => f.ticket).sort();
    assert.deepEqual(owners, ["AAA", "BBB"],
      `both projects must be named, got: ${owners.join(",") || "(none)"}`);
  });

  test("a project inherits no finding from a clean top layer", () => {
    const { findings } = auditCorpus({
      tickets: [ticket("AAA", 1)], projects: { AAA: {} }, config: { projects: ["AAA"] },
    });
    assert.deepEqual(kinds(findings), [],
      `schema-invalid fired on an entirely clean board: ${JSON.stringify(kinds(findings))}`);
  });

  test("one per-project block yields ONE finding, not a contradictory pair", () => {
    // It used to produce both "fix the kind" and "this can never reach the scheduler".
    const { findings } = auditCorpus({
      tickets: [ticket("AAA", 1)],
      projects: { AAA: { schema: { linkTypes: { Precedes: { source_kinds: ["spke"], target_kinds: ["spke"] } } } } },
      config: { projects: ["AAA"] },
    });
    const got = kinds(findings);
    assert.equal(got.length, 1, `expected one finding, got: ${got.map((f) => f.detail).join(" | ")}`);
    assert.match(got[0].detail, /does not reach the scheduler/);
  });
});

describe("BLZ-392: the finding registries stay in step with what the code emits", () => {
  // Both of these shipped with ZERO coverage in the round that added them: deleting
  // `schedule-empty` from SCHEDULE_KINDS survived the targeted suite, and deleting its arm of
  // the `noun` ternary survived the FULL suite. So the grouper could go back to labelling it
  // "tickets carrying a stale schedule" — a wrong sentence in the function whose own header
  // says it exists so `blaze audit` and the view layer cannot drift.
  test("groupScheduleFindings gives schedule-empty its own noun", () => {
    const [group] = groupScheduleFindings([
      { ticket: "-", kind: "schedule-empty", detail: "nothing is schedulable" },
    ]);
    assert.equal(group.kind, "schedule-empty");
    assert.doesNotMatch(group.summary, /stale schedule/,
      `schedule-empty fell through to another kind's noun: ${group.summary}`);
    assert.match(group.summary, /schedulable/, `unexpected summary: ${group.summary}`);
  });

  test("every schedule kind is a declared soft kind", () => {
    // Adding a kind to scheduleFindings without registering it is how both defects happened.
    for (const k of SCHEDULE_KINDS) {
      assert.ok(SOFT_KINDS.includes(k), `${k} is emitted but not declared soft`);
      assert.ok(!HARD_KINDS.has(k), `${k} is both hard and a schedule kind`);
    }
    assert.ok(SCHEDULE_KINDS.includes("schedule-empty"),
      "schedule-empty is emitted by scheduleFindings but not registered as a schedule kind, "
      + "so the grouper mislabels it");
  });

  test("a repeated bad endpoint kind is ONE finding, not two identical ones", () => {
    // The top-layer dedup: `["taks","taks"]` produces the same error string twice.
    const cfg = { projects: ["AAA"], schema: { linkTypes: { Precedes: {
      source_kinds: ["taks", "taks"], target_kinds: ["task"], min_card: 0, max_card: null } } } };
    const { findings } = auditCorpus({
      tickets: [{ frontmatter: { id: "AAA-1", type: "task", project: "AAA", estimate: 480 }, status: "defined" }],
      projects: { AAA: {} }, config: cfg,
    });
    const got = findings.filter((f) => f.kind === "schema-invalid" && /taks/.test(f.detail));
    assert.equal(got.length, 1,
      `the same error was reported ${got.length} times: ${got.map((f) => f.detail).join(" | ")}`);
  });
});

describe("BLZ-392: an endpoint kind declared by a PROJECT is not called undeclared", () => {
  test("a top-level Precedes may name a type only one project declares", () => {
    // This produced a finding its own report contradicted: "spike is not a declared type, so it
    // stays unschedulable", printed in the same audit as a `deadline-unreachable` proving a
    // spike had just been scheduled. A type's WORKFLOW is judged against the layer that
    // declares it; an ENDPOINT KIND has to be judged against every type that exists.
    const config = { projects: ["AAA"], schema: { linkTypes: { Precedes: {
      source_kinds: ["task", "spike"], target_kinds: ["task", "spike"],
      min_card: 0, max_card: null } } } };
    const projects = { AAA: { schema: { types: {
      spike: { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title"] } } } } };
    const { findings } = auditCorpus({
      tickets: [{ frontmatter: { id: "AAA-1", type: "task", project: "AAA", estimate: 480 }, status: "defined" }],
      projects, config,
    });
    const bogus = findings.filter((f) => f.kind === "schema-invalid" && /spike/.test(f.detail));
    assert.deepEqual(bogus, [],
      `a project-declared type was reported as undeclared: ${bogus.map((f) => f.detail).join(" | ")}`);
  });

  test("a kind no layer declares is still reported — the control", () => {
    const config = { projects: ["AAA"], schema: { linkTypes: { Precedes: {
      source_kinds: ["task", "spke"], target_kinds: ["task"], min_card: 0, max_card: null } } } };
    const { findings } = auditCorpus({
      tickets: [{ frontmatter: { id: "AAA-1", type: "task", project: "AAA", estimate: 480 }, status: "defined" }],
      projects: { AAA: {} }, config,
    });
    assert.ok(findings.some((f) => f.kind === "schema-invalid" && /spke/.test(f.detail)),
      "a genuinely undeclared endpoint kind was not reported");
  });
});

describe("BLZ-392: the schedule model reads no ambient state", () => {
  // `candidates` briefly asked `workflowFor`, which reads `schema.mjs`'s ambient TYPES — built
  // at import time from whatever blaze.config.json the CWD resolves to. The model then gave
  // different answers in different directories: `blaze audit <dir>` positionally lost the
  // finding, an unrelated board's config could conjure one, and a test in this very file failed
  // when run from a board directory. The registry is a parameter now, like `linkTypes`.
  test("a custom delivery type counts only when the PASSED registry declares it", () => {
    const t0 = t("S", { type: "spike", deadline: "2026-08-01" });
    const bare = scheduleModel({ tickets: [t0], links: [], schedule: SCHEDULE, now: MON });
    assert.equal(bare.candidates, 0,
      "an unknown type counted with no registry saying it is a delivery type");
    const withReg = scheduleModel({
      tickets: [t0], links: [], schedule: SCHEDULE, now: MON,
      types: { ...DEFAULT_TYPES, spike: { level: 0, workflow: "delivery", parentTypes: [], required: [] } } });
    assert.equal(withReg.candidates, 1, "the passed registry was ignored");
  });

  test("a custom NON-delivery type still does not count, even when passed", () => {
    const withReg = scheduleModel({
      tickets: [t("D", { type: "decision" })], links: [], schedule: SCHEDULE, now: MON,
      types: { ...DEFAULT_TYPES, decision: { level: 2, workflow: "architecture", parentTypes: [], required: [] } } });
    assert.equal(withReg.candidates, 0, "a non-delivery custom type counted as schedulable");
  });

  test("the model does not IMPORT the ambient registry helpers", () => {
    // The determinism grep next door bans Date.now/Math.random; ambient FILESYSTEM reads were
    // invisible to it, which is how this shipped. `workflowFor`, `requiredFields`,
    // `hierarchyLevel` and `allTypes` all resolve through `TYPES`, which is CWD-dependent.
    //
    // Checks the IMPORT LIST, not the whole file: the comments explaining this defect name
    // `workflowFor` on purpose, and a test that cannot survive its own subject's documentation
    // is a test that will be deleted the first time someone edits a comment.
    const src = readFileSync(new URL("../../scripts/model/schedule.mjs", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import\s+\{([^}]*)\}\s+from\s+"([^"]+)"/gm)]
      .flatMap((m) => m[1].split(",").map((x) => x.trim()));
    // `isTerminal` and `workflowDef` reach the same ambient state THROUGH `workflows.mjs`, which
    // is how the terminal-ticket defect got in after `workflowFor` itself was removed. `TYPES`
    // and `WORKFLOWS` are the ambient objects; importing either is the same mistake by value.
    for (const helper of ["workflowFor", "requiredFields", "hierarchyLevel", "allTypes",
                          "isTerminal", "workflowDef", "statusesFor", "initialStatus",
                          "TYPES", "WORKFLOWS"]) {
      assert.ok(!imports.includes(helper),
        `schedule.mjs imports ${helper}, which reads the ambient registry — pass the value instead`);
    }
    for (const constant of ["DEFAULT_TYPES", "DEFAULT_WORKFLOWS"]) {
      assert.ok(imports.includes(constant),
        `the model should take ${constant} as a value`);
    }
  });
});

describe("BLZ-392: the finding registries are complete, not just consistent", () => {
  // SOFT_KINDS exists because `--help`'s list went stale twice. It shipped guarded only by
  // `SCHEDULE_KINDS ⊆ SOFT_KINDS`, which covers 4 of its 9 entries — so dropping
  // `schema-invalid` or `empty-labels`, or adding a phantom, all survived the full suite.
  const KIND_LITERAL = /(?:add\([^,]+,\s*|kind:\s*)"([a-z][a-z0-9-]+)"/g;
  const EMITTERS = ["../../scripts/model/audit.mjs", "../../scripts/audit-runner.mjs"];

  test("every kind the audit emits is registered as hard or soft", () => {
    const emitted = [...new Set(EMITTERS.flatMap((f) =>
      [...readFileSync(new URL(f, import.meta.url), "utf8").matchAll(KIND_LITERAL)].map((m) => m[1])))];
    assert.ok(emitted.length > 8, `only ${emitted.length} kinds found — the scan is not working`);
    const known = new Set([...SOFT_KINDS, ...HARD_KINDS]);
    const missing = emitted.filter((k) => !known.has(k));
    assert.deepEqual(missing, [],
      `emitted but registered nowhere, so \`blaze audit --help\` will not list them: ${missing.join(", ")}`);
  });

  test("SOFT_KINDS carries no phantom", () => {
    // BOTH emitters. `terminal-goal-unverified-requirement` is pushed from `audit-runner.mjs`,
    // not `audit.mjs`, so scanning the model alone reported a real kind as a phantom.
    const emitted = new Set(EMITTERS.flatMap((f) =>
      [...readFileSync(new URL(f, import.meta.url), "utf8").matchAll(KIND_LITERAL)].map((m) => m[1])));
    const phantom = SOFT_KINDS.filter((k) => !emitted.has(k));
    assert.deepEqual(phantom, [], `declared soft but never emitted: ${phantom.join(", ")}`);
  });

  test("hard and soft are disjoint", () => {
    const both = SOFT_KINDS.filter((k) => HARD_KINDS.has(k));
    assert.deepEqual(both, [], `declared both hard and soft: ${both.join(", ")}`);
  });
});

describe("BLZ-392: the endpoint-kind union reaches the PROJECT layer too", () => {
  test("two projects — one declaring the type — produce no bogus finding for either", () => {
    // The one-project test could not see this: `topLevel.has(e)` masked the project layer
    // entirely, so dropping `endpointTypes` from the per-project call survived the full suite.
    const config = { projects: ["AAA", "BBB"], schema: { linkTypes: { Precedes: {
      source_kinds: ["task", "spike"], target_kinds: ["task", "spike"],
      min_card: 0, max_card: null } } } };
    const projects = {
      AAA: { schema: { types: {
        spike: { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title"] } } } },
      BBB: {},
    };
    const { findings } = auditCorpus({
      tickets: [
        { frontmatter: { id: "AAA-1", type: "task", project: "AAA", estimate: 480 }, status: "defined" },
        { frontmatter: { id: "BBB-1", type: "task", project: "BBB", estimate: 480 }, status: "defined" },
      ], projects, config,
    });
    const bogus = findings.filter((f) => f.kind === "schema-invalid" && /spike/.test(f.detail));
    assert.deepEqual(bogus, [],
      `a type declared by a sibling project was called undeclared: ${bogus.map((f) => `${f.ticket}: ${f.detail}`).join(" | ")}`);
  });
});

describe("BLZ-392: a terminal ticket of a CUSTOM type is still terminal", () => {
  // The state ADR-0022 forbids outright, reachable only once resolved `linkTypes` let a custom
  // type be a node: `terminalOf` read `isTerminal`, which resolves through the ambient
  // registries and THREW for a type they do not know — the catch swallowed it and the ticket
  // was declared non-terminal. A `done` spike therefore became a CPM node, had its frozen
  // actuals overwritten with dates months in the future, and was put on the critical path.
  //
  // `mutate-schedule.mjs` mutation #5 exists to kill exactly that and did not, because every
  // terminal-exemption test uses a SHIPPED type, where `isTerminal` happens to answer.
  const SPIKE = { spike: { level: 0, workflow: "delivery", parentTypes: [], required: [] } };
  const wide = [{ name: "Precedes", source_kinds: ["spike"], target_kinds: ["spike"], min_card: 0, max_card: null }];
  const run = (status) => scheduleModel({
    tickets: [{ id: "S", type: "spike", status, estimate_minutes: 4800,
                constraint_start_no_earlier_than: null, deadline: "2026-08-26",
                start_date: "2026-01-02", due_date: "2026-01-05" }],
    links: [], schedule: SCHEDULE, now: MON,
    linkTypes: wide, types: { ...DEFAULT_TYPES, ...SPIKE } });

  test("a done custom-type ticket is NOT a node and keeps its actuals", () => {
    const r = run("done");
    assert.equal(r.node_count, 0,
      "a finished ticket became a CPM node — its frozen actuals are being replanned");
    assert.deepEqual(r.scheduled, [], `a terminal ticket was scheduled: ${JSON.stringify(r.scheduled)}`);
    assert.deepEqual(scheduleFindings(r).map((f) => f.kind), [],
      "a finished board produced schedule findings");
  });

  test("a non-terminal one of the same type still IS a node — the control", () => {
    const r = run("defined");
    assert.equal(r.node_count, 1, "the custom type stopped being schedulable altogether");
  });

  test("terminality comes from the PASSED workflows, not an ambient lookup", () => {
    // Same ticket, same status, a registry that calls `done` non-terminal.
    const r = scheduleModel({
      tickets: [{ id: "S", type: "spike", status: "done", estimate_minutes: 480,
                  constraint_start_no_earlier_than: null, deadline: null,
                  start_date: null, due_date: null }],
      links: [], schedule: SCHEDULE, now: MON, linkTypes: wide,
      types: { ...DEFAULT_TYPES, ...SPIKE },
      workflows: { delivery: { statuses: ["defined", "done"], terminal: [] } } });
    assert.equal(r.node_count, 1, "the passed workflow registry was ignored");
  });
});

describe("BLZ-392: a malformed workflow does not take the model down", () => {
  test("a workflow override with no `terminal` list is survivable", () => {
    // Replacing the old try/catch with a bare property read made this throw a TypeError out of
    // scheduleModel, which in `blaze audit` means the whole hygiene report is lost — the exact
    // failure the subprocess suite was written to prevent, reintroduced one file over.
    assert.doesNotThrow(() => scheduleModel({
      tickets: [t("A")], links: [], schedule: SCHEDULE, now: MON,
      types: { ...DEFAULT_TYPES, task: { level: 0, workflow: "broken", parentTypes: [], required: [] } },
      workflows: { broken: { statuses: ["defined", "done"], transitions: [["defined", "done"]] } },
    }), "a workflow with no `terminal` key threw out of the model");
  });

  test("and such a ticket is treated as non-terminal, not silently skipped", () => {
    const r = scheduleModel({
      tickets: [t("A")], links: [], schedule: SCHEDULE, now: MON,
      types: { ...DEFAULT_TYPES, task: { level: 0, workflow: "broken", parentTypes: [], required: [] } },
      workflows: { broken: { statuses: ["defined"], transitions: [] } },
    });
    assert.equal(r.node_count, 1, "the ticket vanished from the graph entirely");
  });
});
