// scripts/readonly.mjs — shared BLAZE_READONLY env parsing (BLZ-121). One
// module, imported by cli.mjs (the dispatch gate) and by every mutating runner
// and serve.mjs (defence-in-depth for callers that bypass cli.mjs: a
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
// runners and handlers reached without cli.mjs (bypassing cli.mjs's own gate,
// which already names the subcommand).
export function assertWritable(what, env = process.env) {
  if (isReadonly(env)) throw new Error(`blaze: read-only mode (BLAZE_READONLY=1) — refusing to ${what}`);
}

// BLZ-690: the sub-verb of a verb that has them (`blaze db <verb>`) — the first argument that is
// not a flag. ONE rule, shared by cli.mjs's read-only exemption and db-runner.mjs's dispatch, so
// the verb the gate lets through is always the verb the runner runs.
// BLZ-705: the flags that take a separate value. The word after one is its value, never the verb
// (`--sprints-from x migrate` is a migrate); the `--flag=value` spelling is skipped as a flag.
export const VALUE_FLAGS = ["--identity-from", "--sprints-from"];
export function subVerbOf(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i])) { i++; continue; }
    if (!argv[i].startsWith("-")) return argv[i];
  }
  return undefined;
}
