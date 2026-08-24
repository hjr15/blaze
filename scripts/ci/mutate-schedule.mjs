// Applies each of BLZ-360 §11's mutations to the solve, runs the suite, restores.
// A mutation that does NOT break a test is a hole in the suite and is reported as one.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SOLVE = "scripts/model/schedule.mjs";
const AUDIT = "scripts/model/audit.mjs";
const SUITES = "tests/model/schedule.test.mjs tests/model/schedule-findings.test.mjs";

const MUTATIONS = [
  { n: 1, file: AUDIT, name: "EF > deadline flipped to EF >= deadline",
    from: "if (!row.deadline || !(row.due_date > row.deadline)) continue;",
    to:   "if (!row.deadline || !(row.due_date >= row.deadline)) continue;" },
  { n: 2, name: "drop the + lag term from the forward pass",
    from: "start = Math.max(start, ef.get(e.src) + e.lag_minutes);",
    to:   "start = Math.max(start, ef.get(e.src));" },
  { n: 3, name: "backward pass takes max over successors instead of min",
    from: "late = late === null ? ls.get(e.target) - e.lag_minutes : Math.min(late, ls.get(e.target) - e.lag_minutes);",
    to:   "late = late === null ? ls.get(e.target) - e.lag_minutes : Math.max(late, ls.get(e.target) - e.lag_minutes);" },
  { n: 4, name: "float returned as ES - LS instead of LS - ES",
    from: "const floatMinutes = ls.get(id) - es.get(id);",
    to:   "const floatMinutes = es.get(id) - ls.get(id);" },
  { n: 5, name: "remove the terminal-ticket exemption so done tickets are rescheduled",
    from: ".filter((id) => !terminalOf(rows.get(id)) && isDelivery(rows.get(id)) && !duplicated.has(id))",
    to:   ".filter((id) => isDelivery(rows.get(id)) && !duplicated.has(id))" },
  { n: "5b", file: SOLVE, name: "remove the delivery-workflow node filter",
    from: ".filter((id) => !terminalOf(rows.get(id)) && isDelivery(rows.get(id)) && !duplicated.has(id))",
    to:   ".filter((id) => !terminalOf(rows.get(id)) && !duplicated.has(id))" },
  { n: 6, name: "SCC members are not marked unscheduled",
    from: "for (const c of cycles) for (const id of c) unscheduled.push({ id, reason: \"dependency-cycle\", scc: c });",
    to:   "" },
  { n: "6b", name: "SCC members are returned as scheduled",
    from: "const solveIds = nodeIds.filter((id) => !inCycle.has(id));",
    to:   "const solveIds = nodeIds;" },
  // Found by adversarial review, not by BLZ-360 §11. All seven SURVIVED when first applied, and
  // the tests that kill them were added in the same commit that records this.
  { n: "R1", file: AUDIT, name: "crosses_projects forced always true",
    from: "const crosses = new Set(chain.map(projectOf)).size > 1;",
    to:   "const crosses = true;" },
  { n: "R2", file: AUDIT, name: "lateness counted in calendar days, not working days",
    from: "while (ms < end) { ms += day; if (working.has(new Date(ms).getUTCDay())) n++; }",
    to:   "while (ms < end) { ms += day; n++; }" },
  { n: "R3", name: "lastDayIndex back to ef - 1 with no start-day floor",
    from: "lastDayIndex(es, ef) { return this.dayIndexAt(Math.max(es, ef - 1)); }",
    to:   "lastDayIndex(es, ef) { return this.dayIndexAt(ef - 1); }" },
  { n: "R4", name: "minutesAtEndOf rounds a non-working date up again",
    from: "return (this.working.has(dayOf(parseDay(iso))) ? n + 1 : n) * this.mpd;",
    to:   "return (n + 1) * this.mpd;" },
  { n: "R5", name: "duplicate ids resolved by input order again",
    from: "if (rows.has(t.id)) duplicated.add(t.id); else rows.set(t.id, t);",
    to:   "rows.set(t.id, t);" },
  { n: "R6", file: AUDIT, name: "no-predecessors claimed whenever no predecessor binds",
    from: "      : hasPredecessor(schedule, row.id)",
    to:   "      : false" },
  { n: "R7", file: AUDIT, name: "the migration banner claims already-in-the-past unchecked",
    from: "const past = all && items.every((f) => f.deadline && epochDate && f.deadline < epochDate);",
    to:   "const past = all;" },
  { n: 7, name: "a missing estimate is one day instead of 0",
    from: "dur.set(id, Number.isFinite(e) && e > 0 ? e : 0);",
    to:   "dur.set(id, Number.isFinite(e) && e > 0 ? e : cal.mpd);" },
  { n: 8, name: "drop the project_epoch floor so a schedule may start in the past",
    from: "    let start = 0;\n    if (r.constraint_start_no_earlier_than) start = Math.max(start, cal.minutesAtStartOf(r.constraint_start_no_earlier_than));",
    to:   "    let start = r.constraint_start_no_earlier_than ? cal.minutesAtStartOf(r.constraint_start_no_earlier_than) : 0;" },
];

const results = [];
for (const m of MUTATIONS) {
  const src = m.file ?? SOLVE;
  const original = readFileSync(src, "utf8");
  if (!original.includes(m.from)) { results.push({ ...m, status: "PATCH-MISS" }); continue; }
  if (original.split(m.from).length - 1 !== 1) { results.push({ ...m, status: "PATCH-AMBIGUOUS" }); continue; }
  writeFileSync(src, original.replace(m.from, m.to));
  let killed = false, detail = "";
  try {
    execSync(`node --test ${process.argv[2] ?? SUITES}`, { stdio: "pipe" });
  } catch (e) {
    killed = true;
    const out = String(e.stdout ?? "");
    detail = (out.match(/^ℹ fail \d+$/m) ?? [""])[0];
  }
  writeFileSync(src, original);
  results.push({ ...m, status: killed ? "KILLED" : "SURVIVED", detail });
}

console.log("\n=== BLZ-360 §11 mutation results ===");
for (const r of results) console.log(`  #${r.n}  ${r.status.padEnd(15)} ${r.name}  ${r.detail}`);
const bad = results.filter((r) => r.status !== "KILLED");
console.log(bad.length ? `\n${bad.length} mutation(s) NOT killed — these are holes in the suite.` : "\nAll mutations killed.");
// Exit non-zero on a survivor. Reporting a hole and exiting 0 is a gate that cannot gate — the
// same defect audit-runner.mjs already calls out for `blaze audit`.
process.exitCode = bad.length ? 1 : 0;
