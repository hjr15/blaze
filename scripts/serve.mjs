#!/usr/bin/env node
// serve.mjs — a tiny, zero-dependency dashboard for the file-based tracker.
//
//   node scripts/serve.mjs            # serves http://localhost:<cfg.port>
//   PORT=8080 node scripts/serve.mjs  # custom port
//
// Reads the markdown tickets fresh on every request, so editing a file in your
// IDE and refreshing shows the change. The page also auto-reloads within a few
// seconds when any ticket file changes (it polls a cheap content hash), but
// never reloads while the files are untouched — so it won't fight you mid-read.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig, listProjects, resolveRoots } from "./config.mjs";
import { PRIORITIES } from "./model/schema.mjs";
import { applyMove } from "./move.mjs";
import { applyResolve } from "./resolve.mjs";
import { applyLog } from "./log.mjs";
import { applyEdit, applyToggleAc } from "./edit.mjs";
import { commitFile } from "./serve-commit.mjs";
import { esc, inline, prLink } from "./views/render-lib.mjs";
import { boardModel, contentHash, liveModel } from "./views/data.mjs";
import * as live from "./views/live.mjs";
import * as board from "./views/board.mjs";
import * as list from "./views/list.mjs";
import * as panel from "./views/panel.mjs";
import * as metrics from "./views/metrics.mjs";
import * as map from "./views/map.mjs";
export { boardModel, contentHash, liveModel }; // back-compat for tests + supervisor.mjs

const cfg = loadConfig({ root: resolveRoots().dataRoot });

const PORT = Number(process.env.PORT) || cfg.port;

export const CSRF = randomUUID();

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0, settled = false;
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > 256 * 1024) {
        settled = true;
        req.destroy();
        reject(new Error("too large"));
      } else {
        data += c;
      }
    });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", (e) => { if (!settled) reject(e); });
  });
}

