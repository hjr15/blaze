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
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig, listProjects, resolveRoots } from "./config.mjs";
import { walkTickets, buildIndex } from "./model/index.mjs";
import { rollUp } from "./model/rollup.mjs";
import { formatMinutes } from "./model/time.mjs";
import { WORKFLOWS } from "./model/workflows.mjs";
import { PRIORITIES } from "./model/schema.mjs";
import { parseActivity, groupByTicket } from "./model/activity.mjs";
import { applyMove } from "./move.mjs";
import { applyResolve } from "./resolve.mjs";
import { applyLog } from "./log.mjs";
import { applyEdit, applyToggleAc } from "./edit.mjs";
import { commitFile } from "./serve-commit.mjs";

const cfg = loadConfig({ root: resolveRoots().dataRoot });

const PORT = Number(process.env.PORT) || cfg.port;

const PRIORITY_ORDER = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4, none: 5, urgent: 0 };

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

// The canonical column order = the union of every workflow's statuses, in
// declaration order, deduped. (delivery, then goal-only, then risk-only.)
const STATUS_ORDER = [...new Set(Object.values(WORKFLOWS).flatMap((w) => w.statuses))];

const title = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Pure board model: read every ticket under projectsDir, optionally filter to one
// project, and group into status columns. Read-only (the editable board is Phase 6).
export function boardModel(projectsDir, { project = "all" } = {}) {
  const all = [...walkTickets(projectsDir)].map((t) => ({
    file: basename(t.file), meta: t.frontmatter, body: t.body,
    status: t.status, project: t.frontmatter.project,
  }));
  const projectsCount = all.reduce((acc, t) => {
    acc[t.project] = (acc[t.project] || 0) + 1; return acc;
  }, {});
  const rows = project === "all" ? all : all.filter((t) => t.project === project);

  const byStatus = new Map();
  for (const t of rows) {
    if (!byStatus.has(t.status)) byStatus.set(t.status, []);
    byStatus.get(t.status).push(t);
  }
  const statuses = [
    ...STATUS_ORDER.filter((s) => byStatus.has(s)),
    ...[...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s)),
  ];
  const columns = statuses.map((dir) => ({
    dir, label: title(dir),
    tickets: byStatus.get(dir).sort((a, b) => {
      const pa = PRIORITY_ORDER[a.meta.priority] ?? 6, pb = PRIORITY_ORDER[b.meta.priority] ?? 6;
      return pa - pb || String(a.meta.id || "").localeCompare(String(b.meta.id || ""));
    }),
  }));
  const rollup = rollUp(buildIndex(projectsDir));
  return { selected: project, projects: projectsCount, columns, total: rows.length, rollup };
}

// A cheap hash of all ticket files' size+mtime, for the auto-reload poll.
export function contentHash() {
  let h = 0;
  const projectsDir = resolveRoots().projectsDir;
  const stack = [projectsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e);
      let s; try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { stack.push(p); continue; }
      const sig = `${p}:${s.size}:${s.mtimeMs}`;
      for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
    }
  }
  return String(h);
}

// Live-activity model: tail <dataRoot>/.blaze/activity.jsonl, group by ticket,
// attach each ticket's current column from the board index. Missing/empty file
// degrades to no groups. Read-only; the feed is written by the claude-config hook.
export function liveModel(dataRoot, projectsDir, { now = Date.now() } = {}) {
  let text = "";
  try { text = readFileSync(join(dataRoot, ".blaze", "activity.jsonl"), "utf8"); } catch { text = ""; }
  const events = parseActivity(text);
  const statusByKey = {};
  for (const r of buildIndex(projectsDir).rows) if (r.id) statusByKey[r.id] = r.status;
  return { groups: groupByTicket(events, { now, statusByKey }) };
}

// ---- render -------------------------------------------------------------

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

