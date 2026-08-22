// scripts/model/advisory.mjs — spec §4.3's advisory checks (BLZ-333).
//
// "Reported, NEVER BLOCKING: RQ-4b warn tier, singularity, necessity,
// verification-method appropriateness, architecture-coverage percentage."
//
// Only the warn tier existed (wording-lint.mjs). The other four are here.
//
// The §4 tier split is load-bearing and this module must not blur it: §4.1 BLOCKS, §4.2
// GATES, §4.3 REPORTS. The spec's own test for which tier a rule belongs to is that a
// blocking rule must be true of every legitimate case — and every check below fails that
// test. A requirement can legitimately contain "and"; a statement can legitimately be
// verified by inspection; an architecture item can legitimately address nothing yet.
// Nothing here returns an `ok`, because nothing here has a verdict to give.
//
// A second constraint the tests pin down: these must not be NOISY. An advisory people
// learn to ignore is worse than no advisory, because it also trains them to ignore the
// next one. Flagging every "and" would do exactly that.

const OBLIGATION = /\b(shall|must)\b/i;

/**
 * More than one requirement in one statement. Two signals, and both are deliberately
 * conservative — a conjunction alone is not evidence, because "first and last name" is one
 * requirement and flagging it is the noise that kills the check.
 */
export function checkSingularity(statement) {
  const s = String(statement ?? "");
  const obligations = (s.match(/\b(shall|must)\b/gi) ?? []).length;
  if (obligations > 1) {
    return [{ check: "singularity", why:
      `states more than one obligation (${obligations} of shall/must) — split it, `
      + "so each can be verified and can fail independently" }];
  }
  // A conjunction only counts when it joins two CLAUSES: the second half must carry its
  // own verb phrase. "shall record the first and last name" has none; "shall lock the
  // account and email the user" does.
  const CLAUSE_JOIN = /\b(and|as well as)\s+(also\s+)?(the\s+\w+\s+)?(shall|must|will|then\s+\w+s?\b|\w+s\s+the\b)/i;
  if (CLAUSE_JOIN.test(s)) {
    return [{ check: "singularity", why:
      "appears to state more than one requirement in one sentence — split it, so each can "
      + "be verified and can fail independently" }];
  }
  return [];
}

/**
 * Is there an obligation at all? A statement that only describes cannot be verified,
 * because there is nothing it could fail to do.
 */
export function checkNecessity(statement) {
  const s = String(statement ?? "").trim();
  if (!s) {
    return [{ check: "necessity", why: "is empty — there is no obligation to verify" }];
  }
  if (!OBLIGATION.test(s)) {
    return [{ check: "necessity", why:
      "states no obligation (no shall/must) — a description cannot be verified, because "
      + "there is nothing it could fail to do" }];
  }
  return [];
}

export const VERIFICATION_METHODS = ["inspection", "analysis", "demonstration", "test"];

// A number with a unit, or a percentile. This is what "quantitative" means for the purpose
// of picking a verification method.
const QUANTITATIVE =
  /\b\d+(\.\d+)?\s*(ms|s|sec|seconds?|minutes?|hours?|days?|%|percent|percentile|rps|qps|MB|GB|KB|bytes?)\b|\b\d+(st|nd|rd|th) percentile\b/i;

/**
 * Some (statement, method) pairs cannot work. Reading a document cannot establish that a
 * p95 latency is under 200 ms — the number has to be measured. Reported, not blocked: the
 * author may know something this check does not.
 */
export function checkVerificationMethod({ statement, method } = {}) {
  if (method == null || String(method).trim() === "") {
    return [{ check: "verification-method", why:
      "states no verification method — how this will be shown to hold is part of the "
      + "requirement, not a later decision" }];
  }
  const m = String(method).toLowerCase();
  if (!VERIFICATION_METHODS.includes(m)) {
    return [{ check: "verification-method", why:
      `${JSON.stringify(method)} is not a verification method — expected `
      + VERIFICATION_METHODS.join(", ") }];
  }
  if (QUANTITATIVE.test(String(statement ?? "")) && (m === "inspection" || m === "demonstration")) {
    return [{ check: "verification-method", why:
      `states a quantitative threshold but is verified by ${m} — a number has to be `
      + "measured (analysis or test), not read or shown once" }];
  }
  return [];
}

/**
 * The share of requirements carrying at least one INBOUND Addresses link.
 *
 * Numerator and denominator always travel with the percentage, because a bare percentage
 * cannot be checked: 50% of two and 50% of two thousand are very different facts and the
 * reader cannot tell them apart. A denominator of zero reports `percent: null` — "there
 * are no requirements" is not "0% of them are covered".
 */
export function architectureCoverage({ artifacts = [], links = [] } = {}) {
  const requirements = artifacts.filter((a) => a.kind === "requirement");
  // A SET, so two architecture items addressing one requirement count it once — otherwise
  // coverage can exceed 100% and the number is nonsense.
  const addressed = new Set();
  for (const l of links) {
    if (l.type_name !== "Addresses") continue;
    addressed.add(l.target_id);   // INBOUND: the requirement is the TARGET
  }
  const covered = requirements.filter((r) => addressed.has(r.id)).length;
  const total = requirements.length;
  return {
    check: "architecture-coverage",
    covered,
    total,
    percent: total === 0 ? null : Math.round((covered / total) * 1000) / 10,
    uncovered: requirements.filter((r) => !addressed.has(r.id)).map((r) => r.ref).sort(),
  };
}

/**
 * The per-statement checks, composed. Returns findings only — no `ok`, because §4.3 has no
 * verdict to give. Each finding names the check that produced it: a finding that does not
 * say which rule fired is one nobody can act on, the same reason §4.4's rules have names.
 */
export function adviseStatement({ statement, method } = {}) {
  return {
    findings: [
      ...checkNecessity(statement),
      ...checkSingularity(statement),
      ...checkVerificationMethod({ statement, method }),
    ],
  };
}
