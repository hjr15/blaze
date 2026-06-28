# Mind Map view — design

**Date:** 2026-06-28
**Status:** Approved (brainstorm complete)
**Surface:** `scripts/serve.mjs` (board renderer) + new `scripts/map-view.mjs`

## Goal

Add a third board view — **Map** — alongside the existing **Board** and **List**
views. It renders the board as a horizontal tidy tree that makes the
**epic → sub-task** relationship (the `parent:` frontmatter field) visible at a
glance, with two independent filters: a **time window** (last 7 / 14 / 30 / all
days, by `updated`) and a **status** split (Active / Inactive / All).

## Non-goals (v1)

- Pinch/zoom or a custom zoom control — rely on container scroll + browser zoom.
- Editing tickets from the map (it is a viewer, like the rest of the board).
- Any third-party graph/layout library — Blaze stays zero-dependency.
- Drag-to-rearrange nodes.

## Integration

Both servers — the standalone board (`serve.mjs`) and the supervisor app
(`supervisor.mjs`) — render through the same exported `pageHtml()`. The Map view
is baked **into `pageHtml`** (not via the `afterHeader`/`beforeBodyEnd` injection
hooks, which stay reserved for server-specific extras like the supervisor's
controls and activity feed). So the view appears in both servers with no
duplication.

- A third pill **Map** joins the Board / List toggle.
- Selected view persists in `localStorage` under the existing `tracker.view` key
  (now accepting `"map"`). CSS `html[data-view="map"]` hides `.board` + `.list`
  and shows the map; the pre-paint inline script already restores the saved view.

### The `map-view.mjs` module — one source, two runtimes

A new `scripts/map-view.mjs` is **both** a node module and a browser ES module:

- **Node:** `serve.mjs` imports it for the CSS string and any shared constants;
  `tests/map-view.test.mjs` imports its pure functions directly under
  `node --test`.
- **Browser:** the same file is served verbatim at `/assets/map-view.js` and
  imported by an inline `<script type="module">` in the page, which calls
  `initMap()`.

**Constraint:** no node-only API and no DOM access at module top level. DOM code
lives only inside function bodies (called only in the browser). This keeps the
file importable in node for testing while running unchanged in the browser.

