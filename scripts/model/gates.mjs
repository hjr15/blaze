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
export const GATED_ACTIONS = new Set([
  "document:baselined",
  "requirement:verified",
  "goal:achieved",
  "architecture:accepted",
]);

const REQUIRED_ADR_SECTIONS = ["Context", "Decision", "Consequences"];

export function checkGate({ action, subject = {}, context = {} }) {
  if (!GATED_ACTIONS.has(action)) return { ok: true, error: null, failures: [] };

  let failures = [];
  if (action === "requirement:verified") {
    const has = (context.links ?? []).some(
      (l) => l.type_name === "Verifies" && l.target_id === subject.id);
    if (!has) failures = [{ ref: subject.ref, why: "no resolving Verifies link" }];
  }

  if (action === "goal:achieved") {
    failures = (context.children ?? [])
      .filter((c) => c.kind === "requirement" && !c.terminal)
      .map((c) => ({ ref: c.ref, why: `still ${c.status ?? "open"}` }));
  }

  if (action === "architecture:accepted") {
    const body = String(subject.body ?? "");
    failures = REQUIRED_ADR_SECTIONS
      .filter((s) => !sectionHasContent(body, s))
      .map((s) => ({ ref: subject.ref, why: `section "${s}" is missing or empty` }));
  }

  if (action === "document:baselined") {
    failures = (context.coverageViolations ?? [])
      .map((v) => ({ ref: v.ref, why: v.why }));
  }

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
