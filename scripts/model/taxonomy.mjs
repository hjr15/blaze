// scripts/model/taxonomy.mjs — pure: validate a ticket's labels/components
// values against the project's declared project.json taxonomy. A project that
// declares an empty set opts out (backward-compatible). No filesystem.

const SINGULAR = { labels: "label", components: "component" };

export function validateTaxonomy(fm, project) {
  const errors = [];
  for (const field of ["labels", "components"]) {
    const declared = project?.[field] ?? []; // loadProject/PROJECT_DEFAULTS guarantee an array
    if (declared.length === 0) continue; // no taxonomy declared → skip (backward compat)
    for (const v of fm?.[field] ?? []) {
      if (!declared.includes(v)) {
        errors.push(`off-taxonomy ${SINGULAR[field]}: '${v}' is not in projects/${project.key ?? "?"}/project.json ${field} — add it there first`);
      }
    }
  }
  return errors;
}
