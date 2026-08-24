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
import { fsReadStorage } from "./model/read-storage.mjs";
import { fsStorage } from "./model/storage.mjs";
import { parseTicket, serializeTicket } from "./model/ticket.mjs";
import { planDateMigration } from "./model/migrate-dates.mjs";
import { planDependencyImport, DISPOSITION } from "./model/import-deps.mjs";
import { resolveRoots, loadConfig } from "./config.mjs";
import { resolveSchema } from "./model/schema-config.mjs";

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

/** The frontmatter block's non-empty lines, for the round-trip guard below. */
function frontmatterOf(text) {
  const lines = text.split("\n");
  const end = lines.indexOf("---", 1);
  return lines.slice(1, end === -1 ? lines.length : end)
    .map((l) => l.trim()).filter((l) => l !== "");
}
const sameLines = (a, b) =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

const { projectsDir, dataRoot } = resolveRoots();
// BLZ-392. Tolerated the way audit-runner tolerates it: a config that will not load leaves the
// shipped endpoint kinds in force rather than taking the command down, because import-deps is a
// read-only planner and refusing to plan would be the worse failure.
let scheduleConfig = null;
try { scheduleConfig = loadConfig({ root: dataRoot }); } catch { scheduleConfig = null; }
const RESOLVED_LINK_TYPES = resolveSchema({ config: scheduleConfig }).linkTypes;
const tickets = [];
// A file whose frontmatter will not parse yields no id — a CRLF ticket does exactly this,
// because `parseTicket`'s line regex has no `m` flag and cannot match before a `\r`. Such a
// ticket would be skipped SILENTLY, keeping its legacy dates forever while the run reported
// success. Counted and reported instead. Measured: 0 on the live board.
let unparseable = 0;
// Through the READ SEAM (ADR-0009), not a bespoke walk. tests/model/seam-closure.test.mjs
// enforces this and caught an earlier version of this file calling walkTickets directly —
// "a bespoke directory walk outside the seam is how contentHash hid for four slices".
for (const t of fsReadStorage.listTickets(projectsDir)) {
  const fm = t.frontmatter ?? {};
  if (fm.id == null) { unparseable++; continue; }
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
  if (plan.conflicted.length) {
    console.log("");
    console.log(`  REFUSED — already carries a constraint, and the legacy dates would overwrite it: ${plan.conflicted.length}`);
    for (const c of plan.conflicted) {
      console.log(`    ${c.id.padEnd(10)} has not_before=${c.already_has.not_before ?? "-"} `
        + `deadline=${c.already_has.deadline ?? "-"}; would have set `
        + Object.entries(c.would_set).map(([k, v]) => `${k}=${v}`).join(" "));
    }
    console.log("    Resolve each by hand — the migration will not choose between them.");
  }
  if (plan.unresolved.length) {
    console.log("");
    console.log(`  UNRESOLVED type or status, reported not dropped: ${plan.unresolved.join(", ")}`);
  }
  if (unparseable) {
    console.log("");
    console.log(`  UNPARSEABLE frontmatter, skipped and NOT migrated: ${unparseable} file(s).`);
    console.log("    A CRLF ticket parses to nothing and would otherwise be skipped in silence.");
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
    const skipped = [];
    let n = 0;
    for (const ch of plan.changes) {
      const file = byId.get(ch.id).file;
      // Through the WRITE SEAM, for the same reason: seam-closure.test.mjs refuses a
      // writeFileSync on a ticket path from anywhere but model/storage.mjs.
      const original = fsStorage.read(file);
      const parsed = parseTicket(original);
      // ROUND-TRIP GUARD. `parseTicket`/`serializeTicket` model a subset of YAML: a block
      // scalar's content lines, a hyphenated key and a frontmatter comment are all DROPPED
      // rather than preserved. Rewriting such a ticket would destroy content the migration
      // never meant to touch, so the unchanged parse is re-serialized first and the file is
      // refused if anything went missing.
      //
      // Compared as a LINE MULTISET rather than byte-for-byte: `serializeTicket` reorders keys
      // into FIELD_ORDER, and zero-diff.mjs already classifies field-order-only differences as
      // informational. A dropped line is data loss; a moved one is not.
      //
      // Measured: 0 tickets on the live board fail this, which is why the migration is safe to
      // run there — but "0 today" is not a reason to write blind.
      if (!sameLines(frontmatterOf(original), frontmatterOf(serializeTicket(parsed)))) {
        skipped.push(ch.id);
        continue;
      }
      for (const k of ch.clears) delete parsed.frontmatter[k];
      Object.assign(parsed.frontmatter, ch.sets);
      fsStorage.write(file, serializeTicket(parsed));
      n++;
    }
    console.log("");
    console.log(`  wrote ${n} ticket(s). The ${plan.frozen.length} frozen actuals were not touched.`);
    if (skipped.length) {
      console.log(`  REFUSED ${skipped.length}: ${skipped.join(", ")} — the file does not survive a`);
      console.log("  parse/serialize round trip, so rewriting it would drop frontmatter this");
      console.log("  migration does not model. Migrate those by hand.");
      process.exitCode = 1;
    }
    console.log("  Commit these as ONE commit and list the ids in the body (§4.1 item 2).");
  }
} else {
  const links = tickets.flatMap((t) => t.links
    .filter((l) => l && l.type === "Blocks")
    .map((l) => ({ type: "Blocks", src: t.id, target: String(l.target) })));
  // BLZ-392: the RESOLVED endpoint kinds. The planner that creates `Precedes` edges and the
  // solve that consumes them must agree about what may be an endpoint, and an override that
  // reached only one of them would let a type be schedulable but undependable.
  const plan = planDependencyImport({ tickets, links, linkTypes: RESOLVED_LINK_TYPES });
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
