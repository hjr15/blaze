// tests/top-level-schema-write-path.test.mjs — BLZ-246.
//
// A data repo's top-level `schema.types` block (blaze.config.json) reached the READ path —
// schema.mjs resolves the exported TYPES through `ambientSchemaOverride()` — but never the
// WRITE path. `new.mjs` and `edit.mjs` called `loadProjectSchema(projectsDir, key)` with no
// `config`, and that parameter defaults to `null`, so `resolveSchema` saw no top-level layer
// and merged only DEFAULT_TYPES with the per-project block. The declared override silently
// did nothing on the two commands that enforce it.
//
// It bit blaze-pm after BLZ-231 made `epic` unparentable in the shipped defaults: the board
// declares `task.parentTypes: ["epic", "feature", "story"]` to keep its epic→task edge, yet
// `blaze new --parent <epic> --type task` and `blaze edit <child> parent <epic>` both failed
// with `invalid parent: task cannot be a child of epic`, while creating a bare epic worked —
// which is what made the failure look arbitrary. The default is deliberate; the bug is that
// the data repo's override was ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyNew } from "../scripts/new.mjs";
import { applyEdit } from "../scripts/edit.mjs";
import { loadProjectSchema } from "../scripts/model/schema-config.mjs";
import { loadConfig } from "../scripts/config.mjs";
import { DEFAULT_TYPES } from "../scripts/model/schema.mjs";

// blaze-pm's real override, trimmed to the two entries under test: it restores the epic→task
// edge that the shipped default retires.
const OVERRIDE = {
  types: {
    epic: { level: 1, workflow: "delivery", parentTypes: ["goal", "requirement"], required: ["title", "description"] },
    task: { level: 0, workflow: "delivery", parentTypes: ["epic", "feature", "story"], required: ["title", "description", "estimate"] },
  },
};

// BLZ-136: `applyNew` reserves ids in the shared git common dir, so the fixture must be a
// real worktree — the same reason tests/new.test.mjs inits one.
function board({ schema = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blaze-topschema-"));
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  const cfg = { key: "OBA", projects: ["OBA"] };
  if (schema) cfg.schema = schema;
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify(cfg));
  const projects = join(root, "projects");
  // No project.json: the per-project layer is deliberately empty so only the TOP-LEVEL
  // override can explain a passing assertion.
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  return { root, projects };
}

function put(projects, id, type, extra = {}) {
  const fm = { id, title: `${type} ${id}`, type, project: "OBA", priority: "medium",
    resolution: "", parent: "", assignee: "unassigned", labels: [], components: [],
    estimate: "", created: "2026-08-16", updated: "2026-08-16", ...extra };
  const lines = Object.entries(fm).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`);
  writeFileSync(join(projects, "OBA", "defined", `${id}-x.md`),
    `---\n${lines.join("\n")}\n---\n\n## Context\n\nbody\n`);
}

const typeOf = (projects, id) =>
  /^type:\s*(\S+)/m.exec(readFileSync(join(projects, "OBA", "defined", `${id}-x.md`), "utf8"))[1];
const parentOf = (projects, id) =>
  /^parent:[ \t]*(\S*)/m.exec(readFileSync(join(projects, "OBA", "defined", `${id}-x.md`), "utf8"))[1];

// --- new.mjs -----------------------------------------------------------------

test("applyNew honours a top-level schema.types override when validating the parent", async () => {
  const { root, projects } = board({ schema: OVERRIDE });
  const epic = await applyNew(projects, { project: "OBA", type: "epic", title: "Engine bundle", today: "2026-08-16" });
  assert.equal(epic.ok, true, JSON.stringify(epic.errors));

  const task = await applyNew(projects, { project: "OBA", type: "task", title: "Thread the config",
    today: "2026-08-16", extra: { estimate: 30, parent: epic.id } });
  assert.equal(task.ok, true,
    `the board's declared task.parentTypes includes epic, so this create must succeed: ${JSON.stringify(task.errors)}`);
  rmSync(root, { recursive: true, force: true });
});

test("applyNew still refuses the same create when the board declares NO override", async () => {
  // Without this control the test above proves nothing: it would also pass if the engine
  // had simply stopped enforcing parent rules.
  assert.deepEqual(DEFAULT_TYPES.task.parentTypes, ["feature", "story"],
    "BLZ-231's default is the baseline this control depends on");
  const { root, projects } = board();
  const epic = await applyNew(projects, { project: "OBA", type: "epic", title: "Engine bundle", today: "2026-08-16" });
  assert.equal(epic.ok, true, JSON.stringify(epic.errors));

  const task = await applyNew(projects, { project: "OBA", type: "task", title: "Thread the config",
    today: "2026-08-16", extra: { estimate: 30, parent: epic.id } });
  assert.equal(task.ok, false, "the shipped default must still retire the epic→task edge");
  assert.ok(task.errors.some((e) => /invalid parent/i.test(e)), JSON.stringify(task.errors));
  rmSync(root, { recursive: true, force: true });
});