// Minimal markdown for the ticket body: headings, lists, checkboxes, bold, code.
// AC checkboxes (under `## Acceptance Criteria`) are live: they carry data-ac-index
// matching the ordinal used by applyToggleAc (0-based, AC section only).
// Checkboxes outside the AC section remain disabled.
function mdLite(src) {
  const lines = esc(src).split("\n");
  const out = [];
  let inList = false;
  let inAc = false;   // true while inside the ## Acceptance Criteria section
  let acIndex = 0;    // ordinal counter — AC checkboxes only, mirrors applyToggleAc
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
      // Mirror applyToggleAc: inAc = true on "## Acceptance Criteria", false on any other heading
      inAc = /^#{1,6}\s+acceptance criteria\s*$/i.test(t);
      out.push(`<h4>${inline(t.replace(/^#{1,6}\s/, ""))}</h4>`);
    } else if (/^- \[[ xX]\]\s/.test(t)) {
      if (!inList) {
        out.push('<ul class="md">');
        inList = true;
      }
      const checked = /^- \[[xX]\]/.test(t);
      const text = t.replace(/^- \[[ xX]\]\s/, "");
      if (inAc) {
        out.push(
          `<li class="task"><input type="checkbox" data-ac-index="${acIndex++}" ${checked ? "checked" : ""}> ${inline(text)}</li>`,
        );
      } else {
        out.push(
          `<li class="task"><input type="checkbox" disabled ${checked ? "checked" : ""}> ${inline(text)}</li>`,
        );
      }
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
    m.estimate ? esc(formatMinutes(m.estimate)) : "",
    m.parent ? `↳ ${esc(m.parent)}` : "",
    m.project ? esc(m.project) : "",
    prLink(m.pr),
  ].filter(Boolean);
}

function card(t, rollup) {
  const m = t.meta;
  const prio = m.priority || "none";
  const labels = (m.labels || [])
    .map((l) => `<span class="label">${esc(l)}</span>`)
    .join("");
  const meta = metaPieces(m).join(" · ");
  const ru = rollup && rollup.get(m.id);
  const isParent = m.type === "goal" || m.type === "epic";
  const rolled = (isParent && ru && (ru.rolled_estimate || ru.rolled_worklog))
    ? `<div class="rollup">Σ ${esc(formatMinutes(ru.rolled_estimate) || "0m")} est · ${esc(formatMinutes(ru.rolled_worklog) || "0m")} logged</div>`
    : "";
  return `
    <details class="card prio-${esc(prio)}" draggable="true" data-id="${esc(m.id || t.file)}">
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
        ${rolled}
        <div class="editmeta" data-ticket="${esc(m.id)}">
          <span class="editable" data-edit="priority" data-value="${esc(prio)}">${esc(prio)}</span>
          <span class="editable" data-edit="assignee" data-value="${esc(m.assignee || "")}">@${esc(m.assignee || "unassigned")}</span>
          <span class="editable" data-edit="estimate" data-value="${esc(m.estimate || "")}">${esc(formatMinutes(m.estimate) || "—")}</span>
        </div>
      </summary>
      <div class="body" data-ticket="${esc(m.id)}">${mdLite(t.body)}</div>
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
    <details class="row prio-${esc(prio)}" draggable="true" data-id="${esc(m.id || t.file)}">
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
      <div class="body" data-ticket="${esc(m.id)}">${mdLite(t.body)}</div>
    </details>`;
}

