#!/usr/bin/env node
// cli.mjs — the `blaze` command. Dispatches to the scripts.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const node = (file, args = []) => spawnSync(process.execPath, [join(here, file), ...args], { stdio: "inherit" });
const bash = (file, args = []) => spawnSync("bash", [join(here, file), ...args], { stdio: "inherit" });

let r;
switch (cmd) {
  case undefined:
  case "start": r = node("supervisor.mjs"); break;
  case "board": r = node("serve.mjs"); break;
  case "reconcile": r = node("reconcile.mjs", rest); break;
  case "groom": r = node("loops/groomer.mjs", rest); break;
  case "new": r = bash("new-ticket.sh", rest); break;
  default:
    console.log("usage: blaze [start|board|reconcile|groom|new]");
    process.exit(1);
}
process.exit(r.status ?? 0);