// --- edit.mjs: the edited ticket's own parent edge (schema-config.mjs call at edit.mjs:43) --

test("applyEdit honours a top-level schema.types override when re-parenting", async () => {
  const { root, projects } = board({ schema: OVERRIDE });
  put(projects, "OBA-1", "epic");
  put(projects, "OBA-2", "task", { estimate: 30 });

  const res = await applyEdit(projects, "OBA-2", { parent: "OBA-1" }, { today: "2026-08-16" });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(parentOf(projects, "OBA-2"), "OBA-1");
  rmSync(root, { recursive: true, force: true });
});

test("applyEdit still refuses the same re-parent when the board declares NO override", async () => {
  const { root, projects } = board();
  put(projects, "OBA-1", "epic");
  put(projects, "OBA-2", "task", { estimate: 30 });

  const res = await applyEdit(projects, "OBA-2", { parent: "OBA-1" }, { today: "2026-08-16" });
  assert.equal(res.ok, false, "the shipped default must still retire the epic→task edge");
  assert.ok(res.errors.some((e) => /invalid parent/i.test(e)), JSON.stringify(res.errors));
  assert.equal(parentOf(projects, "OBA-2"), "", "a refused edit must not write");
  rmSync(root, { recursive: true, force: true });
});

// --- edit.mjs: the CHILD re-check on a retype (schema-config.mjs call at edit.mjs:54) -------
// This is a separate defect from the one above: fixing only edit.mjs:43 leaves the
// child-orphan check judging every child against the un-overridden defaults.

test("a retype's CHILD re-check honours the top-level override", async () => {
  const { root, projects } = board({ schema: OVERRIDE });
  put(projects, "OBA-1", "requirement");
  put(projects, "OBA-2", "feature", { parent: "OBA-1" });
  put(projects, "OBA-3", "task", { parent: "OBA-2", estimate: 30 });

  // feature → epic is legal for OBA-2 itself (the override gives epic parentTypes
  // ["goal","requirement"]), and the board declares task→epic legal, so OBA-3 stays valid.
  // Only the child re-check at edit.mjs:54 can wrongly refuse this.
  const res = await applyEdit(projects, "OBA-2", { type: "epic" }, { today: "2026-08-16" });
  assert.equal(res.ok, true,
    `the board declares task→epic legal, so retyping the parent must be accepted: ${JSON.stringify(res.errors)}`);
  assert.equal(typeOf(projects, "OBA-2"), "epic");
  rmSync(root, { recursive: true, force: true });
});

test("a retype's CHILD re-check still refuses an edge the board does not declare", async () => {
  const { root, projects } = board({ schema: OVERRIDE });
  put(projects, "OBA-1", "requirement");
  put(projects, "OBA-2", "feature", { parent: "OBA-1" });
  put(projects, "OBA-3", "subtask", { parent: "OBA-2" });

  // `subtask` is NOT in the override, so it keeps the shipped parentTypes
  // ["story","task","bug"] — retyping its parent to an epic must still be refused, and the
  // error must name the child.
  const res = await applyEdit(projects, "OBA-2", { type: "epic" }, { today: "2026-08-16" });
  assert.equal(res.ok, false, "an override must widen only the entries it declares");
  assert.ok(res.errors.some((e) => /OBA-3/.test(e)), JSON.stringify(res.errors));
  assert.equal(typeOf(projects, "OBA-2"), "feature", "a refused retype must not write");
  rmSync(root, { recursive: true, force: true });
});

// --- the resolver contract the three call sites depend on ---------------------

test("loadProjectSchema merges the top-level override only when a config is supplied", async () => {
  const { root, projects } = board({ schema: OVERRIDE });
  const config = loadConfig({ root });

  assert.deepEqual(loadProjectSchema(projects, "OBA", { config }).types.task.parentTypes,
    ["epic", "feature", "story"], "with a config, the top-level layer applies");
  assert.deepEqual(loadProjectSchema(projects, "OBA").types.task.parentTypes,
    DEFAULT_TYPES.task.parentTypes,
    "with no config there is no top-level layer — which is why every call site must pass one");
  rmSync(root, { recursive: true, force: true });
});
