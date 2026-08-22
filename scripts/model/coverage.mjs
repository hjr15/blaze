// scripts/model/coverage.mjs — coverage rules as named, first-class objects.
//
// Not hardcoded queries: a rule has a NAME, so a refusal can cite the rule that
// refused rather than saying "coverage incomplete", which nobody can act on.
import { ARTIFACT_KINDS } from "./artifact-schema.mjs";

export const DEFAULT_COVERAGE_RULES = [
  { name: "every-requirement-addressed", subject_kind: "requirement",
    description: "Every requirement is addressed by at least one architecture decision.",
    definition: { requires_link: "Addresses", direction: "inbound", min: 1 } },
  { name: "every-requirement-verified", subject_kind: "requirement",
    description: "Every requirement has at least one verifying item.",
    definition: { requires_link: "Verifies", direction: "inbound", min: 1 } },
  { name: "no-orphan-architecture", subject_kind: "architecture",
    description: "Every architecture decision addresses a requirement or states why not.",
    definition: { requires_link: "Addresses", direction: "outbound", min: 1 } },
];

export function evaluateCoverage({ rule, artifacts = [], links = [] }) {
  const { requires_link, direction, min = 1 } = rule.definition ?? {};
  const counts = new Map();
  for (const l of links) {
    if (l.type_name !== requires_link) continue;
    const key = direction === "inbound" ? l.target_id : l.source_id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const violations = [];
  for (const a of artifacts) {
    if (a.kind !== rule.subject_kind) continue;
    const n = counts.get(a.id) ?? 0;
    if (n < min) {
      violations.push({ ref: a.ref, why:
        `needs at least ${min} ${direction} ${requires_link} link${min === 1 ? "" : "s"}, has ${n}` });
    }
  }
  return { rule: rule.name, violations };
}

// -- schema ---------------------------------------------------------------
//
// Table-level constraints after all columns: SQLite STRICT requires it, Postgres
// tolerates it (artifact-schema.mjs:6).
//
// Two defects already hit this plan in schema code (BLZ-314 fix round) and must not
// repeat here:
//  1. A nullable column inside a composite PRIMARY KEY is uninsertable under STRICT
//     SQLite and in Postgres. coverage_rule keys on the surrogate `id` alone — nothing
//     nullable is ever part of a PRIMARY KEY here.
//  2. `boolean NOT NULL DEFAULT 0` is rejected by Postgres — an untyped integer literal
//     does not implicitly cast to boolean. `enabled` uses the `true_` dialect token,
//     never a literal.
function dialect(name) {
  if (name === "postgres") return { txt: "text", bool: "boolean", true_: "true", tbl: "" };
  if (name === "sqlite")   return { txt: "TEXT", bool: "INTEGER", true_: "1", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function coverageDdl(name) {
  const d = dialect(name);
  const kinds = ARTIFACT_KINDS.map((k) => `'${k}'`).join(", ");
  return `
CREATE TABLE IF NOT EXISTS coverage_rule (
  id           ${d.txt} NOT NULL,
  project_key  ${d.txt} NOT NULL,
  name         ${d.txt} NOT NULL,
  description  ${d.txt} NOT NULL,
  subject_kind ${d.txt} NOT NULL,
  definition   ${d.txt} NOT NULL,
  enabled      ${d.bool} NOT NULL DEFAULT ${d.true_},
  PRIMARY KEY (id),
  UNIQUE (project_key, name),
  CHECK (subject_kind IN (${kinds})),
  CHECK (length(trim(name)) > 0),
  CHECK (length(trim(description)) > 0)
)${d.tbl};

CREATE INDEX IF NOT EXISTS coverage_rule_project_kind_idx
  ON coverage_rule (project_key, subject_kind, enabled);
`;
}
