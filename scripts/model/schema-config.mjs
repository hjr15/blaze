// scripts/model/schema-config.mjs — layered schema resolver. Pure, no filesystem.
// Merges the built-in defaults with a top-level (blaze.config.json) override and a
// per-project (project.json) override, per registry entry: default → top → project,
// later wins. Callers load `config`/`project` via config.mjs and pass them in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TYPES, mergeTypes } from "./schema.mjs";
import { DEFAULT_WORKFLOWS, mergeWorkflows } from "./workflows.mjs";
import { GOAL_SATISFYING_REQUIREMENT } from "./gates.mjs";

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

  // BLZ-361. An override replaces a workflow wholesale (`mergeWorkflows` is a shallow merge at
  // the workflow-NAME level), so a board carrying a status list written before the engine grew a
  // status silently loses it. That is legal when deliberate and catastrophic when accidental:
  // the `goal:achieved` gate needs a requirement to reach one of GOAL_SATISFYING_REQUIREMENT, so
  // a board missing `verified` can never achieve a goal that has a delivered requirement, and the
  // audit finding that reports it can never clear.
  //
  // Reported rather than thrown: it is a soft finding on a board that may have narrowed on
  // purpose, and `validateSchema`'s existing contract is to return errors, not to refuse.
  const req = workflows.requirement;
  if (req && Array.isArray(req.statuses)) {
    const missing = [...GOAL_SATISFYING_REQUIREMENT].filter((s) => !req.statuses.includes(s));
    if (missing.length) {
      errors.push(
        `workflow "requirement" omits ${missing.map((m) => `"${m}"`).join(", ")}, which the `
        + "goal:achieved gate requires — a goal cannot be achieved while a requirement beneath "
        + "it has not reached one of them, so with these absent no such goal can ever close. "
        + "Add them, or drop the gate deliberately (BLZ-353, ruling R48).");
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
