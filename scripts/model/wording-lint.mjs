// scripts/model/wording-lint.mjs — ISO/IEC/IEEE 29148 §5.2.7, enforced in two tiers
// (ADR-0017).
//
// Fires at creation, which is the ~93% moment. engineering-method.md measured that
// obligations met at creation land ~93% while return-visit obligations land 15% and 0%.
//
// TWO TIERS, and the split is load-bearing: "the system shall never store plaintext
// passwords" is a genuine, testable, correct requirement. A flat list that blocked
// "never" would refuse it, so "never" can only warn.
export const BLOCK_TIER = [
  { phrase: "user friendly",  why: "unmeasurable — state the task and the time budget" },
  { phrase: "user-friendly",  why: "unmeasurable — state the task and the time budget" },
  { phrase: "easy to use",    why: "unmeasurable — state the task and the time budget" },
  { phrase: "intuitive",      why: "unmeasurable" },
  { phrase: "fast",           why: "superlative without a number — give a latency budget" },
  { phrase: "quick",          why: "superlative without a number — give a latency budget" },
  { phrase: "as appropriate", why: "permits any behaviour, so nothing can fail" },
  { phrase: "as required",    why: "permits any behaviour, so nothing can fail" },
  { phrase: "if possible",    why: "doing nothing satisfies it" },
  { phrase: "where possible", why: "doing nothing satisfies it" },
  { phrase: "including but not limited to", why: "open-ended list — nothing is testable" },
  { phrase: "etc",            why: "open-ended list — name the members" },
  { phrase: "and/or",         why: "two different systems both satisfy it — pick one" },
  { phrase: "provide support for", why: "partial support passes — state the behaviour" },
  { phrase: "sufficient",     why: "unmeasurable" },
  { phrase: "adequate",       why: "unmeasurable" },
  { phrase: "reasonable",     why: "unmeasurable" },
  { phrase: "robust",         why: "unmeasurable" },
  { phrase: "seamless",       why: "unmeasurable" },
  { phrase: "state of the art", why: "unmeasurable and time-dependent" },
];

export const WARN_TIER = [
  { phrase: "all",    why: "often unverifiable — can every case actually be tested?" },
  { phrase: "always", why: "often unverifiable" },
  { phrase: "never",  why: "often unverifiable — though sometimes exactly right" },
  { phrase: "every",  why: "often unverifiable" },
  { phrase: "should", why: "29148 reserves 'shall' for requirements; 'should' is a goal" },
];

const rx = (p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

export function lintStatement(text, { blockList = BLOCK_TIER, warnList = WARN_TIER } = {}) {
  const s = String(text ?? "");
  return {
    blocked:  blockList.filter((e) => rx(e.phrase).test(s)).map((e) => ({ ...e })),
    warnings: warnList.filter((e) => rx(e.phrase).test(s)).map((e) => ({ ...e })),
  };
}