A small helper `tryServeAsset(req, res): boolean` — **exported from `serve.mjs`**
(where `supervisor.mjs`'s `pageHtml`/`contentHash` imports already come from) —
serves the `/assets/map-view.js` route (correct `text/javascript` content-type,
read from disk so edits show on refresh). **Both** `serve.mjs`'s and
`supervisor.mjs`'s `createServer` call it early and return if it handled the
request.

## Data flow

`serve.mjs` already has `boardData()`, `parse()`, and `mdLite()`. A new
`mapData()` flattens every ticket across all columns to:

```js
{ id, title, type, priority, labels, project, assignee, estimate,
  parent, status /* the column dir */, pr, created, updated, bodyHtml }
```

`bodyHtml` is the ticket body pre-rendered server-side with the existing
`mdLite()`, so the detail panel needs no client-side markdown renderer. The array
is embedded **once** as `<script type="application/json" id="blaze-map-data">`.
The browser parses it and does all rendering, filtering, and layout client-side,
so filter toggles are **instant** (no server round-trip). The existing
content-hash poll (`/api/hash`, every 3s) still triggers a full reload when ticket
files actually change.

## Layout — horizontal tidy tree

### Forest construction — `buildForest(tickets)`

- **Children** = tickets whose `parent` resolves to an existing ticket id.
- **Epics** = any ticket referenced as a `parent` by ≥1 child.
- **Orphans** = tickets that are neither a child nor an epic.
- **Roots** = epics + orphans.
- Defensive: a `parent` id that doesn't exist → treat the ticket as a root.
  Cycles (a → b → a) are broken — once a node is placed in the tree it is never
  re-parented; the back-edge is dropped so traversal terminates.
- Arbitrary depth is supported (a sub-task that is itself a parent nests further),
  though the convention expects two levels.

### Positioning — `layoutTree(forest)`

Classic tidy horizontal tree:

- `x = depth * (NODE_W + H_GAP)` — depth 0 (roots) on the left, children flow
  right.
- Post-order y assignment: each **leaf** takes the next row slot
  (`y = rowCursor++ * ROW_H`); each **internal node** centers on its children
  (`y = midpoint(firstChild.y, lastChild.y)`).
- A running `rowCursor` spans the whole forest so trees stack vertically without
  overlapping; a blank gap row separates trees.
- **Orphans** stack last, after the epic trees, under a faint **"Standalone"**
  divider (confirmed wanted).
- Output: `{ nodes: [{ ticket, x, y, depth, contextOnly }], edges: [{ from, to }],
  width, height }` — deterministic for a given input (testable).

### Rendering

- Each node is an absolutely-positioned **HTML** card (rich chips/colors),
  fixed width `NODE_W` so columns align.
- Connectors are a single **SVG** overlay sized to the layout, drawing orthogonal
  elbows: parent right-center → mid-x → child y → child left-center.
- The map container scrolls both axes (`overflow: auto`).

## Filters (independent, AND-combined)

A map-only toolbar (rendered inside the map container, hidden in other views) with
two control groups:

- **Time:** `[7] [14] [30] [All]` — keeps tickets whose `updated` is within the
  last N days. "Now" is computed in-browser (`Date.now()`).
- **Status:** `[Active] [Inactive] [All]` where
  **Active = `in-progress` or `todo`**, **Inactive = every other column**
  (`backlog`, `in-review`, `done`, `canceled`, `duplicate`). Per the approved
  definition, `in-review` counts as **Inactive**.

Both selections persist to `localStorage` (`tracker.map.window`,
`tracker.map.status`) and restore on load. Changing either re-runs filtering +
layout + render with no reload.

`ticketMatches(ticket, { window, status, now })` returns whether a ticket itself
satisfies both filters (pure, testable).

## Pruning — keep epic as context

`computeVisible(tickets, matchedIds)`:

- A ticket is **visible** if it matches the filters **or** it is an **ancestor**
  of a matching ticket.
- Ancestors included only for context (not themselves matching) are flagged
  `contextOnly: true` and render **dimmed**, so a matched sub-task is never
  orphaned from its epic.
- Non-matching **children** of a matching epic are **not** auto-included (the map
  stays focused on matches; lineage is preserved upward only).
- Empty result → the map area shows "No tickets match these filters."

## Node encoding

Compact fixed-width card:

- **Priority** → colored **left accent bar** (reuses the existing card
  convention: urgent=red, high=orange, medium=amber, low/none=grey).
- **Status** → subtle **background tint** by column.
- **Type + labels** → a chip row (e.g. `feature` · `frontend`).
- **@assignee · N pts** → a meta line.
- Title truncates with ellipsis; full text is in the detail panel.
- `contextOnly` nodes render dimmed (reduced opacity, chips suppressed).

## Detail panel

Clicking a node selects it and slides a panel in from the right showing: id,
title, full meta line, PR link, and the rendered `bodyHtml` (acceptance-criteria
checkboxes included, disabled). The tree stays put. Dismiss via Esc, click
outside, or a close button. Selection state is purely client-side (not persisted).

## Testing — `tests/map-view.test.mjs` (`node --test`)

Pure functions only (DOM rendering is not unit-tested — zero-dep, no jsdom):

- **`buildForest`** — roots/children/orphans classification; missing-parent → root;
  cycle is broken; multi-level nesting.
- **`layoutTree`** — leaves get sequential slots; parent centered on children;
  trees don't overlap; deterministic output; orphans placed after epics.
- **`ticketMatches`** — time window boundary (exactly N days), each status set,
  AND-combination of the two filters.
- **`computeVisible`** — ancestor-of-match included as `contextOnly`; matching
  ticket not flagged context; non-matching child of a match excluded; empty input.

## Files touched

- `scripts/serve.mjs` — Map pill in the toggle; `data-view="map"` CSS switch;
  `mapData()` flattener + JSON embed; import `MAP_STYLES` and the map markup into
  `pageHtml`; export + wire `tryServeAsset`.
- `scripts/map-view.mjs` — **new.** Pure logic (`buildForest`, `layoutTree`,
  `ticketMatches`, `computeVisible`), DOM render (`initMap`, `renderMap`,
  `renderPanel`, toolbar wiring), `MAP_STYLES`, `tryServeAsset` is exported from
  `serve.mjs` (asset path constant shared).
- `scripts/supervisor.mjs` — call `tryServeAsset` early in `createServer`.
- `tests/map-view.test.mjs` — **new.** Unit tests for the four pure functions.
