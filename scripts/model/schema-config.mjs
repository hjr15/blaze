// scripts/model/schema-config.mjs — layered schema resolver. Pure, no filesystem.
// Merges the built-in defaults with a top-level (blaze.config.json) override and a
// per-project (project.json) override, per registry entry: default → top → project,
// later wins. Callers load `config`/`project` via config.mjs and pass them in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TYPES, mergeTypes } from "./schema.mjs";
import { DEFAULT_WORKFLOWS, mergeWorkflows, RESOLUTIONS } from "./workflows.mjs";
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
export function validateSchema({ types: rawTypes = {}, workflows: rawWorkflows = {}, linkTypes = null,
                                 config = null, project = null, endpointTypes = null } = {}) {
  // A default only fires for `undefined`, and this function is pure and public — anyone
  // may call it with anything, `auditCorpus` included, on a config that parsed to null.
  // `Object.entries(null)` throws, and a throw here is the exact regression BLZ-392
  // closed: it would take `blaze audit` down instead of reporting.
  const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  const types = isRecord(rawTypes) ? rawTypes : {};
  const workflows = isRecord(rawWorkflows) ? rawWorkflows : {};
  // `endpointTypes` exists because the two checks below ask different questions. A type's
  // workflow is judged against the layer that declares it; an ENDPOINT KIND is judged against
  // every type that exists anywhere, because the top-level `Precedes` list legitimately names
  // types some project declares. Judging both against one registry produced a finding that its
  // own report contradicted: "spike is not a declared type, so it stays unschedulable", printed
  // beside a `deadline-unreachable` proving a spike had just been scheduled.
  const known = endpointTypes ?? types;
  const errors = [];
  for (const [name, def] of Object.entries(types)) {
    const wf = def && def.workflow;
    if (wf && !Object.prototype.hasOwnProperty.call(workflows, wf)) {
      errors.push(`type "${name}" maps to undeclared workflow "${wf}"`);
    }
  }

  // --- BLZ-56: shape, then referential integrity -----------------------------
  // A well-formed-JSON override with the wrong SHAPE used to be accepted in silence, so
  // the resolved schema could be internally inconsistent and only say so much later —
  // `workflowDef` throwing deep in a verb, or a validation rule quietly ceasing to fire.
  //
  // REPORTED, never thrown, exactly like everything else in this function. The loud half
  // lives in `assertSchemaValid` below, and the separation is the point: this function's
  // production caller is `auditCorpus`, where a throw loses the whole hygiene report.
  const isStr = (v) => typeof v === "string" && v.trim() !== "";
  for (const [name, def] of Object.entries(types)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) {
      errors.push(`type "${name}" is not an object — a type is a { level, workflow, parentTypes, required } record`);
      continue;
    }
    if (typeof def.level !== "number" || !Number.isFinite(def.level)) {
      errors.push(`type "${name}" has a level that is not a number (${def.level === null ? "null" : typeof def.level})`
        + " — level orders the hierarchy, and a non-number cannot be compared");
    }
    if (!isStr(def.workflow)) {
      errors.push(`type "${name}" has a workflow that is not a name `
        + `(${def.workflow === null ? "null" : typeof def.workflow}) — every type must map to a declared workflow`);
    }
    if (!Array.isArray(def.parentTypes)) {
      errors.push(`type "${name}" has parentTypes that is not an array `
        + `(${def.parentTypes === null ? "null" : typeof def.parentTypes}) — use [] for a root type`);
    } else {
      for (const parent of def.parentTypes) {
        if (!Object.prototype.hasOwnProperty.call(types, parent)) {
          errors.push(`type "${name}" lists parentTypes "${parent}", which is not a declared type — `
            + "nothing could ever be created under it");
        }
      }
    }
    if (!Array.isArray(def.required)) {
      errors.push(`type "${name}" has required that is not an array `
        + `(${def.required === null ? "null" : typeof def.required}) — use [] for no required fields`);
    } else if (!def.required.every(isStr)) {
      errors.push(`type "${name}" has a required entry that is not a field name — `
        + "every entry must be a non-empty string");
    }
  }

  for (const [name, wf] of Object.entries(workflows)) {
    if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
      errors.push(`workflow "${name}" is not an object — a workflow is a { statuses, terminal, transitions, reopenTo } record`);
      continue;
    }
    const statuses = wf.statuses;
    if (!Array.isArray(statuses) || statuses.length === 0 || !statuses.every(isStr)) {
      errors.push(`workflow "${name}" has statuses that is not a non-empty array of names — `
        + "a workflow with no statuses can hold no ticket");
      continue; // every check below is relative to `statuses`; without it they are noise.
    }
    const declared = new Set(statuses);
    const terminal = wf.terminal;
    if (terminal !== undefined) {
      if (!Array.isArray(terminal)) {
        errors.push(`workflow "${name}" has terminal that is not an array `
          + `(${terminal === null ? "null" : typeof terminal})`);
      } else {
        for (const t of terminal) {
          if (!declared.has(t)) {
            errors.push(`workflow "${name}" marks "${t}" terminal, but it is not one of its statuses — `
              + "nothing can ever reach it");
          }
        }
      }
    }
    if (wf.transitions !== undefined) {
      if (!Array.isArray(wf.transitions)) {
        errors.push(`workflow "${name}" has transitions that is not an array`);
      } else {
        for (const pair of wf.transitions) {
          if (!Array.isArray(pair) || pair.length !== 2) {
            errors.push(`workflow "${name}" has a transition that is not a [from, to] pair — `
              + `got ${JSON.stringify(pair)}`);
            continue;
          }
          for (const st of pair) {
            if (!declared.has(st)) {
              errors.push(`workflow "${name}" has a transition naming "${st}", which is not one of `
                + "its statuses — that move can never be made");
            }
          }
        }
      }
    }
    if (wf.reopenTo !== undefined && !declared.has(wf.reopenTo)) {
      errors.push(`workflow "${name}" sets reopenTo "${wf.reopenTo}", which is not one of its `
        + "statuses — reopening would write a status the workflow does not have");
    }
    const rot = wf.resolutionOnTerminal;
    if (rot !== undefined) {
      if (!rot || typeof rot !== "object" || Array.isArray(rot)) {
        errors.push(`workflow "${name}" has resolutionOnTerminal that is not an object`);
      } else {
        const term = new Set(Array.isArray(terminal) ? terminal : []);
        for (const [status, resolution] of Object.entries(rot)) {
          if (!term.has(status)) {
            errors.push(`workflow "${name}" maps a resolution onto "${status}", which is not one of its `
              + "terminal statuses — the mapping can never fire");
          }
          if (!RESOLUTIONS.includes(resolution)) {
            errors.push(`workflow "${name}" maps "${status}" to resolution "${resolution}", which is not a `
              + `known resolution (${RESOLUTIONS.join(", ")})`);
          }
        }
      }
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
          if (!Object.prototype.hasOwnProperty.call(known, kind)) {
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
  // NOT also run over the project layer. Doing so paired "…stays unschedulable, fix the kind"
  // with "…does not reach the scheduler at all" for the same block — two findings that
  // contradict each other, one of them implying a repair that cannot work.
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


/**
 * The LOAD path. Resolve-and-check, and refuse to continue on a bad override.
 *
 * BLZ-56's acceptance criteria say a malformed override must FAIL LOUD. BLZ-392
 * deliberately made `validateSchema` REPORT rather than throw, because throwing killed
 * `blaze audit` outright — a stack trace and no report at all, from inside
 * `auditCorpus`, losing the whole hygiene report for one bad field. Those are not in
 * conflict, but only while the paths stay separate, and this function is the separation:
 *
 *   `validateSchema`    the REPORTING path. Returns errors. Never throws. `auditCorpus`
 *                       calls it, and `schema-invalid` is a soft finding.
 *   `assertSchemaValid` the LOAD path. Throws a named, actionable error listing every
 *                       problem at once, so one run fixes the config rather than three.
 *
 * It is NOT called from `ambientSchemaOverride`, and must never be. `TYPES` and
 * `WORKFLOWS` are module-scope constants resolved through that function at IMPORT time
 * (`schema.mjs`, `workflows.mjs`), so a throw inside it would make merely importing the
 * model kill every verb before it ran — `blaze audit` included, with a raw stack trace.
 * That is BLZ-392's defect one level worse, and the guarded catch there stays exactly as
 * it is. See ADR-0002.
 */
export function assertSchemaValid(resolved, { source = "blaze.config.json" } = {}) {
  const errors = validateSchema(resolved ?? {});
  if (!errors.length) return;
  const err = new Error(
    `blaze: the schema override in ${source} is not valid, so the resolved schema would be `
    + `internally inconsistent:\n\n`
    + errors.map((e) => `  - ${e}`).join("\n")
    + `\n\nFix ${source}, or remove its "schema" block to fall back to the built-in defaults.\n`,
  );
  err.name = "SchemaOverrideError";
  // The message IS the report. A stack trace here points at this function, never at the
  // line of config that is wrong, so it is noise in front of the part that helps.
  err.stack = err.message;
  err.errors = errors;
  throw err;
}
