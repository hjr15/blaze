// scripts/model/field-budget.mjs — spec §3.4's continuously-surfaced field budget (BLZ-329).
//
// "The 200-field cap ... must be surfaced CONTINUOUSLY, never sprung (CS-008)." Until this
// module the number lived only inside promotionPlan's refusal string, so you learned the
// budget at the exact moment you were denied. That is the definition of sprung.
//
// And the consequence ADR-0018 says plainly "will surprise people": fields are DEFINED per
// project, but promoted columns live on one SHARED table, so the column budget is shared
// across every project in the installation. A field promoted in project A consumes budget
// project B can no longer use. §3.4: "The budget must therefore be reported install-wide
// and per project, so one team cannot silently exhaust another's headroom. An installation
// approaching the cap needs to see WHICH PROJECTS are consuming it, not just that it is
// close."
//
// PURE and SYNCHRONOUS. It counts persisted definitions; it never takes a number from a
// caller — that was the C5 defect in defineField, where a request supplying
// `filterableCount: 0` walked straight through the cap.
import { FILTERABLE_CAP, TARGET_TABLE } from "./field-promotion.mjs";

// 80% of the cap. The benchmark's indexing knee is 200-400 (insert p95 3.15 -> 51.4 ms),
// so 160 is still comfortably inside the flat region: there is real headroom left to act
// in, which is the whole point of warning rather than refusing. A threshold AT the cap
// warns nobody.
export const BUDGET_WARN_AT = Math.floor(FILTERABLE_CAP * 0.8);

export const BUDGET_TABLES = ["artifact", "ticket"];

const tableFor = (kind) => TARGET_TABLE[kind] ?? "ticket";

/**
 * @param definitions  every persisted field_definition in the INSTALLATION — not one
 *   project's. The budget is install-wide by construction (§3.4); handing this only one
 *   project's rows is how a team silently exhausts another's headroom.
 * @param project_key  OPTIONAL — when given, each table also reports `yours` / `others`,
 *   so the shared-budget consequence is visible rather than implied. Omitted, both are
 *   null rather than a misleading 0.
 */
export function fieldBudget({ definitions = [], project_key = null } = {}) {
  const out = {};
  for (const table of BUDGET_TABLES) {
    const filterable = definitions.filter(
      (d) => d.is_filterable && tableFor(d.applies_to_kind) === table);

    const perProject = new Map();
    for (const d of filterable) {
      perProject.set(d.project_key, (perProject.get(d.project_key) ?? 0) + 1);
    }
    const byProject = [...perProject.entries()]
      .map(([key, used]) => ({ project_key: key, used }))
      // Biggest consumer first: §3.4 asks WHICH projects are consuming the budget, and an
      // answer nobody can scan is the same as no answer.
      .sort((a, b) => b.used - a.used || String(a.project_key).localeCompare(String(b.project_key)));

    const used = filterable.length;
    const yours = project_key == null ? null : (perProject.get(project_key) ?? 0);
    out[table] = {
      table,
      used,
      cap: FILTERABLE_CAP,
      // Floored: a negative headroom is not a number anyone can act on. `used` still
      // reports the truth above the cap.
      remaining: Math.max(0, FILTERABLE_CAP - used),
      warnAt: BUDGET_WARN_AT,
      warn: used >= BUDGET_WARN_AT,
      exhausted: used >= FILTERABLE_CAP,
      yours,
      others: yours == null ? null : used - yours,
      byProject,
    };
  }
  return out;
}
