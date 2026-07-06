// scripts/model/schema.mjs — Blaze type registry: hierarchy, parent rules,
// required fields, and the workflow that governs each type.
//
// DEFAULT_TYPES is the built-in registry the engine ships. The exported TYPES is
// DEFAULT_TYPES merged with the ambient data repo's top-level `schema.types`
// override (guarded — falls back to defaults when there is no data repo or no
// override), so validation, the board, and the CLI all read the resolved registry
// without any consumer change. With no override, TYPES deep-equals DEFAULT_TYPES.
import { ambientSchemaOverride } from "../config.mjs";

/** Canonical priority enum — single source of truth across rules, serve, and client. */
export const PRIORITIES = ["highest", "high", "medium", "low", "lowest", "none", "urgent"];

export const DEFAULT_TYPES = {
  goal:    { level: 2,  workflow: "goal",     parentTypes: [],                       required: ["title", "description"] },
  epic:    { level: 1,  workflow: "delivery", parentTypes: ["goal"],                 required: ["title", "description"] },
  risk:    { level: 1,  workflow: "risk",     parentTypes: ["goal", "epic"],         required: ["title", "description", "likelihood", "impact"] },
  story:   { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
  task:    { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
  bug:     { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
  subtask: { level: -1, workflow: "delivery", parentTypes: ["story", "task", "bug"], required: ["title", "description"] },
};

/** Per-entry replace/add merge: each override entry replaces or adds a whole type. */
export function mergeTypes(defaults, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return { ...defaults };
  return { ...defaults, ...override };
}

/** Resolved registry: built-in defaults + ambient top-level override. */
export const TYPES = mergeTypes(DEFAULT_TYPES, ambientSchemaOverride()?.types);

export function allTypes() { return Object.keys(TYPES); }

export function isType(t) { return Object.prototype.hasOwnProperty.call(TYPES, t); }

function must(type) { if (!isType(type)) throw new Error(`unknown type: ${type}`); }

export function hierarchyLevel(type) { must(type); return TYPES[type].level; }
export function workflowFor(type)    { must(type); return TYPES[type].workflow; }
export function requiredFields(type) { must(type); return TYPES[type].required; }

export function canParent(childType, parentType) {
  must(childType); must(parentType);
  return TYPES[childType].parentTypes.includes(parentType);
}
