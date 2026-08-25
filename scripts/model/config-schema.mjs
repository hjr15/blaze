// scripts/model/config-schema.mjs — the `blaze_config` namespace (BLZ-286).
//
// Design D1/D3: config and data are separate namespaces — two Postgres schemas in one
// database, two ATTACHed files in SQLite. Every statement addresses objects by the
// same qualified name (`blaze_config.x`) in both drivers, so the adapter owns
// connect/attach and nothing else.
//
// THE SEEDS ARE DERIVED, NEVER RETYPED. Priorities, resolutions, link types, the type
// registry and the workflow registry are read from the engine's own exported
// registries at build time. Retyping them here would create a second source of truth
// that drifts the first time someone adds a type — and drifts silently, because a
// hand-written seed list is still valid SQL when it is wrong.
import { join, dirname } from "node:path";
import { PRIORITIES, DEFAULT_TYPES } from "./schema.mjs";
import { RESOLUTIONS, DEFAULT_WORKFLOWS } from "./workflows.mjs";
import { LINK_TYPES, TRACE_LINK_TYPES } from "./links.mjs";

// `workflow.reopen_to` references `workflow_status`, which references `workflow`. That
// cycle is not an ordering problem to be solved by inserting one table first — there IS
// no order that satisfies it, because a workflow needs its statuses and its statuses
// need their workflow. The design records it as "FK added after workflow_status exists",
// which fixes DDL creation and leaves DML impossible. Both dialects therefore declare it
// DEFERRABLE INITIALLY DEFERRED, and `configSeedSql` MUST be applied inside a
// transaction — see `seedInTransaction` below, which is the supported way to do it.

// Display-only inverses. Not derivable from LINK_TYPES, which is a bare Set.
const INVERSE = { Blocks: "Blocked by", Cloners: "Cloned by", Implements: "Implemented by",
                  Addresses: "Addressed by" };
const DIRECTED = new Set(["Blocks", "Cloners", "Implements", "Addresses"]);

// Success/failure per resolution. `done` is the only success today.
const SUCCESS = new Set(["done"]);

const BOARD_SCOPE = "*";

/**
 * Dialect divergences, all of them, in one place. §2 of the v3 design plus the four
 * found while building the Postgres driver (BLZ-282).
 */
function dialect(name) {
  if (name === "postgres") {
    return {
      ts: "timestamptz", bool: "boolean", true_: "true", false_: "false",
      // Postgres regex operator. SQLite has no regex without an extension.
      projectKeyCheck: "CHECK (key ~ '^[A-Z][A-Z0-9]*$')",
      // Postgres cannot declare an FK to a table that does not exist yet.
      // IDEMPOTENT, like every other statement in this DDL (BLZ-377). Postgres has no
      // `ADD CONSTRAINT IF NOT EXISTS`, so the duplicate is caught instead.
      //
      // This was the ONE statement here that could not be run twice, which did not matter while
      // nothing in production ran this DDL at all. The moment `createDbSchema` started
      // installing the namespace, it did: `blaze_config` is a schema, not a table, so it
      // outlives the `public` tables the create guard inspects — a database whose data tables
      // were dropped still has it. The second create then failed with
      // `constraint "workflow_reopen_to_fk" for relation "workflow" already exists`, and on a
      // FRESH Postgres — which is what CI provisions every run — that took the whole gate down.
      circularFk: `DO $$
BEGIN
  ALTER TABLE blaze_config.workflow
    ADD CONSTRAINT workflow_reopen_to_fk
    FOREIGN KEY (scope, name, reopen_to)
    REFERENCES blaze_config.workflow_status (scope, workflow, status)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;`,
      inlineCircularFk: "",
      namespace: "CREATE SCHEMA IF NOT EXISTS blaze_config;",
      ifNotExists: "IF NOT EXISTS ",
      // Postgres resolves an unqualified FK target through search_path, which need not
      // contain blaze_config — so every REFERENCES target must be schema-qualified.
      ref: (t) => `blaze_config.${t}`,
    };
  }
  if (name === "sqlite") {
    return {
      ts: "TEXT", bool: "INTEGER", true_: "1", false_: "0",
      // GLOB is the closest SQLite gets. `[A-Z]*` then a second GLOB for the tail.
      projectKeyCheck: "CHECK (key GLOB '[A-Z]*' AND key NOT GLOB '*[^A-Z0-9]*')",
      circularFk: "",
      // SQLite resolves FK targets at DML time, not DDL time, so the circular
      // reference can simply be declared inline — no ALTER needed (and SQLite has no
      // ALTER TABLE ADD CONSTRAINT at all).
      inlineCircularFk: ",\n  FOREIGN KEY (scope, name, reopen_to)\n    REFERENCES workflow_status (scope, workflow, status)\n    DEFERRABLE INITIALLY DEFERRED",
      namespace: "",   // the caller ATTACHes the file AS blaze_config
      ifNotExists: "IF NOT EXISTS ",
      // SQLite FKs are always within one database file and MUST NOT be qualified —
      // "foreign key on X should reference only one table" if you try.
      ref: (t) => t,
    };
  }
  throw new Error(`unknown dialect ${JSON.stringify(name)} — expected 'sqlite' or 'postgres'`);
}

