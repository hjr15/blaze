// scripts/model/graph.mjs — the Map view's model. BLZ-108 narrowed the map from
// a hierarchy graph to a DEPENDENCY neighbourhood: given a focused ticket, select
// its 1-hop link neighbours (what Blocks it → upstream, what it Blocks →
// downstream, what Relates → related), lay them out in role columns, and return
// positioned nodes + directed edges. Pure, zero-dep, no Date/random so the golden
// order stays stable. A link's blocker is its `src`, the blocked ticket its
// `target` (see model/index.mjs).
import { buildIndex } from "./index.mjs";

const BLOCKS = "Blocks";
const ROLE_RANK = { upstream: 0, downstream: 1, related: 2 };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function nodeFrom(row, role) {
  return {
    id: row.id, type: row.type ?? null, title: row.title ?? null,
    status: row.status ?? null, project: row.project ?? null,
    role, anchor: role === "anchor",
  };
}

// Pure selection: the 1-hop dependency neighbourhood of focusId over an
// index-shaped object ({ links, get }). Roles by precedence upstream >
// downstream > related, so a node appears once even in a Blocks cycle.
export function neighbourhood(index, focusId) {
  const anchorRow = focusId ? (index.get(focusId) ?? null) : null;
  if (!anchorRow) return { anchor: null, nodes: [], edges: [], unresolved: [] };

  const links = index.links ?? [];
  const roleById = new Map();  // id -> role (best/first wins)
  const rows = new Map();      // id -> resolved row
  const edges = [];
  const unresolved = [];
  const assign = (id, role) => {
    if (!roleById.has(id) || ROLE_RANK[role] < ROLE_RANK[roleById.get(id)]) roleById.set(id, role);
  };

  for (const l of links) {
    if (l.src !== focusId && l.target !== focusId) continue;
    if (l.src === l.target) continue; // a self-link is meaningless and would duplicate the anchor
    const otherId = l.src === focusId ? l.target : l.src;
    const otherRow = otherId != null ? index.get(otherId) : undefined;
    if (!otherRow) { unresolved.push({ type: l.type ?? null, target: otherId ?? null }); continue; }
    rows.set(otherId, otherRow);
    if (l.type === BLOCKS) {
      const downstream = l.src === focusId; // focus blocks other
      assign(otherId, downstream ? "downstream" : "upstream");
      edges.push(downstream
        ? { src: focusId, target: otherId, type: BLOCKS, directed: true }
        : { src: otherId, target: focusId, type: BLOCKS, directed: true });
    } else {
      assign(otherId, "related");
      edges.push({ src: focusId, target: otherId, type: l.type ?? null, directed: false });
    }
  }

  const nodes = [nodeFrom(anchorRow, "anchor")];
  for (const [id, role] of [...roleById.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    nodes.push(nodeFrom(rows.get(id), role));
  }
  return { anchor: nodeFrom(anchorRow, "anchor"), nodes, edges, unresolved };
}

// The point on box's border along the ray from (fromX,fromY) toward box centre —
// so an edge stops at the node boundary and its arrowhead is visible, not buried
// under the target box.
function clipToBox(fromX, fromY, box) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = cx - fromX, dy = cy - fromY;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? (box.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (box.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx - dx * s, y: cy - dy * s };
}

// Deterministic role-column layout: upstream (what blocks the anchor) left,
// anchor centre, downstream (what the anchor blocks) right; related in a neutral
// band below the anchor. Columns are vertically centred on a common midline.
export function layoutNeighbourhood(nb, opts = {}) {
  const NODE_W = opts.nodeW ?? 160;
  const NODE_H = opts.nodeH ?? 44;
  const COL_STRIDE = opts.colStride ?? 240; // x between adjacent columns
  const ROW_STRIDE = opts.rowStride ?? 64;  // y between stacked nodes
  const BAND_GAP = opts.bandGap ?? 48;      // y gap before the related band
  const PAD = opts.pad ?? 40;

  const nodes = nb.nodes ?? [];
  const anchor = nb.anchor ?? null;
  const unresolved = nb.unresolved ?? [];
  if (!nodes.length) return { nodes: [], edges: [], width: 2 * PAD, height: 2 * PAD, unresolved, anchor };

  const byRole = { upstream: [], anchor: [], downstream: [], related: [] };
  for (const n of nodes) byRole[n.role].push(n);

  const colX = { upstream: PAD, anchor: PAD + COL_STRIDE, downstream: PAD + 2 * COL_STRIDE };
  const colLen = Math.max(byRole.upstream.length, byRole.downstream.length, 1);
  const centerY = PAD + ((colLen - 1) * ROW_STRIDE) / 2;

  const placed = [];
  const posById = new Map();
  const placeColumn = (list, x) => {
    const top = centerY - ((list.length - 1) * ROW_STRIDE) / 2;
    list.forEach((n, i) => {
      const node = { ...n, x, y: top + i * ROW_STRIDE, w: NODE_W, h: NODE_H };
      placed.push(node); posById.set(n.id, node);
    });
  };
  placeColumn(byRole.upstream, colX.upstream);
  placeColumn(byRole.anchor, colX.anchor);
  placeColumn(byRole.downstream, colX.downstream);

  const colBottom = PAD + (colLen - 1) * ROW_STRIDE + NODE_H;
  byRole.related.forEach((n, i) => {
    const node = { ...n, x: colX.anchor, y: colBottom + BAND_GAP + i * ROW_STRIDE, w: NODE_W, h: NODE_H };
    placed.push(node); posById.set(n.id, node);
  });

  const edges = (nb.edges ?? []).map((e) => {
    const s = posById.get(e.src), t = posById.get(e.target);
    if (!s || !t) return null;
    const cs = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
    const ct = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    const p1 = clipToBox(ct.x, ct.y, s);
    const p2 = clipToBox(cs.x, cs.y, t);
    return { ...e, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }).filter(Boolean);

  let maxRight = 0, maxBottom = 0;
  for (const n of placed) { maxRight = Math.max(maxRight, n.x + n.w); maxBottom = Math.max(maxBottom, n.y + n.h); }
  return { nodes: placed, edges, width: maxRight + PAD, height: maxBottom + PAD, unresolved, anchor };
}

// FS wrapper: read the index (or use the passed one) and lay out the focused
// ticket's dependency neighbourhood. `index` must be a full Index ({ links, get })
// — page.mjs passes the board's own m.index. No focus → empty-shaped result;
// the view renders a "pick a ticket" prompt.
export function graphModel({ projectsDir, index = null, focus = null } = {}) {
  const idx = index ?? buildIndex(projectsDir);
  return layoutNeighbourhood(neighbourhood(idx, focus));
}
