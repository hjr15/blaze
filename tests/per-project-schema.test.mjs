// tests/per-project-schema.test.mjs — BLZ-238.
//
// `resolveSchema` layered `default → top-level → per-project` and NOTHING called it, so a
// `schema` block in `projects/<KEY>/project.json` parsed, validated, and had no effect on
// anything. REQ-047 ("schema customisation is scoped to one project") could not be met.
//
// It bit during the portfolio rollout: one shared registry made tightening all-or-nothing
// across eleven projects, which is the whole reason the additive → migrate → tighten
// sequence was needed rather than tightening each project as it finished.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateTicket } from "../scripts/model/rules.mjs";
import { resolveSchema } from "../scripts/model/schema-config.mjs";
import { DEFAULT_TYPES } from "../scripts/model/schema.mjs";

const T = (fm, body = "x") => ({ frontmatter: fm, body });

test("validateTicket uses the ambient registry when given no schema", () => {
  const feature = T({ id: "A-1", type: "feature", title: "f", parent: "" });
  const task = T({ id: "A-2", type: "task", title: "t", estimate: 30, parent: "A-1" });
  assert.deepEqual(validateTicket(task, () => feature), []);
});

test("a per-project registry can WIDEN what a project accepts", () => {
  // This project alone keeps the legacy epic→task edge that the shipped default retires.
  const { types } = resolveSchema({
    project: { schema: { types: {
      epic: { level: 1, workflow: "delivery", parentTypes: ["goal"], required: ["title", "description"] },
      task: { level: 0, workflow: "delivery", parentTypes: ["epic", "feature", "story"], required: ["title", "description", "estimate"] },
    } } },
  });
  const epic = T({ id: "A-1", type: "epic", title: "e", parent: "" });
  const task = T({ id: "A-2", type: "task", title: "t", estimate: 30, parent: "A-1" });

  assert.deepEqual(validateTicket(task, () => epic, { types }), [],
    "the project's own registry should permit its legacy edge");
  const withDefault = validateTicket(task, () => epic);
  assert.ok(withDefault.some((e) => /invalid parent/.test(e)),
    "and the shipped default should still refuse it — otherwise the override proved nothing");
});

test("a per-project registry can NARROW what a project accepts", () => {
  const { types } = resolveSchema({
    project: { schema: { types: {
      task: { level: 0, workflow: "delivery", parentTypes: ["story"], required: ["title", "description", "estimate"] },
    } } },
  });
  const feature = T({ id: "A-1", type: "feature", title: "f", parent: "" });
  const task = T({ id: "A-2", type: "task", title: "t", estimate: 30, parent: "A-1" });
  assert.ok(validateTicket(task, () => feature, { types }).some((e) => /invalid parent/.test(e)),
    "this project alone forbids task→feature");
  assert.deepEqual(validateTicket(task, () => feature), [], "the default still allows it");
});

test("a per-project override wins over the top-level one for the same entry", () => {
  const { types } = resolveSchema({
    config:  { schema: { types: { task: { level: 0, workflow: "delivery", parentTypes: ["feature"], required: ["title"] } } } },
    project: { schema: { types: { task: { level: 0, workflow: "delivery", parentTypes: ["story"],   required: ["title"] } } } },
  });
  assert.deepEqual(types.task.parentTypes, ["story"]);
});

test("a per-project override does not leak into the shipped defaults", () => {
  const before = JSON.stringify(DEFAULT_TYPES);
  resolveSchema({ project: { schema: { types: { task: { level: 9, workflow: "delivery", parentTypes: [], required: [] } } } } });
  assert.equal(JSON.stringify(DEFAULT_TYPES), before, "resolveSchema must not mutate the defaults");
});

test("required fields come from the project's registry too", () => {
  const { types } = resolveSchema({
    project: { schema: { types: {
      feature: { level: 1, workflow: "delivery", parentTypes: ["goal"], required: ["title", "description", "estimate"] },
    } } },
  });
  const feat = T({ id: "A-1", type: "feature", title: "f", parent: "" });
  assert.ok(validateTicket(feat, () => null, { types }).some((e) => /missing required: estimate/.test(e)));
  assert.deepEqual(validateTicket(feat, () => null), [], "the default does not require it");
});

test("an unknown type is still unknown under a project registry", () => {
  const { types } = resolveSchema({ project: { schema: { types: {} } } });
  assert.ok(validateTicket(T({ id: "A-1", type: "nope", title: "x" }), () => null, { types })
    .some((e) => /unknown or missing type/.test(e)));
});

test("loadProjectSchema reads a project.json schema block off disk", async () => {
  const { loadProjectSchema } = await import("../scripts/model/schema-config.mjs");
  const root = mkdtempSync(join(tmpdir(), "blaze-projsch-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "AAA"), { recursive: true });
  writeFileSync(join(projects, "AAA", "project.json"), JSON.stringify({
    key: "AAA",
    schema: { types: { task: { level: 0, workflow: "delivery", parentTypes: ["story"], required: ["title"] } } },
  }));
  const { types } = loadProjectSchema(projects, "AAA");
  assert.deepEqual(types.task.parentTypes, ["story"]);
  // A project with no schema block resolves to the ambient registry, not to nothing.
  mkdirSync(join(projects, "BBB"), { recursive: true });
  writeFileSync(join(projects, "BBB", "project.json"), JSON.stringify({ key: "BBB" }));
  assert.deepEqual(loadProjectSchema(projects, "BBB").types.task.parentTypes,
                   DEFAULT_TYPES.task.parentTypes);
  rmSync(root, { recursive: true, force: true });
});
