// map-view.mjs — the Blaze Map view.
//
// Dual-runtime: this file is imported by node (serve.mjs + tests) for its pure
// functions and constants, AND served verbatim to the browser at
// /assets/map-view.js where initMap() runs. CONSTRAINT: no node-only API and no
// DOM access at module top level — DOM code lives only inside function bodies.

// Layout geometry (pixels). Shared by layoutTree (pure) and the DOM renderer.
export const NODE_W = 200;
export const NODE_H = 64;
export const H_GAP = 72;
export const ROW_H = 84;
export const PAD = 24;

const ACTIVE = new Set(["todo", "in-progress"]);

// ---- pure: filtering ----------------------------------------------------

export function ticketMatches(t, { window, status, now }) {
  let windowOk = true;
  if (window != null) {
    const ms = Date.parse(t.updated);
    if (Number.isNaN(ms)) windowOk = false;
    else windowOk = (now - ms) / 86400000 <= window;
  }
  let statusOk = true;
  if (status === "active") statusOk = ACTIVE.has(t.status);
  else if (status === "inactive") statusOk = !ACTIVE.has(t.status);
  return windowOk && statusOk;
}

// ---- pure: forest construction -----------------------------------------

export function buildForest(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const childrenOf = new Map();
  const roots = [];
  for (const t of tickets) {
    const p = t.parent;
    if (p && p !== t.id && byId.has(p)) {
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(t);
    } else {
      roots.push(t);
    }
  }
  const epicIds = new Set(
    [...childrenOf.keys()].filter((id) => childrenOf.get(id).length > 0),
  );
  return { byId, childrenOf, roots, epicIds };
}

// ---- pure: tidy horizontal tree layout ---------------------------------

export function layoutTree(forest) {
  const { childrenOf, roots, byId } = forest;
  const nodes = [];
  const edges = [];
  const placed = new Set();
  let cursor = 0; // next free row slot
  let maxDepth = 0;

  function place(ticket, depth, standalone) {
    if (placed.has(ticket.id)) return null;
    placed.add(ticket.id);
    maxDepth = Math.max(maxDepth, depth);
    const kids = (childrenOf.get(ticket.id) || []).filter((k) => !placed.has(k.id));
    let y;
    if (kids.length === 0) {
      y = PAD + cursor * ROW_H;
      cursor += 1;
    } else {
      const childNodes = [];
      for (const k of kids) {
        const cn = place(k, depth + 1, false);
        if (cn) {
          childNodes.push(cn);
          edges.push({ from: ticket.id, to: k.id });
        }
      }
      if (childNodes.length) {
        y = (childNodes[0].y + childNodes[childNodes.length - 1].y) / 2;
      } else {
        y = PAD + cursor * ROW_H;
        cursor += 1;
      }
    }
    const node = {
      ticket,
      x: PAD + depth * (NODE_W + H_GAP),
      y,
      depth,
      standalone,
      contextOnly: false,
    };
    nodes.push(node);
    return node;
  }

  const hasKids = (r) => (childrenOf.get(r.id) || []).length > 0;
  const epics = roots.filter(hasKids);
  const orphans = roots.filter((r) => !hasKids(r));

  for (const r of epics) {
    place(r, 0, false);
    cursor += 1; // gap row between trees
  }

  let standaloneY = null;
  if (orphans.length) {
    if (epics.length > 0) {
      cursor += 1; // gap row after the epic trees
      standaloneY = PAD + cursor * ROW_H; // the "Standalone" divider row
      cursor += 1; // orphans sit below the divider
    }
    for (const r of orphans) place(r, 0, true);
  }

  // Completeness: anything left unplaced (a pure cycle) becomes its own root.
  for (const t of byId.values()) {
    if (!placed.has(t.id)) {
      place(t, 0, false);
    }
  }

  const width = PAD * 2 + (maxDepth + 1) * (NODE_W + H_GAP) - H_GAP;
  const height = PAD + cursor * ROW_H;
  return { nodes, edges, width, height, standaloneY };
}

// ---- pure: visibility (keep epic as context) ---------------------------

export function computeVisible(tickets, matchedIds) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const visibleIds = new Set();
  const contextOnlyIds = new Set();
  for (const id of matchedIds) {
    visibleIds.add(id);
    let cur = byId.get(id);
    const guard = new Set([id]);
    while (cur && cur.parent && byId.has(cur.parent) && !guard.has(cur.parent)) {
      const pid = cur.parent;
      guard.add(pid);
      visibleIds.add(pid);
      if (!matchedIds.has(pid)) contextOnlyIds.add(pid);
      cur = byId.get(pid);
    }
  }
  return { visibleIds, contextOnlyIds };
}
