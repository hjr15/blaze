#!/usr/bin/env node
// cli.mjs — the `blaze` command. Dispatches to the scripts.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const node = (file, args = []) => spawnSync(process.execPath, [join(here, file), ...args], { stdio: "inherit" });

// One line per subcommand: which script runs it, plus a one-line description
// used for both the full usage listing and `blaze <cmd> --help`. --help/-h
// is intercepted below BEFORE this map is used to spawn anything, so a new
// subcommand added here can never ship without help by omission (BLZ-119) —
// there is no separate per-runner help path to forget.
const SUBCOMMANDS = {
  start: { file: "supervisor.mjs", desc: "run the reconcile/groomer loops (default)" },
  board: { file: "serve.mjs", desc: "serve the board viewer" },
  reconcile: { file: "reconcile.mjs", desc: "sync board status to git/PR state" },
  groom: { file: "loops/groomer.mjs", desc: "run one groomer pass" },
  new: { file: "new-runner.mjs", desc: "create a ticket" },
  sprint: { file: "sprint-runner.mjs", desc: "create/list/activate sprints" },
  reindex: { file: "reindex.mjs", desc: "rebuild the derived index + transitions cache" },
  move: { file: "move-runner.mjs", desc: "move a ticket to a new status" },
  edit: { file: "edit-runner.mjs", desc: "edit a ticket field" },
  link: { file: "link-runner.mjs", desc: "add/remove a link between tickets" },
  resolve: { file: "resolve-runner.mjs", desc: "set a ticket's resolution" },
  log: { file: "log-runner.mjs", desc: "log worked minutes against a ticket" },
  commit: { file: "commit-runner.mjs", desc: "flush the pending queue into a commit" },
  rollup: { file: "rollup-runner.mjs", desc: "print rolled-up estimate/worklog totals" },
  migrate: { file: "migrate-runner.mjs", desc: "import tickets from a Jira export" },
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

let r;
switch (cmd) {
  case undefined:
  case "start": r = node(SUBCOMMANDS.start.file); break;
  case "board": r = node(SUBCOMMANDS.board.file); break;
  case "reconcile": r = node(SUBCOMMANDS.reconcile.file, rest); break;
  case "groom": r = node(SUBCOMMANDS.groom.file, rest); break;
  case "new": r = node(SUBCOMMANDS.new.file, rest); break;
  case "sprint": r = node(SUBCOMMANDS.sprint.file, rest); break;
  case "reindex": r = node(SUBCOMMANDS.reindex.file, rest); break;
  case "move": r = node(SUBCOMMANDS.move.file, rest); break;
  case "edit": r = node(SUBCOMMANDS.edit.file, rest); break;
  case "link": r = node(SUBCOMMANDS.link.file, rest); break;
  case "resolve": r = node(SUBCOMMANDS.resolve.file, rest); break;
  case "log": r = node(SUBCOMMANDS.log.file, rest); break;
  case "commit": r = node(SUBCOMMANDS.commit.file, rest); break;
  case "rollup": r = node(SUBCOMMANDS.rollup.file, rest); break;
  case "migrate": r = node(SUBCOMMANDS.migrate.file, rest); break;
  default:
    printUsage();
    process.exit(1);
}
process.exit(r.status ?? 0);
