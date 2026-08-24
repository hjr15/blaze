// scripts/model/migrate-dates.mjs — BLZ-360 §4's one-time date migration, as a PURE planner.
// The runner does the I/O; everything here is a function of its arguments, so the cohort split
// is testable at every boundary and does not hide behind `scripts/*-runner.mjs`, which
// `.c8rc.json` excludes from the coverage gate.
//
// ADR-0022 changes the MEANING of two fields every existing board already populates:
// `start_date`/`due_date` stop being operator inputs and become scheduler outputs. This decides
// what happens to the values already sitting in them, and THE SPLIT IS ON TERMINALITY:
//
//   terminal     → the dates are ACTUALS owned by history. Kept verbatim, frozen, never
//                  re-derived. "A forecast of the past is not a number anyone wants."
//   non-terminal → the dates were the operator's intent. `due` becomes a `deadline`, `start`
//                  becomes a `not_before`, and the derived fields are cleared and recomputed.
//
// §4 records why both UNIFORM answers destroy information. Making everything a constraint
// invents 28 commitments nobody made, every one already in the past, every one of which would
// raise `deadline-unreachable` on day one — the exact "gate people learn to skip" failure
// audit.mjs's header warns about. Discarding everything throws away `OMA-4`, the clearest
// evidence in the corpus that `deadline` has the right shape.
import { isTerminal } from "./workflows.mjs";

export const COHORT = {
  TERMINAL_BOTH: "terminal-actuals-both",
  TERMINAL_DUE_ONLY: "terminal-actuals-due-only",
  TERMINAL_START_ONLY: "terminal-actuals-start-only",
  OPEN_BOTH: "constraints-both",
  OPEN_DUE_ONLY: "constraints-due-only",
  OPEN_START_ONLY: "constraints-start-only",
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const val = (x) => { const s = String(x ?? "").trim(); return s === "" ? null : s; };

/**
 * @param tickets [{ id, type, status, start, due, deadline?, not_before? }] — the whole corpus
 * @returns {
 *   changes:  [{ id, cohort, sets, clears }]  the tickets whose fields actually change
 *   frozen:   [{ id, cohort, start, due }]    dated terminal tickets, kept verbatim
 *   dated:            every id carrying any date         (§4's 40)
 *   expectedDelta:    every id whose start/due CHANGES   (a strict subset — see below)
 *   migratedDeadlines: every id that GAINS a deadline    (spec 3 §8's set)
 *   unresolved:       ids whose type will not resolve, reported rather than dropped
 *   counts:           one bucket per ticket, reconciling to the input length
 * }
 *
 * THREE DIFFERENT SETS, and spec 3 §8 exists because an earlier draft conflated two of them.
 * §4's 40 ids are 28 terminal + 12 non-terminal, so membership in `dated` identifies a DATED
 * ticket, not a MIGRATED DEADLINE. `expectedDelta` is what the zero-diff oracle must allow to
 * differ, and it is NOT the 40: a frozen terminal ticket keeps its bytes, so it cannot show up
 * as a diff and must not be excused as though it could.
 */
export function planDateMigration({ tickets = [] } = {}) {
  const changes = [], frozen = [], unresolved = [], dated = [], migratedDeadlines = [];
  const counts = {
    terminalBoth: 0, terminalDueOnly: 0, terminalStartOnly: 0,
    openBoth: 0, openDueOnly: 0, openStartOnly: 0,
    undated: 0, alreadyMigrated: 0, unresolved: 0, dated: 0,
  };

  for (const t of tickets) {
    if (!t || t.id == null) continue;
    const start = val(t.start), due = val(t.due);

    // Idempotence: the write is one commit a human reviews, so a second run must be a no-op
    // rather than clearing the constraint the first one wrote.
    if (!start && !due && (val(t.deadline) || val(t.not_before))) { counts.alreadyMigrated++; continue; }
    if (!start && !due) { counts.undated++; continue; }

    let terminal;
    try { terminal = isTerminal(t.type, t.status); }
    catch { unresolved.push(t.id); counts.unresolved++; continue; }

    dated.push(t.id);
    counts.dated++;

    if (terminal) {
      const cohort = start && due ? COHORT.TERMINAL_BOTH
        : due ? COHORT.TERMINAL_DUE_ONLY : COHORT.TERMINAL_START_ONLY;
      counts[start && due ? "terminalBoth" : due ? "terminalDueOnly" : "terminalStartOnly"]++;
      frozen.push({ id: t.id, cohort, start, due });
      continue;
    }

    const cohort = start && due ? COHORT.OPEN_BOTH
      : due ? COHORT.OPEN_DUE_ONLY : COHORT.OPEN_START_ONLY;
    counts[start && due ? "openBoth" : due ? "openDueOnly" : "openStartOnly"]++;
    const sets = {}, clears = [];
    if (start) { sets.not_before = start; clears.push("start"); }
    if (due) { sets.deadline = due; clears.push("due"); migratedDeadlines.push(t.id); }
    changes.push({ id: t.id, cohort, sets, clears });
  }

  changes.sort((a, b) => cmp(a.id, b.id));
  frozen.sort((a, b) => cmp(a.id, b.id));
  return {
    changes, frozen,
    dated: dated.slice().sort(cmp),
    expectedDelta: changes.map((c) => c.id),
    migratedDeadlines: migratedDeadlines.slice().sort(cmp),
    unresolved: unresolved.slice().sort(cmp),
    counts,
  };
}
