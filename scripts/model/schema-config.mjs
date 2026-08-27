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
import { SCHEMA_BLOCK_DROPPED } from "./schema-marker.mjs";

/** Every kind the loaders can drop: `typeof` of a non-record, plus arrays. */
const DROPPED_KINDS = new Set(["an array", "string", "number", "boolean", "bigint", "symbol", "function"]);

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

/** Pure structural check over the resolved schema. ONE list, tagged where each problem is
 *  collected — never two parallel functions, which would drift the moment a check moved.
 *  Returns `[{ message, hard }]`; the two public entry points below select from it.
 *
 *  HARD — the resolved schema is MALFORMED, and BLZ-56 exists to catch exactly this class:
 *         a type mapping to a workflow nothing declares, a partial type record (`mergeTypes`
 *         is a per-entry REPLACE, so `"task": {"workflow":"delivery"}` silently drops level,
 *         parentTypes and required), a workflow whose terminal/transitions/reopenTo name a
 *         status it does not have. The board is internally inconsistent and will throw or
 *         quietly stop validating later. Refusing to start is the right answer.
 *
 *  SOFT — an ADVISORY about a configuration that is legal, merely inert or deliberately
 *         narrowed: the BLZ-361 requirement-narrowing note ("legal when deliberate"), the
 *         BLZ-392 endpoint-kind findings, and the note that a per-project `schema.linkTypes`
 *         block never reaches the scheduler. `blaze audit` files every one of these SOFT and
 *         calls such a board ok=true. Throwing on them made every non-exempt verb exit 1 on a
 *         board audit calls clean — a check worse than the bug it replaced. Report only. */
/** BLZ-396: the override's CONTAINER, not its entries.
 *
 *  `mergeTypes`/`mergeWorkflows` coerce a non-record block to `{}` and say nothing, so
 *  `{"schema": {"types": "notanobject"}}` — and an array, a number, or a whole `schema`
 *  that is a string — produced ZERO findings and `blaze audit` reported ok=true. The
 *  operator wrote a block, it did nothing, and the board ran on built-in defaults it never
 *  asked for. That is BLZ-56's failure one level up.
 *
 *  The engine already has the right shape of answer for this class: `linkTypeOverrideErrors`
 *  says "the whole block was IGNORED". This mirrors that wording deliberately rather than
 *  inventing a second vocabulary for the same fact.
 *
 *  `undefined` is NOT a wrong shape — an absent block is how almost every board is written,
 *  and reporting it would put a finding on essentially every installation, which is worse
 *  than the bug this closes. */