/** The `blaze_config` DDL for one dialect. */
export function configDdl(name) {
  const d = dialect(name);
  const T = (t) => `blaze_config.${t}`;
  return `
${d.namespace}

CREATE TABLE ${d.ifNotExists}${T("board")} (
  id             integer PRIMARY KEY CHECK (id = 1),
  title          text    NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  port           integer NOT NULL DEFAULT 4321,
  agent_command  text    NOT NULL DEFAULT 'claude -p',
  provider       text    NOT NULL DEFAULT 'github',
  views_json     text    NOT NULL DEFAULT '{}',
  loops_json     text    NOT NULL DEFAULT '{}',
  updated_at     ${d.ts} NOT NULL
);

CREATE TABLE ${d.ifNotExists}${T("config_version")} (
  id        integer PRIMARY KEY CHECK (id = 1),
  version   bigint  NOT NULL CHECK (version > 0),
  bumped_at ${d.ts} NOT NULL
);

CREATE TABLE ${d.ifNotExists}${T("project")} (
  key         text PRIMARY KEY ${d.projectKeyCheck},
  name        text NOT NULL,
  description text,
  ord         integer NOT NULL DEFAULT 0,
  label_mode      text NOT NULL DEFAULT 'open'  CHECK (label_mode     IN ('open','closed')),
  component_mode  text NOT NULL DEFAULT 'open'  CHECK (component_mode IN ('open','closed')),
  require_labels                  ${d.bool} NOT NULL DEFAULT ${d.false_},
  require_components              ${d.bool} NOT NULL DEFAULT ${d.false_},
  require_worklog_before_terminal ${d.bool} NOT NULL DEFAULT ${d.false_},
  code_repos_json text NOT NULL DEFAULT '[]',
  archived_at ${d.ts},
  created_at  ${d.ts} NOT NULL,
  updated_at  ${d.ts} NOT NULL
);

CREATE TABLE ${d.ifNotExists}${T("priority")} (
  name text PRIMARY KEY,
  ord  integer NOT NULL UNIQUE
);

CREATE TABLE ${d.ifNotExists}${T("resolution")} (
  name       text PRIMARY KEY,
  is_success ${d.bool} NOT NULL,
  ord        integer NOT NULL UNIQUE
);

CREATE TABLE ${d.ifNotExists}${T("link_type")} (
  name         text PRIMARY KEY,
  is_directed  ${d.bool} NOT NULL,
  is_trace     ${d.bool} NOT NULL DEFAULT ${d.false_},
  inverse_name text,
  ord          integer NOT NULL
);

CREATE TABLE ${d.ifNotExists}${T("workflow")} (
  scope     text NOT NULL,
  name      text NOT NULL,
  reopen_to text NOT NULL,
  PRIMARY KEY (scope, name)${d.inlineCircularFk}
);

CREATE TABLE ${d.ifNotExists}${T("workflow_status")} (
  scope                  text NOT NULL,
  workflow               text NOT NULL,
  status                 text NOT NULL,
  ord                    integer NOT NULL,
  is_terminal            ${d.bool} NOT NULL DEFAULT ${d.false_},
  resolution_on_terminal text,
  PRIMARY KEY (scope, workflow, status),
  UNIQUE (scope, workflow, ord),
  CHECK (resolution_on_terminal IS NULL OR is_terminal = ${d.true_}),
  FOREIGN KEY (scope, workflow) REFERENCES ${d.ref("workflow")} (scope, name) ON DELETE CASCADE,
  FOREIGN KEY (resolution_on_terminal) REFERENCES ${d.ref("resolution")} (name)
);

CREATE TABLE ${d.ifNotExists}${T("workflow_transition")} (
  scope       text NOT NULL,
  workflow    text NOT NULL,
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (scope, workflow, from_status, to_status),
  CHECK (from_status <> to_status),
  FOREIGN KEY (scope, workflow, from_status) REFERENCES ${d.ref("workflow_status")} (scope, workflow, status) ON DELETE CASCADE,
  FOREIGN KEY (scope, workflow, to_status)   REFERENCES ${d.ref("workflow_status")} (scope, workflow, status) ON DELETE CASCADE
);

CREATE TABLE ${d.ifNotExists}${T("ticket_type")} (
  scope    text NOT NULL,
  type     text NOT NULL,
  level    integer NOT NULL,
  workflow text NOT NULL,
  ord      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, type),
  FOREIGN KEY (scope, workflow) REFERENCES ${d.ref("workflow")} (scope, name)
);

CREATE TABLE ${d.ifNotExists}${T("type_parent")} (
  scope       text NOT NULL,
  child_type  text NOT NULL,
  parent_type text NOT NULL,
  PRIMARY KEY (scope, child_type, parent_type),
  FOREIGN KEY (scope, child_type)  REFERENCES ${d.ref("ticket_type")} (scope, type) ON DELETE CASCADE,
  FOREIGN KEY (scope, parent_type) REFERENCES ${d.ref("ticket_type")} (scope, type)
);

CREATE TABLE ${d.ifNotExists}${T("type_required_field")} (
  scope text NOT NULL,
  type  text NOT NULL,
  field text NOT NULL CHECK (field IN ('title','description','estimate','likelihood','impact')),
  PRIMARY KEY (scope, type, field),
  FOREIGN KEY (scope, type) REFERENCES ${d.ref("ticket_type")} (scope, type) ON DELETE CASCADE
);

CREATE TABLE ${d.ifNotExists}${T("project_component")} (
  project_key text NOT NULL REFERENCES ${d.ref("project")} (key) ON DELETE CASCADE,
  name        text NOT NULL,
  ord         integer NOT NULL DEFAULT 0,
  source      text NOT NULL DEFAULT 'declared' CHECK (source IN ('declared','implicit')),
  retired_at  ${d.ts},
  PRIMARY KEY (project_key, name)
);

CREATE TABLE ${d.ifNotExists}${T("project_label")} (
  project_key text NOT NULL REFERENCES ${d.ref("project")} (key) ON DELETE CASCADE,
  name        text NOT NULL,
  ord         integer NOT NULL DEFAULT 0,
  source      text NOT NULL DEFAULT 'declared' CHECK (source IN ('declared','implicit')),
  retired_at  ${d.ts},
  PRIMARY KEY (project_key, name)
);

${d.circularFk}
`.trim() + "\n";
}

