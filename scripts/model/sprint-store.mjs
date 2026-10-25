// scripts/model/sprint-store.mjs — the sprint registry's database mapping (BLZ-705, spec D3).
//
// Sprints are data (the `sprints.mjs` header, ADR-0004), so on a Postgres board at schema v6
// they live in two tables: `sprint`, one row per sprint, and `sprint_registry`, the singleton
// that holds the active sprint and the registry's version. Both `extra_json` columns keep
// BLZ-369's rule — preserve what this engine does not understand — at both levels.
//
// No FK from `ticket.sprint_id` (spec D3): a migrate step must not fail on orphan data, and the
// engine already validates `--sprint` against the registry.
//
// BOTH DIALECTS ARE DECLARED, ONE IS INSTALLED (review I3). `sprint_registry` is a singleton in
// ADR-0014's own definition, and `tests/adr-0014-singletons.test.mjs` requires the two dialects
// to declare the same singleton set. So the SQLite form exists as an inert twin, and only
// `applyCreate` and `v5ToV6` install it — on Postgres only. The SQLite shadow is derived: a
// sprint written there would be lost on the next rebuild.
//
// BLZ-707 gives the tables their reader, writer and source picker. `openSprintSource` is the one
// place a sprint verb decides where the registry lives: Postgres only when all three hold —
// BLAZE_WRITE_PORT=db, database.driver postgres, and a stamp of at least V6_FEATURES_FROM —
// and `sprints.json`, exactly as before, in every other case.
import { join } from "node:path";
import { dialect } from "./sql-dialect.mjs";
import { isIsoDate, normaliseRegistry, stampedRegistry, loadSprints, saveSprints } from "./sprints.mjs";
import { checkDbSchema, V6_FEATURES_FROM } from "./db-schema-version.mjs";
import { resolveWriteMode, pgExec, describePgTarget } from "./write-port-resolve.mjs";
import { resolveDatabaseConfig } from "./database-config.mjs";
import { openPostgresClient } from "../init-pg.mjs";
import { loadConfig } from "../config.mjs";

/** Postgres has a `date` type; SQLite keeps an ISO `YYYY-MM-DD` string. */
const DATE = { postgres: "date", sqlite: "TEXT" };

/** The DDL for `sprint` and `sprint_registry`, for `"sqlite"` or `"postgres"`. */
export function sprintDdl(name) {
  const d = dialect(name);
  const date = DATE[name];
  return `
CREATE TABLE IF NOT EXISTS sprint (
  id         ${d.txt} PRIMARY KEY,
  name       ${d.txt} NOT NULL,
  start_date ${date},
  end_date   ${date},
  ord        ${d.int} NOT NULL,
  extra_json ${d.txt} NOT NULL DEFAULT '{}'
)${d.tbl};

CREATE TABLE IF NOT EXISTS sprint_registry (
  id               ${d.int} PRIMARY KEY CHECK (id = 1),
  active           ${d.txt},
  registry_version ${d.int},
  extra_json       ${d.txt} NOT NULL DEFAULT '{}'
)${d.tbl};
`;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * What the tables can hold, refused by name. `loadSprints` tolerates a malformed file by reading
 * it as no sprints; an import into the database must not, because the verify would then
 * "succeed" against an emptied registry. The message names a sprint by index and id, never by
 * anything else it carries.
 */
function validateRegistry(reg, source) {
  const fail = (reason) => { throw new Error(`blaze: ${source}: ${reason}`); };
  if (!isObject(reg)) fail("the registry is not an object");
  if (!Array.isArray(reg.sprints)) fail("sprints is not an array");
  // A stricter rule than the brief's list: `active` lands in a text column, so a number would
  // read back as a string and fail the verify with no better reason given.
  if (reg.active !== undefined && reg.active !== null && typeof reg.active !== "string") {
    fail("active is neither a sprint id nor null");
  }
  if (reg.registryVersion !== undefined
      && !(Number.isInteger(reg.registryVersion) && reg.registryVersion >= 1)) {
    fail("registryVersion is not an integer ≥ 1");
  }
  const seen = new Set();
  reg.sprints.forEach((sp, i) => {
    const at = `sprints[${i}]`;
    if (!isObject(sp)) fail(`${at} is not an object`);
    if (typeof sp.id !== "string" || sp.id === "") fail(`${at} has no id`);
    const named = `${at} (${sp.id})`;
    if (seen.has(sp.id)) fail(`${named} duplicates the id of an earlier sprint`);
    seen.add(sp.id);
    if (typeof sp.name !== "string") fail(`${named} name is not a string`);
    for (const f of ["start", "end"]) {
      if (sp[f] !== undefined && !isIsoDate(sp[f])) fail(`${named} ${f} is not a YYYY-MM-DD date`);
    }
  });
}

/** A `sprints.json`'s text, strictly: `blaze: <source>: <reason>` on anything the tables cannot hold. */
export function parseSprintRegistry(text, source) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`blaze: ${source}: the text is not JSON`); }
  validateRegistry(parsed, source);
  return normaliseRegistry(parsed);
}

