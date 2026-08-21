// scripts/model/db-schema-version.mjs — a version stamp for the DATABASE schema
// (BLZ-297), and the guard that refuses to open one this engine does not understand.
//
// THE DEFECT THIS EXISTS FOR, reproduced before it was written: `openSqliteRead` exec'd
// the whole DDL on every open, and every statement is `CREATE TABLE IF NOT EXISTS`.
// Against a database created by an EARLIER engine the creates are skipped, the missing
// columns are never added, and nothing reports anything:
//
//     open() SUCCEEDED against the old schema
//     ref column present after open? false
//     getTicket: returned a ticket
//
// The engine read happily from a stale schema. Blaze's CONFIG schema has been guarded
// since ADR-0002 (`schema-version.mjs`); its DATABASE schema was not guarded at all.
// That asymmetry is what this closes.
//
// The vocabulary is deliberately the same as the config guard's — `{ ok, error }`,
// never throwing — so there is one way to ask "can this engine read this?" rather than
// two that drift.
import { SQLITE_DDL } from "./sqlite-schema.mjs";
import { PG_DDL } from "./pg-schema.mjs";

/** Bump when a change makes an OLDER engine unable to read a database this one writes. */
export const DB_SCHEMA_VERSION = 1;
/** The oldest stamp this engine can still read. */
export const MIN_DB_SCHEMA_VERSION = 1;

const DOCS = "https://github.com/hjr15/blaze/blob/main/docs/schema-versioning.md";

/** The meta table, in both dialects. Deliberately trivial and deliberately separate
 *  from `blaze_config.board`: a config bump is not an engine-schema bump, and
 *  conflating them makes an upgrade look like a config change. */
export function metaDdl(dialect) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  return `CREATE TABLE IF NOT EXISTS blaze_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
`;
}

const ph = (dialect, i) => (dialect === "postgres" ? `$${i + 1}` : "?");

/**
 * What state is this database in, from the engine's point of view?
 *
 * Returns `{ ok, error, state, version }` and never throws, matching
 * `checkSchemaVersion`'s contract. `state` is one of:
 *
 *   empty      — no Blaze tables at all; safe to create
 *   current    — stamped, and this engine can read it
 *   unstamped  — HAS Blaze tables but no stamp. Refused: either it predates versioning
 *                or it is not a Blaze database, and guessing which is how the original
 *                defect happened
 *   older      — stamped below this engine's floor
 *   newer      — stamped above this engine's ceiling
 */
export function judgeDbSchema({ hasTicket, hasMeta, version,
                                current = DB_SCHEMA_VERSION,
                                min = MIN_DB_SCHEMA_VERSION }) {
  if (!hasTicket && !hasMeta) {
    return { ok: true, error: null, state: "empty", version: null };
  }
  if (version === null || version === undefined
      || !Number.isInteger(version) || version < 1) {
    return {
      ok: false, state: "unstamped", version: null,
      error: "this database holds tables but no Blaze schema stamp. It was either "
           + "created by an engine that predates database-schema versioning, or it is "
           + `not a Blaze database. Refusing to use it rather than guessing — see ${DOCS}`,
    };
  }
  if (version > current) {
    return {
      ok: false, state: "newer", version,
      error: `database schema version ${version} is newer than this engine supports `
           + `(supported: ${min}..${current}); upgrade the engine — see ${DOCS}`,
    };
  }
  if (version < min) {
    return {
      ok: false, state: "older", version,
      error: `database schema version ${version} is older than this engine supports `
           + `(supported: ${min}..${current}); run 'blaze db migrate' — see ${DOCS}`,
    };
  }
  return { ok: true, error: null, state: "current", version };
}

/** The three facts the judgement needs, read the SYNC way. For node:sqlite. */
export function readSchemaFactsSync(exec) {
  const has = (name) => Boolean(exec.all(
    "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = ?", [name])?.length);
  const hasMeta = has("blaze_meta");
  let version = null;
  if (hasMeta) {
    const rows = exec.all("SELECT value FROM blaze_meta WHERE key = ?", ["schema_version"]);
    if (rows?.length) version = Number(rows[0].value);
  }
  return { hasTicket: has("ticket"), hasMeta, version };
}

/** Async wrapper, for drivers whose I/O is async. Same judgement, different fetch. */
export async function checkDbSchema(exec, { dialect = "sqlite", current, min } = {}) {
  const facts = dialect === "postgres"
    ? await readSchemaFactsAsync(exec)
    : readSchemaFactsSync(exec);
  return judgeDbSchema({ ...facts, ...(current ? { current } : {}), ...(min ? { min } : {}) });
}

async function readSchemaFactsAsync(exec) {
  const has = async (name) => Boolean((await exec.all(
    `SELECT 1 AS hit FROM information_schema.tables
      WHERE table_name = $1 AND table_schema = ANY (current_schemas(false))`, [name]))?.length);
  const hasMeta = await has("blaze_meta");
  let version = null;
  if (hasMeta) {
    const rows = await exec.all("SELECT value FROM blaze_meta WHERE key = $1", ["schema_version"]);
    if (rows?.length) version = Number(rows[0].value);
  }
  return { hasTicket: await has("ticket"), hasMeta, version };
}

/**
 * Create the schema and stamp it. THE explicit, named operation — runtime `open()`
 * refuses rather than doing this silently, which is the whole point of BLZ-297.
 *
 * Refuses a database that already holds Blaze tables: creating over one is how a
 * half-migrated schema is produced, and `CREATE TABLE IF NOT EXISTS` makes that look
 * like success.
 */
export async function createDbSchema(exec, { dialect = "sqlite" } = {}) {
  return applyCreate(exec, dialect, await checkDbSchema(exec, { dialect }));
}

/** Same rule, sync fetch. node:sqlite cannot await. */
export function createDbSchemaSync(exec) {
  return applyCreate(exec, "sqlite", judgeDbSchema(readSchemaFactsSync(exec)));
}

function applyCreate(exec, dialect, state) {
  if (state.state !== "empty") {
    throw new Error(state.ok
      ? `refusing to create: this database already holds a Blaze schema at version ${state.version}`
      : `refusing to create: ${state.error}`);
  }
  const ddl = dialect === "postgres" ? PG_DDL : SQLITE_DDL;
  const r1 = exec.run(ddl, []);
  const r2 = exec.run(metaDdl(dialect), []);
  const r3 = exec.run(
    `INSERT INTO blaze_meta (key, value) VALUES (${ph(dialect, 0)}, ${ph(dialect, 1)})`,
    ["schema_version", String(DB_SCHEMA_VERSION)]);
  // Await only if the driver actually returned promises — one body, both drivers.
  const done = { created: true, version: DB_SCHEMA_VERSION };
  return (r1 instanceof Promise || r2 instanceof Promise || r3 instanceof Promise)
    ? Promise.all([r1, r2, r3]).then(() => done)
    : done;
}
