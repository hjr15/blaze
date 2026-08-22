// scripts/model/matrix.mjs — the traceability matrix as a query.
//
// Derived, never hand-edited. The tickets are the source of truth; the matrix is a
// view of them. build_matrices.py already works this way on the v3 board; this makes
// it native.
export function buildMatrix({ rows = [], cols = [], links = [], linkTypes = [] }) {
  const inverseOf = new Map(linkTypes.map((t) => [t.name, t.inverse_name ?? null]));
  const colIds = new Set(cols.map((c) => c.id));
  const cells = {};
  const traced = new Set();

  for (const l of links) {
    if (!colIds.has(l.source_id)) continue;
    if (!cells[l.target_id]) cells[l.target_id] = {};
    cells[l.target_id][l.source_id] = {
      type: l.type_name,
      inverse: inverseOf.get(l.type_name) ?? null,
    };
    traced.add(l.target_id);
  }

  return {
    rows, cols, cells,
    untraced: rows.filter((r) => !traced.has(r.id)).map((r) => r.ref),
  };
}