/**
 * Replace the registry in the tables with `registry`, re-validated first (nothing is deleted for
 * an invalid one). Every top-level key but active/sprints/registryVersion goes to
 * `sprint_registry.extra_json`, and every sprint key but id/name/start/end to `sprint.extra_json`.
 * The caller owns the transaction.
 */
export async function writeSprintRegistry(exec, registry) {
  validateRegistry(registry, "sprint registry");
  await exec.run("DELETE FROM sprint", []);
  await exec.run("DELETE FROM sprint_registry", []);
  const { active = null, sprints, registryVersion = null, ...extra } = registry;
  await exec.run("INSERT INTO sprint_registry (id, active, registry_version, extra_json) VALUES (1, $1, $2, $3)",
    [active ?? null, registryVersion, JSON.stringify(extra)]);
  for (const [ord, sp] of sprints.entries()) {
    const { id, name, start = null, end = null, ...rest } = sp;
    await exec.run("INSERT INTO sprint (id, name, start_date, end_date, ord, extra_json) "
      + "VALUES ($1, $2, $3, $4, $5, $6)", [id, name, start, end, ord, JSON.stringify(rest)]);
  }
}

/** The registry the tables hold — `{ active: null, sprints: [] }` when they hold none. */
export async function readSprintRegistry(exec) {
  const reg = await exec.all("SELECT active, registry_version, extra_json FROM sprint_registry WHERE id = 1", []);
  // `::text`, as pg-storage.mjs casts every date: `pg` decodes a date as a LOCAL-midnight instant.
  const rows = await exec.all("SELECT id, name, start_date::text AS start_date, end_date::text AS end_date, "
    + "extra_json FROM sprint ORDER BY ord, id", []);
  if (!reg.length && !rows.length) return { active: null, sprints: [] };
  const r = reg[0] ?? { active: null, registry_version: null, extra_json: "{}" };
  const sprints = rows.map((s) => ({
    id: s.id, name: s.name,
    ...(s.start_date ? { start: s.start_date } : {}),
    ...(s.end_date ? { end: s.end_date } : {}),
    ...JSON.parse(s.extra_json),
  }));
  return { ...JSON.parse(r.extra_json), active: r.active, sprints,
           ...(r.registry_version !== null ? { registryVersion: r.registry_version } : {}) };
}

/**
 * Where `blaze sprint` reads and writes this board's registry. `postgres` holds one connection
 * until `close()`; a `save` there is one transaction, stamped by `stampedRegistry`'s rule.
 * Throws when db mode names a Postgres database it cannot use — never "no sprints".
 */
export async function openSprintSource({ dataRoot, env = process.env,
                                         resolveDbConfig = resolveDatabaseConfig,
                                         openPgClient = openPostgresClient } = {}) {
  const file = {
    kind: "file", where: join(dataRoot, "sprints.json"),
    load: () => loadSprints({ root: dataRoot }),
    save: (r) => saveSprints({ root: dataRoot }, r),
    close() {},
  };
  if (resolveWriteMode(env) !== "db") return file;
  const dbConfig = resolveDbConfig({ dataRoot, config: loadConfig({ root: dataRoot }), env });
  if (dbConfig.driver !== "postgres") return file;

  const client = await openPgClient(dbConfig.connection);
  const end = async () => { try { await client.end(); } catch { /* already closed */ } };
  const exec = pgExec(client);
  let state;
  try { state = await checkDbSchema(exec, { dialect: "postgres" }); }
  catch (e) { await end(); throw e; }
  if (!state.ok || state.state === "empty") {
    await end();
    throw new Error(`blaze: ${state.error ?? "the Postgres database has no Blaze schema — run 'blaze db init'"}`);
  }
  if (state.version < V6_FEATURES_FROM) { await end(); return file; }
  return {
    kind: "postgres", where: describePgTarget(dbConfig.connection),
    load: () => readSprintRegistry(exec),
    async save(registry) {
      await exec.run("BEGIN", []);
      try {
        await writeSprintRegistry(exec, stampedRegistry(registry));
        await exec.run("COMMIT", []);
      } catch (e) {
        try { await exec.run("ROLLBACK", []); } catch { /* the original error is what matters */ }
        throw e;
      }
    },
    close: end,
  };
}
