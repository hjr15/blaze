#!/usr/bin/env node
// scripts/import-mapping-runner.mjs — `blaze import propose-mapping`.
// BLZ-635, design §4.3, §4.4 and §6 (docs/design/csv-import-and-export.md).
//
// ARGUMENT PARSING, PRINTING AND THE PROMPT ONLY — .c8rc.json excludes
// `scripts/*-runner.mjs` from the coverage gate, and "a decision made in a
// runner is a decision nothing measures" (design §6). Every decision lives in
// scripts/model/import-mapping-propose.mjs.
//
// THIS RUNNER IS SPAWNED BY `import-runner.mjs`, NOT IMPORTED BY IT, and that
// is the whole reason it is a separate file. `scripts/model/
// import-mapping-propose.mjs` is the one module in the tree that spawns
// `agentCommand` besides the groomer; keeping it out of `import-runner.mjs`'s
// transitive graph is §4.3's one surviving STATIC assertion, and it is pinned
// in tests/import-agent-boundary.test.mjs. The three DYNAMIC assertions there
// are what actually carry the property — "no agent command is executed on the
// import path" — because a static graph shape cannot say what ran.
//
// NO `--apply`, NO `--yes`. Its one write is gated by the operator's answer
// at the prompt (ADR-0037 §4), and the flag that would replace that answer is
// rejected by name in that ADR's Alternatives: "a flag that exists is a flag
// that ends up in a script".
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readSync } from "node:fs";
import { resolveRoots, loadConfig, InvalidProjectKeyError } from "./config.mjs";
import { runProposeMapping } from "./model/import-mapping-propose.mjs";
import { assertWritable } from "./readonly.mjs";

function usage() {
  console.error("usage: blaze import propose-mapping <file.csv>");
  console.error("  Asks the configured agent command for a CANDIDATE column mapping for an");
  console.error("  arbitrary CSV, shows you what it would map, discard and leave unfilled, and");
  console.error("  writes import-mappings/<name>.json only if you answer y.");
  console.error("  It creates no ticket, allocates no id and stages nothing: you are agreeing");
  console.error("  to a FILE, not to a run. The import is a separate command, run later.");
  console.error("  The agent command is `agentCommand` in blaze.config.json (default");
  console.error("  \"claude -p\"), overridden by BLAZE_AGENT_COMMAND.");
  console.error("  Exit: 0 clean or declined · 1 the proposal failed · 2 could not read the input.");
}

/** One line from stdin, synchronously, so the whole verb stays synchronous.
 *  Reads a byte at a time rather than draining the descriptor: `readFileSync(0)`
 *  waits for EOF, which on a terminal is never. */
function askLine(prompt) {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(1);
  const idle = new Int32Array(new SharedArrayBuffer(4));
  let line = "";
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      // A non-blocking stdin answers EAGAIN before the operator has typed.
      // Wait rather than spin: a prompt that pins a core is its own bug.
      if (e.code === "EAGAIN") { Atomics.wait(idle, 0, 0, 20); continue; }
      return line;
    }
    if (n === 0) return line;               // EOF — an unanswered question is a No
    const c = buf.toString("utf8");
    if (c === "\n") return line;
    if (c !== "\r") line += c;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  for (const a of argv) {
    if (a === "--apply" || a === "--yes" || a === "-y") {
      // Named rather than ignored: an operator who typed it is expecting the
      // write to happen without being asked, and ADR-0037 §4 says it does not.
      console.error(`blaze import propose-mapping: ${a} is not a flag of this subcommand. Its one `
        + "write is gated by your answer at the prompt, not by a flag (ADR-0037 §4)");
      usage();
      process.exit(1);
    }
    if (a.startsWith("--")) {
      console.error(`blaze import propose-mapping: unknown flag: ${a}`);
      usage();
      process.exit(1);
    }
    positional.push(a);
  }
  if (positional.length !== 1) {
    console.error(positional.length === 0
      ? "blaze import propose-mapping: a CSV file is required"
      : `blaze import propose-mapping: expected one file, got ${positional.length}`);
    usage();
    process.exit(1);
  }

  const { dataRoot } = resolveRoots();
  let cfg;
  try { cfg = loadConfig({ root: dataRoot }); }
  catch (e) {
    if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
    throw e;
  }

  // BLZ-121: this verb writes a file, so it is refused under BLAZE_READONLY
  // like every other writer. cli.mjs already declines to spawn `import` at
  // all there; this is the defence in depth for a direct `node scripts/…`.
  try { assertWritable("write an import mapping file"); }
  catch (e) { console.error(e.message); process.exit(1); }

  const r = runProposeMapping({
    file: resolve(positional[0]),
    dataRoot,
    // `loadConfig` has already applied BLAZE_AGENT_COMMAND's OVERRIDE
    // (config.mjs:279), so this one read covers both arms of §4.3's
    // resolution order: an env-var value (spawned as given — absolute, and
    // PATH is never consulted) and the built-in "claude -p" (a bare name,
    // resolved through PATH).
    agentCommand: cfg.agentCommand,
    confirm: askLine,
  });

  const out = r.exitCode === 0 ? console.log : console.error;
  if (r.report) out(r.report);
  process.exit(r.exitCode);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(`blaze import propose-mapping failed: ${e.message}`);
    process.exit(1);
  }
}
