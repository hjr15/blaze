// page.mjs — composes the single-page board document (the switcher shell).
// Moved verbatim out of serve.mjs (Task 7 of the serve.mjs decomposition) so
// serve.mjs can shrink to routing + /api/* handlers.

import { randomUUID } from "node:crypto";
import { loadConfig, resolveRoots } from "../config.mjs";
import { PRIORITIES } from "../model/schema.mjs";
import { esc } from "./render-lib.mjs";
import { activeStatuses } from "../model/filters.mjs";
import { boardModel } from "./data.mjs";
import { metricsModel } from "../model/metrics.mjs";
import { graphModel } from "../model/graph.mjs";
import { loadTransitions } from "../model/transitions.mjs";
import * as live from "./live.mjs";
import * as board from "./board.mjs";
import * as list from "./list.mjs";
import * as panel from "./panel.mjs";
import * as metrics from "./metrics.mjs";
import * as map from "./map.mjs";

const cfg = loadConfig({ root: resolveRoots().dataRoot });

export const CSRF = randomUUID();

// ---- view registry --------------------------------------------------------

// How to render each view's fragment. metrics/map compute their models
// lazily — only when that view is actually requested — so GET / (which
// always renders "board") never pays for the metrics/graph walk.
export function renderView(name, { m, pDir, project, now, transitions }) {
  switch (name) {
    case "board": return board.render(m);
    case "list": return list.render(m);
    case "live": return live.render();
    case "metrics": {
      const txns = transitions === undefined ? loadTransitions({ root: resolveRoots().dataRoot }).transitions : transitions;
      const mFlat = boardModel(pDir, { project, flat: true, index: m.index }); // cheap post-cache; whole project scope
      return `<div class="metricsview">${metrics.render(metricsModel({ board: mFlat, transitions: txns, now, project }))}</div>`;
    }
    case "map": return `<div class="mapview">${map.render(graphModel({ projectsDir: pDir, project, index: m.index }))}</div>`;
    default: return null;
  }
}
export const VIEW_NAMES = ["board", "list", "live", "metrics", "map"];

// ---- shared fragments (chipbar / crumbs / subline) -------------------------
// Extracted so pageHtml (full document) and viewEnvelope (JSON fragment for a
// swap) render byte-identical chrome from one source.

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

export function crumbsHtml(m, project, flat = false) {
  if (!m.focus && !flat) return "";
  const proj = project && project !== "all" ? `project=${esc(project)}` : "";
  // Goals-first nesting (BLZ-87) is the default: no-focus shows parentless
  // tickets only, focus shows direct children only. `flat` is the escape
  // hatch back to the old whole-corpus wall — toggle it beside the crumbs
  // (or on its own when there's no focus but flat=1 is set).
  const flatToggle = flat
    ? `<a href="?${proj}">nested</a>`
    : `<a href="?flat=1${proj ? "&" + proj : ""}">flat</a>`;
  if (!m.focus) return `<nav class="crumbs">Flat view · ${flatToggle}</nav>`;
  return `<nav class="crumbs"><a href="?${proj}">All</a>${m.focus.crumbs
    .map((c) => ` › <a href="?focus=${esc(c.id)}${proj ? "&" + proj : ""}">${esc(c.id)}${c.title ? " · " + esc(c.title) : ""}</a>`)
    .join("")} · ${flatToggle}</nav>`;
}

export function sublineHtml(m) {
  const inflight = m.columns.filter((c) => ["todo", "in-progress", "in-review"].includes(c.dir)).reduce((n, c) => n + c.tickets.length, 0);
  return `${m.total} tickets · ${inflight} in flight`;
}

// ---- JSON fragment envelope (client swap target) ---------------------------

export function viewEnvelope({ project = "all", focus = null, flat = false, view = "board", projectsDir: _pDir, now = Date.now(), transitions, views = cfg.views } = {}) {
  if (!VIEW_NAMES.includes(view) || !views[view]) return null;
  const pDir = _pDir ?? resolveRoots().projectsDir;
  const m = boardModel(pDir, { project, focus, flat });
  return {
    view,
    html: renderView(view, { m, pDir, project, now, transitions }),
    chipbar: chipbarHtml(m),
    crumbs: crumbsHtml(m, project, flat),
    total: m.total,
    subline: sublineHtml(m),
  };
}

