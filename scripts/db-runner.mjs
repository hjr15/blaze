// scripts/db-runner.mjs — `blaze db init|status` (BLZ-299).
//
// ADR-0012 makes schema creation an EXPLICIT, named operation: runtime `open()` reads
// and refuses rather than writing DDL behind your back (BLZ-297). This is that named
// operation, plus the command that reads back what a dual-write soak has found.
import { existsSync, rmSync } from "node:fs";
// BLZ-512 / ADR-0031. `existsSync` is not a guard — a FIFO satisfies it — and the
// divergence log is read with nothing between the check and the open.
import { readRegularFileSync } from "./model/regular-file.mjs";
import { resolveRoots, loadConfig, InvalidProjectKeyError } from "./config.mjs";
import { openShadow, shadowDbPath, configDbPath, divergenceLogPath,
         readSoakState, pgExec, openCheckedPg, describePgTarget } from "./model/write-port-resolve.mjs";
import { resolveDatabaseConfig } from "./model/database-config.mjs";
import { openPostgresClient } from "./init-pg.mjs";
import { corpusMaxima, seedCounter } from "./model/seed-counter.mjs";
import { WRITE_PORT_ENV } from "./model/write-port.mjs";
import { fsReadStorage } from "./model/read-storage.mjs";
import { DB_SCHEMA_VERSION, createDbSchema } from "./model/db-schema-version.mjs";

export const USAGE = `usage: blaze db <command>

  init          create the database schema. SQLite: create the shadow database and load
                this board into it. Postgres: create the schema and seed the id counter
                (the board's tickets are NOT loaded — that is the BLZ-254 migration)
  seed-counter  raise the db-mode id counter to every number already taken (ticket files,
                .ids/ claims, database rows). Run it immediately before BLAZE_WRITE_PORT=db
  status        what the database holds, and what the dual-write soak has found

  --force       with init, SQLite only: replace an existing shadow database
`;

/** The resolved `database` block, or a printed refusal (null). Resolved BEFORE anything is
 *  touched, so a bad key or an incomplete Postgres connection changes nothing on disk. */
function dbConfigOr(ctx) {
  try { return ctx.resolveDbConfig({ dataRoot: ctx.dataRoot, config: loadConfig({ root: ctx.dataRoot }) }); }
  catch (e) { ctx.err(e.message); return null; }
}

/** One line per project, `before → after`, plus a note when nothing moved. */
function printSeed(rows, log) {
  if (!rows.length) { log("  (no projects — nothing to seed)"); return; }
  for (const r of rows) log(`  ${r.project.padEnd(10)} ${r.before} → ${r.after}`);
}

/**
 * BLZ-668: `blaze db init` on Postgres — schema + counter seed ONLY. Loading the corpus into
 * Postgres is BLZ-254's migration (it carries the zero-diff oracle), not this command.
 * `--force` is refused: a CLI flag never drops a real database's tables.
 */
