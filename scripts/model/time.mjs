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

/**
 * The estimate a DATABASE MIRROR may store: an integer multiple of 5, or null.
 *
 * Deliberately NOT `roundEstimate`. That is `blaze new`'s INPUT policy and it invents —
 * `roundEstimate(1)` is 5 — which is a category error in a path whose whole job is to reflect
 * what the filesystem already says. It is also not `Number(v)` unrounded: `estimate_minutes` is
 * INTEGER and CHECKs `% 5 = 0`, and SQLite's `%` casts to integer, so a hand-edited `10.5` used
 * to pass that CHECK and land as a REAL in an INTEGER column until STRICT (BLZ-390) refused it.
 *
 * So: mirror what is storable, null what is not, and let the zero-diff oracle report the gap —
 * which it does, as a `valueDiffs` entry naming the ticket. Both writers call THIS, because
 * they disagreed three ways about `estimate: 7` (filesystem 7, loadCorpus null, write-port 5).
 */
export function storableEstimate(v) {
  const n = Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Number.isInteger(n) && n % 5 === 0 ? n : null;
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
