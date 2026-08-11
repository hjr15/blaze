// scripts/model/audit.mjs — pure: corpus hygiene findings over an already-loaded set of
// tickets. No filesystem, no git. The runner (`blaze audit`) walks the board and hands the
// tickets in; everything below is a function of its arguments.
//
// Ported from the blaze-pm board's `scripts/metadata_audit.py` (BLZ-137), which could only
// ever run against that one board. The semantics are carried over deliberately, including
// the split that makes the gate usable:
//
//   HARD — the corpus is WRONG. An off-taxonomy value, a link that resolves to nothing, an
//          illegal parent pair. These fail the run.
//   SOFT — a FILL QUEUE. Empty metadata, an orphan. These are reported and never fail a run.
//
// That split is blaze-pm ADR-0011's soft gate, and it is load-bearing: a gate that fails on
// the fill queue is a gate people learn to skip, which costs the hard findings too.
import { resolveSchema } from "./schema-config.mjs";
import { LINK_TYPES } from "./links.mjs";

export const HARD_KINDS = new Set([
  "off-taxonomy-component", "off-taxonomy-label", "bad-link-key", "unknown-link-type",
  "dangling-target", "dangling-parent", "invalid-parent-type", "parse-error",
  // duplicate-status (BLZ-122/REQ-035) is raised by the RUNNER, not by auditCorpus — ticket
  // identity is a property of the walk, and this pure function is a function of frontmatter
  // alone. Its severity still belongs here: HARD_KINDS is the published contract that
  // `summarise` and every caller reads, so a kind raised elsewhere must still be classified
  // in one place.
  "duplicate-status",
]);

// Types whose classification lives in typed fields rather than labels (BLZ-234).
const LABEL_EXEMPT = new Set(["requirement", "architecture", "risk"]);

const keyOf = (id) => String(id ?? "").split("-")[0];

/**
 * @param tickets   [{ frontmatter, body }] — the whole corpus
 * @param projects  { KEY: projectJson } — taxonomy and optional per-project schema block
 * @param config    the board config, for the top-level schema override
 * @returns { findings: [{ ticket, kind, detail }], ok }
 */
export function auditCorpus({ tickets = [], projects = {}, config = null } = {}) {
  const findings = [];
  const add = (ticket, kind, detail = "") => findings.push({ ticket, kind, detail });

  const ids = new Set();
  const typeById = new Map();
  for (const t of tickets) {
    const fm = t?.frontmatter ?? {};
    if (fm.id) { ids.add(fm.id); typeById.set(fm.id, fm.type); }
  }

  // Each project is judged by its OWN resolved registry (BLZ-238), so one project's
  // customisation cannot make another project's corpus look wrong.
  const registryFor = new Map();
  const typesFor = (key) => {
    if (!registryFor.has(key)) {
      registryFor.set(key, resolveSchema({ config, project: projects[key] ?? null }).types);
    }
    return registryFor.get(key);
  };

  for (const t of tickets) {
    const fm = t?.frontmatter ?? {};
    const id = fm.id;
    if (!id) { add("?", "parse-error", "ticket has no id"); continue; }

    const key = keyOf(id);
    const project = projects[key] ?? {};
    const types = typesFor(key);
    const ttype = fm.type;

    // --- taxonomy -----------------------------------------------------------------
    const components = fm.components ?? [];
    const labels = fm.labels ?? [];
    if (components.length === 0) add(id, "empty-components", ttype);
    if (labels.length === 0 && !LABEL_EXEMPT.has(ttype)) add(id, "empty-labels", ttype);

    if (Array.isArray(project.components) && project.components.length) {
      for (const c of components) {
        if (!project.components.includes(c)) add(id, "off-taxonomy-component", c);
      }
    }
    if (Array.isArray(project.labels) && project.labels.length) {
      for (const l of labels) {
        if (!project.labels.includes(l)) add(id, "off-taxonomy-label", l);
      }
    }

    // --- links --------------------------------------------------------------------
    for (const link of fm.links ?? []) {
      if (link == null || typeof link !== "object") { add(id, "bad-link-key", "not an object"); continue; }
      if (link.target === undefined) {
        const bad = Object.keys(link).find((k) => k !== "type");
        add(id, "bad-link-key", bad ? `found '${bad}:' instead of 'target:'` : "missing 'target:'");
        continue;
      }
      if (!LINK_TYPES.has(link.type)) add(id, "unknown-link-type", String(link.type));
      if (!ids.has(link.target)) add(id, "dangling-target", link.target);
    }

    // --- hierarchy ----------------------------------------------------------------
    const parent = fm.parent;
    if (!parent) {
      if (ttype !== "goal") add(id, "missing-parent", ttype);   // soft: an orphan is reported
      continue;
    }
    if (!ids.has(parent)) { add(id, "dangling-parent", parent); continue; }
    const ptype = typeById.get(parent);
    const def = types[ttype];
    if (!def) { add(id, "invalid-parent-type", `unknown type '${ttype}'`); continue; }
    if (!def.parentTypes.includes(ptype)) {
      add(id, "invalid-parent-type", `${ttype} cannot be a child of ${ptype}`);
    }
  }

  return { findings, ok: !findings.some((f) => HARD_KINDS.has(f.kind)) };
}

/** Counts by kind, for a runner that prints a summary rather than every finding. */
export function summarise(findings) {
  const out = new Map();
  for (const f of findings) out.set(f.kind, (out.get(f.kind) ?? 0) + 1);
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({
    kind, count, severity: HARD_KINDS.has(kind) ? "hard" : "soft",
  }));
}
