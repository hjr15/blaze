// scripts/model/rules.mjs — the single home for Blaze business rules.
// Phase 1: required-field + parent-integrity validation. (Transitions: Phase 2.)
import { isType, requiredFields, canParent, PRIORITIES } from "./schema.mjs";
import { statusesFor, canTransition, RESOLUTIONS } from "./workflows.mjs";

// ticket = { frontmatter, body }; lookup(id) => ticket | null (for parent checks).
export function validateTicket(ticket, lookup = () => null) {
  const errors = [];
  const fm = ticket.frontmatter || {};
  const type = fm.type;

  if (!isType(type)) {
    errors.push(`unknown or missing type: ${type}`);
    return errors;
  }

  for (const field of requiredFields(type)) {
    if (field === "description") {
      if (!ticket.body || ticket.body.trim() === "") errors.push("missing required: description (body)");
    } else if (fm[field] === undefined || fm[field] === null || fm[field] === "") {
      errors.push(`missing required: ${field}`);
    }
  }

  // Enum validation for priority and resolution.
  if (fm.priority && !PRIORITIES.includes(fm.priority)) {
    errors.push(`invalid priority: ${fm.priority}`);
  }
  if (fm.resolution && !RESOLUTIONS.includes(fm.resolution)) {
    errors.push(`invalid resolution: ${fm.resolution}`);
  }

  if (fm.parent) {
    const parent = lookup(fm.parent);
    if (!parent) {
      errors.push(`parent not found: ${fm.parent}`);
    } else {
      if (!canParent(type, parent.frontmatter.type)) {
        errors.push(`invalid parent: ${type} cannot be a child of ${parent.frontmatter.type}`);
      }
      const seen = new Set([fm.id]);
      let cur = parent;
      while (cur && cur.frontmatter.parent) {
        if (seen.has(cur.frontmatter.id)) { errors.push(`parent cycle detected at ${cur.frontmatter.id}`); break; }
        seen.add(cur.frontmatter.id);
        cur = lookup(cur.frontmatter.parent);
      }
    }
  }
  return errors;
}

// Type-scoped transition validation. Separate from resolution (which is a post-
// function, not a transition gate). Returns [] when the move is legal.
export function validateTransition(type, from, to) {
  const errors = [];
  if (!isType(type)) { errors.push(`unknown type: ${type}`); return errors; }
  if (!statusesFor(type).includes(to)) {
    errors.push(`invalid status '${to}' for type ${type}`);
  } else if (!canTransition(type, from, to)) {
    errors.push(`illegal transition: ${from} → ${to} for type ${type}`);
  }
  return errors;
}
