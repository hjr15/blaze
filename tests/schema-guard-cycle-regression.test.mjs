import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const configMod = join(REPO, "scripts", "config.mjs").replace(/\\/g, "/");
const schemaMod = join(REPO, "scripts", "model", "schema.mjs").replace(/\\/g, "/");

function dataRootWithSchema(schema) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cycle-regress-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "X", projects: [], schema }));
  return dir;
}

// A child process, not an in-process import, is the only way to control ESM
// module-graph entry order deterministically (node --test's own runner has
// already imported half the engine by the time a test body runs). Two
// sequential, awaited dynamic imports force config.mjs to fully link AND
// evaluate — pulling in whatever it transitively imports — before schema.mjs's
// import even begins resolving. That is the one entry order the deviation note
// and ADR-0002 warn about: on the *rejected* design (checkSchemaVersion defined
// inside schema-config.mjs, config.mjs importing it from there), this order
// drives config.mjs's dependency walk into schema.mjs's top-level
// ambientSchemaOverride() call while config.mjs's own consts are still in the
// TDZ, and the override below is silently dropped. On this plan's zero-import
// schema-version.mjs design there is no cycle for config.mjs to walk into, so
// it survives.
const script = `
  await import("${configMod}");
  const { TYPES } = await import("${schemaMod}");
  console.log(JSON.stringify({ hasFeature: Object.prototype.hasOwnProperty.call(TYPES, "feature") }));
`;

test("D5a regression: a schema.types override still reaches TYPES when config.mjs enters the module graph first", () => {
  const dir = dataRootWithSchema({
    types: { feature: { level: 0, workflow: "delivery", parentTypes: ["epic"], required: ["title", "description"] } },
  });
  const r = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    env: { ...process.env, BLAZE_PROJECTS_DIR: join(dir, "projects") },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(r.trim()), { hasFeature: true });
  rmSync(dir, { recursive: true, force: true });
});
