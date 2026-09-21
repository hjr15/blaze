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
// `propose-mapping` and `repair` are subcommands this build does not have
// yet — C1/C2 in the design's ticket breakdown. They are deliberately NOT
// stubbed here: a subcommand that exists and does nothing is worse than one
// that does not exist, because `blaze import --help` would then advertise it.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { resolveRoots, loadConfig, InvalidProjectKeyError } from "./config.mjs";
import { resolveWritePort } from "./model/write-port-resolve.mjs";
import { runImport } from "./model/import-apply.mjs";
import { assertWritable } from "./readonly.mjs";

function usage() {
  console.error("usage: blaze import [--apply] [--update] [--allocate-ids] <file.csv>");
  console.error("  Reads a canonical 31-column CSV (design §2) and creates, updates or skips rows.");
  console.error("  DRY RUN unless --apply is given: without it nothing is written.");
  console.error("  --update        apply a row whose id exists on the board and differs.");
  console.error("  --allocate-ids  accept rows with an empty id; forfeits the re-run-is-a-no-op");
  console.error("                  guarantee, and the dry run says so.");
  console.error("  Exit: 0 clean · 1 data refused · 2 could not read the input · 3 mapping");
  console.error("        incomplete · 4 the board changed and the run did not finish cleanly");
  console.error("        · 5 the run's own records are not in a state it may start from.");
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { apply: false, update: false, allocateIds: false };
  const positional = [];
  for (const a of argv) {
    if (a === "--apply") { opts.apply = true; continue; }
    if (a === "--update") { opts.update = true; continue; }
    if (a === "--allocate-ids") { opts.allocateIds = true; continue; }
    if (a.startsWith("--")) { console.error(`blaze import: unknown flag: ${a}`); usage(); process.exit(1); }
    positional.push(a);
  }
  if (positional.length !== 1) {
    console.error(positional.length === 0
      ? "blaze import: a CSV file is required"
      : `blaze import: expected one file, got ${positional.length}`);
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
    try { assertWritable("import tickets from CSV"); }
    catch (e) { console.error(e.message); process.exit(1); }
  }

  // ADR-0037 §1: the port is injected, never assumed, so the same importer
  // writes rows instead of files under BLAZE_WRITE_PORT=db.
  let wp;
  try { wp = await resolveWritePort({ dataRoot, projectsDir }); }
  catch (e) { console.error(e.message); process.exit(1); }

  let r;
  try {
    r = await runImport({
      file: resolve(positional[0]),
      projectsDir, dataRoot,
      apply: opts.apply, update: opts.update, allocateIds: opts.allocateIds,
      commitMode: cfg.commitMode,
      writePort: wp.port,
    });
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
