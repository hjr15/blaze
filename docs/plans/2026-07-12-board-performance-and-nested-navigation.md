# Board Performance + Nested Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make board navigation snappy (BLZ-86: cache the corpus parse, render only the active view, gzip, patch instead of reload) and make goals-first drill-down the default navigation model (BLZ-85), keeping the engine zero-dependency, no-build, npx-installable.

**Architecture:** All changes live in the public engine repo (`hjr15/blaze`). Server stays a plain `node:http` string-template renderer; the client stays inline vanilla JS. New pieces: a per-file mtime/size parse cache inside `walkTickets`, a shared per-request index, a `/view/<name>` fragment endpoint returning a JSON envelope (view + chipbar + crumbs + counts) that the client swaps in place of `location.reload()`, `node:zlib` gzip, one-level-at-a-time focus scoping, and a `views:` config toggle (used to switch the Map off on blaze-pm).

**Tech Stack:** Node ≥20 built-ins only (`node:http`, `node:fs`, `node:zlib`), `node --test`, vanilla browser JS in template literals. No new dependencies, no build step.

## Global Constraints

- Zero runtime dependencies; `package.json` `dependencies` stays absent. No build step; `bin: scripts/cli.mjs` and `npx @hjr15/blaze-board` must keep working.
- Board = pure view over markdown files (prime directive): any ticket-file change must be visible on the next render — caches are validated per request, never trusted blind.
- The byte-level golden (`tests/views/page-golden.test.mjs`) guards `pageHtml`. Tasks that intentionally change page markup MUST delete `tests/views/page-golden.html`, re-run to regenerate, and eyeball the diff — say so in the commit body.
- Determinism: no `Date.now()`/`Math.random()`/locale-dependent compares in render or model code paths that feed the golden (existing rule — see `graph.mjs` header).
- Tests: `node --test tests/` must pass after every task. Coverage gate: `npm run test:coverage` (c8) is the CI gate — new modules need tests.
- Commits on the epic integration branch, message prefix = the ticket (`BLZ-90: …`). PR unit = the epic: branch `BLZ-86-board-performance` first; `BLZ-85-nested-navigation` after BLZ-86 merges.
- Repo conventions: ESM `.mjs`, two-space indent, `// file.mjs — purpose` header comment, pure model functions with FS-touching wrappers.

## File Structure

| File | Role in this plan |
|---|---|
| `scripts/model/index.mjs` | Task 1: per-file parse cache inside `walkTickets`; `buildIndex(projectsDir, {tickets})` reuse hook |
| `scripts/views/data.mjs` | Task 1: `boardModel` accepts `{index}`; Task 4: direct-children/parentless scoping + `flat` |
| `scripts/model/graph.mjs` | Task 1: `graphModel({index})` reuse hook |
| `scripts/views/page.mjs` | Task 2: render active view only, view-script registry, swap helper; Task 3: envelope-refresh client; Task 5: pill gating |
| `scripts/serve.mjs` | Task 2: `/view/<name>` endpoint + gzip; Task 3: scoped `/api/hash`; Task 5: fragment 404 for disabled views |
| `scripts/config.mjs` | Task 5: `views` key in DEFAULTS + merge |
| `scripts/model/focus.mjs` | Task 4: `childrenIds` in `focusScope` |
| `tests/model/index-cache.test.mjs` | Task 1 (new) |
| `tests/views/{page,data}.test.mjs`, `tests/serve-endpoints.test.mjs`, `tests/model/focus.test.mjs`, `tests/config.test.mjs` | extended per task |
| `AGENTS.md`, `README.md`, `docs/architecture.md` | Task 6: document `views:` config + fragment endpoint + cache |

---

## Epic BLZ-86 — branch `BLZ-86-board-performance`

### Task 1 (BLZ-90): per-file parse cache + one shared index per request

**Files:**
- Modify: `scripts/model/index.mjs`
- Modify: `scripts/views/data.mjs` (boardModel signature)
- Modify: `scripts/model/graph.mjs` (graphModel signature)
- Modify: `scripts/views/page.mjs` (build index once, pass down)
- Test: `tests/model/index-cache.test.mjs` (new), extend `tests/views/data.test.mjs`

**Interfaces:**
- Produces: `walkTickets(projectsDir)` — unchanged generator signature, now stat-validated cached parses; **treat yielded `frontmatter`/`body` as immutable**.
- Produces: `buildIndex(projectsDir, { tickets } = {})` — optional pre-walked array of `{frontmatter, body, status, file}` to skip the walk.
- Produces: `boardModel(projectsDir, { project, focus, index })` — optional prebuilt index.
- Produces: `graphModel({ projectsDir, project, index })` — optional prebuilt index (skips its `buildIndex`).

- [ ] **Step 1: Write the failing cache test**

`tests/model/index-cache.test.mjs`:

