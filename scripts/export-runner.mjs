#!/usr/bin/env node
// scripts/export-runner.mjs — `blaze export --format csv`: read-only corpus →
// canonical CSV, on stdout. BLZ-627, the export half of the format layer's
// round trip (design §3, docs/design/csv-import-and-export.md). No board
// writes — `blaze export` is `mutates: false` in cli.mjs's SUBCOMMANDS.
//
// Argument parsing and printing only (excluded from the coverage gate,
// .c8rc.json's `scripts/*-runner.mjs` rule) — every decision this verb makes
// lives in scripts/model/export-rows.mjs.
import { fileURLToPath } from "node:url";
import { resolveRoots, loadConfig } from "./config.mjs";
import { exportCsv } from "./model/export-rows.mjs";

function usage() {
  console.error("usage: blaze export --format csv");
  console.error("  Prints the corpus as a canonical CSV (design §2) on stdout. Read-only.");
  console.error("  'csv' is the only format this build emits.");
}

function main() {
  const args = process.argv.slice(2);
  let format = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--format") { format = args[++i]; continue; }
    if (a.startsWith("--format=")) { format = a.slice("--format=".length); continue; }
    if (a.startsWith("--")) { console.error(`blaze export: unknown flag: ${a}`); usage(); process.exit(1); }
    positional.push(a);
  }
  if (positional.length > 0) {
    console.error(`blaze export: unexpected argument(s): ${positional.join(" ")}`);
    usage();
    process.exit(1);
  }
  if (format !== "csv") {
    console.error(
      `blaze export: --format is required and must be 'csv' (got ${JSON.stringify(format)})`);
    usage();
    process.exit(1);
  }

  const { dataRoot, projectsDir } = resolveRoots();
  // Same version guard rollup-runner.mjs takes before doing any read: fail
  // loud on a board stamped outside this engine's supported window rather
  // than exporting against config this build cannot actually honour.
  loadConfig({ root: dataRoot });

  const { text, warnings } = exportCsv(projectsDir);
  // design §2.5: export never refuses and never mutates a hostile cell — it
  // only names every one, with the ticket, the column and (below) the total,
  // so the operator learns before opening the file in a spreadsheet.
  for (const w of warnings) console.error(`blaze export: ${w}`);
  if (warnings.length > 0) {
    console.error(`blaze export: ${warnings.length} hostile cell(s) found — see above`);
  }
  process.stdout.write(text);
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`blaze export failed: ${e.message}`);
    process.exit(1);
  }
}
