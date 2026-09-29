// scripts/model/write-port-resolve.mjs — turning BLAZE_WRITE_PORT into a real port
// (BLZ-299), so the dual-write soak can run against a live board.
//
// `selectWritePort` has existed since BLZ-293 and NOTHING in production called it: the
// verbs each defaulted to their own `fsWritePort`, so setting the environment variable
// did exactly nothing. That is the gap this closes — a flag that silently does nothing
// is worse than no flag, because it invites you to believe a soak is running.
//
// THE DEFAULT IS STILL THE FILESYSTEM. `fs` needs no database and opens none. Only
// `dual` and `db` touch SQLite, and only `db` makes it the source of truth — which
// remains a Phase 2 decision (BLZ-254), not a configuration accident.
import { existsSync, mkdirSync } from "node:fs";
// BLZ-512 / ADR-0031. Both instruments here are `existsSync`-gated, WHICH A FIFO SATISFIES,
// and both were reproduced as hangs at `44b797f` (`EXIT=137` under a 6s cap). `blaze db
// status` reaches `readSoakState` before anything else it prints, so one `mkfifo
// .blaze/soak-ops.jsonl` wedged the command an operator runs to diagnose the soak.
import { appendFileSync } from "node:fs";
import { readRegularFileSync } from "./regular-file.mjs";
import { join, dirname } from "node:path";
import { fsStorage, slugify } from "./storage.mjs";
import { allocateId } from "./ids.mjs";
import { remoteMaxClaim, writeClaim } from "./claims.mjs";
import { fsWritePort, dbWritePort, dualWritePort, WRITE_PORT_ENV } from "./write-port.mjs";
import { resolveDatabaseConfig } from "./database-config.mjs";
import { openPostgresClient } from "../init-pg.mjs";
import { checkDbSchema } from "./db-schema-version.mjs";
import { closeOnSetupFailure, postgresReader } from "./pg-storage.mjs";
// BLZ-670: sqlite-storage.mjs imports `assertConfigNamespace` from here, so this closes a
// cycle. Harmless — only function references, used at call time — and kept at module top so
// the evaluation order does not change.
import { openSqliteRead as defaultOpenSqliteRead } from "./sqlite-storage.mjs";
import { fsReadStorage } from "./read-storage.mjs";

/** Where the shadow database and the divergence log live. Both under .blaze/, which is
 *  gitignored — `blaze init` writes that rule, and this board has carried it for years. */
export const shadowDbPath = (dataRoot) => join(dataRoot, ".blaze", "blaze.db");
/** The config namespace's file, beside the shadow (BLZ-377). Same rule as `configDbPathFor`,
 *  spelled in terms of a data root for callers that have one. */
export const configDbPath = (dataRoot) => join(dataRoot, ".blaze", "config.db");
export const divergenceLogPath = (dataRoot) => join(dataRoot, ".blaze", "divergences.jsonl");
export const soakStatePath = (dataRoot) => join(dataRoot, ".blaze", "soak-ops.jsonl");

