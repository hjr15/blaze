# Mind Map View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third Blaze board view — **Map** — a horizontal tidy tree of epic→sub-task relationships with independent time and status filters.

**Architecture:** All map logic lives in a new dual-runtime module `scripts/map-view.mjs` — pure functions (tested under `node --test`) plus browser-only DOM render code (no DOM at module top level). It is served verbatim to the browser at `/assets/map-view.js`. `serve.mjs` bakes the view into the shared `pageHtml()` (so both the standalone board and the supervisor app get it), embeds the ticket data as JSON, and exports a `tryServeAsset` helper both servers call.

**Tech Stack:** Node ≥16 built-ins only. Zero dependencies. ES modules. `node --test` + `node:assert/strict`. Browser: vanilla ES module, hand-rolled SVG + HTML.

## Global Constraints

- **Zero dependencies** — no npm packages, no graph/layout libraries. Node built-ins and browser built-ins only.
- **`scripts/map-view.mjs` must import cleanly in node** — no node-only API and no DOM access (`document`, `window`) at module top level; DOM code lives only inside function bodies.
- **Spec:** `docs/specs/2026-06-28-mind-map-view-design.md` — the authority for all behavior.
- **Active = `in-progress` or `todo`; Inactive = every other column** (`backlog`, `in-review`, `done`, `canceled`, `duplicate`).
- **Time window is by the `updated` frontmatter date**, inclusive of the boundary (exactly N days old still matches).
- Tests are `tests/<name>.test.mjs`, run with `npm test` (`node --test`). Follow the existing style in `tests/config.test.mjs`.
- Run from the repo root `/home/jordan/blaze`.

---

### Task 1: Forest construction (`buildForest`)

**Files:**
- Create: `scripts/map-view.mjs`
- Test: `tests/map-view.test.mjs`

**Interfaces:**
- Produces: `buildForest(tickets) -> { byId: Map<id,ticket>, childrenOf: Map<parentId,ticket[]>, roots: ticket[], epicIds: Set<id> }`. A ticket is `{ id, title, type, priority, labels, project, assignee, estimate, parent, status, pr, created, updated, bodyHtml }`; this function only reads `id` and `parent`. `roots` = tickets whose `parent` is empty, self, or unresolvable. `childrenOf` groups resolvable children by parent id, in input order. `epicIds` = ids with ≥1 child.
- Also exports the layout constants used by later tasks: `NODE_W`, `NODE_H`, `H_GAP`, `ROW_H`, `PAD`.

- [ ] **Step 1: Write the failing test**

Create `tests/map-view.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForest } from "../scripts/map-view.mjs";

const tk = (id, parent = "") => ({ id, parent, status: "todo", updated: "2026-06-28" });

test("buildForest: flat orphans are all roots", () => {
  const f = buildForest([tk("A"), tk("B")]);
  assert.deepEqual(f.roots.map((t) => t.id), ["A", "B"]);
  assert.equal(f.childrenOf.size, 0);
  assert.equal(f.epicIds.size, 0);
});

test("buildForest: epic with two children", () => {
  const f = buildForest([tk("E"), tk("C1", "E"), tk("C2", "E")]);
  assert.deepEqual(f.roots.map((t) => t.id), ["E"]);
  assert.deepEqual(f.childrenOf.get("E").map((t) => t.id), ["C1", "C2"]);
  assert.ok(f.epicIds.has("E"));
});

test("buildForest: unresolvable or self parent becomes a root", () => {
  const f = buildForest([tk("A", "GHOST"), tk("B", "B")]);
  assert.deepEqual(f.roots.map((t) => t.id).sort(), ["A", "B"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/map-view.test.mjs`
Expected: FAIL — cannot resolve `../scripts/map-view.mjs` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/map-view.mjs`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/map-view.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/map-view.mjs tests/map-view.test.mjs
git commit -m "feat(map): forest construction for the mind-map view"
```

---

### Task 2: Tidy-tree layout (`layoutTree`)

**Files:**
- Modify: `scripts/map-view.mjs`
- Test: `tests/map-view.test.mjs`

