// scripts/model/time.mjs — the single home for Blaze time policy: estimate
// rounding (5m), worklog rounding (1m, positive-only), and human formatting.
// Pure, zero-dependency. Consumed by new.mjs (estimate at create), log.mjs
// (worklog), and the rollup/board display.

// Estimate: round to the nearest 5 minutes. null/absent/non-finite/≤0 → null.
// A positive value that would round to 0 is bumped to 5 — a positive estimate
// never silently becomes "no estimate". (Spec §4.1.)
export function roundEstimate(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return null;
  const r = Math.round(n / 5) * 5;
  return r === 0 ? 5 : r;
}

// Worklog: round to the nearest whole minute. Positive-only — throws on ≤0 or
// non-finite (the positive-minutes guard for `blaze log`). (Spec §4.1.)
export function roundWorklog(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`worklog minutes must be a positive number, got: ${min}`);
  }
  return Math.round(n);
}

// Human display: "1h 30m" / "45m" / "2h". null/undefined → "" (board renders
// blank); 0 → "0m".
export function formatMinutes(min) {
  if (min === null || min === undefined) return "";
  const n = Number(min);
  if (!Number.isFinite(n)) return "";
  if (n === 0) return "0m";
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