export function schemaContainerErrors(schema, dropped = null, layer = "config", configSchema = null) {
  const kind = (v) => (Array.isArray(v) ? "an array" : v === null ? "null" : typeof v);
  const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  // `null` is ABSENT, not a wrong shape. `loadConfig` and `loadProject` both normalise a
  // missing `schema` to null, so treating null as malformed put a `schema-invalid` finding
  // on EVERY ordinary board — the "a new check is worse than the bug" outcome this repo has
  // paid for twice, and the existing "a healthy board reports no schema-invalid" test
  // caught it immediately. The loaders hand the dropped KIND separately, because by the
  // time the block reaches here a wrong shape and an absent one look identical.
  // WHAT IS STILL IN FORCE IS DERIVED, NEVER ASSUMED. `resolveSchema` merges DEFAULT, then
  // blaze.config.json, then the project block, so dropping the LAST one leaves whatever the
  // first two resolved to. Two wrong answers have already shipped through here:
  //
  //   1. hardcoded to the built-in defaults — untrue at the project layer whenever
  //      blaze.config.json carries a valid override, and it named the wrong file too;
  //   2. hardcoded to "the blaze.config.json layer is still in force" for every project-layer
  //      report — untrue whenever that layer does not exist, is ITSELF dropped, or declares
  //      nothing for this particular block. That is wrong on the MORE common board, and on a
  //      board with both layers dropped the report contradicted itself in adjacent lines.
  //
  //   3. `isRecord(configSchema)` — which asks whether the config layer is a RECORD, while
  //      the sentence asserts that it puts something IN FORCE. Those diverge for every
  //      well-formed record that declares nothing, including one whose own inner block was
  //      reported as IGNORED on the line immediately above.
  //
  // So the predicate is DERIVED from `resolveSchema`: does this layer change the resolved
  // schema, or not? Reimplementing it by hand gets the coercions wrong — `mergeTypes` and
  // `mergeLinkTypes` flatten a non-record to `{}`, so `{"linkTypes": ["x"]}` is a NO-OP
  // despite being a non-empty array, and a "does it have keys" rule would call it in force.
  // Asking the merge is the only answer that cannot drift from the merge.
  //
  //   4. and, in the half fix 3 never touched, the CONFIG layer's own clause stayed hardcoded
  //      to "the built-in X are still in force" — untrue whenever a PROJECT layer carries a
  //      valid override. Round 1's defect exactly, mirrored. Every test written for fix 3
  //      filtered on `project.json:`, so not one of them looked at it.
  //
  // The config layer's clause cannot be repaired by naming what IS in force, because that
  // finding is emitted ONCE for the whole installation — `auditCorpus` dedups it across every
  // project — so no single project's schema is the right thing to name, and rendering two
  // different sentences for one finding is its own defect. It therefore says something true
  // about the FILE and claims nothing about the board.
  //
  // LAZY, because the resolves are only needed to build a message: an eager version charged
  // two merges to every ordinary board with a config schema record, finding or not.
  //   5. and in the branch fix 4 itself added: when the comparison could not be COMPUTED it
  //      returned false, which renders as the definite claim "the built-in X are still in
  //      force" — round 1's defect verbatim. `false` is not the weaker answer. It is also
  //      REACHABLE from `JSON.parse`, which the previous comment here denied: `JSON.parse`
  //      accepts nesting depths `JSON.stringify` cannot serialise, so a hand-written
  //      blaze.config.json reaches it with no exotic runtime value involved.
  //
  // Hence a TRI-STATE. "Unknown" gets the sentence that is unconditionally true whatever the
  // config layer turns out to be: the block being reported was dropped, so THAT file
  // contributes nothing. It is the same shape of answer the config layer always gives.
  let inForce;  // undefined = not computed; null = could not be computed
  const contributes = (block) => {
    if (layer !== "project" || !isRecord(configSchema)) return false;
    if (inForce === undefined) {
      inForce = null;
      try {
        // EVERY stringify inside the try. They sat outside it, so a config that cannot be
        // serialised — a circular structure, a BigInt, a throwing `toJSON` — made a REPORT
        // throw, breaking this file's "never throws, on any input" contract. Unreachable
        // from `JSON.parse`, but the contract is what other code relies on, and deleting
        // this guard survived the whole suite until it was pinned.
        const base = resolveSchema({});
        const top = resolveSchema({ config: { schema: configSchema } });
        const differs = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
        inForce = { all: differs(base, top), types: differs(base.types, top.types),
                    workflows: differs(base.workflows, top.workflows) };
      } catch { inForce = null; }  // unknown is NOT the same as in force — say the weaker thing
    }
    if (inForce === null) return null;  // UNKNOWN — never collapse this into `false`
    // `?? null` so a block this memo does not carry reads as UNKNOWN, not as "no". The memo
    // holds `types` and `workflows` because those are the two the loop below inspects; add
    // `linkTypes` to that loop without this and `undefined` falls to the falsy branch and
    // renders "the built-in linkTypes are still in force" — round 1's defect a sixth time,
    // via a road nothing currently travels.
    return block === null ? inForce.all : (inForce[block] ?? null);
  };
  // The layer's own file, which is true for both layers and needs no resolve: the block
  // being reported was dropped, so it contributes nothing.
  const thisFile = layer === "project" ? "project.json" : "blaze.config.json";
  // FUNCTIONS, not values. As a bare ternary this ran on every call, including the ordinary
  // boards that produce no finding at all — the eager cost the previous commit claimed to
  // have removed and had not.
  const stillInForce = () => {
    if (layer !== "project") return `nothing in ${thisFile} reaches the resolved schema`;
    const c = contributes(null);
    if (c === null) return `nothing in ${thisFile} reaches the resolved schema`;
    return c ? "the blaze.config.json layer is still in force"
             : "every type, workflow and link type came from the built-in defaults";
  };
  const blockInForce = (block) => {
    if (layer !== "project") return `${thisFile} contributes no ${block}`;
    const c = contributes(block);
    if (c === null) return `${thisFile} contributes no ${block}`;
    return c ? `the blaze.config.json layer's ${block} are still in force`
             : `the built-in ${block} are still in force`;
  };
  // A dropped-kind marker is only ever set by the loaders, and only to one of these. It
  // arrives as a SYMBOL key so operator-written JSON cannot forge one — but a wrong VALUE
  // under the right key would still render `[object Object]` into an audit detail, which is
  // BLZ-392's defect by another route, so the value is whitelisted as well.
  if (dropped && DROPPED_KINDS.has(dropped)) {
    return [`schema must be an object, got ${dropped} — the whole block was IGNORED, `
      + `so ${stillInForce()}`];
  }
  if (schema === undefined || schema === null) return [];
  if (!isRecord(schema)) {
    return [`schema must be an object, got ${kind(schema)} — the whole block was IGNORED, `
      + `so ${stillInForce()}`];
  }
  const errors = [];
  for (const block of ["types", "workflows"]) {
    const v = schema[block];
    // `null` is absent here too, for the same reason it is absent one level up: the loaders
    // produce it for "not written", and a check that cannot tell the two apart fires on
    // ordinary boards.
    if (v === undefined || v === null || isRecord(v)) continue;
    errors.push(`schema.${block} must be an object keyed by ${block === "types" ? "type" : "workflow"} `
      + `name, got ${kind(v)} — the whole block was IGNORED, so ${blockInForce(block)}`);
  }
  return errors;
}

