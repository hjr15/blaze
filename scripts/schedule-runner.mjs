// scripts/schedule-runner.mjs — CLI entry for `blaze schedule`. The I/O half of BLZ-384; every
// decision it reports comes from a pure planner in scripts/model/, because `.c8rc.json` excludes
// `scripts/*-runner.mjs` from the coverage gate and logic put here would escape it silently.
//
//   blaze schedule migrate-dates [--dry-run | --write]   BLZ-360 §4
//   blaze schedule import-deps   [--dry-run]             BLZ-360 §5.5
//
// DRY-RUN IS THE DEFAULT for both, and `--write` exists only on migrate-dates. §4.1: the dry-run
// "is reviewed by a human before the write", and §5.5's import is operator-driven by design —
// the tool never guesses a direction, so it has nothing to write on its own.
import { readFileSync, writeFileSync } from "node:fs";
import { walkTickets } from "./model/index.mjs";
import { parseTicket, serializeTicket } from "./model/ticket.mjs";
import { planDateMigration } from "./model/migrate-dates.mjs";
import { planDependencyImport, DISPOSITION } from "./model/import-deps.mjs";
import { resolveRoots } from "./config.mjs";

const argv = process.argv.slice(2);
const sub = argv[0];
let write = false;
for (const a of argv.slice(1)) {
  if (a === "--write") write = true;
  else if (a === "--dry-run") write = false;
  else { console.error(`unknown flag: ${a}`); process.exit(1); }
}
if (sub !== "migrate-dates" && sub !== "import-deps") {
  console.error("usage: blaze schedule migrate-dates [--dry-run | --write]");
  console.error("       blaze schedule import-deps   [--dry-run]");
  console.error("  Dry-run is the DEFAULT for both. --write applies the date migration.");
  process.exit(1);
}
if (sub === "import-deps" && write) {
  // Not an oversight, and the refusal names the reason rather than just saying no.
  console.error("blaze schedule import-deps has no --write: BLZ-360 §5.5 makes the import "
    + "operator-driven because 124 of the 392 Blocks pairs are mutual and carry no direction. "
    + "The tool reports; you decide.");
  process.exit(1);
}

const { projectsDir } = resolveRoots();
const tickets = [];
for (const t of walkTickets(projectsDir)) {
  const fm = t.frontmatter ?? {};
  if (fm.id == null) continue;
  tickets.push({
    id: String(fm.id), type: fm.type ?? null, status: t.status, file: t.file,
    start: fm.start ?? null, due: fm.due ?? null,
    deadline: fm.deadline ?? null, not_before: fm.not_before ?? null,
    links: Array.isArray(fm.links) ? fm.links : [],
  });
}

if (sub === "migrate-dates") {
  const plan = planDateMigration({ tickets });
  const c = plan.counts;
  console.log("=== blaze schedule migrate-dates" + (write ? " --write" : " --dry-run") + " ===");
  console.log(`  ${tickets.length} tickets; ${c.dated} carry a date`);
  console.log("");
  console.log(`  FROZEN as actuals (terminal, kept verbatim): ${plan.frozen.length}`);
  for (const f of plan.frozen) {
    console.log(`    ${f.id.padEnd(10)} ${f.cohort.padEnd(28)} start=${f.start ?? "-"} due=${f.due ?? "-"}`);
  }
  console.log("");
  console.log(`  MIGRATED to constraints (non-terminal): ${plan.changes.length}`);
  for (const ch of plan.changes) {
    const sets = Object.entries(ch.sets).map(([k, v]) => `${k}=${v}`).join(" ");
    console.log(`    ${ch.id.padEnd(10)} ${ch.cohort.padEnd(28)} ${sets}  (clears ${ch.clears.join("/")})`);
  }
  if (plan.unresolved.length) {
    console.log("");
    console.log(`  UNRESOLVED type, reported not dropped: ${plan.unresolved.join(", ")}`);
  }
  console.log("");
  console.log(`  cohorts: ${JSON.stringify(c)}`);
  console.log(`  expected-delta for the zero-diff oracle (${plan.expectedDelta.length}): ${plan.expectedDelta.join(" ")}`);
  console.log(`  frozen ids asserted UNCHANGED (${plan.frozen.length})`);

  if (!write) {
    console.log("");
    console.log("  dry run — nothing written. Review the lists above, then re-run with --write.");
    process.exitCode = 0;
  } else {
    const byId = new Map(tickets.map((t) => [t.id, t]));
    let n = 0;
    for (const ch of plan.changes) {
      const file = byId.get(ch.id).file;
      const parsed = parseTicket(readFileSync(file, "utf8"));
      for (const k of ch.clears) delete parsed.frontmatter[k];
      Object.assign(parsed.frontmatter, ch.sets);
      writeFileSync(file, serializeTicket(parsed));
      n++;
    }
    console.log("");
    console.log(`  wrote ${n} ticket(s). The ${plan.frozen.length} frozen actuals were not touched.`);
    console.log("  Commit these as ONE commit and list the ids in the body (§4.1 item 2).");
  }
} else {
  const links = tickets.flatMap((t) => t.links
    .filter((l) => l && l.type === "Blocks")
    .map((l) => ({ type: "Blocks", src: t.id, target: String(l.target) })));
  const plan = planDependencyImport({ tickets, links });
  const c = plan.counts;
  console.log("=== blaze schedule import-deps --dry-run ===");
  console.log(`  ${c.total} Blocks edges considered`);
  console.log("");
  for (const d of [DISPOSITION.PROPOSED, DISPOSITION.UNDECIDABLE, DISPOSITION.REFUSED, DISPOSITION.DANGLING]) {
    const rows = plan.edges.filter((e) => e.disposition === d);
    if (!rows.length) continue;
    console.log(`  ${d.toUpperCase()} (${rows.length})`);
    for (const e of rows) {
      const tail = e.disposition === DISPOSITION.PROPOSED
        ? `Precedes ${e.src} -> ${e.target}${e.terminal_target ? "   [terminal target: the solve drops it]" : ""}`
        : e.reason;
      console.log(`    ${(e.src + " -> " + e.target).padEnd(24)} ${tail}`);
    }
    console.log("");
  }
  console.log(`  counts: ${JSON.stringify(c)}`);
  console.log(`  ${c.mutualPairs} mutual pair(s) are UNDECIDABLE — the tool proposes no direction`);
  console.log("  for any of them, and never will: guessing is right half the time and the wrong");
  console.log("  half is an invisible schedule error (§5.5).");
  console.log("");
  console.log("  Nothing written — this verb is report-only. Resolve each pair yourself.");
}
