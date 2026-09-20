// scripts/model/spawn-exit-code.mjs — BLZ-639.
//
// A spawnSync() result for a child that died from a signal (SIGKILL from an
// OOM-killer, SIGTERM from a supervisor, ...) reports `status: null` and
// `signal: "<NAME>"`. Reading `r.status ?? 0` in that case reads as exit 0 —
// a clean-looking exit for a signal-killed process. This maps ANY signal
// name to a non-zero code (the `128 + signum` shell convention), not just
// SIGKILL, so cli.mjs's final `process.exit` never reports success for a
// child that never got to exit on its own terms.
import { constants } from "node:os";

export function exitCodeForSpawn(r) {
  if (r.signal) {
    const signum = constants.signals[r.signal];
    // An unrecognised signal name (shouldn't happen — Node only ever
    // reports names node:os itself knows) still falls back to a fixed
    // non-zero code rather than letting `?? 0` turn it into success.
    return typeof signum === "number" ? 128 + signum : 1;
  }
  return r.status ?? 0;
}