function collectSchemaProblems(input = {}) {
  // Destructuring `null` throws, and a parameter default only fires for `undefined`. This
  // function is pure and public and `auditCorpus` may call it with a config that parsed to
  // null — a throw here is the BLZ-392 regression by another route, so it takes ANYTHING.
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const { types: rawTypes = {}, workflows: rawWorkflows = {}, linkTypes = null,
          config = null, project = null, endpointTypes = null } = src;
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
  const problems = [];
  const hard = (message) => problems.push({ message, hard: true });
  const soft = (message) => problems.push({ message, hard: false });
  for (const [name, def] of Object.entries(types)) {
    const wf = def && def.workflow;
    if (wf && !Object.prototype.hasOwnProperty.call(workflows, wf)) {
      hard(`type "${name}" maps to undeclared workflow "${wf}"`);
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
      hard(`type "${name}" is not an object — a type is a { level, workflow, parentTypes, required } record`);
      continue;
    }
    if (typeof def.level !== "number" || !Number.isFinite(def.level)) {
      hard(`type "${name}" has a level that is not a number (${def.level === null ? "null" : typeof def.level})`
        + " — level orders the hierarchy, and a non-number cannot be compared");
    }
    if (!isStr(def.workflow)) {
      hard(`type "${name}" has a workflow that is not a name `
        + `(${def.workflow === null ? "null" : typeof def.workflow}) — every type must map to a declared workflow`);
    }
    if (!Array.isArray(def.parentTypes)) {
      hard(`type "${name}" has parentTypes that is not an array `
        + `(${def.parentTypes === null ? "null" : typeof def.parentTypes}) — use [] for a root type`);
    } else {
      for (const parent of def.parentTypes) {
        if (!Object.prototype.hasOwnProperty.call(types, parent)) {
          hard(`type "${name}" lists parentTypes "${parent}", which is not a declared type — `
            + "nothing could ever be created under it");
        }
      }
    }
    if (!Array.isArray(def.required)) {
      hard(`type "${name}" has required that is not an array `
        + `(${def.required === null ? "null" : typeof def.required}) — use [] for no required fields`);
    } else if (!def.required.every(isStr)) {
      hard(`type "${name}" has a required entry that is not a field name — `
        + "every entry must be a non-empty string");
    }
  }

  for (const [name, wf] of Object.entries(workflows)) {
    if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
      hard(`workflow "${name}" is not an object — a workflow is a { statuses, terminal, transitions, reopenTo } record`);
      continue;
    }
    const statuses = wf.statuses;
    if (!Array.isArray(statuses) || statuses.length === 0 || !statuses.every(isStr)) {
      hard(`workflow "${name}" has statuses that is not a non-empty array of names — `
        + "a workflow with no statuses can hold no ticket");
      continue; // every check below is relative to `statuses`; without it they are noise.
    }
    const declared = new Set(statuses);
    const terminal = wf.terminal;
    // PRESENCE, not just shape. `mergeWorkflows` is a per-entry REPLACE, exactly like
    // `mergeTypes` — so a record naming only some keys does not ADJUST the shipped
    // workflow, it replaces it and silently drops the rest. That is the same class as the
    // partial TYPE entry above, and `docs/schema-customization.md` already states the
    // contract: "supply the complete {statuses, terminal, transitions, reopenTo,
    // resolutionOnTerminal} for a workflow". Guarded as optional, a record carrying only
    // `statuses` passed this check, passed `blaze audit` with ok=true and ZERO findings,
    // and then died inside a verb as a raw `TypeError: Cannot read properties of
    // undefined (reading 'some')` from `canTransition` — the silent-then-fatal failure
    // this whole ticket exists to end.
    //
    // `reopenTo` stays optional deliberately: `canTransition` compares against it and an
    // absent value simply means "no reopen path", which is a legal workflow.
    if (terminal === undefined) {
      hard(`workflow "${name}" has no terminal — an override REPLACES the whole workflow `
        + "record, so a partial one drops the statuses that end it and nothing can close");
    } else {
      if (!Array.isArray(terminal)) {
        hard(`workflow "${name}" has terminal that is not an array `
          + `(${terminal === null ? "null" : typeof terminal})`);
      } else {
        for (const t of terminal) {
          if (!declared.has(t)) {
            hard(`workflow "${name}" marks "${t}" terminal, but it is not one of its statuses — `
              + "nothing can ever reach it");
          }
        }
      }
    }
    if (wf.transitions === undefined) {
      hard(`workflow "${name}" has no transitions — an override REPLACES the whole workflow `
        + "record, so a partial one drops every legal move and the ticket cannot leave its status");
    } else if (!Array.isArray(wf.transitions)) {
      hard(`workflow "${name}" has transitions that is not an array`);
    } else {
      for (const pair of wf.transitions) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          hard(`workflow "${name}" has a transition that is not a [from, to] pair — `
            + `got ${JSON.stringify(pair)}`);
          continue;
        }
        for (const st of pair) {
          if (!declared.has(st)) {
            hard(`workflow "${name}" has a transition naming "${st}", which is not one of `
              + "its statuses — that move can never be made");
          }
        }
      }
    }
    if (wf.reopenTo !== undefined && !declared.has(wf.reopenTo)) {
      hard(`workflow "${name}" sets reopenTo "${wf.reopenTo}", which is not one of its `
        + "statuses — reopening would write a status the workflow does not have");
    }
    const rot = wf.resolutionOnTerminal;
    // Required for the same reason as `terminal` and `transitions`: the override replaces
    // the record. Omitting only this one is the MOST plausible partial — it looks like a
    // detail — and it passed, then died in `resolutionForTerminal` as `TypeError: Cannot
    // convert undefined or null to object` the first time a ticket reached a terminal
    // status.
    if (rot === undefined) {
      hard(`workflow "${name}" has no resolutionOnTerminal — an override REPLACES the whole `
        + "workflow record, so a partial one leaves every terminal status with no resolution");
    } else {
      if (!rot || typeof rot !== "object" || Array.isArray(rot)) {
        hard(`workflow "${name}" has resolutionOnTerminal that is not an object`);
      } else {
        const term = new Set(Array.isArray(terminal) ? terminal : []);
        for (const [status, resolution] of Object.entries(rot)) {
          if (!term.has(status)) {
            hard(`workflow "${name}" maps a resolution onto "${status}", which is not one of its `
              + "terminal statuses — the mapping can never fire");
          }
          if (!RESOLUTIONS.includes(resolution)) {
            hard(`workflow "${name}" maps "${status}" to resolution "${resolution}", which is not a `
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
      soft(
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
          soft(`link type "${lt?.name}" has a ${side} that is not an array `
            + `(${kinds === null ? "null" : typeof kinds}) — it declares no endpoints, so `
            + "nothing can be schedulable through it");
          continue;
        }
        for (const kind of kinds ?? []) {
          if (!Object.prototype.hasOwnProperty.call(known, kind)) {
            soft(`link type "${lt.name}" names "${kind}" in ${side}, which is not a `
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
    soft(`blaze.config.json: ${e}`);
  }
  // BLZ-396. HARD, and the split is BLZ-56's: this is a genuine MALFORMATION, not a
  // legal-but-inert block. An operator who writes `"types": "notanobject"` meant to change
  // the registry and did not; continuing on defaults they never chose is exactly the silent
  // acceptance BLZ-56 exists to end. Both layers are inspected, because unlike `linkTypes`
  // — which is inert per-project by design — a per-project `types`/`workflows` block IS
  // read (`resolveSchema` merges `project.schema.types` over the top-level layer), so a
  // malformed one there is just as much a lie about what the board is running.
  //
  // Measured before shipping the refusal, because a preflight that refuses a board `blaze
  // audit` calls clean has been the worse-than-the-bug outcome here twice: at blaze-pm's
  // v4-spine worktree, `blaze.config.json` carries a well-formed `schema` and NO
  // project.json carries a `schema` block at all. This refuses nothing that exists today.
  for (const e of schemaContainerErrors(config?.schema, config?.[SCHEMA_BLOCK_DROPPED], "config")) {
    hard(`blaze.config.json: ${e}`);
  }
  for (const e of schemaContainerErrors(project?.schema, project?.[SCHEMA_BLOCK_DROPPED], "project", config?.schema)) {
    hard(`project.json: ${e}`);
  }
  // NOT also run over the project layer. Doing so paired "…stays unschedulable, fix the kind"
  // with "…does not reach the scheduler at all" for the same block — two findings that
  // contradict each other, one of them implying a repair that cannot work.
  // A per-project block is INERT, well-formed or not: a CPM solve runs over the whole corpus at
  // once, so both production callers resolve with `config` alone and no project layer reaches
  // the scheduler. Reporting a malformed one as "the override was ignored" implied that fixing
  // the shape would make it work. It would not, so the block itself is what gets reported.
  if (project?.schema?.linkTypes !== undefined) {
    soft("project.json: schema.linkTypes does not reach the scheduler — a critical path "
      + "is solved over the whole installation at once, so endpoint kinds are read from "
      + "blaze.config.json only. Move it there, or remove it.");
  }
  return problems;
}

/** The REPORTING path. Returns a list of human-readable strings ([] when valid), in the
 *  order the problems were found. Never throws, on any input.
 *
 *  THE PUBLIC SHAPE IS LOAD-BEARING and must not become the tagged records above:
 *  `auditCorpus` puts these straight into a `Set`, compares them across layers, and prints
 *  each as a `schema-invalid` finding's `detail`. Handing it objects would render every
 *  detail as [object Object] — BLZ-392's defect by another route. Pinned by a test. */
export function validateSchema(input = {}) {
  return collectSchemaProblems(input).map((p) => p.message);
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
 *   `validateSchema`    the REPORTING path. Returns EVERY problem, hard and soft. Never
 *                       throws. `auditCorpus` calls it, and `schema-invalid` is soft.
 *   `assertSchemaValid` the LOAD path. Throws a named, actionable error listing every HARD
 *                       problem at once, so one run fixes the config rather than three.
 *
 * Both read the same tagged list (`collectSchemaProblems`), because two lists would drift.
 * The load path takes only the hard entries: `validateSchema` deliberately also reports
 * advisories — an inert per-project `linkTypes` block, a deliberately narrowed workflow —
 * and `blaze audit` calls a board carrying those ok=true. A load check that refused them
 * would disagree with audit on the same board, which is worse than no check at all.
 *
 * It is NOT called from `ambientSchemaOverride`, and must never be. `TYPES` and
 * `WORKFLOWS` are module-scope constants resolved through that function at IMPORT time
 * (`schema.mjs`, `workflows.mjs`), so a throw inside it would make merely importing the
 * model kill every verb before it ran — `blaze audit` included, with a raw stack trace.
 * That is BLZ-392's defect one level worse, and the guarded catch there stays exactly as
 * it is. See ADR-0002.
 */
export function assertSchemaValid(resolved, { source = "blaze.config.json" } = {}) {
  // The HARD half only. `validateSchema` returns a MIX — malformations and advisories about
  // configurations that are legal but inert or deliberately narrowed — and throwing on the
  // whole list made a per-project `schema.linkTypes` block, or a narrowed `requirement`
  // workflow, refuse every non-exempt verb on a board `blaze audit` reports ok=true. Both are
  // regression-tested end to end (tests/schema-fail-loud-on-load.test.mjs). The soft entries
  // are not dropped, only not fatal: `blaze audit` still reports every one of them.
  const errors = collectSchemaProblems(resolved ?? {}).filter((p) => p.hard).map((p) => p.message);
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
