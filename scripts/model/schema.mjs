// scripts/model/schema.mjs — Blaze type registry: hierarchy, parent rules,
// required fields, and the workflow that governs each type. Pure data + helpers.

/** Canonical priority enum — single source of truth across rules, serve, and client. */
export const PRIORITIES = ["highest", "high", "medium", "low", "lowest", "none", "urgent"];

export const TYPES = {
  goal:    { level: 2,  workflow: "goal",     parentTypes: [],                       required: ["title", "description"] },
  epic:    { level: 1,  workflow: "delivery", parentTypes: ["goal"],                 required: ["title", "description"] },
  risk:    { level: 1,  workflow: "risk",     parentTypes: ["goal", "epic"],         required: ["title", "description", "likelihood", "impact"] },
  story:   { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
  task:    { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
  bug:     { level: 0,  workflow: "delivery", parentTypes: ["epic"],                 required: ["title", "description", "estimate"] },
  subtask: { level: -1, workflow: "delivery", parentTypes: ["story", "task", "bug"], required: ["title", "description"] },
};

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
