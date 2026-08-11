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
  goal:         { level: 4,  workflow: "goal",         parentTypes: [],                                             required: ["title", "description"] },
  requirement:  { level: 3,  workflow: "requirement",  parentTypes: ["goal"],                                       required: ["title", "description"] },
  architecture: { level: 2,  workflow: "architecture", parentTypes: ["requirement", "goal"],                        required: ["title", "description"] },
  feature:      { level: 1,  workflow: "delivery",     parentTypes: ["architecture", "requirement", "goal"],        required: ["title", "description"] },
  risk:         { level: 1,  workflow: "risk",         parentTypes: ["goal", "requirement", "architecture", "feature"], required: ["title", "description", "likelihood", "impact"] },
  story:        { level: 0,  workflow: "delivery",     parentTypes: ["requirement", "feature"],                     required: ["title", "description", "estimate"] },
  task:         { level: 0,  workflow: "delivery",     parentTypes: ["feature", "story"],                           required: ["title", "description", "estimate"] },
  bug:          { level: 0,  workflow: "delivery",     parentTypes: ["feature", "story"],                           required: ["title", "description", "estimate"] },
  subtask:      { level: -1, workflow: "delivery",     parentTypes: ["story", "task", "bug"],                       required: ["title", "description"] },
  // `epic` is RETAINED and unparentable (BLZ-231). It cannot be removed: `mergeTypes` is a
  // spread, so an override can replace or add an entry but never delete one — a board that
  // still holds epics must keep loading. Giving it no legal parent retires it without
  // deleting it: existing epics stay readable, and no new one can be created anywhere.
  epic:         { level: 1,  workflow: "delivery",     parentTypes: [],                                             required: ["title", "description"] },
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
