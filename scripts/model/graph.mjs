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
