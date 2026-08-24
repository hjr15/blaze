// tests/model/migrate-dates.test.mjs — BLZ-385 / BLZ-360 §4.
//
// The migration that makes the kernel live. ADR-0022 changes the MEANING of two fields every
// existing board already populates, so the cohort split is the whole correctness argument:
// a terminal ticket's dates are ACTUALS owned by history, a non-terminal one's are the
// operator's CONSTRAINTS. Getting the split backwards destroys information in both
// directions, and §4 records why each uniform alternative is wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDateMigration, COHORT } from "../../scripts/model/migrate-dates.mjs";

const t = (id, over = {}) => ({ id, type: "task", status: "defined", start: null, due: null, ...over });
const plan = (tickets) => planDateMigration({ tickets });
const forId = (p, id) => p.changes.find((c) => c.id === id) ?? p.frozen.find((c) => c.id === id);

// ---------------------------------------------------------------- the terminal cohorts

test("a terminal ticket with start AND due is frozen verbatim — 27 of the corpus", () => {
  // §4: "A done ticket's dates already describe what happened. Re-deriving them would
  // overwrite history with a forecast, and a forecast of the past is not a number anyone wants."
  const p = plan([t("D", { status: "done", start: "2026-06-01", due: "2026-06-05" })]);
  assert.deepEqual(p.changes, [], "a frozen ticket is NOT a change");
  assert.deepEqual(p.frozen.map((f) => f.id), ["D"]);
  assert.equal(forId(p, "D").cohort, COHORT.TERMINAL_BOTH);
  assert.equal(forId(p, "D").start, "2026-06-01", "byte-for-byte");
  assert.equal(forId(p, "D").due, "2026-06-05");
});

test("a terminal ticket with due only is frozen too — the 1", () => {
  const p = plan([t("D", { status: "done", due: "2026-06-05" })]);
  assert.deepEqual(p.changes, []);
  assert.equal(forId(p, "D").cohort, COHORT.TERMINAL_DUE_ONLY);
});

test("terminality is decided by isTerminal, not by the directory name being 'done'", () => {
  // A `goal` is terminal at `achieved`, which is the definition error BLZ-353 shipped on.
  const p = plan([t("G", { type: "goal", status: "achieved", start: "2026-01-01", due: "2026-02-01" })]);
  assert.deepEqual(p.changes, [], "achieved is terminal for a goal");
  assert.equal(p.frozen.length, 1);
});

// ---------------------------------------------------------------- the non-terminal cohorts

test("a non-terminal ticket with start AND due becomes two constraints — 11 of the corpus", () => {
  const p = plan([t("O", { start: "2026-08-11", due: "2026-08-16" })]);
  assert.deepEqual(p.frozen, []);
  const c = forId(p, "O");
  assert.equal(c.cohort, COHORT.OPEN_BOTH);
  assert.deepEqual(c.sets, { not_before: "2026-08-11", deadline: "2026-08-16" });
  assert.deepEqual(c.clears, ["start", "due"], "the derived fields are cleared and recomputed");
});

test("OMA-4's shape — a non-terminal ticket with due only becomes a deadline and no constraint", () => {
  // §4: "the single clearest proof in the corpus that the `deadline` field has the right shape."
  const p = plan([t("OMA-4", { due: "2026-10-20" })]);
  const c = forId(p, "OMA-4");
  assert.equal(c.cohort, COHORT.OPEN_DUE_ONLY);
  assert.deepEqual(c.sets, { deadline: "2026-10-20" });
  assert.ok(!("not_before" in c.sets), "no start means no lower bound is invented");
  assert.deepEqual(c.clears, ["due"], "there is no start to clear");
});

test("a non-terminal ticket with start only becomes a constraint and no deadline", () => {
  // Measured 0 on the live board, so this is the cohort the corpus does not exercise. It is
  // handled rather than left to fall through a gap, because "0 today" is not "0 forever".
  const p = plan([t("S", { start: "2026-09-01" })]);
  const c = forId(p, "S");
  assert.equal(c.cohort, COHORT.OPEN_START_ONLY);
  assert.deepEqual(c.sets, { not_before: "2026-09-01" });
  assert.deepEqual(c.clears, ["start"]);
});

test("an undated ticket is not touched and is not in any list", () => {
  const p = plan([t("U"), t("V")]);
  assert.deepEqual(p.changes, []);
  assert.deepEqual(p.frozen, []);
  assert.equal(p.counts.undated, 2);
  assert.deepEqual(p.dated, []);
});

// ---------------------------------------------------------------- the sets the oracle needs

test("dated, expectedDelta and migratedDeadlines are three DIFFERENT sets", () => {
  // Spec 3 §8 caught an earlier draft conflating them: §4's 40 ids are 28 terminal + 12
  // non-terminal, so membership identifies a DATED ticket, not a MIGRATED DEADLINE. The
  // migration must record WHICH of them became a deadline, not only that they changed.
  const p = plan([
    t("T1", { status: "done", start: "2026-06-01", due: "2026-06-05" }),
    t("T2", { status: "done", due: "2026-06-05" }),
    t("O1", { start: "2026-08-11", due: "2026-08-16" }),
    t("O2", { due: "2026-10-20" }),
    t("O3", { start: "2026-09-01" }),
    t("U1"),
  ]);
  assert.deepEqual(p.dated, ["O1", "O2", "O3", "T1", "T2"], "every ticket carrying any date");
  assert.deepEqual(p.expectedDelta, ["O1", "O2", "O3"], "only what actually changes");
  assert.deepEqual(p.migratedDeadlines, ["O1", "O2"], "O3 has no due, so it gains no deadline");
  assert.deepEqual(p.frozen.map((f) => f.id), ["T1", "T2"], "and these change nothing at all");
});

test("every list is sorted, so the dry-run and the commit body are byte-stable", () => {
  const p = plan([t("B", { due: "2026-09-01" }), t("A", { due: "2026-09-01" }), t("C", { due: "2026-09-01" })]);
  assert.deepEqual(p.expectedDelta, ["A", "B", "C"]);
  assert.deepEqual(p.changes.map((c) => c.id), ["A", "B", "C"]);
});

test("the counts reconcile to the input, so nothing is silently dropped", () => {
  const p = plan([
    t("T1", { status: "done", start: "2026-06-01", due: "2026-06-05" }),
    t("O1", { start: "2026-08-11", due: "2026-08-16" }),
    t("U1"), t("U2"),
  ]);
  const c = p.counts;
  assert.equal(c.terminalBoth + c.terminalDueOnly + c.terminalStartOnly
    + c.openBoth + c.openDueOnly + c.openStartOnly + c.undated, 4, "every input lands in exactly one cohort");
  assert.equal(c.dated, 2);
  assert.equal(p.changes.length + p.frozen.length, c.dated);
});

test("a ticket whose type will not resolve is reported, never silently dropped", () => {
  const p = plan([t("X", { type: "nonsense", due: "2026-09-01" }), t("OK", { due: "2026-09-01" })]);
  assert.deepEqual(p.unresolved, ["X"]);
  assert.ok(!p.dated.includes("X"), "and it is not counted as migrated either");
  assert.deepEqual(p.expectedDelta, ["OK"]);
});

test("the migration is idempotent — a ticket already carrying deadline is not re-migrated", () => {
  // The write is one commit and a human reviews the dry-run, so a second run must be a no-op
  // rather than clearing the constraint it just wrote.
  const p = plan([t("O", { due: null, start: null, deadline: "2026-10-20" })]);
  assert.deepEqual(p.changes, []);
  assert.equal(p.counts.alreadyMigrated, 1);
});
