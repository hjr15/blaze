// scripts/model/focus.mjs — pure hierarchy scoping over the derived index.
export function focusScope(index, id) {
  if (!id || !index || !index.get(id)) return { crumbs: [], descendantIds: new Set(), childrenIds: new Set() };

  const crumbs = [];
  const guard = new Set();
  let cur = id;
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const row = index.get(cur);
    if (!row) break;
    crumbs.unshift({ id: cur, title: row.title ?? null });
    cur = row.parent;
  }

  const childrenOf = new Map();
  for (const r of index.rows) {
    if (!r.parent) continue;
    if (!childrenOf.has(r.parent)) childrenOf.set(r.parent, []);
    childrenOf.get(r.parent).push(r.id);
  }
  const descendantIds = new Set();
  const stack = [id];
  while (stack.length) {
    for (const c of childrenOf.get(stack.pop()) || []) {
      if (!descendantIds.has(c)) { descendantIds.add(c); stack.push(c); }
    }
  }
  descendantIds.delete(id);
  const childrenIds = new Set(childrenOf.get(id) || []);
  return { crumbs, descendantIds, childrenIds };
}

// The ONE shared drill-scope rule (BLZ-89): a valid focus scopes to that row's
// DIRECT children (BLZ-87 — not transitive descendants); no focus scopes to
// parentless rows; flat=1 is the whole-corpus escape hatch. Focus wins over
// flat. boardModel consumes this for board/list/metrics; graphModel does NOT
// (BLZ-108 moved the map to a dependency neighbourhood over links, not this
// hierarchy scope).
export function scopedRows(index, { focus = null, flat = false } = {}) {
  const focused = focus ? (index.get(focus) ?? null) : null;
  if (focused) {
    const { crumbs, childrenIds } = focusScope(index, focus);
    return { focused, crumbs, rows: index.rows.filter((r) => childrenIds.has(r.id)) };
  }
  return { focused: null, crumbs: [], rows: flat ? index.rows : index.rows.filter((r) => !r.parent) };
}
