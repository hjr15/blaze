// scripts/model/schema-config.mjs — layered schema resolver. Pure, no filesystem.
// Merges the built-in defaults with a top-level (blaze.config.json) override and a
// per-project (project.json) override, per registry entry: default → top → project,
// later wins. Callers load `config`/`project` via config.mjs and pass them in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TYPES, mergeTypes } from "./schema.mjs";
import { DEFAULT_WORKFLOWS, mergeWorkflows } from "./workflows.mjs";
import { DEFAULT_LINK_TYPES, mergeLinkTypes, linkTypeOverrideErrors } from "./link-schema.mjs";
import { GOAL_SATISFYING_REQUIREMENT } from "./gates.mjs";

export function resolveSchema({ config = null, project = null } = {}) {
  const topTypes = config?.schema?.types;
  const projTypes = project?.schema?.types;
  const topWorkflows = config?.schema?.workflows;
  const projWorkflows = project?.schema?.workflows;
  // BLZ-392: link types layer here too. Before this, `resolveSchema` had no link-type branch
  // at all, so the solve's node rule — "a declared `Precedes` source kind" — read a module
  // constant while the old rule it replaced read the override-merged type registry. An
  // installation could add its own delivery type and had NO WAY to make it schedulable.
  return {
    types: mergeTypes(mergeTypes(DEFAULT_TYPES, topTypes), projTypes),
    workflows: mergeWorkflows(mergeWorkflows(DEFAULT_WORKFLOWS, topWorkflows), projWorkflows),
    linkTypes: mergeLinkTypes(
      mergeLinkTypes(DEFAULT_LINK_TYPES, config?.schema?.linkTypes), project?.schema?.linkTypes),
  };
}

/** Pure structural check: every type's workflow must be a declared workflow.
 *  Returns a list of human-readable errors ([] when valid). */
export function validateSchema({ types = {}, workflows = {}, linkTypes = null,
                                 config = null, project = null } = {}) {
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
  // BLZ-392. An endpoint kind that names no declared type matches nothing, so the type it was
  // meant to schedule stays silently unschedulable — which is the failure this ticket exists to
  // end, reintroduced by a typo. Reported rather than thrown, matching this function's contract.
  if (Array.isArray(linkTypes)) {
    for (const lt of linkTypes) {
      for (const side of ["source_kinds", "target_kinds"]) {
        const kinds = lt?.[side];
        // REPORTED, never thrown — this function's contract, and the comment below used to
        // claim it while `for...of` threw on a number and iterated a STRING PER CHARACTER,
        // turning `source_kinds: "spike"` into five bogus errors instead of one clear one.
        // `mergeLinkTypes` refuses these shapes outright now; this stays because
        // `validateSchema` is a pure function anyone may call with anything.
        if (kinds !== undefined && !Array.isArray(kinds)) {
          errors.push(`link type "${lt?.name}" has a ${side} that is not an array `
            + `(${kinds === null ? "null" : typeof kinds}) — it declares no endpoints, so `
            + "nothing can be schedulable through it");
          continue;
        }
        for (const kind of kinds ?? []) {
          if (!Object.prototype.hasOwnProperty.call(types, kind)) {
            errors.push(`link type "${lt.name}" names "${kind}" in ${side}, which is not a `
              + "declared type — it can never match, so any type it was meant to cover stays "
              + "unschedulable");
          }
        }
      }
    }
  }
  // BLZ-392. A malformed `schema.linkTypes` entry is IGNORED by the merge — it cannot throw,
  // because that took `blaze audit` down with a stack trace from inside `auditCorpus`. Ignoring
  // it silently would be the other half of the same failure, so the raw blocks are inspected
  // here and reported. The operator wrote the block; they need to know it did nothing.
  for (const e of linkTypeOverrideErrors(config?.schema?.linkTypes)) {
    errors.push(`blaze.config.json: ${e}`);
  }
  // A per-project block is INERT, well-formed or not: a CPM solve runs over the whole corpus at
  // once, so both production callers resolve with `config` alone and no project layer reaches
  // the scheduler. Reporting a malformed one as "the override was ignored" implied that fixing
  // the shape would make it work. It would not, so the block itself is what gets reported.
  if (project?.schema?.linkTypes !== undefined) {
    errors.push("project.json: schema.linkTypes does not reach the scheduler — a critical path "
      + "is solved over the whole installation at once, so endpoint kinds are read from "
      + "blaze.config.json only. Move it there, or remove it.");
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