```js
// tests/model/index-cache.test.mjs — walkTickets parse cache: reuse on
// unchanged mtime+size, re-parse on change, and buildIndex tickets reuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkTickets, buildIndex } from "../../scripts/model/index.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cache-"));
  mkdirSync(join(dir, "T", "todo"), { recursive: true });
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: one\ntype: task\nproject: T\nestimate: 5\n---\nbody\n");
  return dir;
}

test("unchanged file yields the identical parsed object (cache hit)", () => {
  const dir = fixture();
  const a = [...walkTickets(dir)][0];
  const b = [...walkTickets(dir)][0];
  assert.equal(a.frontmatter, b.frontmatter); // same object, not a re-parse
  assert.equal(a.body, b.body);
});

test("a changed file is re-parsed (mtime/size invalidation)", () => {
  const dir = fixture();
  const before = [...walkTickets(dir)][0];
  writeFileSync(join(dir, "T", "todo", "T-1.md"),
    "---\nid: T-1\ntitle: renamed\ntype: task\nproject: T\nestimate: 5\n---\nbody2\n");
  const after = [...walkTickets(dir)][0];
  assert.notEqual(before.frontmatter, after.frontmatter);
  assert.equal(after.frontmatter.title, "renamed");
});

test("same size + forced same mtime still re-parses when content differs is NOT required — stat contract only", () => {
  // Documents the contract: invalidation key is (mtimeMs, size). Equal-size
  // writes normally bump mtime; utimesSync back-dating is out of contract.
  const dir = fixture();
  const p = join(dir, "T", "todo", "T-1.md");
  const before = [...walkTickets(dir)][0];
  writeFileSync(p, "---\nid: T-1\ntitle: two\ntype: task\nproject: T\nestimate: 5\n---\nbodyX\n"); // different size
  const after = [...walkTickets(dir)][0];
  assert.equal(after.frontmatter.title, "two");
  assert.notEqual(before.frontmatter, after.frontmatter);
});

test("buildIndex accepts pre-walked tickets and skips its own walk", () => {
  const dir = fixture();
  const tickets = [...walkTickets(dir)];
  const idx = buildIndex(dir, { tickets });
  assert.equal(idx.count(), 1);
  assert.equal(idx.get("T-1").title, "one");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/Documents/Code/blaze && node --test tests/model/index-cache.test.mjs`
Expected: FAIL — first test fails (`a.frontmatter !== b.frontmatter`, fresh parse each walk), last fails (`buildIndex` ignores second arg → still passes count but signature test may pass accidentally; the identity tests are the real gate).

- [ ] **Step 3: Implement the cache + reuse hooks**

`scripts/model/index.mjs` — replace `walkTickets` and `buildIndex`:

```js
// Per-file parse cache: path → { mtimeMs, size, frontmatter, body }.
// Validated by stat on every walk (same freshness semantics as re-reading —
// the board stays a pure view over files); hits skip readFileSync+parse.
// Yielded objects are shared across walks: callers must treat them as
// immutable. Entries for deleted/moved paths are pruned lazily.
const parseCache = new Map();

export function* walkTickets(projectsDir) {
  const seen = new Set();
  for (const project of safeReaddir(projectsDir)) {
    const projPath = join(projectsDir, project);
    if (!isDir(projPath)) continue;
    for (const status of safeReaddir(projPath)) {
      const statusPath = join(projPath, status);
      if (!isDir(statusPath)) continue;
      for (const f of safeReaddir(statusPath)) {
        if (!f.endsWith(".md")) continue;
        const file = join(statusPath, f);
        let s; try { s = statSync(file); } catch { continue; }
        seen.add(file);
        const hit = parseCache.get(file);
        if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) {
          yield { frontmatter: hit.frontmatter, body: hit.body, status, file };
          continue;
        }
        const { frontmatter, body } = parseTicket(readFileSync(file, "utf8"));
        parseCache.set(file, { mtimeMs: s.mtimeMs, size: s.size, frontmatter, body });
        yield { frontmatter, body, status, file };
      }
    }
  }
  // Lazy prune: drop cache entries whose file vanished (moved/deleted) so a
  // long-lived server doesn't accumulate one stale entry per ticket move.
  if (parseCache.size > seen.size) {
    for (const k of parseCache.keys()) if (!seen.has(k)) parseCache.delete(k);
  }
}

export function buildIndex(projectsDir, { tickets } = {}) {
  const rows = [];
  const links = [];
  for (const t of tickets ?? walkTickets(projectsDir)) {
    const fm = t.frontmatter;
    const worklog_minutes = Array.isArray(fm.worklog)
      ? fm.worklog.reduce((s, w) => s + (Number(w.minutes) || 0), 0) : 0;
    rows.push({
      id: fm.id, project: fm.project ?? null, type: fm.type ?? null, title: fm.title ?? null,
      status: t.status, priority: fm.priority ?? null, resolution: fm.resolution ?? null,
      parent: fm.parent ?? null, assignee: fm.assignee ?? null, estimate: fm.estimate ?? null,
      worklog_minutes, file: t.file,
    });
    for (const link of fm.links ?? []) links.push({ src: fm.id, type: link.type, target: link.target });
  }
  return makeIndex(rows, links);
}
```

(Keep `safeReaddir`, `isDir`, `makeIndex` as they are; `statSync` is already imported.)

`scripts/views/data.mjs` — `boardModel` takes and reuses one walk + optional index:

```js
export function boardModel(projectsDir, { project = "all", focus = null, flat = false, index = null } = {}) {
  const walked = [...walkTickets(projectsDir)];
  const all = walked.map((t) => ({
    file: basename(t.file), meta: t.frontmatter, body: t.body,
    status: t.status, project: t.frontmatter.project,
  }));
  // …unchanged…
  const idx = index ?? buildIndex(projectsDir, { tickets: walked });
  // every later use of `index` in this function becomes `idx`
```

