// tests/model/derived-dates-not-editable.test.mjs — BLZ-386 / BLZ-360 §4.2.
//
// The migration is only half-done if the write path can put the old values back. `start` and
// `due` become SCHEDULER OUTPUTS under ADR-0022, so the operator loses the ability to set them
// and gains `not_before` and `deadline` instead.
//
// The comment above EDITABLE_FIELDS has always claimed "id/project/dates are read-only" while
// the set contained `start` and `due`. ADR-0022's own Context cites that contradiction as the
// reason the ADR exists. This is where the comment becomes true.
//
// EVERY REFUSAL NAMES THE REPLACEMENT FIELD. That is spec 1 §4.2's rule applied here, and §4.2
// states the consequence in as many words: "A refusal that does not name the replacement field
// is a defect."
import { test } from "node:test";
import assert from "node:assert/strict";
import { EDITABLE_FIELDS, derivedFieldRefusal } from "../../scripts/model/fields.mjs";

test("start and due are NOT editable — the fields the scheduler owns", () => {
  assert.equal(EDITABLE_FIELDS.has("start"), false);
  assert.equal(EDITABLE_FIELDS.has("due"), false);
});

test("not_before and deadline ARE editable — the constraints the operator owns", () => {
  assert.equal(EDITABLE_FIELDS.has("not_before"), true);
  assert.equal(EDITABLE_FIELDS.has("deadline"), true);
});

test("the set is asserted whole, so a field cannot be added without a test saying so", () => {
  // The comment above the set is prose and drifts. This is the contract.
  assert.deepEqual([...EDITABLE_FIELDS].sort(), [
    "assignee", "components", "deadline", "estimate", "impact", "labels", "likelihood",
    "not_before", "parent", "priority", "sprint", "title", "type",
  ]);
});

test("sprint SURVIVES — it is not a date and the migration does not touch it", () => {
  // Grepped rather than reasoned: `blaze sprint new --start` is the SPRINT WINDOW's start, a
  // different flag on a different runner, and removing ticket dates must not disturb it.
  assert.equal(EDITABLE_FIELDS.has("sprint"), true);
});

test("the refusal for start NAMES not_before — a refusal that does not is a defect", () => {
  const m = derivedFieldRefusal("start");
  assert.match(m, /start is derived by the scheduler/);
  assert.match(m, /'not_before'/, "it must name the replacement, not merely refuse");
});

test("the refusal for due NAMES deadline", () => {
  const m = derivedFieldRefusal("due");
  assert.match(m, /due is derived by the scheduler/);
  assert.match(m, /'deadline'/);
});

test("a field that is simply unknown gets no replacement suggestion", () => {
  // The replacement text must be specific to the two migrated fields; suggesting one for a
  // typo would be a confident wrong answer.
  assert.equal(derivedFieldRefusal("nonsense"), null);
  assert.equal(derivedFieldRefusal("title"), null);
});

// ---------------------------------------------------------------- validating what replaced them

import { validateSprintFields } from "../../scripts/model/sprints.mjs";

const validateDates = (fm) => validateSprintFields(fm, { sprintIds: new Set() });

test("not_before and deadline are validated as ISO dates — the gate start/due used to have", () => {
  // Closing a hole this migration would otherwise OPEN. The ISO/ordering validator guarded
  // `start` and `due`; after BLZ-386 nothing hand-writes those, so the guard now protects two
  // fields the scheduler writes correctly by construction — while the two fields an operator
  // DOES type had no validation at all.
  assert.deepEqual(validateDates({ not_before: "2026-08-11", deadline: "2026-08-16" }), []);
  assert.match(validateDates({ not_before: "11/08/2026" })[0], /not_before.*YYYY-MM-DD/);
  assert.match(validateDates({ deadline: "soon" })[0], /deadline.*YYYY-MM-DD/);
});

test("a not_before AFTER its deadline is refused — an impossible pair, not a missed one", () => {
  // Distinct from `deadline-unreachable`, and the distinction is ADR-0022's own split. A missed
  // deadline is a true statement about a CORRECT corpus and ships soft. "Start no earlier than
  // the 16th, finish by the 11th" is not a plan that failed — it is two constraints that cannot
  // both hold, which is the corpus being wrong.
  const e = validateDates({ not_before: "2026-08-16", deadline: "2026-08-11" });
  assert.equal(e.length, 1);
  assert.match(e[0], /not_before \(2026-08-16\) is after deadline \(2026-08-11\)/);
});

test("equal not_before and deadline is legal — a one-day window is still a window", () => {
  assert.deepEqual(validateDates({ not_before: "2026-08-11", deadline: "2026-08-11" }), []);
});

test("the start/due checks are KEPT, because the migration and the scheduler still write them", () => {
  // Removing them would leave the scheduler's own outputs unvalidated on the path that writes
  // them, which is a different path from the one BLZ-386 closed.
  assert.match(validateDates({ start: "nonsense" })[0], /start.*YYYY-MM-DD/);
  assert.match(validateDates({ start: "2026-07-25", due: "2026-07-20" })[0], /start.*is after due/);
});
