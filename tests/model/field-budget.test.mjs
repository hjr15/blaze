// tests/model/field-budget.test.mjs — BLZ-329, spec §3.4's continuously-surfaced budget.
//
// "It must be surfaced CONTINUOUSLY, never sprung (CS-008)" and "the budget must therefore
// be reported install-wide and per project, so one team cannot silently exhaust another's
// headroom." Until now the number existed only inside promotionPlan's refusal string —
// you learned the budget at the exact moment you were denied, which is the definition of
// sprung.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fieldBudget, BUDGET_WARN_AT } from "../../scripts/model/field-budget.mjs";
import { FILTERABLE_CAP } from "../../scripts/model/field-promotion.mjs";

const f = (o) => ({ project_key: "BLZ", applies_to_kind: "requirement",
                    is_filterable: true, key: "k", ...o });

describe("the budget is reported per target table", () => {
  test("an empty installation reports the full cap as remaining, on both tables", () => {
    const b = fieldBudget({ definitions: [] });
    for (const table of ["artifact", "ticket"]) {
      assert.equal(b[table].used, 0);
      assert.equal(b[table].cap, FILTERABLE_CAP);
      assert.equal(b[table].remaining, FILTERABLE_CAP);
    }
  });

  test("the two tables do NOT pool — §3.4's independent column budgets", () => {
    // A `requirement`/`architecture` field promotes on `artifact`; a work-item type
    // promotes on `ticket`. Summing them would report a cap that neither table has.
    const b = fieldBudget({ definitions: [
      f({ key: "a", applies_to_kind: "requirement" }),
      f({ key: "b", applies_to_kind: "architecture" }),
      f({ key: "c", applies_to_kind: "story" }),
    ]});
    assert.equal(b.artifact.used, 2);
    assert.equal(b.ticket.used, 1);
  });

  test("a NON-filterable field consumes no budget — it lives in the JSON tail", () => {
    const b = fieldBudget({ definitions: [
      f({ key: "a" }), f({ key: "b", is_filterable: false }), f({ key: "c", is_filterable: false }),
    ]});
    assert.equal(b.artifact.used, 1);
    assert.equal(b.artifact.remaining, FILTERABLE_CAP - 1);
  });
});

describe("the shared-budget consequence ADR-0018 says will surprise people", () => {
  test("byProject is ordered by consumption, biggest consumer first", () => {
    const defs = [
      ...Array.from({ length: 5 }, (_, i) => f({ key: `a${i}`, project_key: "AAA" })),
      ...Array.from({ length: 9 }, (_, i) => f({ key: `b${i}`, project_key: "BBB" })),
      ...Array.from({ length: 2 }, (_, i) => f({ key: `c${i}`, project_key: "CCC" })),
    ];
    const b = fieldBudget({ definitions: defs });
    assert.deepEqual(b.artifact.byProject.map((p) => p.project_key), ["BBB", "AAA", "CCC"]);
    assert.deepEqual(b.artifact.byProject.map((p) => p.used), [9, 5, 2]);
    assert.equal(b.artifact.used, 16);
  });

  test("asking as a project reports what OTHER projects have spent of the shared budget", () => {
    // "A field promoted in project A consumes budget that project B can no longer use."
    // A per-project view that hides that is the silent exhaustion §3.4 warns about.
    const defs = [
      ...Array.from({ length: 3 }, (_, i) => f({ key: `a${i}`, project_key: "AAA" })),
      ...Array.from({ length: 7 }, (_, i) => f({ key: `b${i}`, project_key: "BBB" })),
    ];
    const b = fieldBudget({ definitions: defs, project_key: "AAA" });
    assert.equal(b.artifact.yours, 3);
    assert.equal(b.artifact.others, 7, "what other projects have spent must be visible, not implied");
    assert.equal(b.artifact.used, 10);
  });

  test("with no project_key asked for, `yours` is null rather than a misleading zero", () => {
    const b = fieldBudget({ definitions: [f({ key: "a", project_key: "AAA" })] });
    assert.equal(b.artifact.yours, null);
    assert.equal(b.artifact.others, null);
  });
});

describe("approaching the cap is observable, not merely inferable", () => {
  const many = (n, table = "requirement") =>
    Array.from({ length: n }, (_, i) => f({ key: `k${i}`, applies_to_kind: table }));

  test("well under the threshold, no warning", () => {
    const b = fieldBudget({ definitions: many(10) });
    assert.equal(b.artifact.warn, false);
    assert.equal(b.artifact.exhausted, false);
  });

  test("at the warn threshold, warn fires BEFORE the cap is reached", () => {
    const b = fieldBudget({ definitions: many(BUDGET_WARN_AT) });
    assert.equal(b.artifact.warn, true);
    assert.equal(b.artifact.exhausted, false, "warning is not refusal — there is still headroom");
    assert.ok(b.artifact.remaining > 0);
  });

  test("one below the threshold it does not fire — the boundary is real, not decorative", () => {
    const b = fieldBudget({ definitions: many(BUDGET_WARN_AT - 1) });
    assert.equal(b.artifact.warn, false);
  });

  test("at the cap, exhausted is true and remaining is 0, never negative", () => {
    const b = fieldBudget({ definitions: many(FILTERABLE_CAP) });
    assert.equal(b.artifact.exhausted, true);
    assert.equal(b.artifact.remaining, 0);
  });

  test("past the cap remaining floors at 0 rather than reporting a negative headroom", () => {
    const b = fieldBudget({ definitions: many(FILTERABLE_CAP + 5) });
    assert.equal(b.artifact.remaining, 0);
    assert.equal(b.artifact.used, FILTERABLE_CAP + 5, "but `used` still tells the truth");
  });

  test("the warn threshold is BELOW the cap — a warning at the cap warns nobody", () => {
    assert.ok(BUDGET_WARN_AT < FILTERABLE_CAP);
  });

  test("one table exhausted does not report the other as exhausted", () => {
    const b = fieldBudget({ definitions: many(FILTERABLE_CAP) });
    assert.equal(b.artifact.exhausted, true);
    assert.equal(b.ticket.exhausted, false);
  });
});