/**
 * The seeded registries, DERIVED from the engine's exported registries.
 *
 * Returns plain rows rather than SQL so a test can compare them against the engine
 * directly — the drift check is then on the data, not on a string of INSERTs.
 */
export function configSeed({ types = DEFAULT_TYPES, workflows = DEFAULT_WORKFLOWS } = {}) {
  const priority   = PRIORITIES.map((name, ord) => ({ name, ord }));
  const resolution = RESOLUTIONS.map((name, ord) => ({ name, ord, is_success: SUCCESS.has(name) }));
  const link_type  = [...LINK_TYPES].map((name, ord) => ({
    name, ord, is_directed: DIRECTED.has(name),
    is_trace: TRACE_LINK_TYPES.has(name), inverse_name: INVERSE[name] ?? null,
  }));

  const workflow = [], workflow_status = [], workflow_transition = [];
  for (const [name, def] of Object.entries(workflows)) {
    workflow.push({ scope: BOARD_SCOPE, name, reopen_to: def.reopenTo });
    const terminal = new Set(def.terminal ?? []);
    def.statuses.forEach((status, ord) => {
      workflow_status.push({
        scope: BOARD_SCOPE, workflow: name, status, ord,
        is_terminal: terminal.has(status),
        resolution_on_terminal: terminal.has(status)
          ? (def.resolutionOnTerminal?.[status] ?? null) : null,
      });
    });
    for (const [from_status, to_status] of def.transitions ?? []) {
      workflow_transition.push({ scope: BOARD_SCOPE, workflow: name, from_status, to_status });
    }
    // The reopen edge is IMPLICIT today — canTransition returns true for any
    // `from -> reopenTo`. Materialise it, so the transition check is one index lookup
    // with no special case and the graph view can show the real edge set.
    for (const status of def.statuses) {
      if (status === def.reopenTo) continue;
      const already = workflow_transition.some((t) =>
        t.workflow === name && t.from_status === status && t.to_status === def.reopenTo);
      if (!already) {
        workflow_transition.push({ scope: BOARD_SCOPE, workflow: name,
                                   from_status: status, to_status: def.reopenTo });
      }
    }
  }

  const ticket_type = [], type_parent = [], type_required_field = [];
  Object.entries(types).forEach(([type, def], ord) => {
    ticket_type.push({ scope: BOARD_SCOPE, type, level: def.level, workflow: def.workflow, ord });
    for (const parent_type of def.parentTypes ?? []) {
      type_parent.push({ scope: BOARD_SCOPE, child_type: type, parent_type });
    }
    for (const field of def.required ?? []) {
      type_required_field.push({ scope: BOARD_SCOPE, type, field });
    }
  });

  return { priority, resolution, link_type, workflow, workflow_status,
           workflow_transition, ticket_type, type_parent, type_required_field };
}

