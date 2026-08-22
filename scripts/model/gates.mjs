// scripts/model/gates.mjs — the enumerated set of gated actions (ADR-0015, ADR-0017).
//
// A gate is where a coverage rule finally bites. Coverage cannot block a write --
// when a requirement is created, the architecture answering it does not exist yet --
// so it blocks at a deliberate checkpoint instead.
//
// A gate not on this list DOES NOT EXIST. Adding one is a deliberate act.
//
// Every refusal lists EVERY failing item. "Coverage incomplete" is a defect: the
// person hitting the gate has to know exactly what to fix.
//
// This module does NOT import evaluateCoverage (coverage.mjs). Three of the four
// gates have nothing to do with coverage, and `document:baselined` receives its
// coverage failures pre-computed on context.coverageViolations -- the composition of
// evaluateCoverage's output into that context happens in a later API task, not here.
const REQUIRED_ADR_SECTIONS = ["Context", "Decision", "Consequences"];

// Each gate is a function from ({subject, context}) to a list of failures.
// GATED_ACTIONS is DERIVED from these keys — a handler cannot exist without being
// registered, and a registered action cannot exist without a handler. The previous
// shape kept the two in separate places, where they could silently disagree.
const GATES = {
  "requirement:verified": ({ subject, context }) => {
    const has = (context.links ?? []).some(
      (l) => l.type_name === "Verifies" && l.target_id === subject.id);
    return has ? [] : [{ ref: subject.ref, why: "no resolving Verifies link" }];
  },
  "goal:achieved": ({ context }) =>
    (context.children ?? [])
      .filter((c) => c.kind === "requirement" && !c.terminal)
      .map((c) => ({ ref: c.ref, why: `still ${c.status ?? "open"}` })),
  "architecture:accepted": ({ subject }) =>
    REQUIRED_ADR_SECTIONS
      .filter((s) => !sectionHasContent(String(subject.body ?? ""), s))
      .map((s) => ({ ref: subject.ref, why: `section "${s}" is missing or empty` })),
  "document:baselined": ({ context }) =>
    (context.coverageViolations ?? []).map((v) => ({ ref: v.ref, why: v.why })),
};

export const GATED_ACTIONS = new Set(Object.keys(GATES));

export function checkGate({ action, subject = {}, context = {} }) {
  const gate = GATES[action];
  if (!gate) return { ok: true, error: null, failures: [] };
  const failures = gate({ subject, context });
  if (!failures.length) return { ok: true, error: null, failures: [] };
  return {
    ok: false,
    failures,
    error: `${action} refused — ${failures.length} item${failures.length === 1 ? "" : "s"} failing:\n`
      + failures.map((f) => `  ${f.ref}: ${f.why}`).join("\n"),
  };
}

function sectionHasContent(body, heading) {
  // \Z is Python/PCRE, not JavaScript -- in a JS RegExp it matches a literal "Z", not
  // end-of-string. That silently broke matching for whichever required section came
  // LAST in the body (nothing follows it, so the `^##\s` branch never fires either),
  // and the gate reported it as "missing or empty" even when fully populated.
  // `$(?![\s\S])` is a flag-independent absolute-end-of-string assertion: `$` still
  // does its normal per-line job under the `m` flag (needed for `^##\s` to anchor
  // each heading line), and `(?![\s\S])` only succeeds when nothing at all follows.
  const m = body.match(new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m"));
  return Boolean(m && m[1].trim().length > 0);
}
