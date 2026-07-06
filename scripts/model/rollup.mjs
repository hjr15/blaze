// scripts/model/rollup.mjs — derived time roll-up over the index. Pure; reads
// only index.rows. buildIndex stays leaf-only (the storage-agnostic seam); the
// roll-up is computed on top. (Spec §2/§3.)
//
//   rolled(node) = node.own + Σ rolled(child)   over the transitive subtree
//
// own_* is kept separate from rolled_*. Cycle-guarded (a per-traversal visited
// set), orphan-parent rows are roots, null estimate contributes 0.

export function rollUp(index) {
  const rows = index.rows || [];
  const own = new Map();        // id → { est, log }
  const children = new Map();   // parentId → id[]
  for (const r of rows) {
    own.set(r.id, { est: Number(r.estimate) || 0, log: Number(r.worklog_minutes) || 0 });
  }
  for (const r of rows) {
    // Only treat parent as an edge when it resolves to a known row; otherwise
    // the row is a root (orphan parent).
    if (r.parent && own.has(r.parent)) {
      if (!children.has(r.parent)) children.set(r.parent, []);
      children.get(r.parent).push(r.id);
    }
  }

  // Subtree sum from `start`, guarded so a malformed cycle terminates and no node
  // is counted twice within one traversal.
  function subtree(start) {
    let est = 0, log = 0, count = -1; // -1 so `start` itself isn't a descendant
    const visited = new Set();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const o = own.get(id);
      if (o) { est += o.est; log += o.log; }
      count++;
      for (const c of children.get(id) || []) if (!visited.has(c)) stack.push(c);
    }
    return { est, log, count };
  }

  const result = new Map();
  for (const r of rows) {
    const o = own.get(r.id);
    const s = subtree(r.id);
    result.set(r.id, {
      own_estimate: o.est, own_worklog: o.log,
      rolled_estimate: s.est, rolled_worklog: s.log,
      descendant_count: s.count,
    });
  }
  return result;
}
