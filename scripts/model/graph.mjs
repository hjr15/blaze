// scripts/model/graph.mjs — pure graph model for the Map view. Derives a
// node/edge graph from the derived index (buildGraph), assigns deterministic
// layered coordinates (layoutGraph), and wraps the FS read (graphModel). Zero
// dependency; no Date/random so the golden snapshot stays stable.
import { hierarchyLevel, isType } from "./schema.mjs";

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

// Deterministic layered layout: one column per distinct type level (highest
// level leftmost), nodes stacked within a column and grouped into project
// swimlanes (an extra gap on each project change). Coordinates are pure — no
// measurement, no Date, no random.
// Lanes are grouped by project explicitly, independent of the input node order.
export function layoutGraph(graph, opts = {}) {
  const NODE_W = opts.nodeW ?? 160;
  const NODE_H = opts.nodeH ?? 44;
  const COL_STRIDE = opts.colStride ?? 240; // x distance between columns
  const ROW_STRIDE = opts.rowStride ?? 60; // y distance between stacked nodes
  const LANE_GAP = opts.laneGap ?? 24; // extra y on a project change
  const PAD = opts.pad ?? 40;

  const nodes = graph.nodes ?? [];
  const levels = [...new Set(nodes.map((n) => n.level))].sort((a, b) => b - a);
  const colOf = new Map(levels.map((lv, i) => [lv, i]));

  const placed = [];
  const posById = new Map();
  let maxBottom = 0;
  for (const lv of levels) {
    const x = PAD + colOf.get(lv) * COL_STRIDE;
    const colNodes = nodes.filter((nn) => nn.level === lv);
    // Group nodes into project swimlanes explicitly (do not rely on the caller's
    // ordering): deterministic lane order via cmp, each lane keeps its node order.
    const byProject = new Map();
    for (const n of colNodes) {
      if (!byProject.has(n.project)) byProject.set(n.project, []);
      byProject.get(n.project).push(n);
    }
    let y = PAD;
    let firstLane = true;
    for (const proj of [...byProject.keys()].sort(cmp)) {
      if (!firstLane) y += LANE_GAP;
      firstLane = false;
      for (const n of byProject.get(proj)) {
        const node = { ...n, x, y, w: NODE_W, h: NODE_H };
        placed.push(node);
        posById.set(n.id, node);
        maxBottom = Math.max(maxBottom, y + NODE_H);
        y += ROW_STRIDE;
      }
    }
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

  const width = nodes.length ? PAD + (levels.length - 1) * COL_STRIDE + NODE_W + PAD : 2 * PAD;
  const height = nodes.length ? maxBottom + PAD : 2 * PAD;
  return { nodes: placed, edges, width, height };
}
