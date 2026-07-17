#!/usr/bin/env node
// cli.mjs — the `blaze` command. Dispatches to the scripts.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const node = (file, args = []) => spawnSync(process.execPath, [join(here, file), ...args], { stdio: "inherit" });

let r;
switch (cmd) {
  case undefined:
  case "start": r = node("supervisor.mjs"); break;
  case "board": r = node("serve.mjs"); break;
  case "reconcile": r = node("reconcile.mjs", rest); break;
  case "groom": r = node("loops/groomer.mjs", rest); break;
  case "new": r = node("new-runner.mjs", rest); break;
  case "sprint": r = node("sprint-runner.mjs", rest); break;
  case "reindex": r = node("reindex.mjs", rest); break;
  case "move": r = node("move-runner.mjs", rest); break;
  case "edit": r = node("edit-runner.mjs", rest); break;
  case "link": r = node("link-runner.mjs", rest); break;
  case "resolve": r = node("resolve-runner.mjs", rest); break;
  case "log": r = node("log-runner.mjs", rest); break;
  case "commit": r = node("commit-runner.mjs", rest); break;
  case "rollup": r = node("rollup-runner.mjs", rest); break;
  case "migrate": r = node("migrate-runner.mjs", rest); break;
  default:
    console.log("usage: blaze [start|board|reconcile|groom|new|sprint|reindex|move|edit|link|resolve|log|commit|rollup|migrate]");
    process.exit(1);
}
process.exit(r.status ?? 0);
