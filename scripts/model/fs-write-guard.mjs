// scripts/model/fs-write-guard.mjs — BLZ-708 (G-engine).
//
// A board whose blaze.config.json names database.driver "postgres" is served from that
// database. A file write on it, with BLAZE_WRITE_PORT unset, lands in this checkout's files
// and never reaches the database: it is refused rather than warned about, because a warning
// scrolls past and the write has already diverged the board from what everyone reads.
// An explicit fs, dual or db states the intent and is allowed.
import { WRITE_PORT_ENV } from "./write-port.mjs";

/** The refusal sentence, or null when the write is allowed. Pure. */
export function fsWriteRefusal({ env = process.env, config, what }) {
  if (config?.database?.driver !== "postgres") return null;
  if (env[WRITE_PORT_ENV] !== undefined) return null;
  return `blaze: refusing to ${what} — this board's blaze.config.json names database.driver "postgres", `
    + "but BLAZE_WRITE_PORT is unset, so the write would land in this checkout's files and never reach "
    + "the database the board serves. Write to the live board in remote mode (BLAZE_REMOTE_URL and "
    + "BLAZE_TOKEN), or set BLAZE_WRITE_PORT=db. During a migration, BLAZE_WRITE_PORT=fs states that "
    + "a file write is deliberate.";
}

/**
 * Throw the refusal for `what` when the board at `dataRoot` (default: the resolved one) names the
 * postgres driver and BLAZE_WRITE_PORT is unset. A root or config that fails to resolve returns:
 * the verb's own load reports that, and a config that fails to load is itself a refusal.
 */
export async function assertFsWriteAllowed(what, { dataRoot = null, env = process.env } = {}) {
  let config;
  try {
    const { resolveRoots, loadConfig } = await import("../config.mjs");
    config = loadConfig({ root: dataRoot ?? resolveRoots().dataRoot });
  } catch { return; }
  const refusal = fsWriteRefusal({ env, config, what });
  if (refusal) throw new Error(refusal);
}