export function pageHtml({ project = "all", afterHeader = "", beforeBodyEnd = "", projectsDir: _pDir } = {}) {
  const m = boardModel(_pDir ?? resolveRoots().projectsDir, { project });
  const { columns: cols, total, projects, selected, rollup } = m;
  const columnsHtml = cols
    .map(
      (c) => `
      <section class="col" data-status="${esc(c.dir)}">
        <header class="colhead">
          <span class="colname">${esc(c.label)}</span>
          <span class="count">${c.tickets.length}</span>
        </header>
        <div class="cards">
          ${c.tickets.map((t) => card(t, rollup)).join("") || '<div class="empty">—</div>'}
        </div>
      </section>`,
    )
    .join("");

  // List view ordering: derived from the rendered columns (already status-ordered).
  const LIST_ORDER = cols.map((c) => c.dir);
  const groupsHtml = LIST_ORDER
    .map((dir) => cols.find((c) => c.dir === dir))
    .filter(Boolean)
    .filter((c) => c.dir !== "in-review" || c.tickets.length > 0)
    .map(
      (c) => `
      <details class="group" open data-group="${esc(c.dir)}" data-status="${esc(c.dir)}">
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
  .rollup { color: var(--blaze-amber); font-size: 11px; font-weight: 600; margin-top: 2px; }
  .editmeta { margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap; font-size: 11px; }
  .editable { color: #adbac7; border-bottom: 1px dotted #444c56; cursor: text; }
  .editable:hover { color: var(--neutral); }
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
  html[data-view="board"] .list { display: none; }
  html[data-view="list"]  .board { display: none; }
  html[data-view="live"] .board, html[data-view="live"] .list { display: none; }
  html[data-view="board"] .live, html[data-view="list"] .live { display: none; }
  .live { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; padding: 16px 20px; }
  .livecard { background: #161b22; border: 1px solid #21262d; border-left: 3px solid #444c56; border-radius: 10px; padding: 10px 12px; }
  .livecard.active { border-left-color: var(--blaze-orange); }
  .lc-top { display: flex; align-items: center; gap: 8px; }
  .lc-dot { width: 8px; height: 8px; border-radius: 999px; background: #444c56; }
  .lc-dot.on { background: var(--blaze-orange); box-shadow: 0 0 0 3px #ff7a0033; }
  .lc-age { margin-left: auto; color: #7d8590; font-size: 11px; }
  .lc-now { margin-top: 6px; color: #c9d1d9; }
  .lc-meta { margin-top: 6px; display: flex; gap: 8px; color: #7d8590; font-size: 11px; flex-wrap: wrap; }
  .lc-col { background: #21314a; color: #79c0ff; padding: 1px 6px; border-radius: 999px; }

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
  <div class="board">${columnsHtml}</div>
  <div class="list">${groupsHtml}</div>
  <div class="live"><div class="empty">Loading live activity…</div></div>
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
  <script>
    // Live view: poll /api/live and render cards. Runs only meaningful work when
    // the Live view is active; degrades to a no-data message on error/empty.
    function fmtAge(ms){var s=Math.floor(Math.max(0,ms)/1000);if(s<5)return"now";if(s<60)return s+"s ago";var m=Math.floor(s/60);if(m<60)return m+"m ago";var h=Math.floor(m/60);if(h<24)return h+"h ago";return Math.floor(h/24)+"d ago";}
    function esc(x){return String(x==null?"":x).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
    async function pollLive(){
      const el=document.querySelector(".live"); if(!el) return;
      try{
        const {groups}=await (await fetch("/api/live")).json();
        if(!groups||!groups.length){ el.innerHTML='<div class="empty">No recent activity.</div>'; return; }
        el.innerHTML=groups.map(function(g){return '<article class="livecard '+(g.active?"active":"idle")+'">'
          +'<div class="lc-top"><span class="id">'+esc(g.key)+'</span><span class="lc-dot '+(g.active?"on":"")+'"></span><span class="lc-age">'+esc(fmtAge(g.ageMs))+'</span></div>'
          +'<div class="lc-now">now: <strong>'+esc(g.tool)+'</strong></div>'
          +'<div class="lc-meta">'+(g.column?'<span class="lc-col">'+esc(g.column)+'</span>':'')+'<span class="lc-branch">'+esc(g.branch)+'</span></div>'
          +'</article>';}).join("");
      }catch(e){ el.innerHTML='<div class="empty">live activity offline</div>'; }
    }
    pollLive(); setInterval(pollLive, 3000);
  </script>
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