function aheadCount(root) {
  const r = spawnSync("git", ["-C", root, "rev-list", "--count", "@{u}..HEAD"], { encoding: "utf8" });
  return r.status === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

// ---- render -------------------------------------------------------------

export function pageHtml({ project = "all", afterHeader = "", beforeBodyEnd = "", projectsDir: _pDir } = {}) {
  const m = boardModel(_pDir ?? resolveRoots().projectsDir, { project });
  const { columns: cols, total, projects, selected } = m;
  const boardHtml = board.render(m);
  const listHtml = list.render(m);

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
    gap: 12px; padding: 14px 20px; background: #0F172Aee;
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
  html[data-view="board"] .live, html[data-view="list"] .live { display: none; }${live.styles}${list.styles}
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
  .col.drop-hover, .group.drop-hover { outline: 2px dashed var(--blaze-orange); outline-offset: -2px; }${panel.styles}${metrics.styles}${map.styles}
</style>
</head>
<body>
  <div id="toast" role="status"></div>
  <header class="top">
    <h1>${cfg.boardTitle}</h1>
    <span class="sub">${total} tickets · ${cols.filter((c) => ["todo","in-progress","in-review"].includes(c.dir)).reduce((n,c)=>n+c.tickets.length,0)} in flight</span>
    ${["all", ...Object.keys(projects)].map((k) =>
      `<a class="proj ${k === selected ? "on" : ""}" href="${k === "all" ? "/" : "/?project=" + esc(k)}">${k === "all" ? "All" : esc(k)}${k === "all" ? "" : ` <span class="count">${projects[k]}</span>`}</a>`
    ).join("")}
    <div class="viewtoggle" role="group" aria-label="View" style="margin-left:auto">
      <button type="button" class="pill" data-view="board">Board</button>
      <button type="button" class="pill" data-view="list">List</button>
      <button type="button" class="pill" data-view="live">Live</button>
    </div>
    <button type="button" id="reconcileBtn" class="pill" style="background:#161b22;border:1px solid #21262d;border-radius:6px;color:#adbac7;cursor:pointer;font:inherit;font-size:12px;font-weight:600;padding:4px 12px">Reconcile (dry-run)</button>
    <span class="sub" id="live">live</span>
    <span class="sub" id="sync"></span>
  </header>
  ${afterHeader}
  ${boardHtml}
  ${listHtml}
  ${live.render()}
  <script>
    // View toggle (Board / List), persisted to localStorage.
    const VIEW_KEY = "tracker.view";
    function applyView(v) {
      document.documentElement.dataset.view = v;
      document.querySelectorAll(".viewtoggle .pill").forEach((b) =>
        b.classList.toggle("on", b.dataset.view === v));
      try { localStorage.setItem(VIEW_KEY, v); } catch {}
    }
    document.querySelectorAll(".viewtoggle .pill").forEach((b) =>
      b.addEventListener("click", () => applyView(b.dataset.view)));
    applyView(document.documentElement.dataset.view || "board");
  </script>
  <script>
    // Poll a cheap content hash; reload only when ticket files actually change.
    // Also updates the sync badge with unsynced-commits count.
    let last = null;
    async function poll() {
      try {
        const h = await (await fetch("/api/hash")).text();
        if (last !== null && h !== last) location.reload();
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
        if (res.ok) { location.reload(); return true; }
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
    for (const zone of document.querySelectorAll("[data-status]")) {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("drop-hover"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("drop-hover"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault(); zone.classList.remove("drop-hover");
        if (dragId && dragSourceStatus !== zone.dataset.status) blazePost("/api/move", { id: dragId, to: zone.dataset.status });
        dragId = null; dragSourceStatus = null;
      });
    }
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
        if (v === cur) { location.reload(); return; }
        blazePost("/api/edit", { id, patch: { [field]: v } });
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { done = true; location.reload(); } });
    }
    document.addEventListener("click", (e) => {
      const span = e.target.closest(".editable"); if (span) { e.preventDefault(); e.stopPropagation(); blazeEdit(span); }
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
  <script>${live.clientScript}</script>
  ${panel.render()}
  <script>${panel.clientScript}${metrics.clientScript}${map.clientScript}</script>
  ${beforeBodyEnd}
</body>
</html>`;
}

// ---- server factory ---------------------------------------------------------

export function startServer({ projectsDir = resolveRoots().projectsDir, root = resolveRoots().dataRoot, port = PORT, host = process.env.HOST || "127.0.0.1" } = {}) {
  return createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

    if (req.method === "GET" && u.pathname === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" }); res.end(contentHash()); return;
    }
    if (req.method === "GET" && u.pathname === "/api/sync") return json(200, { ahead: aheadCount(root) });
    if (req.method === "GET" && u.pathname === "/api/live") {
      return json(200, liveModel(root, projectsDir));
    }
    if (req.method === "GET" && u.pathname === "/api/reconcile-preview") {
      const { reconcile } = await import("./reconcile.mjs");
      const r = reconcile({ fetch: false, commit: false, push: false, dryRun: true, root, projectsDir });
      return json(200, { changes: r.changes || [] });
    }
    if (req.method === "GET" && u.pathname === "/") {
      const project = u.searchParams.get("project") || "all";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml({ project })); return;
    }
    if (req.method === "POST") {
      if (req.headers["x-blaze-csrf"] !== CSRF) return json(403, { errors: ["bad csrf token"] });

      let payload;
      try { payload = await readJson(req); } catch { return json(400, { errors: ["bad json body"] }); }
      const today = new Date().toISOString().slice(0, 10);
      // in-place ops only — use the inline path for ops that rename (see /api/move)
      const done = (r, msg, extra = {}) => {
        if (!r.ok) return json(422, { errors: r.errors });
        const c = commitFile(root, r.file, msg);
        if (!c.ok) return json(500, { errors: [`written but commit failed (status ${c.status})`] });
        return json(200, { ok: true, ...extra });
      };

      if (u.pathname === "/api/move") {
        const r = applyMove(projectsDir, payload.id, payload.to, { today });
        if (!r.ok) return json(422, { errors: r.errors });
        const extraFiles = (r.fromFile && r.fromFile !== r.file) ? [r.fromFile] : [];
        const c = commitFile(root, r.file, `${payload.id}: ${r.from ?? "?"} → ${payload.to}`, extraFiles);
        if (!c.ok) return json(500, { errors: [`written but commit failed (status ${c.status})`] });
        return json(200, { ok: true, resolution: r.resolution });
      }
      if (u.pathname === "/api/edit") {
        const r = applyEdit(projectsDir, payload.id, payload.patch || {}, { today });
        return done(r, `${payload.id}: edit ${Object.keys(payload.patch || {}).join(",")}`);
      }
      if (u.pathname === "/api/resolve") {
        const r = applyResolve(projectsDir, payload.id, payload.resolution, { today });
        return done(r, `${payload.id}: resolve ${payload.resolution}`);
      }
      if (u.pathname === "/api/log") {
        const r = applyLog(projectsDir, payload.id, payload.minutes, { note: payload.note ?? null, today });
        return done(r, `${payload.id}: log ${payload.minutes}m`);
      }
      if (u.pathname === "/api/ac") {
        const r = applyToggleAc(projectsDir, payload.id, { index: payload.index, checked: payload.checked }, { today });
        return done(r, `${payload.id}: ac[${payload.index}]=${payload.checked ? "x" : " "}`);
      }
      return json(404, { errors: ["not found"] });
    }
    res.writeHead(404, { "content-type": "text/plain" }); res.end("not found");
  }).listen(port, host);
}

// ---- standalone entry -------------------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = startServer();
  server.on("listening", () => console.log(`${cfg.boardTitle} board → http://localhost:${server.address().port}`));
}
