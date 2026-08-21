// tests/edit-type-retype.test.mjs — BLZ-230.
//
// `type` was excluded from EDITABLE_FIELDS, so the one operation a model migration is made
// of — re-typing a ticket — could not be driven through the engine. The portfolio rollout
// retyped 295 tickets by rewriting the `type:` line on disk, which is correct against the
// source of truth and runs with NO validation at all: nothing checked that the retyped
// ticket's own parent edge stayed legal, and nothing checked its children's.
//
// A retype must therefore validate BOTH directions. Retyping a parent is the only edit that
// can invalidate a ticket other than the one being edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdit } from "../scripts/edit.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-retype-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  return { root, projects };
}

function put(projects, id, type, extra = {}) {
  const fm = { id, title: `${type} ${id}`, type, project: "OBA", priority: "medium",
    resolution: "", parent: "", assignee: "unassigned", labels: [], components: [],
    estimate: "", created: "2026-08-11", updated: "2026-08-11", ...extra };
  const lines = Object.entries(fm).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`);
  writeFileSync(join(projects, "OBA", "defined", `${id}-x.md`),
    `---\n${lines.join("\n")}\n---\n\n## Context\n\nbody\n`);
}

const typeOf = (projects, id) =>
  /^type:\s*(\S+)/m.exec(readFileSync(join(projects, "OBA", "defined", `${id}-x.md`), "utf8"))[1];

test("type is editable", async () => {
  const { root, projects } = board();
  put(projects, "OBA-1", "goal");
  put(projects, "OBA-2", "requirement", { parent: "OBA-1" });
  put(projects, "OBA-3", "epic", { parent: "OBA-1" });

  const res = await applyEdit(projects, "OBA-3", { type: "feature" });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(typeOf(projects, "OBA-3"), "feature");
  rmSync(root, { recursive: true, force: true });
});

test("a retype that would break the ticket's OWN parent edge is refused", async () => {
  const { root, projects } = board();
  put(projects, "OBA-1", "goal");
  put(projects, "OBA-2", "feature", { parent: "OBA-1" });

  // task cannot hang off a goal — retyping the feature to a task must be refused.
  const res = await applyEdit(projects, "OBA-2", { type: "task" });
  assert.equal(res.ok, false, "a retype must not leave the ticket's own parent illegal");
  assert.ok(res.errors.some((e) => /invalid parent/i.test(e)), JSON.stringify(res.errors));
  assert.equal(typeOf(projects, "OBA-2"), "feature", "a refused retype must not write");
  rmSync(root, { recursive: true, force: true });
});

test("a retype that would orphan a CHILD is refused", async () => {
  const { root, projects } = board();
  put(projects, "OBA-1", "goal");
  put(projects, "OBA-2", "requirement", { parent: "OBA-1" });
  put(projects, "OBA-3", "feature", { parent: "OBA-2" });
  put(projects, "OBA-4", "task", { parent: "OBA-3", estimate: 30 });

  // Retyping the feature to an architecture leaves OBA-4 (a task) under an architecture,
  // which is illegal. Nothing about OBA-4 changed, so only a child-aware check catches it.
  const res = await applyEdit(projects, "OBA-3", { type: "architecture" });
  assert.equal(res.ok, false, "a retype must not silently orphan its children");
  assert.ok(res.errors.some((e) => /OBA-4/.test(e)),
    `the error must name the child it would break: ${JSON.stringify(res.errors)}`);
  assert.equal(typeOf(projects, "OBA-3"), "feature", "a refused retype must not write");
  rmSync(root, { recursive: true, force: true });
});

test("a legal retype with children succeeds and leaves every edge legal", async () => {
  const { root, projects } = board();
  put(projects, "OBA-1", "goal");
  put(projects, "OBA-2", "requirement", { parent: "OBA-1" });
  put(projects, "OBA-3", "epic", { parent: "OBA-2" });
  put(projects, "OBA-4", "task", { parent: "OBA-3", estimate: 30 });

  // epic -> feature keeps task -> feature legal. This is the rollout's whole operation.
  const res = await applyEdit(projects, "OBA-3", { type: "feature" });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(typeOf(projects, "OBA-3"), "feature");
  assert.equal(typeOf(projects, "OBA-4"), "task");
  rmSync(root, { recursive: true, force: true });
});

test("a retype to an unknown type is refused", async () => {
  const { root, projects } = board();
  put(projects, "OBA-1", "goal");
  put(projects, "OBA-2", "feature", { parent: "OBA-1" });
  const res = await applyEdit(projects, "OBA-2", { type: "nonsense" });
  assert.equal(res.ok, false);
  assert.equal(typeOf(projects, "OBA-2"), "feature");
  rmSync(root, { recursive: true, force: true });
});

test("id and project stay read-only", async () => {
  const { root, projects } = board();
  put(projects, "OBA-1", "goal");
  for (const f of ["id", "project"]) {
    const res = await applyEdit(projects, "OBA-1", { [f]: "NOPE-9" });
    assert.equal(res.ok, false, `${f} must not be editable`);
    assert.ok(res.errors.some((e) => /not editable/.test(e)));
  }
  rmSync(root, { recursive: true, force: true });
});
