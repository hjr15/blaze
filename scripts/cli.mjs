#!/usr/bin/env node
// cli.mjs — the `blaze` command. Dispatches to the scripts.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isReadonly } from "./readonly.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const node = (file, args = []) => spawnSync(process.execPath, [join(here, file), ...args], { stdio: "inherit" });

// One line per subcommand: which script runs it, a one-line description used
// for both the full usage listing and `blaze <cmd> --help`, and whether it
// mutates the board (BLZ-121: gates BLAZE_READONLY below). --help/-h is
// intercepted below BEFORE this map is used to spawn anything, so a new
// subcommand added here can never ship without help by omission (BLZ-119) —
// there is no separate per-runner help path to forget. This map is now also
// the ONLY dispatch table (the switch below it was collapsed away) — a new
// entry here is automatically routed, described, help-guarded, and
// BLAZE_READONLY-gated with no second place to update.
//
// mutates classification: `reconcile` defaults to a dry-run but `--apply`
// commits — classified true unconditionally (simpler and safer than
// flag-dependent classification). `start` runs the supervisor, which drives
// the groomer loop (git-commits), so it's true too. `board` (serve.mjs, the
// read/write web viewer — its own mutating `/api/*` handlers are gated
// separately, see readonly.mjs) and `rollup` (a report) are the only false.
const SUBCOMMANDS = {
  start: { file: "supervisor.mjs", desc: "run the reconcile/groomer loops (default)", mutates: true, noArgs: true },
  board: { file: "serve.mjs", desc: "serve the board viewer", mutates: false, noArgs: true },
  reconcile: { file: "reconcile.mjs", desc: "sync board status to git/PR state", mutates: true },
  groom: { file: "loops/groomer.mjs", desc: "run one groomer pass", mutates: true },
  new: { file: "new-runner.mjs", desc: "create a ticket", mutates: true },
  sprint: { file: "sprint-runner.mjs", desc: "create/list/activate sprints", mutates: true },
  reindex: { file: "reindex.mjs", desc: "rebuild the derived index + transitions cache", mutates: true },
  move: { file: "move-runner.mjs", desc: "move a ticket to a new status", mutates: true },
  edit: { file: "edit-runner.mjs", desc: "edit a ticket field", mutates: true },
  link: { file: "link-runner.mjs", desc: "add/remove a link between tickets", mutates: true },
  resolve: { file: "resolve-runner.mjs", desc: "set a ticket's resolution", mutates: true },
  log: { file: "log-runner.mjs", desc: "log worked minutes against a ticket", mutates: true },
  commit: { file: "commit-runner.mjs", desc: "flush the pending queue into a commit", mutates: true },
  rollup: { file: "rollup-runner.mjs", desc: "print rolled-up estimate/worklog totals", mutates: false },
  migrate: { file: "migrate-runner.mjs", desc: "import tickets from a Jira export", mutates: true },
};

function printUsage() {
  console.log("usage: blaze <command> [args]");
  console.log();
  console.log("commands:");
  for (const [name, { desc }] of Object.entries(SUBCOMMANDS)) console.log(`  ${name.padEnd(10)} ${desc}`);
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "--help" || cmd === "-h") { printUsage(); process.exit(0); }
// A subcommand's OWN --help/-h is handled here, at dispatch, not by the
// runner: this fires before the runner ever spawns, so discovering the CLI
// (`blaze commit --help`) can never fall through to a real mutation.
if (cmd !== undefined && (rest.includes("--help") || rest.includes("-h"))) {
  const sub = SUBCOMMANDS[cmd];
  if (!sub) { printUsage(); process.exit(1); }
  console.log(`usage: blaze ${cmd} — ${sub.desc}`);
  process.exit(0);
}

// No args behaves exactly like `start` (unchanged): same table entry, same
// no-args forwarding — there's just no literal "undefined" key to look up.
const key = cmd === undefined ? "start" : cmd;
const sub = SUBCOMMANDS[key];
if (!sub) { printUsage(); process.exit(1); }

// BLZ-121: refuse to even spawn a mutating runner under BLAZE_READONLY — the
// one genuine write choke point (every verb dispatches through here). Gating
// later (e.g. at commitOrQueue) is too late: move.mjs and friends write/rename
// the ticket file before they ever reach a commit decision, so declining only
// the commit would leave a relocated-but-uncommitted file in a shared tree.
if (isReadonly() && sub.mutates) {
  console.error(`blaze: read-only mode (BLAZE_READONLY=1) — refusing to run a mutating command: ${key}`);
  process.exit(1);
}

const r = node(sub.file, sub.noArgs ? [] : rest);
process.exit(r.status ?? 0);
