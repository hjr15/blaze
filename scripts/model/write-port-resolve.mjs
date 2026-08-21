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
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fsStorage } from "./storage.mjs";
import { fsWritePort, dbWritePort, dualWritePort, WRITE_PORT_ENV } from "./write-port.mjs";

/** Where the shadow database and the divergence log live. Both under .blaze/, which is
 *  gitignored — `blaze init` writes that rule, and this board has carried it for years. */
export const shadowDbPath = (dataRoot) => join(dataRoot, ".blaze", "blaze.db");
export const divergenceLogPath = (dataRoot) => join(dataRoot, ".blaze", "divergences.jsonl");

/** A sync {run, all} over node:sqlite, the shape the db port and the schema guard want. */
export function sqliteExec(db) {
  return {
    run(sql, params = []) { return params.length ? db.prepare(sql).run(...params) : db.exec(sql); },
    all(sql, params = []) { return db.prepare(sql).all(...params); },
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
  const exec = sqliteExec(db);
  if (create) {
    const { judgeDbSchema, readSchemaFactsSync, createDbSchemaSync } =
      await import("./db-schema-version.mjs");
    if (judgeDbSchema(readSchemaFactsSync(exec)).state === "empty") createDbSchemaSync(exec);
  } else {
    const { judgeDbSchema, readSchemaFactsSync } = await import("./db-schema-version.mjs");
    const state = judgeDbSchema(readSchemaFactsSync(exec));
    if (!state.ok) { db.close(); throw new Error(`blaze: ${state.error}`); }
  }
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
  appendFileSync(path, JSON.stringify({ at: now, ...d }) + "\n");
}

/**
 * The port a verb should write through, for this board and this environment.
 *
 * @returns { port, mode, close } — `close` releases the shadow database, and is a no-op
 *          for `fs` so every caller can call it unconditionally.
 */
export async function resolveWritePort({ dataRoot, projectsDir, storage = fsStorage,
                                         env = process.env, onDivergence } = {}) {
  const mode = (env[WRITE_PORT_ENV] ?? "fs").trim();
  if (mode === "fs") {
    return { port: fsWritePort(projectsDir, storage), mode, close() {} };
  }
  if (mode !== "dual" && mode !== "db") {
    throw new Error(
      `blaze: ${WRITE_PORT_ENV}=${JSON.stringify(mode)} is not a write port — `
      + "expected 'fs', 'dual' or 'db'. Leaving it unset uses 'fs', which is the "
      + "filesystem behaviour Blaze has always had.");
  }

  const shadow = await openShadow(dataRoot);
  const db = dbWritePort(shadow.exec, { dialect: "sqlite" });
  const close = () => { try { shadow.db.close(); } catch { /* already closed */ } };

  if (mode === "db") return { port: db, mode, close };

  // dual: the filesystem still decides the outcome. A divergence is recorded, never
  // fatal — refusing a legitimate write because a shadow disagreed would make the
  // safety net the outage.
  const report = onDivergence ?? ((d) => logDivergence(dataRoot, d));
  return { port: dualWritePort(fsWritePort(projectsDir, storage), db, { onDivergence: report }),
           mode, close };
}
