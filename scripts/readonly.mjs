// scripts/readonly.mjs — shared BLAZE_READONLY env parsing (BLZ-121). One
// module, imported by cli.mjs (the dispatch gate) and commit-or-queue.mjs +
// pending-ledger.mjs (defence-in-depth for callers that bypass cli.mjs: a
// direct `node scripts/move-runner.mjs`, or serve.mjs's in-process API
// writes) — so the truthiness rule lives in exactly one place.
//
// Truthy: any value except unset/empty/"0"/"false". This is an env guard
// against an agent REACHING for a mutating verb through the normal CLI/API
// surfaces — it is not a sandbox. Code that calls node:fs directly bypasses
// it entirely; that's the accepted threat model.
export function isReadonly(env = process.env) {
  const v = env.BLAZE_READONLY;
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

// Throws under BLAZE_READONLY. `what` names the write being attempted, for
// callers that reach commitOrQueue/appendEntry directly (bypassing cli.mjs's
// own gate, which already names the subcommand).
export function assertWritable(what, env = process.env) {
  if (isReadonly(env)) throw new Error(`blaze: read-only mode (BLAZE_READONLY=1) — refusing to ${what}`);
}
