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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { MAP_STYLES } from "./map-view.mjs";

const cfg = loadConfig();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || cfg.port;

// Columns derived from config, title-cased from their directory names.
const COLUMNS = cfg.columns.map((dir) => ({
  dir,
  label: dir.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
}));

const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

// ---- read + parse -------------------------------------------------------

function readColumn(dir) {
  let files = [];
  try {
    files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const tickets = files.map((file) => {
    const raw = readFileSync(join(ROOT, dir, file), "utf8");
    const { meta, body } = parse(raw);
    return { file, meta, body };
  });
  // Sort by priority then id so the column reads top-down by urgency.
  tickets.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.meta.priority] ?? 5;
    const pb = PRIORITY_ORDER[b.meta.priority] ?? 5;
    return pa - pb || (a.meta.id || "").localeCompare(b.meta.id || "");
  });
  return tickets;
}

function parse(raw) {
  const meta = {};
  let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1];
      let val = kv[2].trim();
      if (key === "labels") {
        val = val
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      meta[key] = val;
    }
  }
  return { meta, body: body.trim() };
}

// A cheap hash of all ticket files' size+mtime, for the auto-reload poll.
export function contentHash() {
  let h = 0;
  for (const { dir } of COLUMNS) {
    let files = [];
    try {
      files = readdirSync(join(ROOT, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const s = statSync(join(ROOT, dir, f));
        const sig = `${dir}/${f}:${s.size}:${s.mtimeMs}`;
        for (let i = 0; i < sig.length; i++) {
          h = (h * 31 + sig.charCodeAt(i)) | 0;
        }
      } catch {}
    }
  }
  return String(h);
}

// ---- render -------------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

// Minimal markdown for the ticket body: headings, lists, checkboxes, bold, code.
function mdLite(src) {
  const lines = esc(src).split("\n");
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (/^#{1,6}\s/.test(t)) {
      closeList();
      out.push(`<h4>${inline(t.replace(/^#{1,6}\s/, ""))}</h4>`);
    } else if (/^- \[[ xX]\]\s/.test(t)) {
      if (!inList) {
        out.push('<ul class="md">');
        inList = true;
      }
      const checked = /^- \[[xX]\]/.test(t);
      const text = t.replace(/^- \[[ xX]\]\s/, "");
      out.push(
        `<li class="task"><input type="checkbox" disabled ${checked ? "checked" : ""}> ${inline(text)}</li>`,
      );
    } else if (/^- \s*/.test(t)) {
      if (!inList) {
        out.push('<ul class="md">');
        inList = true;
      }
      out.push(`<li>${inline(t.replace(/^- \s*/, ""))}</li>`);
    } else if (t === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(t)}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

const inline = (s) =>
  s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

// Render the `pr:` frontmatter field ("#843 — https://…/pull/843") as a link.
function prLink(pr) {
  if (!pr) return "";
  const url = (pr.match(/https?:\/\/\S+/) || [])[0];
  const num = (pr.match(/#(\d+)/) || [])[1];
  if (!url) return "";
  return `<a class="prlink" href="${esc(url)}" target="_blank" rel="noopener">🔗 PR${num ? ` #${esc(num)}` : ""}</a>`;
}

// Build the dot-separated meta line as HTML pieces (text escaped, links raw).
function metaPieces(m) {
  return [
    m.assignee && m.assignee !== "unassigned" ? `@${esc(m.assignee)}` : "",
    m.estimate ? `${esc(m.estimate)} pts` : "",
    m.parent ? `↳ ${esc(m.parent)}` : "",
    m.project ? esc(m.project) : "",
    prLink(m.pr),
  ].filter(Boolean);
}

function card(t) {
  const m = t.meta;
  const prio = m.priority || "none";
  const labels = (m.labels || [])
    .map((l) => `<span class="label">${esc(l)}</span>`)
    .join("");
  const meta = metaPieces(m).join(" · ");
  return `
    <details class="card prio-${esc(prio)}">
      <summary>
        <div class="card-top">
          <span class="id">${esc(m.id || t.file)}</span>
          <span class="badges">
            <span class="prio prio-${esc(prio)}">${esc(prio)}</span>
            ${m.type ? `<span class="type">${esc(m.type)}</span>` : ""}
          </span>
        </div>
        <div class="title">${esc(m.title || t.file)}</div>
        ${labels ? `<div class="labels">${labels}</div>` : ""}
        ${meta ? `<div class="cardmeta">${meta}</div>` : ""}
      </summary>
      <div class="body">${mdLite(t.body)}</div>
    </details>`;
}

// A compact one-line row for the List view (Linear-style). Same expandable body.
function row(t) {
  const m = t.meta;
  const prio = m.priority || "none";
  const labels = (m.labels || [])
    .map((l) => `<span class="label">${esc(l)}</span>`)
    .join("");
  const meta = metaPieces(m).join(" · ");
  return `
    <details class="row prio-${esc(prio)}">
      <summary>
        <span class="rcaret">▸</span>
        <span class="id">${esc(m.id || t.file)}</span>
        <span class="rtitle">${esc(m.title || t.file)}</span>
        <span class="rbadges">
          ${labels}
          <span class="prio prio-${esc(prio)}">${esc(prio)}</span>
          ${m.type ? `<span class="type">${esc(m.type)}</span>` : ""}
        </span>
        ${meta ? `<span class="rmeta">${meta}</span>` : ""}
      </summary>
      <div class="body">${mdLite(t.body)}</div>
    </details>`;
}

export function boardData() {
  const cols = COLUMNS.map((c) => ({ ...c, tickets: readColumn(c.dir) }));
  const total = cols.reduce((n, c) => n + c.tickets.length, 0);
  return { cols, total };
}

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

export function pageHtml({ afterHeader = "", beforeBodyEnd = "" } = {}) {
  const { cols, total } = boardData();
  // `<` is escaped so a ticket title can never break out of the <script> tag.
  const mapJson = JSON.stringify(mapData()).replace(/</g, "\\u003c");
  const columnsHtml = cols
    .map(
      (c) => `
      <section class="col">
        <header class="colhead">
          <span class="colname">${esc(c.label)}</span>
          <span class="count">${c.tickets.length}</span>
        </header>
        <div class="cards">
          ${c.tickets.map(card).join("") || '<div class="empty">—</div>'}
        </div>
      </section>`,
    )
    .join("");

  // List view ordering: preferred-first, then any extra columns in config order.
  const PREFERRED = ["in-review", "in-progress", "todo", "backlog", "done", "canceled", "duplicate"];
  const LIST_ORDER = [...PREFERRED.filter((d) => cfg.columns.includes(d)),
                      ...cfg.columns.filter((d) => !PREFERRED.includes(d))];
  const groupsHtml = LIST_ORDER
    .map((dir) => cols.find((c) => c.dir === dir))
    .filter(Boolean)
    .filter((c) => c.dir !== "in-review" || c.tickets.length > 0)
    .map(
      (c) => `
      <details class="group" open data-group="${esc(c.dir)}">
        <summary class="grouphead">
          <span class="gcaret">▸</span>
          <span class="colname">${esc(c.label)}</span>
          <span class="count">${c.tickets.length}</span>
        </summary>
        <div class="rows">
          ${c.tickets.map(row).join("") || '<div class="empty">No tickets</div>'}
        </div>
      </details>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en" data-view="board">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${cfg.boardTitle}</title>
<script>
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
  header.top .sub { color: #7d8590; font-size: 12px; }
  .board {
    display: grid; grid-auto-flow: column; grid-auto-columns: minmax(260px, 1fr);
    gap: 12px; padding: 16px 20px; overflow-x: auto; align-items: start;
  }
  .col { background: #161b22; border: 1px solid #21262d; border-radius: 10px; }
  .colhead {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 12px; border-bottom: 1px solid #21262d;
    font-weight: 600; font-size: 12px; text-transform: uppercase;
    letter-spacing: .5px; color: #adbac7;
  }
  .count { color: #7d8590; font-weight: 600; }
  .cards { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
  .empty { color: #444c56; text-align: center; padding: 14px 0; }
  .card {
    background: #1c2128; border: 1px solid #2d333b; border-left: 3px solid #444c56;
    border-radius: 8px; padding: 9px 11px; cursor: pointer;
  }
  .card[open] { background: #20262e; }
  .card summary { list-style: none; }
  .card summary::-webkit-details-marker { display: none; }
  .card-top { display: flex; justify-content: space-between; align-items: center; }
  .id { color: #7d8590; font-size: 11px; font-weight: 600; font-family: ui-monospace, monospace; }
  .title { margin-top: 3px; font-weight: 500; }
  .badges { display: flex; gap: 5px; }
  .prio, .type, .label {
    font-size: 10px; padding: 1px 6px; border-radius: 999px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .3px;
  }
  .type { background: #30363d; color: #adbac7; }
  .labels { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
  .label { background: #21314a; color: #79c0ff; text-transform: none; letter-spacing: 0; }
  .cardmeta { margin-top: 6px; color: #7d8590; font-size: 11px; }
  .prio.prio-urgent { background: #4b1113; color: var(--blaze-red); }
  .prio.prio-high   { background: #4a2410; color: var(--blaze-orange); }
  .prio.prio-medium { background: #4a3a0c; color: var(--blaze-amber); }
  .prio.prio-low    { background: #30363d; color: #adbac7; }
  .prio.prio-none   { background: #30363d; color: #7d8590; }
  .card.prio-urgent { border-left-color: var(--blaze-red); }
  .card.prio-high   { border-left-color: var(--blaze-orange); }
  .card.prio-medium { border-left-color: var(--blaze-amber); }
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
  html[data-view="board"] .list, html[data-view="board"] .mapview,
  html[data-view="list"]  .board, html[data-view="list"]  .mapview,
  html[data-view="map"]   .board, html[data-view="map"]   .list { display: none; }
${MAP_STYLES}

  /* ---- list view ---- */
  .list { display: flex; flex-direction: column; gap: 8px; padding: 16px 20px; width: 100%; }
  .group { background: #161b22; border: 1px solid #21262d; border-radius: 10px; overflow: hidden; }
  .grouphead {
    display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer;
    font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; color: #adbac7;
    list-style: none; user-select: none;
  }
  .grouphead::-webkit-details-marker { display: none; }
  .grouphead:hover { background: #1c2128; }
  .gcaret, .rcaret { color: #7d8590; font-size: 10px; transition: transform .15s; display: inline-block; }
  .group[open] > .grouphead .gcaret { transform: rotate(90deg); }
  .grouphead .count { margin-left: auto; }
  .rows { display: flex; flex-direction: column; border-top: 1px solid #21262d; }
  .rows .empty { color: #444c56; padding: 12px; text-align: left; }
  .row {
    border-bottom: 1px solid #21262d; border-left: 3px solid #444c56;
  }
  .row:last-child { border-bottom: 0; }
  .row[open] { background: #1c2128; }
  .row > summary {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer;
    list-style: none; user-select: none;
  }
  .row > summary::-webkit-details-marker { display: none; }
  .row:hover { background: #1c2128; }
  .row[open] > summary .rcaret { transform: rotate(90deg); }
  .row .rtitle {
    flex: 1; min-width: 0; font-weight: 500; color: var(--neutral);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .row .rbadges { display: flex; align-items: center; gap: 4px; flex-wrap: nowrap; }
  .row .rmeta { color: #7d8590; font-size: 11px; white-space: nowrap; }
  .prlink { color: #58a6ff; text-decoration: none; font-weight: 600; }
  .prlink:hover { text-decoration: underline; }
  .row > .body { margin: 0 12px 12px 12px; }
  .row.prio-urgent  { border-left-color: var(--blaze-red); }
  .row.prio-high    { border-left-color: var(--blaze-orange); }
  .row.prio-medium  { border-left-color: var(--blaze-amber); }
  #live { color: var(--blaze-orange); }
  @media (max-width: 640px) {
    .row .rmeta, .row .rbadges .label { display: none; }
  }
</style>
</head>
<body>
  <header class="top">
    <h1>${cfg.boardTitle}</h1>
    <span class="sub">${total} tickets · ${cols.filter((c) => ["todo","in-progress","in-review"].includes(c.dir)).reduce((n,c)=>n+c.tickets.length,0)} in flight</span>
    <div class="viewtoggle" role="group" aria-label="View" style="margin-left:auto">
      <button type="button" class="pill" data-view="board">Board</button>
      <button type="button" class="pill" data-view="list">List</button>
      <button type="button" class="pill" data-view="map">Map</button>
    </div>
    <span class="sub" id="live">live</span>
  </header>
  ${afterHeader}
  <div class="board">${columnsHtml}</div>
  <div class="list">${groupsHtml}</div>
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
    let last = null;
    async function poll() {
      try {
        const h = await (await fetch("/api/hash")).text();
        if (last !== null && h !== last) location.reload();
        last = h;
        document.getElementById("live").textContent = "live";
      } catch {
        document.getElementById("live").textContent = "offline";
      }
    }
    poll();
    setInterval(poll, 3000);
  </script>
  ${beforeBodyEnd}
</body>
</html>`;
}

// ---- server (standalone only) -------------------------------------------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer((req, res) => {
    if (tryServeAsset(req, res)) return;
    if (req.url === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(contentHash());
      return;
    }
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }).listen(PORT, "127.0.0.1", () => {
    console.log(`${cfg.boardTitle} board → http://localhost:${PORT}`);
  });

  // Auto-reconcile timer — only runs in mirror mode (codeRepoPath configured and
  // reconcile loop enabled). In standalone mode the board is a pure viewer.
  if (cfg.codeRepoPath && cfg.loops.reconcile.enabled) {
    import("./reconcile.mjs").then(({ reconcile }) => {
      const tick = () => { try { reconcile({ fetch: true, commit: true, push: true }); } catch {} };
      tick();
      setInterval(tick, cfg.loops.reconcile.intervalSec * 1000);
    }).catch((err) => console.error("reconcile import failed:", err));
  }
}
