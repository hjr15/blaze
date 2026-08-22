// scripts/model/artifact-health.mjs — spec §5's per-artifact indicators (BLZ-330).
//
// "Alongside it, per artifact: orphan / missing-downstream / stale-since-change, all
// computed." Only part of that existed. `buildMatrix` returned `untraced`, but only for
// artifacts placed on a matrix axis; missing-downstream did not exist at all; and
// `staleness.mjs` computed staleLinks with NO CONSUMER — the final review recorded it as a
// module nothing imported. Per §4.5 a computation unreachable through the API is a rule
// that does not exist, which is the same failure §4.4 had.
//
// DIRECTION, stated once because getting it backwards inverts every indicator here:
// a link runs source -> target where the SOURCE realises the TARGET (`architecture
// Addresses requirement`, `feature Implements requirement`). So an artifact's DOWNSTREAM
// realisation arrives as an INBOUND link — the same direction `every-requirement-addressed`
// uses (`direction: inbound`) and the same thing `buildMatrix.untraced` measures.
//
// This is a REPORT, never a verdict. Untraced work is legal and counted (§5): inventing a
// requirement to close a gap makes the matrix a lie, so nothing here refuses anything.
import { staleLinks } from "./staleness.mjs";

/**
 * @param artifacts  candidate artifacts; scoped to `project_key` here so no call site
 *   can forget, consistent with §4.4's project-scoped coverage rules.
 * @param links      DENORMALISED link rows ({ type_name, source_id, target_id,
 *   reviewed_at }) — artifact-api.mjs's `links()` join, not raw link_type_id rows.
 * @param revisions  artifact_revision rows; staleness compares against these rather than
 *   any stored suspicion flag (staleness.mjs's header explains why at length).
 */
export function artifactHealth({ project_key, artifacts = [], links = [], revisions = [] }) {
  const scoped = artifacts.filter(
    (a) => project_key == null || a.project_key == null || a.project_key === project_key);
  const ids = new Set(scoped.map((a) => a.id));

  const inbound = new Map();
  const outbound = new Map();
  for (const l of links) {
    if (ids.has(l.target_id)) inbound.set(l.target_id, (inbound.get(l.target_id) ?? 0) + 1);
    if (ids.has(l.source_id)) outbound.set(l.source_id, (outbound.get(l.source_id) ?? 0) + 1);
  }

  // staleLinks reports links whose SOURCE changed after the link was last reviewed, so
  // each stale entry is attributed to the artifact that CHANGED. Keying it by target
  // instead makes the wrong artifact look suspect and sends the person to re-review the
  // wrong thing.
  const stale = new Map();
  const byLinkId = new Map(links.map((l) => [l.id, l]));
  for (const s of staleLinks({ links, revisions })) {
    const source = byLinkId.get(s.linkId)?.source_id;
    if (source == null || !ids.has(source)) continue;
    if (!stale.has(source)) stale.set(source, []);
    stale.get(source).push(s);
  }

  const rows = scoped.map((a) => {
    const inCount = inbound.get(a.id) ?? 0;
    const outCount = outbound.get(a.id) ?? 0;
    return {
      id: a.id, ref: a.ref, kind: a.kind,
      inbound: inCount,
      outbound: outCount,
      // Disconnected entirely.
      orphan: inCount === 0 && outCount === 0,
      // Nothing realises it. An orphan is ALSO missing downstream — the indicators nest
      // rather than exclude, because "nothing knows about this" is a strictly worse case
      // of "nothing realises this", and reporting only the narrower one hides it.
      missingDownstream: inCount === 0,
      staleSinceChange: stale.get(a.id) ?? [],
    };
  });

  const refsWhere = (pred) => rows.filter(pred).map((r) => r.ref)
    .sort((x, y) => String(x).localeCompare(String(y)));

  return {
    project_key,
    artifacts: rows,
    // The counting half of "untraced work is legal AND COUNTED". Every affected artifact
    // is named — a count alone, or a truncated sample, is something nobody can act on
    // (the same rule §4.2 states for gate refusals).
    summary: {
      counted: rows.length,
      orphans: refsWhere((r) => r.orphan),
      missingDownstream: refsWhere((r) => r.missingDownstream),
      stale: refsWhere((r) => r.staleSinceChange.length > 0),
    },
  };
}