**Interfaces:**
- Consumes: `buildForest`, constants `NODE_W/NODE_H/H_GAP/ROW_H/PAD`.
- Produces: `layoutTree(forest) -> { nodes: Node[], edges: {from,to}[], width, height, standaloneY }`. `Node = { ticket, x, y, depth, standalone, contextOnly }` (pixel coords; `contextOnly` defaults `false`, set later by the renderer). Epic roots (roots with children) are laid out first; orphan roots (no children) after, with `standalone: true` and `standaloneY` = the divider row's y (or `null` when there are no orphans). Cycle-safe and complete: every ticket appears exactly once.

- [ ] **Step 1: Write the failing test**

Append to `tests/map-view.test.mjs`:

```js
import { layoutTree, NODE_H, ROW_H, PAD } from "../scripts/map-view.mjs";

test("layoutTree: single orphan sits at the origin pad", () => {
  const l = layoutTree(buildForest([tk("A")]));
  assert.equal(l.nodes.length, 1);
  assert.equal(l.nodes[0].x, PAD);
  assert.equal(l.nodes[0].y, PAD);
  assert.equal(l.standaloneY, PAD); // A is an orphan -> standalone lane
});

test("layoutTree: parent centers on its two children", () => {
  const l = layoutTree(buildForest([tk("E"), tk("C1", "E"), tk("C2", "E")]));
  const by = Object.fromEntries(l.nodes.map((n) => [n.ticket.id, n]));
  assert.equal(by.C1.depth, 1);
  assert.equal(by.E.depth, 0);
  assert.equal(by.E.y, (by.C1.y + by.C2.y) / 2);
  assert.deepEqual(l.edges, [{ from: "E", to: "C1" }, { from: "E", to: "C2" }]);
  assert.equal(l.standaloneY, null); // no orphans
});

test("layoutTree: a second tree never overlaps the first", () => {
  const l = layoutTree(
    buildForest([tk("E1"), tk("a", "E1"), tk("E2"), tk("b", "E2")]),
  );
  const by = Object.fromEntries(l.nodes.map((n) => [n.ticket.id, n]));
  assert.ok(by.E2.y > by.a.y, "second epic starts below first epic's child");
});

test("layoutTree: a parent cycle still places every node once", () => {
  const l = layoutTree(buildForest([tk("A", "B"), tk("B", "A")]));
  assert.equal(l.nodes.length, 2);
  assert.deepEqual(l.nodes.map((n) => n.ticket.id).sort(), ["A", "B"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/map-view.test.mjs`
Expected: FAIL — `layoutTree is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/map-view.mjs` (after `buildForest`):

```js
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
    standaloneY = PAD + cursor * ROW_H;
    cursor += 1; // reserve the divider row
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/map-view.test.mjs`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/map-view.mjs tests/map-view.test.mjs
git commit -m "feat(map): tidy horizontal tree layout"
```

---

### Task 3: Filter predicate (`ticketMatches`)

**Files:**
- Modify: `scripts/map-view.mjs`
- Test: `tests/map-view.test.mjs`

**Interfaces:**
- Produces: `ticketMatches(ticket, { window, status, now }) -> boolean`. `window`: a number of days, or `null` = all. `status`: `"active" | "inactive" | "all"`. `now`: epoch ms. Returns `windowOk && statusOk`. Window compares `ticket.updated` (a `YYYY-MM-DD` string) — keep if age in days `<= window` (boundary inclusive); an unparseable `updated` fails the window when one is set. Active = `todo`/`in-progress`.

- [ ] **Step 1: Write the failing test**

Append to `tests/map-view.test.mjs`:

```js
import { ticketMatches } from "../scripts/map-view.mjs";

const NOW = Date.parse("2026-06-28T00:00:00Z");
const at = (date, status = "todo") => ({ id: "x", parent: "", status, updated: date });

test("ticketMatches: window keeps recent, drops old, boundary inclusive", () => {
  assert.equal(ticketMatches(at("2026-06-28"), { window: 7, status: "all", now: NOW }), true);
  assert.equal(ticketMatches(at("2026-06-21"), { window: 7, status: "all", now: NOW }), true); // exactly 7d
  assert.equal(ticketMatches(at("2026-06-20"), { window: 7, status: "all", now: NOW }), false); // 8d
  assert.equal(ticketMatches(at("2020-01-01"), { window: null, status: "all", now: NOW }), true); // all
});

