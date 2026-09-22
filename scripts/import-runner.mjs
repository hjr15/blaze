#!/usr/bin/env node
// scripts/import-runner.mjs — `blaze import`: a canonical CSV → the board,
// through the injected write port. BLZ-629, design §5 and §6
// (docs/design/csv-import-and-export.md).
//
// ARGUMENT PARSING AND PRINTING ONLY — .c8rc.json excludes
// `scripts/*-runner.mjs` from the coverage gate, and "a decision made in a
// runner is a decision nothing measures" (design §6). Every decision this
// verb makes lives in scripts/model/import-plan.mjs and
// scripts/model/import-apply.mjs.
//
// DRY RUN IS THE DEFAULT (ADR-0037 §4). `--apply` is what writes.
//
// TWO SUBCOMMANDS, dispatched on the first argument (design §6):
//
//   * `repair`          — IN PROCESS. It reads the receipt, the map and the
//                         board; it writes records and never a ticket.
//   * `propose-mapping` — BY SPAWNING `import-mapping-runner.mjs`, the way
//                         cli.mjs:9 spawns a runner. That is not a style
//                         choice: it is what keeps the proposer — the one
//                         module in the tree that spawns `agentCommand` —
//                         OUT OF THIS RUNNER'S STATIC IMPORT GRAPH, which is
//                         §4.3's one surviving static assertion and is pinned
//                         in tests/import-agent-boundary.test.mjs. An
//                         `import` of it here would redden that test, and
//                         rightly.
import { fileURLToPath } from "node:url";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveRoots, loadConfig, InvalidProjectKeyError } from "./config.mjs";
import { resolveWritePort } from "./model/write-port-resolve.mjs";
import { runImport } from "./model/import-apply.mjs";
import { runMappedImport, runRepair } from "./model/import-mapping.mjs";
import { exitCodeForSpawn } from "./model/spawn-exit-code.mjs";
import { assertWritable } from "./readonly.mjs";

function usage() {
  console.error("usage: blaze import [--apply] [--update] [--allocate-ids] [--mapping <m.json>] <file.csv>");
  console.error("       blaze import repair [--apply] <receipt>");
  console.error("       blaze import propose-mapping <file.csv>");
  console.error("  Reads a canonical 31-column CSV (design §2) and creates, updates or skips rows.");
  console.error("  DRY RUN unless --apply is given: without it nothing is written.");
  console.error("  --update        apply a row whose id exists on the board and differs.");
  console.error("  --allocate-ids  accept rows with an empty id; forfeits the re-run-is-a-no-op");
  console.error("                  guarantee, and the dry run says so.");
  console.error("  --mapping <m.json>  read an ARBITRARY CSV through a confirmed mapping");
  console.error("                  (import-mappings/<name>.json). No model runs: the mapping is");
  console.error("                  one a person already accepted (ADR-0037 §2).");
  console.error("  repair <receipt>    inspect a partial apply and lift its exit-5 refusal.");
  console.error("                  DRY RUN unless --apply. Writes records, never a ticket.");
  console.error("  propose-mapping <file.csv>  ask the configured agent command for a CANDIDATE");
  console.error("                  mapping and, on your confirmation, write it. It writes one");
  console.error("                  file and nothing else — no ticket, no id, no staging.");
  console.error("  Exit: 0 clean · 1 data refused · 2 could not read the input · 3 mapping");
  console.error("        incomplete · 4 the board changed and the run did not finish cleanly");
  console.error("        · 5 the run's own records are not in a state it may start from.");
}

