// scripts/model/schema-config.mjs — layered schema resolver. Pure, no filesystem.
// Merges the built-in defaults with a top-level (blaze.config.json) override and a
// per-project (project.json) override, per registry entry: default → top → project,
// later wins. Callers load `config`/`project` via config.mjs and pass them in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TYPES, mergeTypes } from "./schema.mjs";
import { DEFAULT_WORKFLOWS, mergeWorkflows } from "./workflows.mjs";

export function resolveSchema({ config = null, project = null } = {}) {
  const topTypes = config?.schema?.types;
  const projTypes = project?.schema?.types;
  const topWorkflows = config?.schema?.workflows;
  const projWorkflows = project?.schema?.workflows;
  return {
    types: mergeTypes(mergeTypes(DEFAULT_TYPES, topTypes), projTypes),
    workflows: mergeWorkflows(mergeWorkflows(DEFAULT_WORKFLOWS, topWorkflows), projWorkflows),
  };
}

/** Pure structural check: every type's workflow must be a declared workflow.
 *  Returns a list of human-readable errors ([] when valid). */
export function validateSchema({ types = {}, workflows = {} } = {}) {
  const errors = [];
  for (const [name, def] of Object.entries(types)) {
    const wf = def && def.workflow;
    if (wf && !Object.prototype.hasOwnProperty.call(workflows, wf)) {
      errors.push(`type "${name}" maps to undeclared workflow "${wf}"`);
    }
  }
  return errors;
}

// Config-schema compat window + guard (ADR-0002). Defined in schema-version.mjs —
// a zero-import module config.mjs can import without creating the cycle
// config → schema-config → schema → config — and re-exported here so the schema
// surface stays in one place for consumers and tests.
export { SCHEMA_VERSION, MIN_SCHEMA_VERSION, checkSchemaVersion } from "./schema-version.mjs";

/** Resolve the registry for ONE project: defaults → top-level → that project's own block.
 *  A project with no `schema` block resolves to the ambient registry, not to nothing —
 *  which is what makes per-project customisation opt-in rather than a cliff (BLZ-238). */
export function loadProjectSchema(projectsDir, key, { config = null } = {}) {
  let project = null;
  try { project = JSON.parse(readFileSync(join(projectsDir, key, "project.json"), "utf8")); }
  catch { project = null; }
  return resolveSchema({ config, project });
}