/** A sync {run, all} over node:sqlite, the shape the db port and the schema guard want. */
export function sqliteExec(db) {
  return {
    run(sql, params = []) { return params.length ? db.prepare(sql).run(...params) : db.exec(sql); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
  };
}

/** An async {run, all} over a connected pg.Client, the shape dbWritePort expects. */
export function pgExec(client) {
  return {
    async run(sql, params = []) { await client.query(sql, params); },
    async all(sql, params = []) { return (await client.query(sql, params)).rows; },
  };
}

/**
 * Open the shadow database. Never creates a schema silently — BLZ-297 — so a missing
 * one is an instruction rather than an accident.
 */
export async function openShadow(dataRoot, { create = false } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = shadowDbPath(dataRoot);
  if (!create && !existsSync(path)) {
    throw new Error(
      `blaze: no shadow database at ${path}.\n`
      + "Create it and load the board into it first:\n\n"
      + "    blaze db init\n");
  }
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const { SQLITE_PRAGMAS } = await import("./sqlite-schema.mjs");
  db.exec(SQLITE_PRAGMAS);
  // BLZ-377: same contract as openSqliteRead — the config namespace is attached on every
  // open, because the opener is the only thing that knows where its file lives.
  const { sqliteAttachConfig, configDbPathFor } = await import("./config-schema.mjs");
  const cfgPath = configDbPathFor(path);
  const exec = sqliteExec(db);
  const { judgeDbSchema, readSchemaFactsSync, createDbSchemaSync } =
    await import("./db-schema-version.mjs");
  const state = judgeDbSchema(readSchemaFactsSync(exec));
  // `create` means "make one if there is none" — it never meant "accept whatever is there".
  // This branch tested only `state === "empty"` and DISCARDED `ok`, so an out-of-range shadow
  // was opened silently: exactly the case the version floor exists to refuse, waved through by
  // the one opener that did not ask. sqlite-storage.mjs and pg-storage.mjs both check `ok`.
  if (!state.ok && !(create && state.state === "empty")) {
    db.close(); throw new Error(`blaze: ${state.error}`);
  }
  // Same contract and same ORDER as openSqliteRead: the version judgement speaks first, so a
  // stale shadow still names itself, and only a database that is otherwise fine is required to
  // have its namespace already. Attaching a missing file would CREATE it and let a
  // half-deleted pair look healthy.
  const makingOne = create && state.state === "empty";
  // ATTACH CREATES the file, so it is only reached when a namespace is being made or one is
  // already there. The `empty` branch skipped this check and attached anyway, so a read open
  // over an empty shadow WROTE a 0-byte config.db — the very disguise this guard exists to
  // stop, on the branch `blaze db status` actually uses.
  if (cfgPath !== ":memory:" && !makingOne && !existsSync(cfgPath)) {
    db.close();
    throw new Error(
      `blaze: the config namespace is missing at ${cfgPath}, but the shadow database beside it `
      + "exists. The namespace is derived, so rebuild rather than repair it: run "
      + "'blaze db init --force'.");
  }
  db.exec(sqliteAttachConfig(cfgPath));
  if (makingOne) createDbSchemaSync(exec);
  else assertConfigNamespace(db, cfgPath);
  return { db, exec, path };
}

/**
 * Append one divergence as a JSON line.
 *
 * A file, not stderr: the soak runs across many separate CLI invocations over days, and
 * a divergence printed into the scrollback of whichever terminal happened to run
 * `blaze edit` is a divergence nobody will ever total up.
 */
export function logDivergence(dataRoot, d, { now = new Date().toISOString() } = {}) {
  const path = divergenceLogPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  // A NAMED RESIDUAL — see `readSoakState` below.
  appendFileSync(path, JSON.stringify({ at: now, ...d }) + "\n");
}

/**
 * Count one dual-write operation.
 *
 * "Zero divergences" is not evidence on its own — zero divergences across zero
 * operations is what an INACTIVE soak looks like, and it is indistinguishable from a
 * perfect one unless something counts the denominator. This is that denominator.
 */
export function recordSoakOp(dataRoot, { now = new Date().toISOString() } = {}) {
  // APPEND, never read-modify-write. This board runs parallel sessions (BLAZE_SESSION),
  // and a counter that reads a number, adds one and writes it back loses an increment
  // whenever two sessions overlap — silently, and in the direction that flatters the
  // soak by undercounting the denominator.
  const path = soakStatePath(dataRoot);
  mkdirSync(dirname(path), { recursive: true });
  // A NAMED RESIDUAL — see `readSoakState` below.
  appendFileSync(path, JSON.stringify({ at: now }) + "\n");
  return readSoakState(dataRoot);
}

export function readSoakState(dataRoot) {
  const path = soakStatePath(dataRoot);
  if (!existsSync(path)) return null;
  // REFUSE — and the READ is the half that is fixed here.
  //
  // THE TWO APPENDS ABOVE STILL HANG ON A FIFO, stated rather than left to be discovered.
  // `appendFileSync` on one with no reader blocks in `open(2)` exactly as a read does, and
  // unlike the `.gitignore` writers there is no pre-check in front of them. The fix is one
  // import — `appendRegularFileSync`, whose `O_NONBLOCK` turns that into an immediate
  // ENXIO — but it is a write primitive taken off the local write seam, and
  // `seam-closure.test.mjs`'s narrow exemption for this module names `appendFileSync` by
  // hand, so the swap cannot land without editing that file. It is owned by BLZ-642.
  // Recorded in ADR-0031's residual list for that lane rather than half-done here.
  //
  // `null` from here prints `operations 0 — nothing has been written through the
  // dual port yet`, which is the soak's DENOMINATOR: a week of "no divergences" measured
  // against a count this run never read looks exactly like a week of perfect agreement.
  const lines = readRegularFileSync(path, "utf8").split("\n").filter(Boolean);
  if (!lines.length) return null;
  const at = (line) => { try { return JSON.parse(line).at; } catch { return null; } };
  return { operations: lines.length,
           firstAt: at(lines[0]) ?? "unknown",
           lastAt: at(lines[lines.length - 1]) ?? "unknown" };
}

/**
 * The fs allocator `fsWritePort` is handed (BLZ-667): seed from the remote's published
 * claims, reserve the next id, write the claim. `title` is a CALL-time argument — this
 * port is built before `applyNew` knows the ticket's title. The same closure lives in
 * `applyNew`'s default `writePort` (new.mjs); duplicated deliberately rather than shared,
 * since a shared export would add a cross-module edge the seam guard must pin either way.
 */
function fsAllocator(projectsDir) {
  return async (proj, { title: t } = {}) => {
    const dataRoot = dirname(projectsDir);
    // null = the remote could not be read (stale view): the claim is provisional.
    const remoteMax = remoteMaxClaim(dataRoot, proj);
    const { id, n } = allocateId(projectsDir, proj, { dataRoot, remoteMax: remoteMax ?? 0 });
    const claimFile = writeClaim(projectsDir, proj, n, slugify(t ?? ""),
                                 { provisional: remoteMax === null });
    return { id, n, claimFile };
  };
}

/**
 * Which write mode `BLAZE_WRITE_PORT` configures, with no database opened to find out.
 * Synchronous and cheap — any future caller, sync or async, that just needs to know
 * "what write mode is configured" can call this instead of resolving a full port.
 */
export function resolveWriteMode(env = process.env) {
  return (env[WRITE_PORT_ENV] ?? "fs").trim();
}

/**
 * The port a verb should write through, for this board and this environment.
 *
 * @returns { port, mode, close } — `close` releases the shadow database, and is a no-op
 *          for `fs` so every caller can call it unconditionally.
 */
export async function resolveWritePort({ dataRoot, projectsDir, storage = fsStorage,
                                         env = process.env, onDivergence,
                                         resolveDbConfig = resolveDatabaseConfig,
                                         openPostgresClient: openPgClient = openPostgresClient } = {}) {
  const mode = resolveWriteMode(env);
  if (mode === "fs") {
    return { port: fsWritePort(projectsDir, storage, undefined,
                               { allocate: fsAllocator(projectsDir) }), mode, close() {} };
  }
  if (mode !== "dual" && mode !== "db") {
    throw unknownMode(mode);
  }

  const dbConfig = await dbConfigFor(dataRoot, resolveDbConfig);
  let db, close;
  if (dbConfig.driver === "postgres") {
    // Never creates a schema silently, same refusal as openShadow (BLZ-297) — a missing
    // or out-of-range Postgres schema is an instruction, not an accident to write through.
    const client = await openCheckedPg(dbConfig.connection, openPgClient);
    const exec = pgExec(client);
    db = dbWritePort(exec, { dialect: "postgres" });
    close = endQuietly(client);
  } else {
    const shadow = await openShadow(dataRoot);
    db = dbWritePort(shadow.exec, { dialect: "sqlite" });
    close = () => { try { shadow.db.close(); } catch { /* already closed */ } };
  }

  if (mode === "db") return { port: db, mode, close };

  // dual: the filesystem still decides the outcome. A divergence is recorded, never
  // fatal — refusing a legitimate write because a shadow disagreed would make the
  // safety net the outage.
  const report = onDivergence ?? ((d) => logDivergence(dataRoot, d));
  const port = dualWritePort(
    fsWritePort(projectsDir, storage, undefined, { allocate: fsAllocator(projectsDir) }),
    db, { onDivergence: report });
  // Count every operation, so a week of "no divergences" can be told apart from a week
  // of the soak not running at all.
  const counted = {
    ...port,
    write(t, ctx) { recordSoakOp(dataRoot); return port.write(t, ctx); },
    move(t, ctx) { recordSoakOp(dataRoot); return port.move(t, ctx); },
  };
  return { port: counted, mode, close };
}

/**
 * BLZ-670. Reads resolve from the WRITE mode (`resolveWriteMode`), never independently from
 * `database.driver`: under `db` every read comes from the database the writes go to, while
 * `fs` and `dual` read the filesystem — in `dual` the filesystem decides the outcome.
 */
const unknownMode = (mode) => new Error(
  `blaze: ${WRITE_PORT_ENV}=${JSON.stringify(mode)} is not a write port — `
  + "expected 'fs', 'dual' or 'db'. Leaving it unset uses 'fs', which is the "
  + "filesystem behaviour Blaze has always had.");

/** Connect, and refuse a missing or out-of-range schema, closing the socket on refusal. */
async function openCheckedPg(connection, openPgClient) {
  const client = await openPgClient(connection);
  await closeOnSetupFailure(client, async () => {
    const state = await checkDbSchema(pgExec(client), { dialect: "postgres" });
    if (!state.ok) throw new Error(`blaze: ${state.error}`);
    if (state.state === "empty") {
      throw new Error(
        "blaze: this Postgres database has no Blaze schema. Create it first:\n\n"
        + "    blaze db init\n");
    }
  });
  return client;
}

async function dbConfigFor(dataRoot, resolveDbConfig) {
  const { loadConfig } = await import("../config.mjs");
  return resolveDbConfig({ dataRoot, config: loadConfig({ root: dataRoot }) });
}

function openShadowRead(dataRoot, openSqliteRead) {
  const path = shadowDbPath(dataRoot);
  // existsSync FIRST: `new DatabaseSync(path)` would CREATE an empty file, and a read must
  // never write one (BLZ-297). Same message openShadow gives.
  if (!existsSync(path)) {
    throw new Error(`blaze: no shadow database at ${path}.\n`
      + "Create it and load the board into it first:\n\n    blaze db init\n");
  }
  return openSqliteRead(path);
}

const endQuietly = (client) => async () => { try { await client.end(); } catch { /* already closed */ } };

/** @returns { readStorage, mode, close } — `close` is a no-op for `fs` and `dual`. */
export async function resolveReadStorage({ dataRoot, projectsDir, env = process.env,
                                           resolveDbConfig = resolveDatabaseConfig,
                                           openPostgresClient: openPgClient = openPostgresClient,
                                           openSqliteRead = defaultOpenSqliteRead } = {}) {
  const mode = resolveWriteMode(env);
  if (mode === "fs" || mode === "dual") return { readStorage: fsReadStorage, mode, close() {} };
  if (mode !== "db") throw unknownMode(mode);
  const dbConfig = await dbConfigFor(dataRoot, resolveDbConfig);
  if (dbConfig.driver === "postgres") {
    const client = await openCheckedPg(dbConfig.connection, openPgClient);
    return { readStorage: postgresReader(client), mode, close: endQuietly(client) };
  }
  const readStorage = openShadowRead(dataRoot, openSqliteRead);
  return { readStorage, mode, close: () => readStorage.close() };
}

/** Resolve, run `fn(readStorage, mode)`, and always close. */
export async function withReadStorage(opts, fn) {
  let resolved;
  // Only RESOLUTION failures are tagged: a server answers those 503 (fixable, not the caller's
  // fault), while a failure reading the board after resolution keeps each route's own report.
  try { resolved = await resolveReadStorage(opts); }
  catch (e) { if (e && typeof e === "object") e.blazeResolve = true; throw e; }
  try { return await fn(resolved.readStorage, resolved.mode); }
  finally { await resolved.close(); }
}

/** One resolution, one source: the write port and the reader over the SAME store. */
export async function resolvePorts(opts = {}) {
  const env = opts.env ?? process.env;
  const mode = resolveWriteMode(env);
  if (mode !== "db") {
    const w = await resolveWritePort({ ...opts, env });
    return { writePort: w.port, readStorage: fsReadStorage, mode, close: w.close };
  }
  const dbConfig = await dbConfigFor(opts.dataRoot, opts.resolveDbConfig ?? resolveDatabaseConfig);
  if (dbConfig.driver === "postgres") {
    const client = await openCheckedPg(dbConfig.connection, opts.openPostgresClient ?? openPostgresClient);
    return { writePort: dbWritePort(pgExec(client), { dialect: "postgres" }),
             readStorage: postgresReader(client), mode, close: endQuietly(client) };
  }
  // SQLite: two handles on one file (spec §4.1) — node:sqlite commits before a write returns.
  const readStorage = openShadowRead(opts.dataRoot, opts.openSqliteRead ?? defaultOpenSqliteRead);
  let shadow;
  try { shadow = await openShadow(opts.dataRoot); }
  catch (e) { readStorage.close(); throw e; }
  return { writePort: dbWritePort(shadow.exec, { dialect: "sqlite" }), readStorage, mode,
           close: () => { readStorage.close(); try { shadow.db.close(); } catch { /* closed */ } } };
}

/**
 * A namespace that is present but EMPTY is the same failure as a missing one, and `existsSync`
 * cannot tell them apart (BLZ-377).
 *
 * A 0-byte `config.db` — left by an interrupted init, or by an older engine's read open before
 * the guard above existed — attaches happily, so `blaze db status` reported a healthy v4 while
 * every `blaze_config.view` query failed with "no such table". The stamp cannot catch it: it
 * lives in `blaze_meta`, in the other file.
 */
export function assertConfigNamespace(db, cfgPath) {
  const rows = db.prepare(
    "SELECT name FROM blaze_config.sqlite_master WHERE type = 'table' AND name = 'view_type'").all();
  if (rows.length) return;
  db.close();
  throw new Error(
    `blaze: the config namespace at ${cfgPath} is empty — it holds no Blaze tables. It is `
    + "derived, so rebuild rather than repair it: run 'blaze db init --force'.");
}