async function initPostgres({ dataRoot, projectsDir, force, log, err, openPgClient }, connection) {
  if (force) {
    err("blaze db init: --force is refused on Postgres. It would drop a real database's tables;");
    err("Blaze never does that from a CLI flag. Drop the schema by hand if you mean it.");
    return 1;
  }
  let client;
  try { client = await openPgClient(connection); }
  catch (e) { err(`blaze db init: cannot connect to ${describePgTarget(connection)} — ${e.message}`); return 1; }
  try {
    const exec = pgExec(client);
    const where = describePgTarget(connection);
    try { await createDbSchema(exec, { dialect: "postgres" }); }
    catch (e) {
      err(`blaze db init: ${where} — ${e.message}.`);
      // Only an ALREADY-INITIALISED database is sent to seed-counter. Anything else (an
      // unstamped or foreign schema, a permission error) is surfaced as it is.
      if (/already holds a Blaze schema/.test(e.message)) {
        err("It is already initialised. To bring its id counter up to date, run:\n");
        err("    blaze db seed-counter\n");
      }
      return 1;
    }
    let rows;
    try {
      rows = await seedCounter(exec,
        await corpusMaxima({ projectsDir, readStorage: fsReadStorage }), { dialect: "postgres" });
    } catch (e) {
      // The schema now EXISTS, so re-running init would refuse. Say so, and name the step
      // that finishes the job once the cause is fixed.
      err(`blaze db init: the schema was created at ${where}, but seeding the id counter failed:`);
      err(`  ${e.message}\n`);
      err("Fix that, then finish with:\n");
      err("    blaze db seed-counter\n");
      return 1;
    }
    log(`Postgres schema ready at ${describePgTarget(connection)}  (schema v${DB_SCHEMA_VERSION})`);
    log("id counter seeded:");
    printSeed(rows, log);
    log("\nThe board's tickets were NOT loaded — Postgres holds the schema and the counter only.");
    return 0;
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

async function init(ctx) {
  const dbConfig = dbConfigOr(ctx);
  if (!dbConfig) return 1;
  if (dbConfig.driver === "postgres") return initPostgres(ctx, dbConfig.connection);
  return initSqlite(ctx);
}

async function initSqlite({ dataRoot, projectsDir, force, log, err }) {
  const path = shadowDbPath(dataRoot);
  if (existsSync(path) && !force) {
    err(`blaze db init: ${path} already exists.\n`);
    err("Pass --force to replace it. Replacing discards whatever the current shadow");
    err("holds, including any divergences not yet reviewed.");
    return 1;
  }
  // BLZ-377: the config namespace is a SECOND file, and it is just as derived as the shadow.
  // Removing only `blaze.db` left a stale `config.db` beside a fresh one — the create then
  // re-seeded a `view_type` that already had its six rows and died on the UNIQUE constraint.
  // A half-replaced pair is exactly the state `--force` exists to avoid, so both go together.
  // Both files go together, on EVERY create rather than only under --force. Reaching here means
  // a fresh shadow is being built (init refuses an existing one without --force), and a
  // `config.db` left behind by an older engine would then be silently REUSED: its tables are
  // all `CREATE TABLE IF NOT EXISTS`, so a column added since would never appear, and the
  // version stamp that would catch it lives in `blaze_meta`, in the OTHER file, which was just
  // recreated at the current version. That is precisely the silent-stale-schema defect BLZ-297
  // exists to prevent, and the namespace is derived, so rebuilding costs nothing.
  const cfgPath = configDbPath(dataRoot);
  // Each removal is a NAMED REFUSAL rather than an escaping exception. They run in sequence, so
  // a failure on the second still leaves the first removed — that is safe and is why the message
  // says so: both files are derived, the state is idempotent on retry, and `blaze db init`
  // rebuilds whatever is missing. `rmSync(..., { force: true })` is NOT recursive, so a
  // `config.db` that is a DIRECTORY threw an uncaught EISDIR — after `blaze.db` had already
  // been deleted, leaving no shadow, no message, and the same throw on every retry. A
  // read-only `.blaze` did the same with EACCES. Both printed a caught message before this
  // ticket touched them; `runDb`'s try/catch sits further out than this code runs.
  for (const [label, target] of [["shadow database", force ? path : null], ["config namespace", cfgPath]]) {
    if (!target || !existsSync(target)) continue;
    try { rmSync(target, { recursive: true, force: true }); }
    catch (e) {
      err(`blaze db init: cannot remove the ${label} at ${target}.\n`);
      err(`  ${e.message}\n`);
      err("Remove it by hand and run 'blaze db init' again. Both files are derived, so");
      err("deleting them loses nothing the corpus does not already hold — including whichever");
      err("of the pair was already removed before this one failed.");
      return 1;
    }
  }

  // `blaze db status` is the command an operator runs to DIAGNOSE a version refusal, so it
  // must print the refusal rather than a stack trace about it.
  let db, exec;
  try { ({ db, exec } = await openShadow(dataRoot, { create: true })); }
  catch (e) { console.error(e.message); process.exit(1); }
  try {
    const { loadCorpus } = await import("./migrate/load-corpus.mjs");
    // Migration mode: the corpus predates the required-field rule, and 242 tickets have
    // no estimate. Enforcing on import would demand 242 invented estimates (BLZ-289).
    const { writeRulesDdl, setMigrationModeSql } = await import("./model/write-rules.mjs");
    const { projectionDdl } = await import("./model/projection-schema.mjs");
    const { refreshProjection } = await import("./model/projection.mjs");
    const { configSeed } = await import("./model/config-schema.mjs");

    db.exec(projectionDdl("sqlite"));
    // BLZ-402 review finding 3: loadConfig throws `blaze: …` on a malformed project key
    // too, since BLZ-402 — `cli.mjs`'s preflight already catches this for the normal
    // `blaze db init` path, but a direct `node db-runner.mjs init` bypasses it entirely.
    // The outer `finally` below still closes `db` on this path since it re-throws through it.
    let cfg;
    try { cfg = loadConfig({ root: dataRoot }); }
    catch (e) {
      if (e instanceof InvalidProjectKeyError) {
        db.close(); // process.exit() below would otherwise skip the outer `finally`.
        console.error(e.message);
        process.exit(1);
      }
      throw e;
    }
    await refreshProjection(exec, {
      ...configSeed(),
      project: (cfg.projects ?? []).map((key, ord) => ({ key, name: key, ord })),
      project_label: [], project_component: [],
    }, { now: new Date().toISOString() });
    db.exec(writeRulesDdl("sqlite"));
    db.exec(setMigrationModeSql("sqlite", true));

    const tally = await loadCorpus(db, projectsDir, {
      source: fsReadStorage, today: new Date().toISOString().slice(0, 10),
    });
    db.exec(setMigrationModeSql("sqlite", false));

    log(`shadow database ready at ${path}  (schema v${DB_SCHEMA_VERSION})`);
    log(`  tickets      ${tally.tickets}`);
    log(`  links        ${tally.links}`);
    log(`  criteria     ${tally.criteria}`);
    log(`  worklog      ${tally.worklog}`);
    log(`  labels       ${tally.labels}   components ${tally.components}`);
    // Every substitution is named. A tally that reports only successes is a tally that
    // cannot be trusted (BLZ-280).
    if (tally.titleFallbacks) log(`  ⚠ titles substituted from id: ${tally.titleFallbacks}`);
    if (tally.danglingParents) log(`  ⚠ dangling parents counted: ${tally.danglingParents}`);
    if (tally.danglingLinks) log(`  ⚠ dangling links dropped: ${tally.danglingLinks}`);
    if (tally.skipped.insertFailed.length) {
      log(`  ⚠ rows the database refused: ${tally.skipped.insertFailed.length}`);
      for (const f of tally.skipped.insertFailed.slice(0, 5)) log(`      ${f.id}: ${f.reason}`);
    }
    log(`\nNow run the board with BLAZE_WRITE_PORT=dual to soak it. The filesystem stays`);
    log(`the source of truth; divergences land in ${divergenceLogPath(dataRoot)}.`);
    return 0;
  } finally {
    db.close();
  }
}

async function status({ dataRoot, log }) {
  const path = shadowDbPath(dataRoot);
  if (!existsSync(path)) {
    log("no shadow database. Run 'blaze db init' to create one.");
    return 0;
  }
  // `blaze db status` is the command an operator runs to DIAGNOSE a version refusal, so it
  // must print the refusal rather than a stack trace about it.
  let db, exec;
  try { ({ db, exec } = await openShadow(dataRoot)); }
  catch (e) { console.error(e.message); process.exit(1); }
  try {
    const n = (t) => exec.all(`SELECT count(*) AS n FROM ${t}`)[0].n;
    log(`shadow database ${path}`);
    log(`  schema       v${exec.all("SELECT value FROM blaze_meta WHERE key='schema_version'")[0]?.value}`);
    log(`  tickets      ${n("ticket")}`);
    log(`  links        ${n("ticket_link")}`);
    // Split by kind. `acceptance_criterion` holds BOTH criteria and notes, so counting
    // the table and calling it "criteria" overstates it by every note — 2,339 of them
    // on this board. It reads as the shadow inventing rows, which is exactly the alarm
    // a soak must not raise falsely.
    const acByKind = exec.all(
      "SELECT kind, count(*) AS n FROM acceptance_criterion GROUP BY kind");
    const byKind = Object.fromEntries(acByKind.map((r) => [r.kind, r.n]));
    log(`  criteria     ${byKind.criterion ?? 0}`);
    log(`  AC notes     ${byKind.note ?? 0}`);
  } finally { db.close(); }

  // Is the soak actually ON right now? A week of "no divergences" from a board whose
  // env var was never exported is not evidence of anything, and it looks identical to
  // a week of perfect agreement.
  const mode = (process.env[WRITE_PORT_ENV] ?? "fs").trim();
  log(`\nwrite port   ${mode}${mode === "fs" ? "   (the soak is NOT running — export "
    + `${WRITE_PORT_ENV}=dual)` : ""}`);

  const soak = readSoakState(dataRoot);
  if (soak) {
    log(`operations   ${soak.operations}   (first ${soak.firstAt.slice(0, 10)}, `
      + `last ${soak.lastAt.slice(0, 10)})`);
  } else {
    log("operations   0   — nothing has been written through the dual port yet");
  }

  const logPath = divergenceLogPath(dataRoot);
  if (!existsSync(logPath)) {
    // Deliberately not "no soak has run": the log is written only when the two sides
    // DIFFER, so an absent file is exactly what a clean soak looks like. Claiming
    // otherwise reports a successful soak as one that never happened.
    log("divergences: none recorded — the log is written only when the filesystem");
    log("and the database disagree, so this is also what a clean soak looks like.");
    return 0;
  }
  // REFUSE. Every line below is a count the operator reads as the soak's verdict; a
  // count derived from a file this run could not open is not a verdict.
  const lines = readRegularFileSync(logPath, "utf8").split("\n").filter(Boolean);
  log(`divergences: ${lines.length}  (${logPath})`);
  if (!lines.length) return 0;

  // Grouped by FIELD, because a hundred divergences on one field is one bug and a
  // hundred on a hundred fields is a different problem entirely.
  const byField = {};
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.shadowError) { byField["<shadow threw>"] = (byField["<shadow threw>"] ?? 0) + 1; continue; }
      for (const f of d.fields ?? []) byField[f.field] = (byField[f.field] ?? 0) + 1;
    } catch { byField["<unparseable line>"] = (byField["<unparseable line>"] ?? 0) + 1; }
  }
  for (const [field, count] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
    log(`  ${String(count).padStart(5)}  ${field}`);
  }
  return 0;
}

export async function runDb(argv, io = {}) {
  const { log = console.log, err = console.error } = io;
  const cmd = argv.find((a) => !a.startsWith("-"));
  const force = argv.includes("--force");
  if (!cmd || argv.includes("--help") || argv.includes("-h")) { log(USAGE); return cmd ? 0 : 1; }

  const roots = io.roots ?? resolveRoots();
  // `resolveDbConfig` / `openPostgresClient` are injectable exactly as resolveWritePort's are,
  // so a test drives the Postgres branch against a scratch database.
  const ctx = { dataRoot: roots.dataRoot, projectsDir: roots.projectsDir, force, log, err,
                resolveDbConfig: io.resolveDbConfig ?? resolveDatabaseConfig,
                openPgClient: io.openPostgresClient ?? openPostgresClient };
  if (cmd === "init") return init(ctx);
  if (cmd === "status") return status(ctx);
  err(`blaze db: unknown command ${JSON.stringify(cmd)}\n`);
  err(USAGE);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("db-runner.mjs")) {
  process.exit(await runDb(process.argv.slice(2)));
}
