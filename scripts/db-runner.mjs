// scripts/db-runner.mjs — `blaze db init|status` (BLZ-299).
//
// ADR-0012 makes schema creation an EXPLICIT, named operation: runtime `open()` reads
// and refuses rather than writing DDL behind your back (BLZ-297). This is that named
// operation, plus the command that reads back what a dual-write soak has found.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolveRoots, loadConfig } from "./config.mjs";
import { openShadow, shadowDbPath, divergenceLogPath } from "./model/write-port-resolve.mjs";
import { fsReadStorage } from "./model/read-storage.mjs";
import { DB_SCHEMA_VERSION } from "./model/db-schema-version.mjs";

export const USAGE = `usage: blaze db <command>

  init      create the shadow database and load this board into it
  status    what the database holds, and what the dual-write soak has found

  --force   with init: replace an existing shadow database
`;

async function init({ dataRoot, projectsDir, force, log, err }) {
  const path = shadowDbPath(dataRoot);
  if (existsSync(path) && !force) {
    err(`blaze db init: ${path} already exists.\n`);
    err("Pass --force to replace it. Replacing discards whatever the current shadow");
    err("holds, including any divergences not yet reviewed.");
    return 1;
  }
  if (force && existsSync(path)) rmSync(path, { force: true });

  const { db, exec } = await openShadow(dataRoot, { create: true });
  try {
    const { loadCorpus } = await import("./migrate/load-corpus.mjs");
    // Migration mode: the corpus predates the required-field rule, and 242 tickets have
    // no estimate. Enforcing on import would demand 242 invented estimates (BLZ-289).
    const { writeRulesDdl, setMigrationModeSql } = await import("./model/write-rules.mjs");
    const { projectionDdl } = await import("./model/projection-schema.mjs");
    const { refreshProjection } = await import("./model/projection.mjs");
    const { configSeed } = await import("./model/config-schema.mjs");

    db.exec(projectionDdl("sqlite"));
    const cfg = loadConfig({ root: dataRoot });
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
  const { db, exec } = await openShadow(dataRoot);
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

  const logPath = divergenceLogPath(dataRoot);
  if (!existsSync(logPath)) {
    // Deliberately not "no soak has run": the log is written only when the two sides
    // DIFFER, so an absent file is exactly what a clean soak looks like. Claiming
    // otherwise reports a successful soak as one that never happened.
    log("\ndivergences: none recorded — the log is written only when the filesystem");
    log("and the database disagree, so this is also what a clean soak looks like.");
    return 0;
  }
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  log(`\ndivergences: ${lines.length}  (${logPath})`);
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
  const ctx = { dataRoot: roots.dataRoot, projectsDir: roots.projectsDir, force, log, err };
  if (cmd === "init") return init(ctx);
  if (cmd === "status") return status(ctx);
  err(`blaze db: unknown command ${JSON.stringify(cmd)}\n`);
  err(USAGE);
  return 1;
}

if (process.argv[1] && process.argv[1].endsWith("db-runner.mjs")) {
  process.exit(await runDb(process.argv.slice(2)));
}