// ---- render -------------------------------------------------------------

export function pageHtml({
  project = "all",
  focus = null,
  flat = false,
  view = "board",
  afterHeader = "",
  beforeBodyEnd = "",
  projectsDir: _pDir,
  now = Date.now(),
  transitions,
  views = cfg.views,
} = {}) {
  const pDir = _pDir ?? resolveRoots().projectsDir;
  const m = boardModel(pDir, { project, focus, flat });
  const { columns: cols, projects, selected } = m;
  const boards = m.boards || [];
  const boardToggle = boards.length > 1
    ? `<div class="boardtoggle" role="group" aria-label="Board">${boards
        .map((b, i) => `<button type="button" class="bpill${i === 0 ? " on" : ""}" data-board-pill="${esc(b.name)}">${esc(b.label)}</button>`)
        .join("")}</div>`
    : "";
  const chipbar = chipbarHtml(m);
  const crumbs = crumbsHtml(m, project, flat);
  const statuses = cols.map((c) => c.dir);

  return `<!doctype html>
<html lang="en" data-view="board">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cfg.boardTitle}</title>
<script>
  window.__csrf = "${CSRF}";
  // Set the saved view before paint so there's no flash of the wrong layout.
  try { document.documentElement.dataset.view = localStorage.getItem("tracker.view") || "board"; } catch {}
</script>
<style>
  :root {
    color-scheme: dark;
    --blaze-red: #FF3B1F;
    --blaze-orange: #FF7A00;
    --blaze-amber: #FFC107;
    --charcoal: #0F172A;
    --neutral: #F6F7F9;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: var(--charcoal); color: var(--neutral);
  }
  header.top {
    position: sticky; top: 0; z-index: 5; display: flex; align-items: baseline;
    flex-wrap: wrap; gap: 12px; padding: 14px 20px; background: #0F172Aee;
    border-bottom: 1px solid #21262d; backdrop-filter: blur(6px);
  }
  header.top h1 { font-size: 15px; margin: 0; letter-spacing: .3px; }
  header.top .sub { color: #7d8590; font-size: 12px; }${board.styles}
  .body {
    margin-top: 10px; padding-top: 10px; border-top: 1px solid #2d333b;
    color: #c9d1d9; font-size: 13px;
  }
  .body h4 { margin: 10px 0 4px; font-size: 12px; text-transform: uppercase; color: #adbac7; letter-spacing: .4px; }
  .body p { margin: 4px 0; }
  .body ul.md { margin: 4px 0; padding-left: 18px; }
  .body li.task { list-style: none; margin-left: -18px; }
  .body code { background: #2d333b; padding: 1px 4px; border-radius: 4px; font-size: 12px; }

  /* ---- view toggle ---- */
  .viewtoggle { display: flex; gap: 2px; padding: 2px; background: #161b22; border: 1px solid #21262d; border-radius: 8px; }
  .viewtoggle .pill {
    appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    padding: 4px 12px; border-radius: 6px; color: #7d8590; background: transparent; transition: color .12s, background .12s;
  }
  .viewtoggle .pill:hover { color: #adbac7; }
  .viewtoggle .pill.on { color: var(--charcoal); background: var(--blaze-orange); }

  /* ---- view switching ---- */
  html[data-view="board"] .list { display: none; }
  html[data-view="list"]  .board { display: none; }
  html[data-view="live"] .board, html[data-view="live"] .list { display: none; }
  html[data-view="board"] .live, html[data-view="list"] .live { display: none; }
  html:not([data-view="metrics"]) .metricsview { display: none; }
  html[data-view="metrics"] .board, html[data-view="metrics"] .list, html[data-view="metrics"] .live { display: none; }
  html:not([data-view="map"]) .mapview { display: none; }
  html[data-view="map"] .board, html[data-view="map"] .list, html[data-view="map"] .live { display: none; }

  /* ---- board switching (per-workflow) ---- */
  .boardtoggle { display: flex; gap: 2px; padding: 2px; background: #161b22; border: 1px solid #21262d; border-radius: 8px; }
  .boardtoggle .bpill { appearance: none; border: 0; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    padding: 4px 12px; border-radius: 6px; color: #7d8590; background: transparent; }
  .boardtoggle .bpill:hover { color: #adbac7; }
  .boardtoggle .bpill.on { color: var(--charcoal); background: var(--blaze-amber); }
  .board.board-hidden, .list.board-hidden { display: none !important; }${live.styles}${list.styles}
  .prlink { color: #58a6ff; text-decoration: none; font-weight: 600; }
  .prlink:hover { text-decoration: underline; }
  .row > .body { margin: 0 12px 12px 12px; }
  .row.prio-urgent  { border-left-color: var(--blaze-red); }
  .row.prio-high    { border-left-color: var(--blaze-orange); }
  .row.prio-medium  { border-left-color: var(--blaze-amber); }
  #live { color: var(--blaze-orange); }
  .proj { color: #7d8590; text-decoration: none; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 6px; }
  .proj:hover { color: #adbac7; }
  .proj.on { color: var(--charcoal); background: var(--blaze-amber); }
  @media (max-width: 640px) {
    .row .rmeta, .row .rbadges .label { display: none; }
  }
  #toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: #4b1113;
    color: var(--neutral); border: 1px solid var(--blaze-red); padding: 8px 14px; border-radius: 8px;
    font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 20; max-width: 80vw; }
  #toast.show { opacity: 1; }
  .card[draggable="true"], .row[draggable="true"] { cursor: grab; }
  .col.drop-hover, .group.drop-hover { outline: 2px dashed var(--blaze-orange); outline-offset: -2px; }
  .search { background: #161b22; border: 1px solid #21262d; border-radius: 8px; color: var(--neutral);
    font: inherit; font-size: 13px; padding: 5px 10px; width: min(240px, 40vw); }
  .search:focus { outline: none; border-color: var(--blaze-orange); }
  .search::placeholder { color: #7d8590; }
  .card.filtered-out, .row.filtered-out { display: none !important; }
  .chipbar { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 20px;
    background: #0F172Acc; border-bottom: 1px solid #21262d; }
  .chip { appearance: none; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
    border: 1px solid #21262d; background: #161b22; color: #adbac7; }
  .chip:hover { color: var(--neutral); border-color: #30363d; }
  .chip.on { color: var(--charcoal); background: var(--blaze-amber); border-color: var(--blaze-amber); }
  .chip .chip-n { color: #7d8590; font-size: 11px; font-weight: 600; }
  .chip.on .chip-n { color: var(--charcoal); }
  .crumbs { padding: 8px 20px; font-size: 12px; color: #7d8590; background: #0F172Acc; border-bottom: 1px solid #21262d; }
  .crumbs a { color: #58a6ff; text-decoration: none; font-weight: 600; }
  .crumbs a:hover { text-decoration: underline; }${panel.styles}${metrics.styles}${map.styles}
</style>
</head>
<body>
  <div id="toast" role="status"></div>
  <header class="top">
    <h1>${cfg.boardTitle}</h1>
    <span class="sub">${sublineHtml(m)}</span>
    ${["all", ...Object.keys(projects)].map((k) =>
      `<a class="proj ${k === selected ? "on" : ""}" href="${k === "all" ? "/" : "/?project=" + esc(k)}">${k === "all" ? "All" : esc(k)}${k === "all" ? "" : ` <span class="count">${projects[k]}</span>`}</a>`
    ).join("")}
    <input id="board-search" class="search" type="search" placeholder="Search…" aria-label="Search tickets" autocomplete="off" style="margin-left:auto">
    ${boardToggle}
    <div class="viewtoggle" role="group" aria-label="View">
      ${VIEW_NAMES.filter((v) => views[v]).map((v) =>
        `<button type="button" class="pill" data-view="${v}">${v.charAt(0).toUpperCase()}${v.slice(1)}</button>`
      ).join("\n      ")}
    </div>
    <button type="button" id="reconcileBtn" class="pill" style="background:#161b22;border:1px solid #21262d;border-radius:6px;color:#adbac7;cursor:pointer;font:inherit;font-size:12px;font-weight:600;padding:4px 12px">Reconcile (dry-run)</button>
    <span class="sub" id="live">live</span>
    <span class="sub" id="sync"></span>
  </header>
  ${chipbar}
  ${crumbs}
  ${afterHeader}
  <div id="viewhost" data-rendered="${esc(view)}">${renderView(view, { m, pDir, project, now, transitions })}</div>
  <script>
    // View toggle (Board / List), persisted to localStorage. Synchronous only —
    // flips data-view + pill state + localStorage. Fetching/swapping the actual
    // view markup is swapView's job (defined below, after toast/blazePost).
    const VIEW_KEY = "tracker.view";
    function applyView(v) {
      document.documentElement.dataset.view = v;
      document.querySelectorAll(".viewtoggle .pill").forEach((b) =>
        b.classList.toggle("on", b.dataset.view === v));
      try { localStorage.setItem(VIEW_KEY, v); } catch {}
    }
    document.querySelectorAll(".viewtoggle .pill").forEach((b) =>
      b.addEventListener("click", () => window.blazeSwapView(b.dataset.view)));
  </script>
  <script>
    (function () {
      const pills = [...document.querySelectorAll(".boardtoggle .bpill")];
      if (!pills.length) return;
      const names = pills.map((p) => p.dataset.boardPill);
      const params = () => new URLSearchParams((location.hash || "").replace(/^#/, ""));
      function show(sel) {
        document.querySelectorAll(".board[data-board], .list[data-board]").forEach((el) =>
          el.classList.toggle("board-hidden", el.dataset.board !== sel));
        pills.forEach((p) => p.classList.toggle("on", p.dataset.boardPill === sel));
      }
      function pick(name) {
        const sel = names.includes(name) ? name : names[0];
        show(sel);
        try { localStorage.setItem("tracker.board", sel); } catch {}
        const h = params(); h.set("board", sel); location.hash = h.toString();  // preserves status=
      }
      pills.forEach((p) => p.addEventListener("click", () => pick(p.dataset.boardPill)));
      // Re-applied on every board/list init (multi-board markup swaps in with
      // the right board hidden, since #viewhost's DOM was just replaced).
      window.blazeApplyBoardPill = function () {
        const fromHash = params().get("board");
        let saved = null; try { saved = localStorage.getItem("tracker.board"); } catch {}
        show(names.includes(fromHash) ? fromHash : (names.includes(saved) ? saved : names[0]));
      };
      window.blazeApplyBoardPill();
    })();
  </script>
  <script>
    // Poll a cheap content hash, scoped to the page's own ?project=; refresh
    // in place (swapView) only when ticket files actually change. Focus
    // scoping is deliberately project-granular, not focus-granular — cheap
    // now that refresh is one fragment fetch instead of a document reload.
    // Also updates the sync badge with unsynced-commits count.
    const HASH_PROJECT = new URLSearchParams(location.search).get("project");
    const HASH_URL = "/api/hash" + (HASH_PROJECT ? "?project=" + encodeURIComponent(HASH_PROJECT) : "");
    let last = null;
    async function poll() {
      try {
        const h = await (await fetch(HASH_URL)).text();
        if (last !== null && h !== last) window.blazeSwapView(document.documentElement.dataset.view);
        last = h;
        document.getElementById("live").textContent = "live";
        const s = await (await fetch("/api/sync")).json();
        document.getElementById("sync").textContent = s.ahead > 0 ? "⇧ " + s.ahead + " ahead" : "";
      } catch {
        document.getElementById("live").textContent = "offline";
      }
    }
    poll();
    setInterval(poll, 3000);
  </script>
  <script>
    const CSRF = window.__csrf;
    function toast(msg) {
      const el = document.getElementById("toast");
      el.textContent = msg; el.classList.add("show");
      clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 4000);
    }
    async function blazePost(path, body) {
      try {
        const res = await fetch(path, { method: "POST",
          headers: { "content-type": "application/json", "x-blaze-csrf": CSRF }, body: JSON.stringify(body) });
        if (res.ok) { window.blazeSwapView(document.documentElement.dataset.view); return true; }
        const j = await res.json().catch(() => ({ errors: [res.statusText] }));
        toast((j.errors || ["error"]).join("; ")); return false;
      } catch (e) { toast("network error: " + e.message); return false; }
    }
    // Drag-to-transition: we never move the DOM ourselves — success reloads,
    // failure leaves the card where it was (automatic snap-back).
    let dragId = null, dragSourceStatus = null;
    document.addEventListener("dragstart", (e) => {
      const c = e.target.closest("[data-id]"); if (!c) return;
      dragId = c.dataset.id; e.dataTransfer.effectAllowed = "move";
      const col = c.closest("[data-status]");
      dragSourceStatus = col ? col.dataset.status : null;
    });
    // Drop zones are the board columns and list groups only. The status chips
    // also carry data-status (for filtering) but must never be move targets, so
    // scope the selector rather than matching every [data-status]. Bound fresh
    // on every view init — listeners die with the swapped-out nodes, so
    // re-binding each time cannot duplicate them.
    window.blazeBindZones = function () {
      for (const zone of document.querySelectorAll(".col[data-status], .group[data-status]")) {
        zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drop-hover"); });
        zone.addEventListener("dragleave", () => zone.classList.remove("drop-hover"));
        zone.addEventListener("drop", (e) => {
          e.preventDefault(); zone.classList.remove("drop-hover");
          if (dragId && dragSourceStatus !== zone.dataset.status) blazePost("/api/move", { id: dragId, to: zone.dataset.status });
          dragId = null; dragSourceStatus = null;
        });
      }
    };
    const PRIORITIES = ${JSON.stringify(PRIORITIES)};
    function blazeEdit(span) {
      const field = span.dataset.edit, id = span.closest("[data-ticket]").dataset.ticket;
      const cur = span.dataset.value || "";
      let input;
      if (field === "priority") {
        input = document.createElement("select");
        const opts = PRIORITIES.includes(cur) ? PRIORITIES : [cur, ...PRIORITIES];
        input.innerHTML = opts.map((p) => "<option" + (p === cur ? " selected" : "") + ">" + p + "</option>").join("");
      } else { input = document.createElement("input"); input.value = cur; input.size = 10; }
      span.replaceWith(input); input.focus();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const v = input.value.trim();
        if (v === cur) { window.blazeSwapView(document.documentElement.dataset.view); return; }
        blazePost("/api/edit", { id, patch: { [field]: v } });
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { done = true; window.blazeSwapView(document.documentElement.dataset.view); } });
    }
    document.addEventListener("click", (e) => {
      const span = e.target.closest(".editable");
      if (span) { e.preventDefault(); e.stopPropagation(); blazeEdit(span); return; }
      // Clicking a card/row ticket id opens the detail panel. preventDefault +
      // stopPropagation so it doesn't also toggle the inline <details> expand.
      const idEl = e.target.closest(".id");
      if (idEl) {
        const host = idEl.closest("[data-id]");
        if (host) { e.preventDefault(); e.stopPropagation(); window.blazePanel.open(host.dataset.id); }
      }
    });
    document.addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox][data-ac-index]"); if (!cb) return;
      const id = cb.closest("[data-ticket]").dataset.ticket;
      blazePost("/api/ac", { id, index: Number(cb.dataset.acIndex), checked: cb.checked });
    });
    document.getElementById("reconcileBtn")?.addEventListener("click", async () => {
      const j = await (await fetch("/api/reconcile-preview")).json();
      const lines = (j.changes || []).map((c) => c.id + ": " + c.from + " → " + c.to);
      toast(lines.length ? lines.length + " code-bound move(s) — apply via 'blaze reconcile --apply'" : "no code-bound changes");
    });
  </script>
  <script>
    // View swap: fetch the fragment for a view, replace #viewhost + chipbar +
    // crumbs + subline, then re-run that view's init(). Defined after the
    // toast/blazePost block above so toast() is in scope.
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
  </script>
  <script>
    // Client-side filtering: search + status chips COMPOSE — a card/row is
    // visible iff it passes both. Search matches the data-search index; a chip
    // constrains to a status set. Chip state lives in the URL hash
    // (#status=all|active|<status>) so filtered views are shareable and survive
    // reload. Zero server round-trip; edits/moves reload and re-render counts.
    (function () {
      const search = document.getElementById("board-search");
      const ACTIVE_STATUSES = ${JSON.stringify(activeStatuses(statuses)).replace(/</g, "\\u003c")};
      const ALL_STATUSES = ${JSON.stringify(statuses).replace(/</g, "\\u003c")};
      const hashParams = () => new URLSearchParams((location.hash || "").replace(/^#/, ""));
      function hashStatus() { return (hashParams().get("status") || "all").toLowerCase(); }
      function setHashStatus(v) {
        const h = hashParams(); h.set("status", v);
        location.hash = h.toString();   // fires hashchange -> applyFilters
      }
      // Mirrors model/filters.mjs statusFilter: all/empty/unknown -> null (show
      // all), so a stale or shared #status= for a renamed status doesn't blank
      // the board with no way to recover.
      function allowedStatuses(v) {
        if (!v || v === "all") return null;
        if (v === "active") return new Set(ACTIVE_STATUSES);
        if (ALL_STATUSES.includes(v)) return new Set([v]);
        return null;
      }
      function applyFilters() {
        const chipbar = document.querySelector(".chipbar"); // re-queried: chipbar is replaced on every view swap
        const q = ((search && search.value) || "").trim().toLowerCase();
        const sv = hashStatus();
        const allowed = allowedStatuses(sv);
        document.querySelectorAll("[data-id][data-search]").forEach((el) => {
          const passSearch = !q || (el.getAttribute("data-search") || "").includes(q);
          const container = el.closest("[data-status]");    // column / group carries the status
          const st = container ? container.getAttribute("data-status") : null;
          const passStatus = !allowed || (st !== null && allowed.has(st));
          el.classList.toggle("filtered-out", !(passSearch && passStatus));
        });
        if (chipbar) chipbar.querySelectorAll(".chip").forEach((chip) =>
          chip.classList.toggle("on", (chip.dataset.chip || chip.dataset.status) === sv));
      }
      if (search) search.addEventListener("input", applyFilters);
      // Chipbar fix: the chipbar node itself gets replaced on every view swap
      // (swapView sets .chipbar.outerHTML), so a listener bound to the node
      // dies with it. Delegate at document level instead.
      document.addEventListener("click", (e) => {
        const chip = e.target.closest(".chipbar .chip"); if (!chip) return;
        setHashStatus(chip.dataset.chip || chip.dataset.status);
      });
      window.addEventListener("hashchange", applyFilters);
      window.blazeFilters = { apply: applyFilters };
      applyFilters();
    })();
  </script>
  ${panel.render()}
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
  <script>
    // First-load init runs exactly once: if the client's saved view differs
    // from the server-rendered view, swap (fetches + inits); otherwise just
    // apply pill/localStorage state and run that view's init directly.
    (function () {
      const host = document.getElementById("viewhost");
      let saved = document.documentElement.dataset.view || "board"; // set pre-paint from localStorage
      // Fall back to "board" when the saved view's pill is absent (e.g. the
      // config disabled that view since it was last saved to localStorage).
      document.querySelector('.viewtoggle .pill[data-view="'+saved+'"]') || (saved = "board");
      if (saved !== host.dataset.rendered) { swapView(saved); }        // fetches + inits
      else { applyView(saved); (window.blazeViews[saved] || { init: function () {} }).init(); }
    })();
  </script>
  ${beforeBodyEnd}
</body>
</html>`;
}