(`flat` is plumbed but unused until Task 4 — declare it now so the signature is stable for Task 2's fragment endpoint.)

`scripts/model/graph.mjs`:

```js
export function graphModel({ projectsDir, project = "all", index = null } = {}) {
  const idx = index ?? buildIndex(projectsDir);
  const rows = project === "all" ? idx.rows : idx.rows.filter((r) => r.project === project);
  return layoutGraph(buildGraph({ rows, links: idx.links }));
}
```

`scripts/views/page.mjs` — build once, pass everywhere (inside `pageHtml`):

```js
const pDir = _pDir ?? resolveRoots().projectsDir;
const m = boardModel(pDir, { project, focus });
// …
const gm = graphModel({ projectsDir: pDir, project, index: m.index });
```

and have `boardModel` return the index it built: add `index: idx` to its return object.

- [ ] **Step 4: Run the full suite**

Run: `node --test tests/`
Expected: all PASS, including the golden (output bytes unchanged — this task changes no markup).

- [ ] **Step 5: Benchmark and record on BLZ-90**

Run against blaze-pm data (read-only):
`cd ~/Documents/Code/blaze-pm && PORT=4599 node ~/Documents/Code/blaze/scripts/serve.mjs &` then
`for i in 1 2 3 4 5; do curl -so /dev/null -w "%{time_starttransfer}\n" localhost:4599/; done`; kill by PID.
Expected: warm TTFB well under the audited ~650ms (target ≤450ms; the cache should land it near ~150–250ms). Record the number in BLZ-90's AC checkbox line.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/Code/blaze
git add -- scripts/model/index.mjs scripts/model/graph.mjs scripts/views/data.mjs scripts/views/page.mjs tests/model/index-cache.test.mjs
git commit -m "BLZ-90: per-file parse cache + one shared index per render"
```

---

### Task 2 (BLZ-91, server half): render only the active view; `/view/<name>` fragment endpoint; gzip

**Files:**
- Modify: `scripts/views/page.mjs`
- Modify: `scripts/serve.mjs`
- Test: extend `tests/serve-endpoints.test.mjs`, `tests/views/page.test.mjs`; regenerate golden

**Interfaces:**
- Produces: `pageHtml({ project, focus, view = "board", … })` — renders ONLY `view`'s markup inside `<div id="viewhost" data-rendered="<view>">…</div>`; all views' CSS and client scripts still ship (they're ~KBs; markup was the weight).
- Produces: `viewEnvelope({ project, focus, flat, view, projectsDir })` in `page.mjs` → `{ view, html, chipbar, crumbs, total, subline }` — the JSON the client swaps. Exported for serve.mjs + tests.
- Produces: `GET /view/<name>?project=&focus=&flat=` → `application/json` envelope; 404 `{errors:["unknown view"]}` for a name not in the registry.
- Produces: client global `window.blazeViews = { board: {init}, list: {init}, live: {init}, metrics: {init}, map: {init} }`; `swapView(name)` fetches the envelope, swaps `#viewhost` children + chipbar + crumbs, then calls `init()`.
- Produces: gzip in serve.mjs — `send(res, code, type, body)` helper compressing when `accept-encoding` includes gzip and body ≥ 1024 bytes.

- [ ] **Step 1: Failing endpoint test**

Append to `tests/serve-endpoints.test.mjs` — **its real pattern is a per-test `boot()` helper (lines ~26–31), there is no shared `base`**; read the file first and copy the local helper names exactly, adapting the snippets below (which use `base` as shorthand for the booted server's URL):

```js
test("GET /view/list returns a JSON envelope with only the list markup", async () => {
  const res = await fetch(`${base}/view/list`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.view, "list");
  assert.match(j.html, /class="list"/);
  assert.doesNotMatch(j.html, /class="board"/);
  assert.match(j.chipbar, /class="chipbar"/);
  assert.equal(typeof j.total, "number");
});

test("GET /view/nope 404s", async () => {
  const res = await fetch(`${base}/view/nope`);
  assert.equal(res.status, 404);
});

test("GET / gzips when asked", async () => {
  const res = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(res.headers.get("content-encoding"), "gzip"); // fetch auto-decodes body
  assert.match(await res.text(), /<!doctype html>/);
});

test("GET / renders only the active view's markup", async () => {
  const res = await fetch(`${base}/`);
  const html = await res.text();
  assert.match(html, /id="viewhost" data-rendered="board"/);
  assert.doesNotMatch(html, /class="list" data-board/); // list not inlined
  assert.doesNotMatch(html, /svg class="graph"/);       // map not inlined
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/serve-endpoints.test.mjs` → FAIL (404 route missing, list+map currently inlined, no gzip header).

- [ ] **Step 3: Implement**

`scripts/views/page.mjs` — restructure the render:

1. Extract the per-view markup builders into one registry near the top:

```js
// View registry: how to render each view's fragment. metrics/map compute
// their models lazily — only when that view is actually requested.
export function renderView(name, { m, pDir, project, now, transitions }) {
  switch (name) {
    case "board": return board.render(m);
    case "list": return list.render(m);
    case "live": return live.render();
    case "metrics": {
      const txns = transitions === undefined ? loadTransitions({ root: resolveRoots().dataRoot }).transitions : transitions;
      return `<div class="metricsview">${metrics.render(metricsModel({ board: m, transitions: txns, now, project }))}</div>`;
    }
    case "map": return `<div class="mapview">${map.render(graphModel({ projectsDir: pDir, project, index: m.index }))}</div>`;
    default: return null;
  }
}
export const VIEW_NAMES = ["board", "list", "live", "metrics", "map"];
```

2. `pageHtml` gains `view = "board"`; the body emits `chipbar`, `crumbsHtml`, then `<div id="viewhost" data-rendered="${esc(view)}">${renderView(view, …)}</div>` — delete the five unconditional `${boardHtml}${listHtml}${live.render()}…` lines. Metrics/graph models are NO LONGER computed for `GET /` unless that's the requested view.
3. Add `viewEnvelope`:

```js
export function viewEnvelope({ project = "all", focus = null, flat = false, view = "board", projectsDir: _pDir, now = Date.now(), transitions } = {}) {
  if (!VIEW_NAMES.includes(view)) return null;
  const pDir = _pDir ?? resolveRoots().projectsDir;
  const m = boardModel(pDir, { project, focus, flat });
  return {
    view,
    html: renderView(view, { m, pDir, project, now, transitions }),
    chipbar: chipbarHtml(m),           // extract today's inline chipbar template into chipbarHtml(m)
    crumbs: crumbsHtml(m, project),    // likewise for the crumbs nav (keep project param in hrefs)
    total: m.total,
    subline: sublineHtml(m),           // the "N tickets · M in flight" span text
  };
}
```

   Extract the three shared helpers by moving today's inline template code verbatim out of `pageHtml` (exported so `viewEnvelope` + tests reach them):

```js
export function chipbarHtml(m) {
  const statuses = m.columns.map((c) => c.dir);
  const activeSet = new Set(activeStatuses(statuses));
  const activeCount = m.columns.filter((c) => activeSet.has(c.dir)).reduce((n, c) => n + c.tickets.length, 0);
  return `<nav class="chipbar" aria-label="Filter by status">
    <button type="button" class="chip" data-chip="all">All <span class="chip-n">${m.total}</span></button>
    <button type="button" class="chip" data-chip="active">Active <span class="chip-n">${activeCount}</span></button>
    ${m.columns.map((c) => `<button type="button" class="chip" data-status="${esc(c.dir)}">${esc(c.label)} <span class="chip-n">${c.tickets.length}</span></button>`).join("")}
  </nav>`;
}

export function crumbsHtml(m, project) {
  if (!m.focus) return "";
  const proj = project && project !== "all" ? `project=${esc(project)}` : "";
  return `<nav class="crumbs"><a href="?${proj}">All</a>${m.focus.crumbs
    .map((c) => ` › <a href="?focus=${esc(c.id)}${proj ? "&" + proj : ""}">${esc(c.id)}${c.title ? " · " + esc(c.title) : ""}</a>`)
    .join("")}</nav>`;
}

export function sublineHtml(m) {
  const inflight = m.columns.filter((c) => ["todo", "in-progress", "in-review"].includes(c.dir)).reduce((n, c) => n + c.tickets.length, 0);
  return `${m.total} tickets · ${inflight} in flight`;
}
```

   `pageHtml` calls the same three (its inline copies are deleted). Note `crumbsHtml` deliberately fixes the crumb hrefs to preserve `project` (was dropped before — Task 4 relies on this).
4. Wrap each view's `clientScript` into the registry instead of bare inline execution. **Init contract: `init()` runs after EVERY swap-in (and once on first load for the server-rendered view); it must rebind element-level listeners inside `#viewhost` and must NOT duplicate global side effects (intervals, listeners on nodes outside `#viewhost`).** Three view-module edits make the scripts honour that contract:
   - `scripts/views/live.mjs` `clientScript`: delete the pill-binding line (`document.querySelectorAll('.viewtoggle .pill[data-view="live"]')…` — the registry now triggers polls) and replace the tail `pollLive(); setInterval(pollLive, 3000);` with:

```js
    if (!window.__blazeLiveTimer) window.__blazeLiveTimer = setInterval(pollLive, 3000);
    pollLive();
```

   - `scripts/views/metrics.mjs` `clientScript`: delete its pill-binding block (`document.querySelectorAll('.viewtoggle .pill[data-view="metrics"]')…`) — `.mrange` bindings and the trailing `drawCfd()` stay (they target swapped-in nodes, so re-running per swap is exactly right; there are no intervals).
   - `scripts/views/map.mjs` `clientScript`: unchanged — it binds only the swapped-in `svg` and must re-run per swap.

   In the page template replace `<script>${live.clientScript}</script>` and `<script>${panel.clientScript}${metrics.clientScript}${map.clientScript}</script>` with:

```js
<script>
  window.blazeViews = {
    board: { init: function () { window.blazeBindZones && window.blazeBindZones(); window.blazeApplyBoardPill && window.blazeApplyBoardPill(); } },
    list:  { init: function () { window.blazeBindZones && window.blazeBindZones(); window.blazeApplyBoardPill && window.blazeApplyBoardPill(); } },
    live:  { init: function () { ${live.clientScript} } },
    metrics: { init: function () { ${metrics.clientScript} } },
    map:   { init: function () { ${map.clientScript} } },
  };
  ${panel.clientScript}
</script>
```

   and:
   - move the existing drop-zone binding loop (`for (const zone of document.querySelectorAll(".col[data-status], .group[data-status]"))`) into a `window.blazeBindZones = function () { … }` (listeners die with swapped nodes; binding fresh each init cannot duplicate);
   - in the boardtoggle IIFE, expose the saved-selection re-apply as `window.blazeApplyBoardPill = function () { const fromHash = params().get("board"); let saved = null; try { saved = localStorage.getItem("tracker.board"); } catch {} show(names.includes(fromHash) ? fromHash : (names.includes(saved) ? saved : names[0])); }` and call it at load — board/list init re-applies it so multi-board markup (delivery+risk) swaps in with the right board hidden;
   - **chipbar fix (it gets replaced by swaps):** in the filters IIFE, stop capturing the chipbar node — bind the chip-click handler at `document` level (`document.addEventListener("click", (e) => { const chip = e.target.closest(".chipbar .chip"); … })`) and have `applyFilters` re-query `document.querySelector(".chipbar")` each call.
5. Split view-state from fetching: `applyView(v)` stays synchronous and ONLY flips `data-view` + pill `.on` classes + localStorage (delete its parse-time invocation at the bottom of the toggle script — first-load init is handled once, after the registry, see item 6). Pill clicks call `swapView(v)`. Add (AFTER the toast/blazePost script block, so `toast` exists):

```js
async function swapView(v) {
  const q = new URLSearchParams(location.search);
  q.delete("view"); const qs = q.toString();
  const r = await fetch("/view/" + v + (qs ? "?" + qs : ""));
  if (!r.ok) { toast("view fetch failed"); return; }
  const j = await r.json();
  const host = document.getElementById("viewhost");
  host.innerHTML = j.html; host.dataset.rendered = v;
  document.querySelector(".chipbar").outerHTML = j.chipbar;
  var crumbs = document.querySelector(".crumbs");
  if (crumbs) crumbs.outerHTML = j.crumbs; // j.crumbs may be "" — that removes stale crumbs correctly
  else if (j.crumbs) document.querySelector(".chipbar").insertAdjacentHTML("afterend", j.crumbs);
  document.querySelector("header.top .sub").textContent = j.subline;
  applyView(v);
  (window.blazeViews[v] || { init: function () {} }).init();
  window.blazeFilters && window.blazeFilters.apply();
}
window.blazeSwapView = swapView;
```

6. First-load init runs exactly once, in the FINAL script block (registry + panel already defined; nothing racy earlier — `applyView`'s old parse-time call is gone per item 5):

```js
(function () {
  const host = document.getElementById("viewhost");
  const saved = document.documentElement.dataset.view || "board"; // set pre-paint from localStorage
  if (saved !== host.dataset.rendered) { swapView(saved); }        // fetches + inits
  else { applyView(saved); (window.blazeViews[saved] || { init: function () {} }).init(); }
})();
```
7. Keep ALL views' `styles` inlined as today (CSS is not the weight; avoids FOUC on swap).

`scripts/serve.mjs`:

```js
import { gzipSync } from "node:zlib";
import { pageHtml, viewEnvelope, CSRF } from "./views/page.mjs";

function send(req, res, code, type, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length >= 1024 && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
    res.writeHead(code, { "content-type": type, "content-encoding": "gzip" });
    res.end(gzipSync(buf)); return;
  }
  res.writeHead(code, { "content-type": type });
  res.end(buf);
}
```

- Route `GET /view/<name>`:

```js
const vm = req.method === "GET" && u.pathname.match(/^\/view\/([a-z]+)$/);
if (vm) {
  const envelope = viewEnvelope({
    view: vm[1],
    project: u.searchParams.get("project") || "all",
    focus: u.searchParams.get("focus") || null,
    flat: u.searchParams.get("flat") === "1",
    projectsDir,
  });
  if (!envelope) return json(404, { errors: ["unknown view"] });
  return send(req, res, 200, "application/json", JSON.stringify(envelope));
}
```

- `GET /` passes `view: u.searchParams.get("view") || "board"` into `pageHtml` and responds via `send(req, res, 200, "text/html; charset=utf-8", …)`. Route `json()` bodies through `send` too.

- [ ] **Step 4: Regenerate the golden deliberately**

`rm tests/views/page-golden.html && node --test tests/views/page-golden.test.mjs` (captures new baseline) then `git diff --stat` and eyeball `tests/views/page-golden.html` — it must contain board markup only.

- [ ] **Step 5: Full suite** — `node --test tests/` → PASS. Known casualties to update (behaviour moved, not removed):
  - `tests/serve-endpoints.test.mjs:331` `"pageHtml wires the Live view pill, region and poll"` — asserts `class="live"` on `GET /` markup; keep the `data-view="live"` pill + `/api/live` assertions against the page, move the `class="live"` markup assertion to the `/view/live` envelope.
  - `tests/views/page.test.mjs:18-19` — multi-view inlining assertions; re-point list/map markup checks at `viewEnvelope({view:"list"…})` / `viewEnvelope({view:"map"…})`.
  - `tests/serve.test.mjs` has NO markup assertions (boardModel only) — do not touch it.

- [ ] **Step 6: Commit**

```bash
git add -- scripts/views/page.mjs scripts/serve.mjs tests/serve-endpoints.test.mjs tests/views/page.test.mjs tests/views/page-golden.html
git commit -m "BLZ-91: render only the active view; /view fragments; gzip" -m "Golden regenerated intentionally: page now inlines a single view."
```

---

### Task 3 (BLZ-92): scoped `/api/hash` + fragment refresh instead of `location.reload()`

**Files:**
- Modify: `scripts/views/data.mjs` (`contentHash(scope)`)
- Modify: `scripts/serve.mjs` (`/api/hash` params)
- Modify: `scripts/views/page.mjs` (client: poll + post-mutation refresh)
- Test: extend `tests/views/data.test.mjs`, `tests/serve-endpoints.test.mjs`

**Interfaces:**
- Produces: `contentHash({ project } = {})` — hashes only `projectsDir/<project>` when given, whole tree otherwise.
- Produces: `GET /api/hash?project=<KEY>` — scoped hash.
- Produces: client `refresh()` — replaces every `location.reload()` in page.mjs scripts: re-fetches the current view envelope via `swapView(current)` (Task 2), preserving scroll and open panel.

- [ ] **Step 1: Failing tests**

`tests/views/data.test.mjs` — add:

```js
test("contentHash scoped to a project ignores other projects' changes", () => {
  const dir = fixtureTwoProjects(); // does NOT exist yet — write it in this file, following its existing single-project fixture helper's style (T + U projects, one ticket each)
  const scopedBefore = contentHash({ projectsDir: dir, project: "T" });
  const wholeBefore = contentHash({ projectsDir: dir });
  writeFileSync(join(dir, "U", "todo", "U-1.md"), "---\nid: U-1\ntitle: changed\ntype: task\nproject: U\nestimate: 5\n---\nx\n");
  assert.equal(contentHash({ projectsDir: dir, project: "T" }), scopedBefore); // T-scope blind to U
  assert.notEqual(contentHash({ projectsDir: dir }), wholeBefore);             // whole tree sees it
});
```

(Note: `contentHash` currently hardcodes `resolveRoots().projectsDir` — give it `{ projectsDir, project }` opts with the same default so it stays back-compatible and testable.)

`tests/serve-endpoints.test.mjs` — add: `GET /api/hash?project=T` returns 200 text and differs from `GET /api/hash?project=U` after touching only U.

- [ ] **Step 2: Run to verify failure** — the opts object is currently ignored → FAIL.

- [ ] **Step 3: Implement**

`data.mjs`:

```js
export function contentHash({ projectsDir = resolveRoots().projectsDir, project = null } = {}) {
  let h = 0;
  const rootDir = project ? join(projectsDir, project) : projectsDir;
  const stack = [rootDir];
  // …rest unchanged…
}
```

`serve.mjs`: `/api/hash` MUST pass the server's own resolved projectsDir (the ambient default hashes the wrong tree under the test fixture server — confirmed blocker):

```js
if (req.method === "GET" && u.pathname === "/api/hash") {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(contentHash({ projectsDir, project: u.searchParams.get("project") || null })); return;
}
```

`page.mjs` client changes:
1. The poll script builds its URL from the page's own scope: `const HASH_URL = "/api/hash" + (new URLSearchParams(location.search).get("project") ? "?project=" + encodeURIComponent(new URLSearchParams(location.search).get("project")) : "");` and on change calls `window.blazeSwapView(document.documentElement.dataset.view)` instead of `location.reload()`. (Focus scoping of the hash is deliberately project-granular — a focused view still refreshes on any change within its project; that's cheap now because refresh = one fragment fetch, not a document reload.)
2. `blazePost` success: replace `location.reload()` with `window.blazeSwapView(document.documentElement.dataset.view)` and `return true`.
3. `blazeEdit`'s two `location.reload()` escapes (unchanged value / Escape key): same replacement.
4. The reconcile button and board-pill scripts don't reload — untouched.
5. Scroll/panel: `swapView` only replaces `#viewhost` children + chipbar/crumbs — `window` scroll and the open `panel` element (outside viewhost) survive by construction. No extra work.

- [ ] **Step 4: Full suite + golden** — markup changes again (poll script text) → regenerate golden as in Task 2 Step 4.

- [ ] **Step 5: Manual verification against blaze-pm** (read-only GETs + one throwaway move): serve on :4599, open board, drag a BLZ ticket to another column and back — each move should visibly complete without a full-page flash; edit an OBA ticket file in the editor while viewing `?project=BLZ` — no refresh should occur. Undo the throwaway move (`blaze move` back) if not reverted by the drag-back.

- [ ] **Step 6: Commit**

```bash
git add -- scripts/views/data.mjs scripts/serve.mjs scripts/views/page.mjs tests/views/data.test.mjs tests/serve-endpoints.test.mjs tests/views/page-golden.html
git commit -m "BLZ-92: scoped /api/hash + fragment refresh replaces location.reload"
```

---

### Task 3.5: PR for epic BLZ-86

- [ ] `node --test tests/` + `npm run test:coverage` green locally.
- [ ] Re-run the Step-5 benchmark from Task 1; record final numbers on BLZ-86/90/91/92 AC lines (board tickets in blaze-pm — use `blaze edit`/hand-edit + queue).
- [ ] Run the code-review skill on the branch diff; summarise findings in the PR body.
- [ ] `cd ~/Documents/Code/blaze && gh pr create --base main --head BLZ-86-board-performance --title "BLZ-86: board performance — parse cache, active-view render, gzip, fragment refresh"` with body covering the three tickets + audit numbers + golden-regen note. Merge after CI green (admin-merge is normal); move BLZ-90/91/92 + BLZ-86 through `blaze move` with `blaze log` first.

---

## Epic BLZ-85 — branch `BLZ-85-nested-navigation` (cut AFTER BLZ-86 merges)

### Task 4 (BLZ-87): direct-children focus; parentless top level; `?flat=1`

**Files:**
- Modify: `scripts/model/focus.mjs`
- Modify: `scripts/views/data.mjs`
- Modify: `scripts/serve.mjs` (`flat` param on `/`), `scripts/views/page.mjs` (crumb hrefs keep project; drilldown links keep view state)
- Test: extend `tests/model/focus.test.mjs`, `tests/views/data.test.mjs`

**Interfaces:**
- Consumes: `boardModel(projectsDir, { project, focus, flat, index })` from Task 1.
- Produces: `focusScope(index, id)` → `{ crumbs, descendantIds, childrenIds }` (childrenIds = direct children only).
- Produces: `boardModel` scoping semantics: `focus` → direct children; no focus + `flat: false` → `parent == null` rows only; `flat: true` → today's whole-corpus behaviour.

- [ ] **Step 1: Failing model tests**

`tests/model/focus.test.mjs` — add (**the file's stub helper is named `fakeIndex`** — use it, adapting the row shape to its real signature):

```js
test("focusScope exposes direct children separately from descendants", () => {
  // G-1 ← E-1 ← T-1 ; G-1 ← E-2
  const idx = fakeIndex([
    { id: "G-1", parent: null }, { id: "E-1", parent: "G-1" },
    { id: "E-2", parent: "G-1" }, { id: "T-1", parent: "E-1" },
  ]);
  const s = focusScope(idx, "G-1");
  assert.deepEqual([...s.childrenIds].sort(), ["E-1", "E-2"]);
  assert.deepEqual([...s.descendantIds].sort(), ["E-1", "E-2", "T-1"]);
});
```

`tests/views/data.test.mjs` — add three: (a) no focus → only parentless tickets in columns; (b) `focus: "G-1"` → exactly E-1+E-2; (c) `flat: true` → all four. Build the fixture with a goal file, two epics parented to it, one task parented to an epic (four .md files, same fixture style as the file's existing helpers).

- [ ] **Step 2: Run to verify failure** — `node --test tests/model/focus.test.mjs tests/views/data.test.mjs` → FAIL (`childrenIds` undefined; unfocused board shows all 4).

- [ ] **Step 3: Implement**

`focus.mjs` — inside `focusScope`, after building `childrenOf`:

```js
const childrenIds = new Set(childrenOf.get(id) || []);
```

and return `{ crumbs, descendantIds, childrenIds }`. (Keep `descendantIds` — rollups and future map v2 use the full closure.)

`data.mjs` — in `boardModel`, replace the `scoped` line:

```js
const scoped = focused
  ? rows.filter((t) => scope.childrenIds.has(t.meta.id))
  : (flat ? rows : rows.filter((t) => !t.meta.parent));
```

`serve.mjs` — `GET /` passes `flat: u.searchParams.get("flat") === "1"` into `pageHtml`; `pageHtml` forwards it to `boardModel` and into the poll/fragment query (Task 2's `swapView` already forwards `location.search`, which carries `flat=1`).

**Metrics keeps whole-scope data (confirmed regression otherwise):** `metricsModel` flattens the board columns it's given, so a parentless-only default board would silently rescope Metrics to goals/epics. In `renderView`'s `metrics` case, build the metrics input from an explicitly flat model, reusing the already-built index:

```js
case "metrics": {
  const txns = transitions === undefined ? loadTransitions({ root: resolveRoots().dataRoot }).transitions : transitions;
  const mFlat = boardModel(pDir, { project, flat: true, index: m.index }); // cheap post-cache; whole project scope
  return `<div class="metricsview">${metrics.render(metricsModel({ board: mFlat, transitions: txns, now, project }))}</div>`;
}
```

Add a data.test.mjs assertion: `viewEnvelope({view:"metrics"})`'s html reflects all four fixture tickets (not just the parentless two).

`page.mjs` — crumbs: root crumb href becomes `?${project !== "all" ? "project=" + esc(project) : ""}` (keep project on drill-up); add a `Flat` link beside the crumbs when nested (`<a href="?flat=1${project…}">flat</a>`) and a crumb-style link back when `flat=1`. Card/row drilldown links (board.mjs/list.mjs) already carry `?focus=` + project — unchanged.

- [ ] **Step 4: Full suite + golden** — the golden fixture (T-1 task, T-2 epic, both parentless) still renders both at top level, but if bytes change (crumb/flat link), regenerate deliberately as before.

- [ ] **Step 5: Manual drill check against blaze-pm** — serve :4599: `/` shows only goals per project; click a goal's ⤵ → its epics; epic ⤵ → children; crumbs walk back up; `?flat=1` restores the old wall.

- [ ] **Step 6: Commit**

```bash
git add -- scripts/model/focus.mjs scripts/views/data.mjs scripts/serve.mjs scripts/views/page.mjs tests/model/focus.test.mjs tests/views/data.test.mjs tests/views/page-golden.html
git commit -m "BLZ-87: goals-first nesting — direct-children focus, parentless top level, ?flat=1"
```

---

### Task 5 (BLZ-88): `views:` config toggle; blaze-pm switches Map off

**Files:**
- Modify: `scripts/config.mjs`, `scripts/views/page.mjs`, `scripts/serve.mjs`
- Test: extend `tests/config.test.mjs`, `tests/serve-endpoints.test.mjs`
- (Data repo, at rollout: `~/Documents/Code/blaze-pm/blaze.config.json`)

**Interfaces:**
- Produces: `cfg.views` — `{ board: true, list: true, live: true, metrics: true, map: true }` merged over file's `views` object; `board` is forced `true` (the default render needs one view).
- Produces: **`views` plumbed as an option** — `pageHtml({ …, views })` and `viewEnvelope({ …, views })` default to the module-level `cfg.views`; `startServer({ …, views })` forwards its value to both. (page.mjs's `cfg` is loaded once at import from the ambient root, so a fixture `blaze.config.json` can never reach it in-process — the option is what makes this testable AND what lets a future supervisor pass per-board config.)
- Produces: disabled view ⇒ no pill in the toggle, `/view/<name>` → 404, zero model computation.

- [ ] **Step 1: Failing tests**

`tests/config.test.mjs` (this file's helper is `withConfig` — reuse it, do not invent `mkTmpConfig`):

```js
test("views config merges over all-on defaults and cannot disable board", () => {
  withConfig({ views: { map: false, board: false } }, (root) => {
    const cfg = loadConfig({ root });
    assert.deepEqual(cfg.views, { board: true, list: true, live: true, metrics: true, map: false });
    // board: false in the file is overridden — the shell always needs its default view
  });
});
```

(Match `withConfig`'s real signature from the file before writing — adapt the callback/return shape to the local pattern.)

`tests/serve-endpoints.test.mjs` — boot the fixture server with the option, not a config file: `startServer({ projectsDir: projects, root, port: 0, views: { …allOn, map: false } })` (copy the file's per-test `boot()` pattern) — then `GET /view/map` → 404 and `GET /` HTML has no `data-view="map"` pill while still having the board pill.

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement**

`config.mjs` DEFAULTS gains `views: { board: true, list: true, live: true, metrics: true, map: true }`; after the spread:

```js
cfg.views = { ...DEFAULTS.views, ...(file.views && typeof file.views === "object" ? file.views : {}) };
cfg.views.board = true; // the shell always needs its default view
```

`config.mjs` also: `loadConfig` forces `cfg.views.board = true` after the merge.

`page.mjs`: `pageHtml`/`viewEnvelope` gain `views = cfg.views` in their options; the viewtoggle maps over `VIEW_NAMES.filter((v) => views[v])`; `viewEnvelope` returns null when `!views[view]` (serve.mjs already 404s null envelopes); the first-load saved-view reconciliation falls back to "board" when the saved view's pill is absent (`document.querySelector('.viewtoggle .pill[data-view="'+saved+'"]') || (saved = "board")`).

`serve.mjs`: `startServer({ …, views })` — default `undefined` (page.mjs falls back to its cfg) — forwarded into every `pageHtml`/`viewEnvelope` call; verify a disabled view really is unreachable via the endpoint test.

- [ ] **Step 4: Full suite + golden** (pill markup unchanged for default config → golden should NOT change this task; if it does, stop and find out why).

- [ ] **Step 5: Docs + commit**

Document `views:` in `AGENTS.md` (config section) and `README.md`; note the fragment endpoint in `docs/architecture.md`'s serve section.

```bash
git add -- scripts/config.mjs scripts/views/page.mjs scripts/serve.mjs tests/config.test.mjs tests/serve-endpoints.test.mjs AGENTS.md README.md docs/architecture.md
git commit -m "BLZ-88: config-gated view toggles (views: {name: false})"
```

---

### Task 6: PR for epic BLZ-85 + rollout

- [ ] Suite + coverage green; code-review skill on the branch; PR `BLZ-85: nested navigation — goals-first drill-down + view toggles`, merge after CI.
- [ ] Version bump + `npm publish` (**needs operator TOTP — the one manual step**).
- [ ] blaze-pm: `npm install @hjr15/blaze-board@<new>` , set `"views": { "map": false }` in `blaze.config.json`, restart the board, verify nested drill-down + map pill gone live.
- [ ] Board bookkeeping: `blaze log` + `blaze move` BLZ-87/88 → done, epics BLZ-85/86 → done after their PRs merge; BLZ-89 stays defined (deferred).

## Verification (whole plan)

- `node --test tests/` and `npm run test:coverage` green at every commit.
- Benchmarks recorded on tickets: TTFB ≤450ms target (expect ~150–250ms warm), default-page payload ≪1MB gzipped, move/edit interaction with no full reload.
- `verify` skill run on the final board against blaze-pm data before the PRs merge.