/**
 * The seed as parameterised statements, in FK-safe order.
 *
 * Placeholders and booleans are the two divergences that reach the DML layer: `?` vs
 * `$n`, and `true`/`false` vs `1`/`0`. Everything else is byte-identical SQL.
 */
export function configSeedSql(name, seed = configSeed()) {
  const pg = name === "postgres";
  if (!pg && name !== "sqlite") {
    throw new Error(`unknown dialect ${JSON.stringify(name)} — expected 'sqlite' or 'postgres'`);
  }
  const enc = (v) => (typeof v === "boolean" ? (pg ? v : (v ? 1 : 0)) : v);

  // Order matters: workflow before workflow_status (FK), workflow_status before
  // workflow_transition and before workflow's own circular reopen_to reference,
  // ticket_type before type_parent and type_required_field.
  const ORDER = ["priority", "resolution", "link_type", "workflow", "workflow_status",
                 "workflow_transition", "ticket_type", "type_parent", "type_required_field"];

  const out = [];
  for (const table of ORDER) {
    for (const row of seed[table] ?? []) {
      const cols = Object.keys(row);
      const ph = cols.map((_, i) => (pg ? `$${i + 1}` : "?"));
      // Re-runnable, for the same reason the DDL is: `blaze_config` outlives the data tables,
      // KNOWN LIMIT, stated where someone would hit it: this makes the DATABASE out-rank the
      // registry. A namespace that survives a rebuild keeps its old rows if a code registry has
      // since changed. `blaze db init` removes both files on every create so the supported path
      // never reaches it; making the seed authoritative needs `ON CONFLICT (pk) DO UPDATE` and a
      // per-table primary-key map. See docs/superpowers/plans/2026-08-25-blz-377-install-plan.md.
      // so a create against a database that already carries it re-applies this seed. Without
      // the guard the second run dies on a primary-key collision. `write-rules.mjs` next door
      // already seeds `migration_mode` exactly this way in both dialects.
      out.push({
        sql: pg
          ? `INSERT INTO blaze_config.${table} (${cols.join(", ")}) VALUES (${ph.join(", ")}) `
            + "ON CONFLICT DO NOTHING"
          : `INSERT OR IGNORE INTO blaze_config.${table} (${cols.join(", ")}) VALUES (${ph.join(", ")})`,
        params: cols.map((c) => enc(row[c])),
      });
    }
  }
  return out;
}

