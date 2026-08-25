// scripts/model/view-schema.mjs — the `view` and `view_type` tables (BLZ-354 §3, BLZ-371).
//
// A project owns N named view instances; the installation keeps its own set. Ownership is a
// DISCRIMINATED UNION with an explicit `scope` tag, never a nullable owner read for its
// NULL-ness — §3.1's rule is that no query says `WHERE project_key IS NULL`, it says
// `WHERE scope = 'installation'`.
//
// TWO CORRECTIONS TO §3's DDL, both forced by SQLite and both measured (BLZ-371):
//
// 1. **These tables live in `blaze_config`, not the data namespace.** §3 wrote `view` as a
//    data table whose FKs point at `blaze_config.project` and `blaze_config.view_type`. In
//    SQLite `blaze_config` is an ATTACHed file and **an FK may not cross database files**:
//    the qualified form `REFERENCES blaze_config.project (key)` is a SYNTAX ERROR, and the
//    unqualified form resolves to a non-existent `main.project` so every insert fails with
//    "no such table". Putting `view` beside its FK targets is what makes the constraint
//    real in both engines — and it is where a view belongs anyway: §4.2 excludes view config
//    from ADR-0018's promotion machinery precisely because this is configuration, engine-
//    defined and tens of rows, not a 100k-row item table.
// 2. **FK targets are unqualified in SQLite and schema-qualified in Postgres**, the same
//    split `config-schema.mjs` already makes and for the same reasons: Postgres resolves an
//    unqualified target through `search_path`, which need not contain `blaze_config`.
//
// The two PARTIAL unique indexes are load-bearing and are not a stylistic choice. A naive
// `UNIQUE (project_key, slug)` does NOT stop two installation views sharing a slug, because
// NULL compares distinct under UNIQUE in both engines. `hierarchy-schema.mjs:38-42` solves
// the identical trap the same way; this is applying a house solution, not inventing one.
import { dialect } from "./sql-dialect.mjs";

/**
 * The six builtin view types, in `VIEW_NAMES` order so the switcher renders identically
 * after the migration. Seeded into `view_type` from here — the registry is CODE, and a type
 * row without a renderer module cannot render, which is the honest gap §4.4 records: no
 * constraint can express "this row has a module behind it".
 */
export const VIEW_TYPES = [
  { name: "board",   label: "Board" },
  { name: "list",    label: "List" },
  { name: "live",    label: "Live" },
  { name: "metrics", label: "Metrics" },
  { name: "map",     label: "Map" },
  { name: "gantt",   label: "Gantt" },
];

/** Namespace and FK-qualification differences. Deliberately local: `sql-dialect.mjs` says in
 *  as many words that it carries shared TOKENS and not config's namespace/ref peculiarities. */
function ns(name) {
  if (name === "postgres") {
    return {
      namespace: "CREATE SCHEMA IF NOT EXISTS blaze_config;",
      ref: (t) => `blaze_config.${t}`,
      // Postgres index names are not schema-qualified — an index lives in its table's schema.
      idx: (i, t) => `${i} ON blaze_config.${t}`,
    };
  }
  if (name === "sqlite") {
    // The caller ATTACHes the config file AS blaze_config. SQLite FK targets are always
    // within one database file and MUST NOT be qualified.
    return {
      namespace: "",
      ref: (t) => t,
      // SQLite puts the schema qualifier on the INDEX name and leaves the table bare —
      // `CREATE INDEX blaze_config.i ON t`. Qualifying the table instead is a syntax error,
      // which is how this was found.
      idx: (i, t) => `blaze_config.${i} ON ${t}`,
    };
  }
  throw new Error(`unknown dialect ${JSON.stringify(name)} — expected 'sqlite' or 'postgres'`);
}

export function viewDdl(name) {
  const d = dialect(name);
  const n = ns(name);
  const T = (t) => `blaze_config.${t}`;
  return `
${n.namespace}

CREATE TABLE IF NOT EXISTS ${T("view_type")} (
  name  ${d.txt} NOT NULL,
  label ${d.txt} NOT NULL,
  PRIMARY KEY (name)
)${d.tbl};

CREATE TABLE IF NOT EXISTS ${T("view")} (
  id           ${d.txt} NOT NULL,
  scope        ${d.txt} NOT NULL CHECK (scope IN ('installation','project')),
  project_key  ${d.txt},
  type         ${d.txt} NOT NULL,
  name         ${d.txt} NOT NULL,
  slug         ${d.txt} NOT NULL,
  ord          ${d.int} NOT NULL DEFAULT 0,
  is_builtin   ${d.bool} NOT NULL DEFAULT ${d.false_},
  enabled      ${d.bool} NOT NULL DEFAULT ${d.true_},
  config_json  ${d.json} NOT NULL DEFAULT ${d.jsonEmpty}
                 CHECK (${d.jsonIsObject("config_json")}),
  created_at   ${d.ts} NOT NULL,
  updated_at   ${d.ts} NOT NULL,
  PRIMARY KEY (id),
  -- The tag and the owner are inseparable at the store. §3.1 makes them inseparable at the
  -- call sites too, by a written rule with a grep test.
  CHECK ( (scope = 'installation' AND project_key IS NULL)
       OR (scope = 'project'      AND project_key IS NOT NULL) ),
  FOREIGN KEY (project_key) REFERENCES ${n.ref("project")} (key) ON DELETE CASCADE,
  FOREIGN KEY (type)        REFERENCES ${n.ref("view_type")} (name)
)${d.tbl};

-- NULL compares distinct under UNIQUE in BOTH engines, so a plain UNIQUE (project_key, slug)
-- would let two installation views both be slugged 'gantt'. These two partial indexes are the
-- fix, and both engines support them.
CREATE UNIQUE INDEX IF NOT EXISTS ${n.idx("view_slug_project", "view")}
  (project_key, slug) WHERE scope = 'project';
CREATE UNIQUE INDEX IF NOT EXISTS ${n.idx("view_slug_install", "view")}
  (slug)              WHERE scope = 'installation';
`;
}

/**
 * The `view_type` seed, from `VIEW_TYPES` (BLZ-377).
 *
 * Beside the DDL that declares the table, so the registry stays the one source. `view_type`
 * is deliberately NOT folded into `configSeedSql`'s ORDER: that list is config-schema's own
 * tables, and reaching across would couple it to this module for one row set. There is no
 * circular FK here, so unlike the config seed this needs no transaction.
 */
export function viewTypeSeedSql(name) {
  if (name !== "sqlite" && name !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(name)} — expected 'sqlite' or 'postgres'`);
  }
  const ph = (i) => (name === "postgres" ? `$${i + 1}` : "?");
  // Re-runnable: `blaze_config` outlives the data tables, so a create against a database that
  // already holds it re-applies this. `blaze db init` without `--force` hit exactly that and
  // died on `UNIQUE constraint failed: view_type.name`, leaving a half-built database behind.
  const tail = name === "postgres" ? " ON CONFLICT DO NOTHING" : "";
  const verb = name === "postgres" ? "INSERT INTO" : "INSERT OR IGNORE INTO";
  return VIEW_TYPES.map(({ name: n, label }) => ({
    sql: `${verb} blaze_config.view_type (name, label) VALUES (${ph(0)}, ${ph(1)})${tail}`,
    params: [n, label],
  }));
}
