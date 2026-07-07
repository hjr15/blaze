// scripts/model/workflows.mjs — Blaze type-scoped workflow definitions and the
// pure resolvers over them (statuses, terminal, transitions, resolution).
//
// DEFAULT_WORKFLOWS is the built-in set the engine ships. The exported WORKFLOWS
// is DEFAULT_WORKFLOWS merged with the ambient data repo's top-level
// `schema.workflows` override (guarded — falls back to defaults with no data repo
// or no override), so the board columns and transition enforcement read the
// resolved set with no consumer change. With no override, WORKFLOWS deep-equals
// DEFAULT_WORKFLOWS. Consumes the schema's type→workflow map.
import { workflowFor } from "./schema.mjs";
import { ambientSchemaOverride } from "../config.mjs";

export const RESOLUTIONS = ["done", "wont-do", "duplicate", "cannot-reproduce"];

export const DEFAULT_WORKFLOWS = {
  delivery: {
    statuses: ["defined", "in-progress", "in-review", "done"],
    terminal: ["done"],
    transitions: [["defined", "in-progress"], ["in-progress", "in-review"], ["in-review", "done"]],
    reopenTo: "defined",
    resolutionOnTerminal: { done: "done" },
  },
  goal: {
    statuses: ["defined", "in-progress", "achieved"],
    terminal: ["achieved"],
    transitions: [["defined", "in-progress"], ["in-progress", "achieved"]],
    reopenTo: "defined",
    resolutionOnTerminal: { achieved: "done" },
  },
  risk: {
    statuses: ["identified", "mitigated", "accepted", "obsolete"],
    terminal: ["mitigated", "accepted", "obsolete"],
    transitions: [["identified", "mitigated"], ["identified", "accepted"], ["identified", "obsolete"]],
    reopenTo: "identified",
    resolutionOnTerminal: { mitigated: "done", accepted: "done", obsolete: "wont-do" },
  },
};

/** Per-entry replace/add merge: each override entry replaces or adds a whole workflow. */
export function mergeWorkflows(defaults, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return { ...defaults };
  return { ...defaults, ...override };
}

/** Resolved definitions: built-in defaults + ambient top-level override. */
export const WORKFLOWS = mergeWorkflows(DEFAULT_WORKFLOWS, ambientSchemaOverride()?.workflows);

export function workflowDef(type) {
  const name = workflowFor(type); // throws on unknown type
  const def = WORKFLOWS[name];
  if (!def) throw new Error(`no workflow definition for "${name}" (type "${type}")`);
  return def;
}

export function statusesFor(type) { return workflowDef(type).statuses; }
export function isTerminal(type, status) { return workflowDef(type).terminal.includes(status); }
export function initialStatus(type) { return workflowDef(type).statuses[0]; }

export function canTransition(type, from, to) {
  const def = workflowDef(type);
  if (!def.statuses.includes(to)) return false;
  if (to === def.reopenTo && from !== to) return true; // reopen from any other status
  return def.transitions.some(([f, t]) => f === from && t === to);
}

export function resolutionForTerminal(type, status) {
  const def = workflowDef(type);
  return Object.prototype.hasOwnProperty.call(def.resolutionOnTerminal, status)
    ? def.resolutionOnTerminal[status] : null;
}
