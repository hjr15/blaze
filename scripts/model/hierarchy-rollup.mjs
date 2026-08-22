// scripts/model/hierarchy-rollup.mjs — PURE, duplicate-safe subtree rollup.
//
// A whole-tree pass in JS beat a recursive CTE by 6.0x on 100k items in the
// ADR-0016 benchmark (762.7ms vs 4,585.9ms), so this being pure JS is the fast path,
// not a compromise.
//
// Duplicates are excluded BY DEFAULT. Structure needs a toggle for this, which means
// its default double-counts. A number you have to configure to be correct is not a
// number you can trust.
export function rollup({ memberships = [], values = {}, hierarchyId, rootId }) {
  const children = new Map();
  for (const r of memberships) {
    if (r.hierarchy_id !== hierarchyId) continue;
    if (!children.has(r.parent_id)) children.set(r.parent_id, []);
    children.get(r.parent_id).push(r.item_id);
  }
  const seen = new Set();          // both the dedup and the cycle guard
  const stack = [rootId];
  let total = 0;
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    total += Number(values[id] ?? 0);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return total;
}