test("ticketMatches: status sets", () => {
  assert.equal(ticketMatches(at("2026-06-28", "in-progress"), { window: null, status: "active", now: NOW }), true);
  assert.equal(ticketMatches(at("2026-06-28", "backlog"), { window: null, status: "active", now: NOW }), false);
  assert.equal(ticketMatches(at("2026-06-28", "in-review"), { window: null, status: "inactive", now: NOW }), true);
  assert.equal(ticketMatches(at("2026-06-28", "todo"), { window: null, status: "inactive", now: NOW }), false);
});

test("ticketMatches: filters AND together", () => {
  // active but stale -> excluded by window
  assert.equal(ticketMatches(at("2020-01-01", "in-progress"), { window: 7, status: "active", now: NOW }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/map-view.test.mjs`
Expected: FAIL — `ticketMatches is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/map-view.mjs`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/map-view.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/map-view.mjs tests/map-view.test.mjs
git commit -m "feat(map): time+status filter predicate"
```

---

### Task 4: Visibility / keep-epic-as-context (`computeVisible`)

**Files:**
- Modify: `scripts/map-view.mjs`
- Test: `tests/map-view.test.mjs`

**Interfaces:**
- Produces: `computeVisible(allTickets, matchedIds: Set<id>) -> { visibleIds: Set<id>, contextOnlyIds: Set<id> }`. Visible = matched plus every ancestor of a match (walk `parent` chains, cycle-guarded). Ancestors that are not themselves matched are `contextOnly`. Non-matching children of a match are NOT included.

- [ ] **Step 1: Write the failing test**

Append to `tests/map-view.test.mjs`:

```js
import { computeVisible } from "../scripts/map-view.mjs";

const tree = [tk("E"), tk("C1", "E"), tk("C2", "E"), tk("G", "C1")];

test("computeVisible: matched child pulls in its epic as context", () => {
  const { visibleIds, contextOnlyIds } = computeVisible(tree, new Set(["C1"]));
  assert.deepEqual([...visibleIds].sort(), ["C1", "E"]);
  assert.deepEqual([...contextOnlyIds], ["E"]);
});

test("computeVisible: matched epic does NOT pull in its children", () => {
  const { visibleIds } = computeVisible(tree, new Set(["E"]));
  assert.deepEqual([...visibleIds], ["E"]);
});

test("computeVisible: whole ancestor chain is context", () => {
  const { visibleIds, contextOnlyIds } = computeVisible(tree, new Set(["G"]));
  assert.deepEqual([...visibleIds].sort(), ["C1", "E", "G"]);
  assert.deepEqual([...contextOnlyIds].sort(), ["C1", "E"]);
});

test("computeVisible: empty match is empty", () => {
  const { visibleIds } = computeVisible(tree, new Set());
  assert.equal(visibleIds.size, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/map-view.test.mjs`
Expected: FAIL — `computeVisible is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/map-view.mjs`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/map-view.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/map-view.mjs tests/map-view.test.mjs
git commit -m "feat(map): keep-epic-as-context visibility"
```

---

### Task 5: Browser render layer (`initMap` + styles)

**Files:**
- Modify: `scripts/map-view.mjs`
- Test: `tests/map-view.test.mjs` (import-safety smoke test only)

**Interfaces:**
- Consumes: `buildForest`, `layoutTree`, `ticketMatches`, `computeVisible`, constants.
- Produces: `initMap()` (browser entry; reads `#blaze-map-data` JSON, wires the `.map-tb` toolbar, renders into `.map-scroll`, opens `.map-panel`), and `MAP_STYLES` (a CSS string injected by `serve.mjs`). No DOM access runs at import time — node can still import the module.

- [ ] **Step 1: Write the failing test**

Append to `tests/map-view.test.mjs`:

```js
import * as mapView from "../scripts/map-view.mjs";

test("module exports initMap and MAP_STYLES without touching the DOM", () => {
  assert.equal(typeof mapView.initMap, "function");
  assert.equal(typeof mapView.MAP_STYLES, "string");
  assert.ok(mapView.MAP_STYLES.includes(".map-node"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/map-view.test.mjs`
Expected: FAIL — `mapView.initMap` is undefined / `MAP_STYLES` undefined.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/map-view.mjs` (DOM code — only runs in the browser):

```js
// ---- browser: DOM render -----------------------------------------------

export const MAP_STYLES = `
  .mapview { display: flex; flex-direction: column; height: calc(100vh - 52px); }
  .map-tb { display: flex; gap: 18px; padding: 10px 20px; border-bottom: 1px solid #21262d; flex-wrap: wrap; }
  .map-tbgroup { display: flex; align-items: center; gap: 4px; }
  .map-tblabel { color: #7d8590; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; margin-right: 4px; }
  .map-pill { appearance: none; border: 1px solid #21262d; background: #161b22; color: #adbac7;
    font: inherit; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
  .map-pill:hover { color: #fff; }
  .map-pill.on { color: #0F172A; background: var(--blaze-orange); border-color: var(--blaze-orange); }
  .map-body { position: relative; flex: 1; min-height: 0; display: flex; }
  .map-scroll { flex: 1; overflow: auto; position: relative; }
  .map-stage { position: relative; }
  .map-edges { position: absolute; inset: 0; pointer-events: none; }
  .map-edge { fill: none; stroke: #30363d; stroke-width: 1.5; }
  .map-divider { position: absolute; left: 0; height: 1px; border-top: 1px dashed #30363d;
    color: #7d8590; font-size: 10px; text-transform: uppercase; letter-spacing: .5px; padding-left: ${PAD}px; }
  .map-node { position: absolute; box-sizing: border-box; min-height: ${NODE_H}px;
    background: #1c2128; border: 1px solid #2d333b; border-left: 3px solid #444c56;
    border-radius: 8px; padding: 7px 9px; cursor: pointer; overflow: hidden; }
  .map-node:hover { background: #20262e; }
  .map-node.sel { outline: 2px solid var(--blaze-orange); }
  .map-node.context { opacity: .45; }
  .map-node.prio-urgent { border-left-color: var(--blaze-red); }
  .map-node.prio-high { border-left-color: var(--blaze-orange); }
  .map-node.prio-medium { border-left-color: var(--blaze-amber); }
  .map-node.status-in-progress { background: #182634; }
  .map-node.status-todo { background: #1c2128; }
  .map-node.status-done, .map-node.status-canceled, .map-node.status-duplicate { background: #161b22; }
  .mn-top { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .mn-id { color: #7d8590; font-size: 10px; font-weight: 600; font-family: ui-monospace, monospace; }
  .mn-prio { font-size: 9px; padding: 0 5px; border-radius: 999px; text-transform: uppercase; }
  .mn-prio.prio-urgent { background: #4b1113; color: var(--blaze-red); }
  .mn-prio.prio-high { background: #4a2410; color: var(--blaze-orange); }
  .mn-prio.prio-medium { background: #4a3a0c; color: var(--blaze-amber); }
  .mn-prio.prio-low, .mn-prio.prio-none { background: #30363d; color: #7d8590; }
  .mn-title { margin-top: 2px; font-weight: 500; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mn-chips { margin-top: 4px; display: flex; gap: 3px; flex-wrap: nowrap; overflow: hidden; }
  .mn-type, .mn-label { font-size: 9px; padding: 0 5px; border-radius: 999px; white-space: nowrap; }
  .mn-type { background: #30363d; color: #adbac7; }
  .mn-label { background: #21314a; color: #79c0ff; }
  .mn-meta { margin-top: 4px; color: #7d8590; font-size: 10px; }
  .map-panel { width: 0; overflow: hidden; background: #161b22; border-left: 1px solid #21262d; transition: width .15s; }
  .map-panel.open { width: 340px; overflow: auto; }
  .map-panel > * { margin: 0 16px; }
  .mp-close { float: right; margin: 10px 12px 0 0; background: none; border: 0; color: #7d8590; font-size: 16px; cursor: pointer; }
  .mp-id { display: inline-block; margin-top: 14px; color: #7d8590; font-family: ui-monospace, monospace; font-size: 11px; }
  .mp-title { margin: 4px 16px 6px; font-size: 16px; }
  .mp-meta { color: #7d8590; font-size: 12px; margin-bottom: 10px; }
  .mp-pr { display: inline-block; margin: 0 16px 10px; color: #58a6ff; text-decoration: none; font-weight: 600; }
  .mp-body { color: #c9d1d9; font-size: 13px; padding-bottom: 24px; }
  .mp-body h4 { font-size: 12px; text-transform: uppercase; color: #adbac7; margin: 10px 0 4px; }
  .mp-body ul.md { padding-left: 18px; } .mp-body li.task { list-style: none; margin-left: -18px; }
  .mp-body code { background: #2d333b; padding: 1px 4px; border-radius: 4px; }
  .map-empty { color: #444c56; padding: 40px; text-align: center; }
`;

const SVG_NS = "http://www.w3.org/2000/svg";

export function initMap() {
  const dataEl = document.getElementById("blaze-map-data");
  const root = document.querySelector(".mapview");
  if (!dataEl || !root) return;
  const tickets = JSON.parse(dataEl.textContent);
  const scroll = root.querySelector(".map-scroll");
  const panel = root.querySelector(".map-panel");

  const ls = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const setLs = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  const filters = {
    window: ls("tracker.map.window", "all"),
    status: ls("tracker.map.status", "all"),
  };

  function syncToolbar() {
    root.querySelectorAll(".map-tb [data-filter]").forEach((b) =>
      b.classList.toggle("on", filters[b.dataset.filter] === b.dataset.value));
  }

  root.querySelectorAll(".map-tb [data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      filters[b.dataset.filter] = b.dataset.value;
      setLs("tracker.map." + b.dataset.filter, b.dataset.value);
      syncToolbar();
      render();
    }));

  function render() {
    const now = Date.now();
    const win = filters.window === "all" ? null : Number(filters.window);
    const matchedIds = new Set(
      tickets
        .filter((t) => ticketMatches(t, { window: win, status: filters.status, now }))
        .map((t) => t.id));
    const { visibleIds, contextOnlyIds } = computeVisible(tickets, matchedIds);
    const visible = tickets.filter((t) => visibleIds.has(t.id));
    scroll.innerHTML = "";
    if (!visible.length) {
      scroll.innerHTML = '<div class="map-empty">No tickets match these filters.</div>';
      return;
    }
    const layout = layoutTree(buildForest(visible));
    layout.nodes.forEach((n) => { n.contextOnly = contextOnlyIds.has(n.ticket.id); });
    drawMap(scroll, layout, (t, el) => selectNode(panel, el, t));
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanel(panel); });
  scroll.addEventListener("click", (e) => {
    if (e.target === scroll || e.target.classList.contains("map-stage")) closePanel(panel);
  });

  syncToolbar();
  render();
}

function drawMap(scroll, layout, onSelect) {
  const stage = document.createElement("div");
  stage.className = "map-stage";
  stage.style.width = layout.width + "px";
  stage.style.height = layout.height + "px";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "map-edges");
  svg.setAttribute("width", layout.width);
  svg.setAttribute("height", layout.height);
  const pos = new Map(layout.nodes.map((n) => [n.ticket.id, n]));
  for (const e of layout.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
    const x2 = b.x, y2 = b.y + NODE_H / 2;
    const midX = x1 + H_GAP / 2;
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`);
    path.setAttribute("class", "map-edge");
    svg.appendChild(path);
  }
  stage.appendChild(svg);

  if (layout.standaloneY != null) {
    const div = document.createElement("div");
    div.className = "map-divider";
    div.style.top = layout.standaloneY + "px";
    div.style.width = layout.width + "px";
    div.textContent = "Standalone";
    stage.appendChild(div);
  }

  for (const n of layout.nodes) stage.appendChild(nodeEl(n, onSelect));
  scroll.appendChild(stage);
}

function nodeEl(n, onSelect) {
  const t = n.ticket;
  const el = document.createElement("div");
  el.className =
    `map-node prio-${t.priority || "none"} status-${t.status}` +
    (n.contextOnly ? " context" : "");
  el.style.left = n.x + "px";
  el.style.top = n.y + "px";
  el.style.width = NODE_W + "px";

  const top = document.createElement("div");
  top.className = "mn-top";
  const id = document.createElement("span"); id.className = "mn-id"; id.textContent = t.id;
  const prio = document.createElement("span");
  prio.className = "mn-prio prio-" + (t.priority || "none");
  prio.textContent = t.priority || "none";
  top.append(id, prio);

  const title = document.createElement("div");
  title.className = "mn-title"; title.textContent = t.title;
  el.append(top, title);

  if (!n.contextOnly) {
    const chips = [];
    if (t.type) chips.push(["mn-type", t.type]);
    (t.labels || []).forEach((l) => chips.push(["mn-label", l]));
    if (chips.length) {
      const row = document.createElement("div"); row.className = "mn-chips";
      for (const [cls, txt] of chips) {
        const s = document.createElement("span"); s.className = cls; s.textContent = txt;
        row.appendChild(s);
      }
      el.appendChild(row);
    }
    const bits = [];
    if (t.assignee && t.assignee !== "unassigned") bits.push("@" + t.assignee);
    if (t.estimate) bits.push(t.estimate + " pts");
    if (bits.length) {
      const m = document.createElement("div"); m.className = "mn-meta"; m.textContent = bits.join(" · ");
      el.appendChild(m);
    }
  }

  el.addEventListener("click", (ev) => { ev.stopPropagation(); onSelect(t, el); });
  return el;
}

function selectNode(panel, el, t) {
  document.querySelectorAll(".map-node.sel").forEach((x) => x.classList.remove("sel"));
  el.classList.add("sel");
  openPanel(panel, t);
}

function openPanel(panel, t) {
  panel.innerHTML = "";
  const close = document.createElement("button");
  close.className = "mp-close"; close.textContent = "✕";
  close.addEventListener("click", () => closePanel(panel));
  const id = document.createElement("div"); id.className = "mp-id"; id.textContent = t.id;
  const title = document.createElement("h2"); title.className = "mp-title"; title.textContent = t.title;
  const meta = document.createElement("div"); meta.className = "mp-meta";
  const bits = [];
  if (t.assignee && t.assignee !== "unassigned") bits.push("@" + t.assignee);
  if (t.estimate) bits.push(t.estimate + " pts");
  if (t.parent) bits.push("↳ " + t.parent);
  if (t.project) bits.push(t.project);
  bits.push(t.status);
  meta.textContent = bits.join(" · ");
  panel.append(close, id, title, meta);
  const prUrl = (String(t.pr || "").match(/https?:\/\/\S+/) || [])[0];
  if (prUrl) {
    const a = document.createElement("a");
    a.className = "mp-pr"; a.href = prUrl; a.target = "_blank"; a.rel = "noopener"; a.textContent = "🔗 PR";
    panel.appendChild(a);
  }
  const body = document.createElement("div"); body.className = "mp-body";
  body.innerHTML = t.bodyHtml || ""; // server-rendered + escaped by serve.mjs mdLite()
  panel.appendChild(body);
  panel.classList.add("open");
}

function closePanel(panel) {
  panel.classList.remove("open");
  document.querySelectorAll(".map-node.sel").forEach((x) => x.classList.remove("sel"));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/map-view.test.mjs`
Expected: PASS — module imports in node, exports present, all earlier tests still green.

- [ ] **Step 5: Commit**

```bash
git add scripts/map-view.mjs tests/map-view.test.mjs
git commit -m "feat(map): browser render layer + styles"
```

---

### Task 6: Wire the view into `serve.mjs`

**Files:**
- Modify: `scripts/serve.mjs`
- Test: `tests/serve-map.test.mjs`

**Interfaces:**
- Consumes: `MAP_STYLES` from `./map-view.mjs`; existing `boardData`, `mdLite`, `esc`, `metaPieces` are already in `serve.mjs`.
- Produces (new exports from `serve.mjs`): `mapData() -> ticket[]` (the flattened array described in the spec, `bodyHtml` pre-rendered via `mdLite`), and `tryServeAsset(req, res) -> boolean` (serves `GET /assets/map-view.js` with `text/javascript`). `pageHtml()` now also contains: a `Map` pill in `.viewtoggle`, the `#blaze-map-data` JSON blob, the `.mapview` markup, `<style>${MAP_STYLES}</style>`, the view-switch CSS for `data-view="map"`, and a `<script type="module">` that imports `/assets/map-view.js` and calls `initMap()`.

- [ ] **Step 1: Write the failing test**

Create `tests/serve-map.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapData, pageHtml, tryServeAsset } from "../scripts/serve.mjs";

test("mapData returns flattened tickets with the required keys", () => {
  const data = mapData();
  assert.ok(Array.isArray(data));
  for (const t of data) {
    for (const k of ["id", "title", "priority", "status", "updated", "parent", "labels", "bodyHtml"]) {
      assert.ok(k in t, `missing key ${k}`);
    }
  }
});

test("pageHtml includes the Map view scaffolding", () => {
  const html = pageHtml();
  assert.match(html, /data-view="map"/);
  assert.match(html, /id="blaze-map-data"/);
  assert.match(html, /class="mapview"/);
  assert.match(html, /\/assets\/map-view\.js/);
});

test("tryServeAsset serves the map module and rejects other urls", () => {
  let code = 0, body = "";
  const res = { writeHead: (c) => { code = c; }, end: (b) => { body = b; } };
  assert.equal(tryServeAsset({ url: "/assets/map-view.js" }, res), true);
  assert.equal(code, 200);
  assert.match(body, /export function buildForest/);
  assert.equal(tryServeAsset({ url: "/nope" }, { writeHead() {}, end() {} }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/serve-map.test.mjs`
Expected: FAIL — `mapData`/`tryServeAsset` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `scripts/serve.mjs`:

(a) Add the import near the top (after the existing `loadConfig` import):

```js
import { MAP_STYLES } from "./map-view.mjs";
```

(b) Add `mapData` and `tryServeAsset` (place after `boardData`):

```js
// Flatten every ticket to a JSON-friendly shape for the Map view. bodyHtml is
// pre-rendered here so the browser needs no markdown renderer.
export function mapData() {
  const { cols } = boardData();
  const out = [];
  for (const c of cols) {
    for (const t of c.tickets) {
      const m = t.meta;
      out.push({
        id: m.id || t.file,
        title: m.title || t.file,
        type: m.type || "",
        priority: m.priority || "none",
        labels: m.labels || [],
        project: m.project || "",
        assignee: m.assignee || "",
        estimate: m.estimate || "",
        parent: m.parent || "",
        status: c.dir,
        pr: m.pr || "",
        created: m.created || "",
        updated: m.updated || "",
        bodyHtml: mdLite(t.body),
      });
    }
  }
  return out;
}

// Serve the Map view's browser module verbatim. Both servers call this early.
export function tryServeAsset(req, res) {
  if (req.url === "/assets/map-view.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(readFileSync(join(ROOT, "scripts", "map-view.mjs"), "utf8"));
    return true;
  }
  return false;
}
```

(c) In `pageHtml`, compute the embedded JSON. Add near the top of `pageHtml` (after the `const { cols, total } = boardData();` line):

```js
  // `<` is escaped so a ticket title can never break out of the <script> tag.
  const mapJson = JSON.stringify(mapData()).replace(/</g, "\\u003c");
```

(d) Add the **Map** pill to the `.viewtoggle` — change the toggle block to:

```js
    <div class="viewtoggle" role="group" aria-label="View" style="margin-left:auto">
      <button type="button" class="pill" data-view="board">Board</button>
      <button type="button" class="pill" data-view="list">List</button>
      <button type="button" class="pill" data-view="map">Map</button>
    </div>
```

(e) Add `MAP_STYLES` and the view-switch rules. Inside the `<style>` block, replace the existing view-switching rules:

```css
  /* ---- view switching ---- */
  html[data-view="board"] .list { display: none; }
  html[data-view="list"]  .board { display: none; }
```

with:

```css
  /* ---- view switching ---- */
  html[data-view="board"] .list, html[data-view="board"] .mapview,
  html[data-view="list"]  .board, html[data-view="list"]  .mapview,
  html[data-view="map"]   .board, html[data-view="map"]   .list { display: none; }
${MAP_STYLES}
```

(f) Add the map markup + data blob + bootstrap into the body. After the `<div class="list">${groupsHtml}</div>` line, insert:

```js
  <script type="application/json" id="blaze-map-data">${mapJson}</script>
  <div class="mapview">
    <div class="map-tb">
      <div class="map-tbgroup">
        <span class="map-tblabel">Time</span>
        <button class="map-pill" data-filter="window" data-value="7">7</button>
        <button class="map-pill" data-filter="window" data-value="14">14</button>
        <button class="map-pill" data-filter="window" data-value="30">30</button>
        <button class="map-pill" data-filter="window" data-value="all">All</button>
      </div>
      <div class="map-tbgroup">
        <span class="map-tblabel">Status</span>
        <button class="map-pill" data-filter="status" data-value="active">Active</button>
        <button class="map-pill" data-filter="status" data-value="inactive">Inactive</button>
        <button class="map-pill" data-filter="status" data-value="all">All</button>
      </div>
    </div>
    <div class="map-body">
      <div class="map-scroll"></div>
      <aside class="map-panel"></aside>
    </div>
  </div>
  <script type="module">
    import { initMap } from "/assets/map-view.js";
    initMap();
  </script>
```

(g) Wire `tryServeAsset` into `serve.mjs`'s own standalone server. In the `createServer((req, res) => {` block, add as the **first** statement inside the handler:

```js
    if (tryServeAsset(req, res)) return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/serve-map.test.mjs`
Expected: PASS — 3 tests.

Then sanity-check the standalone server renders and serves the asset:

Run: `node scripts/serve.mjs & sleep 1; curl -s localhost:4321/assets/map-view.js | head -1; curl -s localhost:4321/ | grep -o 'data-view="map"' | head -1; kill %1`
Expected: first line is the `// map-view.mjs` comment; second prints `data-view="map"`.

- [ ] **Step 5: Commit**

```bash
git add scripts/serve.mjs tests/serve-map.test.mjs
git commit -m "feat(map): wire Map view + asset route into serve.mjs"
```

---

### Task 7: Wire the asset route into the supervisor + full verification

**Files:**
- Modify: `scripts/supervisor.mjs:129-150` (the `createServer` handler)
- Test: full suite + manual browser check

**Interfaces:**
- Consumes: `tryServeAsset` from `./serve.mjs` (already imports `pageHtml, contentHash` from there).

- [ ] **Step 1: Add the import**

In `scripts/supervisor.mjs`, change the existing import:

```js
import { pageHtml, contentHash } from "./serve.mjs";
```

to:

```js
import { pageHtml, contentHash, tryServeAsset } from "./serve.mjs";
```

- [ ] **Step 2: Serve the asset early in the handler**

In `supervisor.mjs`'s `createServer((req, res) => {` handler, add as the **first** statement (before the `/api/hash` check):

```js
    if (tryServeAsset(req, res)) return;
```

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS — all suites, including the new `map-view` and `serve-map` tests, plus the pre-existing `config`, `event-bus`, `groomer`, `new-ticket`, `reconcile`, `supervisor` suites.

- [ ] **Step 4: Manual browser verification**

Run: `npm start` (the supervisor app on its configured port), then in a browser:

- [ ] Click the **Map** pill — the tree renders; epics show their sub-tasks as children with elbow connectors; orphans appear under a faint **Standalone** divider.
- [ ] Toggle **Time** `7 / 14 / 30 / All` — the tree reflows; only tickets updated within the window remain (plus dimmed epic ancestors of matches).
- [ ] Toggle **Status** `Active / Inactive / All` — Active shows only `in-progress`/`todo` (+ context epics); Inactive shows the rest.
- [ ] Set Status=Active **and** Time=7 — both filters apply together (AND).
- [ ] Click a node — the detail panel slides in from the right with the ticket body and acceptance-criteria checkboxes; **Esc** and clicking empty space close it.
- [ ] Reload — the selected view (Map) and both filter selections persist.
- [ ] Confirm the **Board** and **List** views still work and the live-reload indicator still says `live`.

- [ ] **Step 5: Commit**

```bash
git add scripts/supervisor.mjs
git commit -m "feat(map): serve the map asset from the supervisor app"
```

---

## Self-Review notes

- **Spec coverage:** integration (T6/T7) · `map-view.mjs` dual-runtime (T1–T5) · `mapData` + JSON embed (T6) · forest (T1) · tidy-tree layout incl. Standalone lane (T2) · time+status filters (T3) · keep-epic-as-context (T4) · node encoding + detail panel + render (T5) · `tryServeAsset` both servers (T6/T7) · tests for the four pure functions (T1–T4). All spec sections map to a task.
- **`in-review` = Inactive** is encoded by `ACTIVE = {todo, in-progress}` (T1) and asserted in T3.
- **Determinism:** layout uses input order + a running cursor; no `Math.random`/`Date.now` in pure functions (`now` is injected into `ticketMatches`).