/** `ATTACH` statement a SQLite caller runs before the config DDL. */
export function sqliteAttachConfig(path = ":memory:") {
  return `ATTACH DATABASE '${String(path).replace(/'/g, "''")}' AS blaze_config;`;
}

/**
 * Where the config namespace's file lives for a given main database (BLZ-377).
 *
 * Beside the database it belongs to, following `identityDbPath`'s precedent of a second
 * SQLite file under `.blaze/`. Derived from the main path rather than from `dataRoot` so
 * that ONE rule serves both openers — `openSqliteRead` is handed a path and never sees a
 * data root.
 *
 * `:memory:` maps to `:memory:`, which ATTACHes a SEPARATE anonymous in-memory database.
 * Giving an in-memory database an on-disk config file would leave a stray `config.db` in
 * whatever directory a test happened to run from.
 */
export function configDbPathFor(mainPath) {
  return mainPath === ":memory:" ? ":memory:" : join(dirname(mainPath), "config.db");
}

/**
 * The seed, in one transaction, SYNCHRONOUSLY (BLZ-377).
 *
 * Not a duplicate of `seedConfigInTransaction` for style. That function is `async`, and
 * node:sqlite's driver is synchronous: every `await` in it defers to a microtask, so a
 * synchronous caller like `createDbSchemaSync` returns BEFORE the seed has run and hands
 * back a database whose config tables are still empty. There is no way to await it from a
 * sync path — that is structural, the same split `readSchemaFactsSync` already makes.
 *
 * The transaction is load-bearing for the same reason it is there: `workflow.reopen_to` is
 * a deferred circular FK, so the seed is only consistent at COMMIT and fails on the first
 * `workflow` row without one.
 *
 * @param run  (sql, params) => void — a SYNCHRONOUS execute. Passing an async one silently
 *             reintroduces the very bug this exists to avoid.
 */
export function seedConfigSync(run, name, seed = configSeed()) {
  run("BEGIN", []);
  try {
    for (const { sql, params } of configSeedSql(name, seed)) run(sql, params);
    run("COMMIT", []);
  } catch (e) {
    try { run("ROLLBACK", []); } catch { /* the original error is what matters */ }
    throw e;
  }
}

/**
 * Apply the seed inside one transaction.
 *
 * Not a convenience: the circular `workflow.reopen_to` FK is deferred, so the seed is
 * only consistent AT COMMIT. Applied statement-by-statement outside a transaction it
 * fails on the very first `workflow` row, in both dialects.
 *
 * @param run  (sql, params) => void|Promise — the driver's execute. May be sync or async.
 * @returns whatever `run` returns for the COMMIT, so an async driver can be awaited.
 */
export async function seedConfigInTransaction(run, name, seed = configSeed()) {
  await run("BEGIN", []);
  try {
    for (const { sql, params } of configSeedSql(name, seed)) await run(sql, params);
    return await run("COMMIT", []);
  } catch (e) {
    // Sync drivers return undefined; `.catch()` on that throws and masks the real error.
    try { await run("ROLLBACK", []); } catch { /* the original error is what matters */ }
    throw e;
  }
}
