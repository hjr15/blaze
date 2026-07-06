import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemaMod = join(REPO, "scripts", "model", "schema.mjs").replace(/\\/g, "/");
const workflowsMod = join(REPO, "scripts", "model", "workflows.mjs").replace(/\\/g, "/");

// Run a node one-liner that imports the engine modules with the data root pointed
// at `dir`, and returns whatever the snippet prints.
function runWithDataRoot(dir, snippet) {
  return execFileSync(process.execPath, ["--input-type=module", "-e", snippet], {
    cwd: dir,
    env: { ...process.env, BLAZE_PROJECTS_DIR: join(dir, "projects") },
    encoding: "utf8",
  }).trim();
}

function dataRootWithSchema(schema) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-override-e2e-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X", projects: [], schema }));
  return dir;
}

test("a blaze.config.json types override reaches the resolved module-level TYPES", () => {
  const dir = dataRootWithSchema({
    types: { feature: { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title", "description"] } },
  });
  const out = runWithDataRoot(dir, `import { allTypes, isType } from "${schemaMod}"; console.log(JSON.stringify({ has: isType("feature"), all: allTypes() }));`);
  const res = JSON.parse(out);
  assert.equal(res.has, true);
  assert.ok(res.all.includes("feature"));
  rmSync(dir, { recursive: true, force: true });
});

test("a workflows override reaches the resolved statuses used by the board and validation", () => {
  const dir = dataRootWithSchema({
    types: { ticket: { level: 0, workflow: "kanban", parentTypes: ["epic"], required: ["title", "description"] } },
    workflows: { kanban: { statuses: ["todo", "doing", "done"], terminal: ["done"], transitions: [["todo", "doing"], ["doing", "done"]], reopenTo: "todo", resolutionOnTerminal: { done: "done" } } },
  });
  const out = runWithDataRoot(dir, `import { statusesFor, initialStatus } from "${workflowsMod}"; console.log(JSON.stringify({ statuses: statusesFor("ticket"), initial: initialStatus("ticket") }));`);
  const res = JSON.parse(out);
  assert.deepEqual(res.statuses, ["todo", "doing", "done"]);
  assert.equal(res.initial, "todo");
  rmSync(dir, { recursive: true, force: true });
});

test("with no override the resolved registry is unchanged from the built-in default", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-override-none-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X", projects: [] }));
  const out = runWithDataRoot(dir, `import { allTypes } from "${schemaMod}"; console.log(JSON.stringify(allTypes().sort()));`);
  assert.deepEqual(JSON.parse(out), ["bug", "epic", "goal", "risk", "story", "subtask", "task"]);
  rmSync(dir, { recursive: true, force: true });
});
