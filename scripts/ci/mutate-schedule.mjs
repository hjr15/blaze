// Applies each of BLZ-360 §11's mutations to the solve, runs the suite, restores.
// A mutation that does NOT break a test is a hole in the suite and is reported as one.
//
// BLZ-441: THIS GATE IS SCOPED, and its output now says so on every run. It mutates two
// files — `scripts/model/schedule.mjs` and `scripts/model/audit.mjs` — against two suites,
// and it says nothing whatever about any other module. "17/17 mutations killed" has been
// quoted as lane-wide evidence beside changes to files this harness never opens, where it
// is not evidence of anything. A lane touching other modules must mutation-verify those
// separately, by reverting each production hunk and watching the NAMED test that claims to
// pin it go red. See docs/ci.md, "Mutation testing is scoped".
//
// BLZ-472: IT MUTATES A COPY. IT NEVER WRITES THE SHARED WORKING TREE.
//
// It used to rewrite `scripts/model/schedule.mjs` in place, in the checkout, with no lock.
// A suite running in the same worktree while it was mutating read a HALF-MUTATED module and
// reported a failure that was not real. Reproduced accidentally by the Lane F reviewer and
// it cost a full re-run: `npm run test:coverage` reported
// `tests/model/link-type-overrides.test.mjs:422 ✖ a board that is all ONE DEPENDENCY CYCLE
// does not raise it — expected the cycle finding, got: (empty)`; in isolation it passed,
// and a clean re-run with nothing else in the worktree was 4,017/0 against 4,016/0 on the
// parent commit. That is the same class as BLZ-468 — two processes in one worktree
// producing a failure that is not real — and its cost is not the re-run, it is that it
// trains a reader to re-run instead of investigate.
//
// The fix is the option that removes the race rather than detecting it: every run copies
// the WORKING TREE (`scripts/`, `tests/`, `package.json` — not HEAD, because the point of
// this gate is to judge the code you are about to ship, uncommitted hunks included) into a
// throwaway directory, and mutates and tests THERE. Two consequences worth naming:
//
//   - a suite failure seen in the checkout while this is running is REAL. This process
//     cannot have caused it; it opens no file in the checkout for writing.
//   - a crash between the mutate and the restore can no longer leave the checkout
//     mutated. It leaves a temp directory, which is swept on the next boot.
//
// A lock was considered and rejected: the thing that has to respect it is `node --test`,
// which knows nothing about this harness, so a lock here would serialise mutation runs
// against each other — which was never the failure — and nothing else.
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOLVE = "scripts/model/schedule.mjs";
const AUDIT = "scripts/model/audit.mjs";
const SUITES = "tests/model/schedule.test.mjs tests/model/schedule-findings.test.mjs";

/** What a run needs in the sandbox. `node --test` is a builtin and the two suites import
 *  nothing outside `scripts/`, so no `node_modules` is copied — that is the whole reason
 *  a copy is cheap enough to be the default. */
export const SANDBOX_CONTENTS = ["scripts", "tests", "package.json"];

/** A throwaway copy of the WORKING TREE — not of HEAD. Returns its path; the caller owns
 *  removing it. Never writes anything under `repo`. */
export function createSandbox(repo = REPO) {
  const dir = mkdtempSync(join(tmpdir(), "blz-mutate-"));
  for (const entry of SANDBOX_CONTENTS) {
    const from = join(repo, entry);
    if (!existsSync(from)) throw new Error(`mutate-schedule: ${entry} is missing from ${repo}`);
    cpSync(from, join(dir, entry), { recursive: true });
  }
  return dir;
}

export const MUTATIONS = [
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
    from: ".filter((id) => !terminalOf(rows.get(id)) && isNodeKind(rows.get(id)) && !duplicated.has(id))",
    to:   ".filter((id) => isNodeKind(rows.get(id)) && !duplicated.has(id))" },
  { n: "5b", file: SOLVE, name: "remove the Precedes-endpoint-kind node filter",
    from: ".filter((id) => !terminalOf(rows.get(id)) && isNodeKind(rows.get(id)) && !duplicated.has(id))",
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

// BLZ-472: every path below is joined onto `sandbox`. Nothing here takes a bare relative
// path any more — a bare path would resolve against the caller's cwd, which is exactly the
// shared checkout this must not touch.
//
// Wrapped in a function, and called only from the CLI block at the foot of this file, so
// that `tests/ci-mutation-sandbox.test.mjs` can import `createSandbox` and `MUTATIONS`
// without running the gate. A test file that ran the gate on import would be the very
// hazard this ticket is about.
function runMutations(suites) {
const sandbox = createSandbox();
const results = [];
try {
  for (const m of MUTATIONS) {
    const src = join(sandbox, m.file ?? SOLVE);
    const original = readFileSync(src, "utf8");
    if (!original.includes(m.from)) { results.push({ ...m, status: "PATCH-MISS" }); continue; }
    if (original.split(m.from).length - 1 !== 1) { results.push({ ...m, status: "PATCH-AMBIGUOUS" }); continue; }
    writeFileSync(src, original.replace(m.from, m.to));
    let killed = false, detail = "";
    try {
      execSync(`node --test ${suites}`, { stdio: "pipe", cwd: sandbox });
    } catch (e) {
      killed = true;
      const out = String(e.stdout ?? "");
      detail = (out.match(/^ℹ fail \d+$/m) ?? [""])[0];
    }
    writeFileSync(src, original);
    results.push({ ...m, status: killed ? "KILLED" : "SURVIVED", detail });
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
return results;
}

// --- CLI ----------------------------------------------------------------------
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
const results = runMutations(process.argv[2] ?? SUITES);
// BLZ-441: the SCOPE is printed with the result, not left to the reader's memory, and it
// is derived from the constants above rather than restated — a file added to MUTATIONS
// under a new `file:` shows up here without anyone remembering to edit a banner.
const covered = [...new Set(MUTATIONS.map((m) => m.file ?? SOLVE))].sort();
console.log("\n=== BLZ-360 §11 mutation results ===");
console.log(`  scope: ${MUTATIONS.length} mutations of ${covered.join(" + ")}`);
console.log(`         judged by ${SUITES}`);
console.log("         SCOPED GATE — it says nothing about any other module. A change");
console.log("         elsewhere must be mutation-verified separately (docs/ci.md).");
// BLZ-472: said on every run, because the reader's question when a suite goes red beside
// this one is exactly "could that have been you".
console.log("         Mutations were applied to a COPY of the working tree, never to this");
console.log("         checkout — a suite failure seen here while this ran is REAL.");
for (const r of results) console.log(`  #${r.n}  ${r.status.padEnd(15)} ${r.name}  ${r.detail}`);
const bad = results.filter((r) => r.status !== "KILLED");
console.log(bad.length
  ? `\n${bad.length} mutation(s) NOT killed — these are holes in the suite.`
  : `\nAll ${MUTATIONS.length} mutations killed, in ${covered.join(" + ")} only.`);
// Exit non-zero on a survivor. Reporting a hole and exiting 0 is a gate that cannot gate — the
// same defect audit-runner.mjs already calls out for `blaze audit`.
process.exitCode = bad.length ? 1 : 0;
}
