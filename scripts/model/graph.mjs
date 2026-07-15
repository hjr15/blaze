// scripts/model/graph.mjs — pure graph model for the Map view. Derives a
// node/edge graph from the derived index (buildGraph), assigns deterministic
// layered coordinates (layoutGraph), and wraps the FS read (graphModel). Zero
// dependency; no Date/random so the golden snapshot stays stable.
import { hierarchyLevel, isType } from "./schema.mjs";
import { buildIndex } from "./index.mjs";
import { scopedRows } from "./focus.mjs";

const FALLBACK_LEVEL = -2; // unknown/null types sink below subtask (-1)

// Locale-independent string compare — the byte-level golden depends on a stable
// order, so avoid String.prototype.localeCompare (host-locale dependent).
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safeLevel(type) {
  return type && isType(type) ? hierarchyLevel(type) : FALLBACK_LEVEL;
}

// Derive { nodes, edges } from an index-shaped object { rows, links }.
// Parent edges (child→parent, solid) and link edges (dashed, labelled) whose
// endpoints are not both present in the node set are dropped.
export function buildGraph(index) {
  const rows = index.rows ?? [];
  const links = index.links ?? [];
  const nodes = rows.map((r) => ({
    id: r.id, type: r.type ?? null, title: r.title ?? null,
    status: r.status ?? null, project: r.project ?? null, level: safeLevel(r.type),
    childCount: r.childCount ?? 0, stub: r.stub === true, anchor: r.anchor === true,
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = [];
  for (const r of rows) {
    if (r.parent && ids.has(r.parent) && ids.has(r.id)) {
      edges.push({ src: r.id, target: r.parent, kind: "parent" });
    }
  }
  for (const l of links) {
    if (ids.has(l.src) && ids.has(l.target)) {
      edges.push({ src: l.src, target: l.target, kind: "link", label: l.type });
    }
  }
  nodes.sort((a, b) =>
    b.level - a.level ||
    cmp(String(a.project), String(b.project)) ||
    cmp(String(a.id), String(b.id)));
  edges.sort((a, b) =>
    cmp(a.kind, b.kind) ||
    cmp(String(a.src), String(b.src)) ||
    cmp(String(a.target), String(b.target)));
  return { nodes, edges };
}

// Deterministic layered layout: one column-block per distinct type level
// (highest level leftmost), nodes stacked within it and grouped into project
// swimlanes (an extra gap on each project change). BLZ-36: a block wraps into
// sub-columns every WRAP_ROWS nodes so a level stays legible without zooming —
// pure arithmetic, no measurement, no Date, no random.
export function layoutGraph(graph, opts = {}) {
  const NODE_W = opts.nodeW ?? 160;
  const NODE_H = opts.nodeH ?? 44;
  const COL_STRIDE = opts.colStride ?? 240; // x from a level's LAST sub-column to the next level
  const ROW_STRIDE = opts.rowStride ?? 60; // y distance between stacked nodes
  const LANE_GAP = opts.laneGap ?? 24; // extra y on a project change
  const PAD = opts.pad ?? 40;
  const WRAP_ROWS = opts.wrapRows ?? 12; // BLZ-36: rows per sub-column before wrapping
  const SUB_STRIDE = opts.subStride ?? 180; // x between sub-columns inside one level

  const nodes = graph.nodes ?? [];
  const levels = [...new Set(nodes.map((n) => n.level))].sort((a, b) => b - a);

  const placed = [];
  const posById = new Map();
  let maxBottom = 0;
  let maxRight = PAD;
  let levelX = PAD; // x of the current level's first sub-column
  for (const lv of levels) {
    const colNodes = nodes.filter((nn) => nn.level === lv);
    // Group nodes into project swimlanes explicitly (do not rely on the caller's
    // ordering): deterministic lane order via cmp, each lane keeps its node order.
    const byProject = new Map();
    for (const n of colNodes) {
      if (!byProject.has(n.project)) byProject.set(n.project, []);
      byProject.get(n.project).push(n);
    }
    let y = PAD;
    let rowsInSub = 0;
    let subCol = 0;
    let firstLane = true;
    for (const proj of [...byProject.keys()].sort(cmp)) {
      if (!firstLane && rowsInSub > 0) y += LANE_GAP;
      firstLane = false;
      for (const n of byProject.get(proj)) {
        if (rowsInSub >= WRAP_ROWS) { subCol += 1; y = PAD; rowsInSub = 0; } // wrap
        const x = levelX + subCol * SUB_STRIDE;
        const node = { ...n, x, y, w: NODE_W, h: NODE_H };
        placed.push(node);
        posById.set(n.id, node);
        maxBottom = Math.max(maxBottom, y + NODE_H);
        maxRight = Math.max(maxRight, x + NODE_W);
        y += ROW_STRIDE;
        rowsInSub += 1;
      }
    }
    levelX += subCol * SUB_STRIDE + COL_STRIDE;
  }

  const edges = (graph.edges ?? []).map((e) => {
    const s = posById.get(e.src), t = posById.get(e.target);
    if (!s || !t) return null;
    return {
      ...e,
      x1: s.x + s.w / 2, y1: s.y + s.h / 2,
      x2: t.x + t.w / 2, y2: t.y + t.h / 2,
    };
  }).filter(Boolean);

  const width = nodes.length ? maxRight + PAD : 2 * PAD;
  const height = nodes.length ? maxBottom + PAD : 2 * PAD;
  return { nodes: placed, edges, width, height };
}

// FS wrapper: read every ticket, optionally restrict to one project, apply the
// shared drill scope (BLZ-89: focus → anchor + DIRECT children; no focus →
// parentless; flat=1 → whole corpus), pull cross-scope link endpoints in as
// muted stubs, and return the laid-out graph. `index` must be a full Index
// ({rows, links, get}) — page.mjs passes the board's own m.index.
export function graphModel({ projectsDir, project = "all", index = null, focus = null, flat = false } = {}) {
  const idx = index ?? buildIndex(projectsDir);
  const { focused, rows: inScope } = scopedRows(idx, { focus, flat });
  let rows = project === "all" ? inScope : inScope.filter((r) => r.project === project);
  // The focused node renders as the anchor: the board shows it in the crumbs,
  // but a map of children with no parent node would have no hierarchy edges.
  if (focused) rows = [{ ...focused, anchor: true }, ...rows.filter((r) => r.id !== focused.id)];
  // Cross-scope link edges: an in-scope endpoint pulls its outside partner in
  // as a stub node rather than silently dropping the dependency (operator
  // decision, 2026-07-15). Ids absent from the index still drop (status quo).
  const ids = new Set(rows.map((r) => r.id));
  const stubs = new Map();
  for (const l of idx.links ?? []) {
    const srcIn = ids.has(l.src), tgtIn = ids.has(l.target);
    if (srcIn === tgtIn) continue; // both in scope (normal edge) or both out (irrelevant)
    const missingId = srcIn ? l.target : l.src;
    const row = idx.get(missingId);
    if (row && !stubs.has(missingId)) stubs.set(missingId, { ...row, stub: true });
  }
  // Drill-affordance data: children per node tallied from the FULL index
  // (mirrors boardModel's childTally), so an in-scope epic can show "⤵ N".
  const childTally = {};
  for (const r of idx.rows) if (r.parent) childTally[r.parent] = (childTally[r.parent] || 0) + 1;
  const decorated = [...rows, ...stubs.values()].map((r) => ({ ...r, childCount: childTally[r.id] || 0 }));
  return layoutGraph(buildGraph({ rows: decorated, links: idx.links }));
}
