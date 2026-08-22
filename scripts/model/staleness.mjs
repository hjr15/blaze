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
export function staleLinks({ links = [], revisions = [] }) {
  const latest = new Map();
  for (const r of revisions) {
    const cur = latest.get(r.artifact_id);
    if (!cur || String(r.at) > String(cur)) latest.set(r.artifact_id, String(r.at));
  }
  const out = [];
  for (const l of links) {
    const changed = latest.get(l.source_id);
    if (!changed) continue;
    if (l.reviewed_at == null || String(l.reviewed_at) < changed) {
      out.push({ linkId: l.id, targetRef: l.target_id, changedAt: changed });
    }
  }
  return out;
}
