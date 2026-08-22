// scripts/model/staleness.mjs — "N linked artifacts have not been re-reviewed since
// this changed", computed from revisions.
//
// We store NO suspicion flag. IBM removed suspicion profiles at DOORS Next 7.0.0 and
// replaced them with something their own docs say is "not a date-based check for
// changes". Polarion's is a boolean their docs concede is "implemented on the UI level
// only... do not work for server-side use cases like imports or API calls".
//
// A derived value cannot go stale, cannot be cleared by accident, and is visible to
// the API by construction.
/**
 * BLZ-335 (C6). These timestamps arrive in TWO shapes: an ISO string from SQLite (TEXT) and
 * a `Date` from node-pg (timestamptz). The original comparison used String(), and
 * String(date) is weekday-first — so "Thu Jan 08 2026" sorts BEFORE "Wed Jan 07 2026" and a
 * link reviewed a day LATER than the change was reported stale. Postgres-only, in both
 * directions: the mirror case missed a genuinely stale link because the later revision lost
 * max() to the earlier one.
 *
 * Comparing instants removes the shape from the comparison entirely. An unparseable value
 * returns null and is treated as "no information", never as an instant at epoch 0 — which
 * would silently make everything stale.
 */
function instant(v) {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

export function staleLinks({ links = [], revisions = [] }) {
  const latest = new Map();
  for (const r of revisions) {
    const at = instant(r.at);
    if (at == null) continue;
    const cur = latest.get(r.artifact_id);
    if (cur == null || at > cur.at) latest.set(r.artifact_id, { at, raw: r.at });
  }
  const out = [];
  for (const l of links) {
    const changed = latest.get(l.source_id);
    if (!changed) continue;
    const reviewed = instant(l.reviewed_at);
    if (reviewed == null || reviewed < changed.at) {
      out.push({ linkId: l.id, targetRef: l.target_id, changedAt: changed.raw });
    }
  }
  return out;
}
