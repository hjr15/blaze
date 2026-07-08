// scripts/model/focus.mjs — pure hierarchy scoping over the derived index.
export function focusScope(index, id) {
  if (!id || !index || !index.get(id)) return { crumbs: [], descendantIds: new Set() };

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
  return { crumbs, descendantIds };
}