async function main() {
  const argv = process.argv.slice(2);

  // `propose-mapping` is SPAWNED, not imported (see the header). The child
  // inherits stdio because §4.4's confirmation is answered on this terminal,
  // and its exit goes through `exitCodeForSpawn` so a signal death is not
  // laundered into a 0 (BLZ-639).
  if (argv[0] === "propose-mapping") {
    const here = dirname(fileURLToPath(import.meta.url));
    const r = spawnSync(process.execPath, [join(here, "import-mapping-runner.mjs"), ...argv.slice(1)],
      { stdio: "inherit" });
    process.exit(exitCodeForSpawn(r));
  }

  const subcommand = argv[0] === "repair" ? "repair" : null;
  const rest = subcommand ? argv.slice(1) : argv;

  const opts = { apply: false, update: false, allocateIds: false, mapping: null };
  const positional = [];
  for (const [i, a] of rest.entries()) {
    if (a === "--apply") { opts.apply = true; continue; }
    if (a === "--update") { opts.update = true; continue; }
    if (a === "--allocate-ids") { opts.allocateIds = true; continue; }
    if (a === "--mapping") { opts.mapping = rest[i + 1] ?? null; continue; }
    if (opts.mapping !== null && rest[i - 1] === "--mapping") continue;
    if (a.startsWith("--")) { console.error(`blaze import: unknown flag: ${a}`); usage(); process.exit(1); }
    positional.push(a);
  }
  if (opts.mapping === null && rest.includes("--mapping")) {
    console.error("blaze import: --mapping takes the path of a confirmed mapping file");
    usage();
    process.exit(1);
  }
  if (subcommand === "repair") {
    for (const flag of ["--update", "--allocate-ids", "--mapping"]) {
      if (rest.includes(flag)) {
        // `repair` reads no CSV and builds no plan, so these are not "ignored
        // flags" — they are an argument list for a different verb.
        console.error(`blaze import repair: ${flag} is not a flag of this subcommand — it reads a `
          + "receipt, not a CSV");
        usage();
        process.exit(1);
      }
    }
  }
  if (positional.length !== 1) {
    const what = subcommand === "repair" ? "a receipt path" : "a CSV file";
    console.error(positional.length === 0
      ? `blaze import${subcommand ? ` ${subcommand}` : ""}: ${what} is required`
      : `blaze import${subcommand ? ` ${subcommand}` : ""}: expected one argument, `
        + `got ${positional.length}`);
    usage();
    process.exit(1);
  }

  const { dataRoot, projectsDir } = resolveRoots();
  let cfg;
  try { cfg = loadConfig({ root: dataRoot }); }
  catch (e) {
    if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
    throw e;
  }

  // BLZ-121 defence-in-depth, hoisted before any write for the same reason
  // new-runner.mjs hoists it: the apply writes claims and tickets before it
  // ever reaches commitOrQueue's own guard, so gating only there would leave
  // a written-but-uncommitted tree. Only for `--apply` — a dry run writes
  // nothing and is a legitimate thing to run under BLAZE_READONLY.
  if (opts.apply) {
    try {
      assertWritable(subcommand === "repair"
        ? "repair an import receipt" : "import tickets from CSV");
    } catch (e) { console.error(e.message); process.exit(1); }
  }

  // `repair` writes the run's own RECORDS and never a ticket, so it needs no
  // write port at all (design §4.3's table: "never a ticket").
  if (subcommand === "repair") {
    const rr = await runRepair({
      receipt: resolve(positional[0]),
      projectsDir, dataRoot,
      apply: opts.apply,
      commitMode: cfg.commitMode,
    });
    const outR = rr.exitCode === 0 ? console.log : console.error;
    if (rr.report) outR(rr.report);
    process.exit(rr.exitCode);
  }

  // ADR-0037 §1: the port is injected, never assumed, so the same importer
  // writes rows instead of files under BLAZE_WRITE_PORT=db.
  let wp;
  try { wp = await resolveWritePort({ dataRoot, projectsDir }); }
  catch (e) { console.error(e.message); process.exit(1); }

  let r;
  try {
    const common = {
      file: resolve(positional[0]),
      projectsDir, dataRoot,
      apply: opts.apply, update: opts.update, allocateIds: opts.allocateIds,
      commitMode: cfg.commitMode,
      writePort: wp.port,
    };
    // One `planImport`, two readers (design §4.5). The mapped path adds the
    // mapping and the `source-ids` map and changes nothing else.
    r = opts.mapping
      ? await runMappedImport({ ...common, mappingPath: resolve(opts.mapping) })
      : await runImport(common);
  } finally {
    wp.close();
  }

  // The report goes to stdout on success and stderr on a refusal, so a
  // `blaze import > plan.txt` keeps the plan and still shows the refusal.
  const out = r.exitCode === 0 ? console.log : console.error;
  if (r.report) out(r.report);
  process.exit(r.exitCode);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (e) {
    console.error(`blaze import failed: ${e.message}`);
    process.exit(1);
  }
}
