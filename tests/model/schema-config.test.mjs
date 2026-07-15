import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSchema, validateSchema, checkSchemaVersion, SCHEMA_VERSION, MIN_SCHEMA_VERSION } from "../../scripts/model/schema-config.mjs";
import { DEFAULT_TYPES } from "../../scripts/model/schema.mjs";
import { DEFAULT_WORKFLOWS } from "../../scripts/model/workflows.mjs";

test("resolveSchema with no config/project returns the defaults", () => {
  const { types, workflows } = resolveSchema();
  assert.deepEqual(types, DEFAULT_TYPES);
  assert.deepEqual(workflows, DEFAULT_WORKFLOWS);
});

test("resolveSchema applies a top-level config override", () => {
  const feature = { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title"] };
  const { types } = resolveSchema({ config: { schema: { types: { feature } } } });
  assert.deepEqual(types.feature, feature);
  assert.ok(types.epic); // defaults preserved
});

test("resolveSchema layers per-project over top-level (project wins)", () => {
  const config = { schema: { types: { epic: { level: 1, workflow: "delivery", parentTypes: ["goal"], required: ["title"] } } } };
  const project = { schema: { types: { epic: { level: 1, workflow: "kanban", parentTypes: ["goal"], required: ["title", "estimate"] } } } };
  const { types } = resolveSchema({ config, project });
  assert.equal(types.epic.workflow, "kanban");
  assert.deepEqual(types.epic.required, ["title", "estimate"]);
});

test("resolveSchema layers workflow overrides from both scopes", () => {
  const config = { schema: { workflows: { kanban: { statuses: ["todo", "done"], terminal: ["done"], transitions: [["todo", "done"]], reopenTo: "todo", resolutionOnTerminal: { done: "done" } } } } };
  const project = { schema: { workflows: { delivery: { statuses: ["open", "closed"], terminal: ["closed"], transitions: [["open", "closed"]], reopenTo: "open", resolutionOnTerminal: { closed: "done" } } } } };
  const { workflows } = resolveSchema({ config, project });
  assert.ok(workflows.kanban);                                  // added top-level
  assert.deepEqual(workflows.delivery.statuses, ["open", "closed"]); // replaced per-project
  assert.ok(workflows.goal);                                    // default preserved
});

test("resolveSchema tolerates a config/project without a schema block", () => {
  const { types, workflows } = resolveSchema({ config: { key: "X" }, project: { key: "ENG" } });
  assert.deepEqual(types, DEFAULT_TYPES);
  assert.deepEqual(workflows, DEFAULT_WORKFLOWS);
});

test("validateSchema: accepts the resolved default schema", () => {
  const { types, workflows } = resolveSchema({});
  assert.deepEqual(validateSchema({ types, workflows }), []);
});

test("validateSchema: rejects a type mapped to an undeclared workflow", () => {
  const types = { task: { level: 0, workflow: "ghost", parentTypes: [], required: [] } };
  const workflows = { delivery: { statuses: ["defined"], terminal: [], transitions: [], reopenTo: "defined", resolutionOnTerminal: {} } };
  const errs = validateSchema({ types, workflows });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /task.*ghost/);
});

// --- config-schema version guard (ADR-0002) ---------------------------------

test("the engine's compat window is currently [1, 1]", () => {
  assert.equal(MIN_SCHEMA_VERSION, 1);
  assert.equal(SCHEMA_VERSION, 1);
});

test("checkSchemaVersion: an absent schemaVersion is legacy → treated as v1 → ok", () => {
  assert.deepEqual(checkSchemaVersion({ key: "OBA", projects: ["OBA"] }), { ok: true, error: null });
});

test("checkSchemaVersion: a null schemaVersion is treated as absent → ok", () => {
  assert.deepEqual(checkSchemaVersion({ schemaVersion: null }), { ok: true, error: null });
});

test("checkSchemaVersion: a version inside [MIN, CURRENT] is ok", () => {
  assert.deepEqual(checkSchemaVersion({ schemaVersion: 1 }), { ok: true, error: null });
  // injected window proves in-range acceptance is range-driven, not `=== 1`:
  assert.deepEqual(checkSchemaVersion({ schemaVersion: 2 }, { current: 3, min: 1 }), { ok: true, error: null });
});

test("checkSchemaVersion: a version newer than the engine fails, naming version, range, and docs", () => {
  const r = checkSchemaVersion({ schemaVersion: 99 });
  assert.equal(r.ok, false);
  assert.match(r.error, /board schemaVersion 99/);
  assert.match(r.error, /1\.\.1/);           // the engine's supported range
  assert.match(r.error, /docs\/schema-versioning\.md/);
});

test("checkSchemaVersion: the too-old branch is reachable with injected constants", () => {
  // Unreachable with the real constants (MIN === CURRENT === 1); the injectable
  // window exists precisely so this branch stays testable.
  const r = checkSchemaVersion({ schemaVersion: 1 }, { current: 3, min: 2 });
  assert.equal(r.ok, false);
  assert.match(r.error, /board schemaVersion 1 is older/);
  assert.match(r.error, /2\.\.3/);
  assert.match(r.error, /docs\/schema-versioning\.md/);
});

test("checkSchemaVersion: non-positive-integer stamps are invalid", () => {
  for (const bad of [0, -1, 1.5, "1", NaN, true, false, [1], { v: 1 }]) {
    const r = checkSchemaVersion({ schemaVersion: bad });
    assert.equal(r.ok, false, `schemaVersion ${String(bad)} must be rejected`);
    assert.match(r.error, /invalid schemaVersion/);
    assert.match(r.error, /positive integer/);
    assert.match(r.error, /docs\/schema-versioning\.md/);
  }
});

test("checkSchemaVersion: the invalid-stamp message renders the value legibly, not bare", () => {
  // A quoted-number stamp like "1" is the single most likely hand-edit typo —
  // the message must show it AS a string (`"1"`), never as the bare digit
  // `1`, which would read as self-contradictory ("1 IS a positive integer!").
  const quoted = checkSchemaVersion({ schemaVersion: "1" });
  assert.equal(quoted.ok, false);
  assert.match(quoted.error, /invalid schemaVersion "1" /, 'stamp "1" must render WITH quotes');
  assert.doesNotMatch(quoted.error, /invalid schemaVersion 1 /, 'stamp "1" must not render as bare 1');

  const arr = checkSchemaVersion({ schemaVersion: [] });
  assert.equal(arr.ok, false);
  assert.match(arr.error, /invalid schemaVersion \[\] /, "empty array must render as []");

  const obj = checkSchemaVersion({ schemaVersion: {} });
  assert.equal(obj.ok, false);
  assert.match(obj.error, /invalid schemaVersion \{\} /, "empty object must render as {}");

  const nan = checkSchemaVersion({ schemaVersion: NaN });
  assert.equal(nan.ok, false);
  assert.match(nan.error, /invalid schemaVersion NaN /, "NaN must render as NaN, not null");
});

test("checkSchemaVersion: error text names no command, only the docs path", () => {
  const failures = [
    checkSchemaVersion({ schemaVersion: 99 }),
    checkSchemaVersion({ schemaVersion: 1 }, { current: 3, min: 2 }),
    checkSchemaVersion({ schemaVersion: 0 }),
  ];
  for (const r of failures) {
    assert.equal(r.ok, false);
    // `blaze migrate` is the Jira importer — a version-mismatch error must never
    // send anyone there (or to any other verb). Docs pointer only.
    assert.doesNotMatch(r.error, /blaze \w+/, "guard must point at docs, never a command");
  }
});
