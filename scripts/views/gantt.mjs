// scripts/views/gantt.mjs — the Gantt view: a deterministic, server-positioned
// SVG scoped to one sprint. Consumes ganttModel(...) (../model/gantt.mjs) — the
// model owns all date math and geometry (x/w in px), so this module only paints
// and wires interaction, keeping the golden SVG stable. Contract mirrors
// views/map.mjs: render(gm) → section HTML; styles → CSS; clientScript → JS.
//
// Row click / bar click → Lane A's window.blazePanel.open(id); a sprint-pill
// click navigates ?sprint=<id> (the model re-selects on the next render).
import { esc } from "./render-lib.mjs";

// Bar stroke colour by type (shared palette with the map view).
const TYPE_COLORS = {
  goal: "#a371f7", epic: "#58a6ff", risk: "#f85149",
  story: "#3fb950", task: "#3fb950", bug: "#d29922", subtask: "#56d4dd",
};
const DEFAULT_COLOR = "#7d8590";

const GUTTER = 220;   // left label column width (id · title · assignee)
const AXIS_H = 28;    // top strip for day labels
const ROW_H = 26;
const HEAD_H = 22;
const BAR_H = 16;
const PAD_BOTTOM = 8;

const fmt = (v) => Math.round(v * 100) / 100;
function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// done → dimmed fill; in-progress/in-review → solid fill; anything else
// (defined) → outline only. Colour comes from the ticket type.
function fillFor(status, color) {
  if (status === "done") return `fill="${color}" fill-opacity="0.35"`;
  if (status === "in-progress" || status === "in-review") return `fill="${color}" fill-opacity="0.9"`;
  return `fill="none"`;
}

export function render(gm) {
  if (!gm || gm.empty || !gm.axis) {
    return `<div class="ganttwrap no-data">
    <div class="gantt-empty empty">No sprint selected. Create one with <code>blaze sprint new</code>, then tag tickets with <code>--sprint</code>.</div>
  </div>`;
  }

  const axis = gm.axis;
  const chartW = GUTTER + axis.width;

  // Sprint-picker pills (active one marked).
  const pills = gm.sprints
    .map((s) => `<button type="button" class="gpill${s.id === gm.selected ? " on" : ""}" data-sprint="${esc(s.id)}">${esc(s.name)}</button>`)
    .join("");

  // Group rows by parent; parentless rows render first without a header.
  const byParent = new Map();
  const ungrouped = [];
  for (const r of gm.rows) {
    if (r.parent == null) { ungrouped.push(r); continue; }
    if (!byParent.has(r.parent)) byParent.set(r.parent, []);
    byParent.get(r.parent).push(r);
  }

  let y = AXIS_H;
  const body = [];
  const rowLabel = (r) =>
    esc(r.id) + " · " + esc(clip(r.title ?? r.id, 28)) +
    (r.assignee && r.assignee !== "unassigned" ? " · " + esc(r.assignee) : "");
  const emitRow = (r) => {
    const color = TYPE_COLORS[r.type] || DEFAULT_COLOR;
    const barY = y + (ROW_H - BAR_H) / 2;
    body.push(
      `<g class="grow" data-id="${esc(r.id)}" role="button" tabindex="0" aria-label="${esc(r.id)}: ${esc(r.title ?? r.id)}">` +
      `<text class="gid" x="8" y="${fmt(y + ROW_H / 2 + 4)}">${rowLabel(r)}</text>` +
      `<rect class="bar bar-${esc(r.barKind)}" data-id="${esc(r.id)}" x="${fmt(GUTTER + r.x)}" y="${fmt(barY)}" width="${fmt(r.w)}" height="${BAR_H}" rx="3" stroke="${color}" stroke-width="1.5" ${fillFor(r.status, color)} />` +
      `</g>`,
    );
    y += ROW_H;
  };

  for (const r of ungrouped) emitRow(r);
  for (const g of gm.groups) {
    body.push(
      `<g class="ghead">` +
      `<rect x="0" y="${fmt(y)}" width="${chartW}" height="${HEAD_H}" fill="#161b22" />` +
      `<text class="ghead-label" x="8" y="${fmt(y + 15)}">${esc(g.epicId)}${g.title ? " · " + esc(clip(g.title, 40)) : ""}</text>` +
      `</g>`,
    );
    y += HEAD_H;
    for (const r of (byParent.get(g.epicId) || [])) emitRow(r);
  }
  const totalH = y + PAD_BOTTOM;

  // Day grid (week-starts emphasised) + weekly axis labels.
  const grid = axis.days
    .map((d) => `<line class="gday${d.weekStart ? " gweek" : ""}" x1="${fmt(GUTTER + d.x)}" y1="${AXIS_H}" x2="${fmt(GUTTER + d.x)}" y2="${totalH}" />`)
    .join("");
  const labels = axis.days
    .filter((d) => d.weekStart)
    .map((d) => `<text class="gaxis" x="${fmt(GUTTER + d.x)}" y="16">${esc(d.iso.slice(5))}</text>`)
    .join("");
  const today = gm.nowX != null
    ? `<line class="today" x1="${fmt(GUTTER + gm.nowX)}" y1="${AXIS_H}" x2="${fmt(GUTTER + gm.nowX)}" y2="${totalH}" />`
    : "";

  const warn = gm.warnings.length
    ? `<div class="gantt-note gantt-warn" role="status">${gm.warnings.length} ticket${gm.warnings.length === 1 ? "" : "s"} in this sprint skipped (not a delivery ticket).</div>`
    : "";

  return `<div class="ganttwrap">
  <div class="gantt-picker" role="group" aria-label="Sprint">${pills}</div>
  ${warn}
  <svg class="gantt" viewBox="0 0 ${chartW} ${totalH}" role="img" aria-label="Sprint Gantt chart">
    <g class="gantt-grid">${grid}</g>
    <g class="gantt-axis">${labels}</g>
    ${body.join("")}
    ${today}
  </svg>
</div>`;
}

export const styles = `
  .ganttwrap { padding: 0 20px 20px; }
  .gantt-picker { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
  .gpill {
    appearance: none; border: 1px solid #21262d; background: #161b22; color: #7d8590;
    font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  }
  .gpill:hover { color: #adbac7; }
  .gpill.on { color: var(--charcoal); background: var(--blaze-orange); border-color: var(--blaze-orange); }
  svg.gantt {
    display: block; width: 100%; height: auto; max-width: 100%;
    background: #0d1117; border: 1px solid #21262d; border-radius: 10px;
  }
  .ganttwrap.no-data svg.gantt { display: none; }
  .gantt-empty {
    display: none; color: #444c56; text-align: center; padding: 40px 0;
    border: 1px dashed #21262d; border-radius: 10px;
  }
  .ganttwrap.no-data .gantt-empty { display: block; }
  .gantt-note { color: #7d8590; font-size: 12px; padding: 4px 0 8px; }
  .gantt-warn { color: #d29922; }
  .gantt .grow { cursor: pointer; }
  .gantt .grow:focus { outline: none; }
  .gantt .grow:focus .bar { stroke-width: 2.5; }
  .gantt .gid { fill: #c9d1d9; font: 12px ui-sans-serif, system-ui, sans-serif; }
  .gantt .ghead-label { fill: #adbac7; font: 600 11px ui-sans-serif, system-ui, sans-serif; }
  .gantt .gaxis { fill: #7d8590; font: 10px ui-monospace, monospace; text-anchor: middle; }
  .gantt .gday { stroke: #1b2129; stroke-width: 1; }
  .gantt .gweek { stroke: #2d333b; }
  .gantt .today { stroke: var(--blaze-orange); stroke-width: 1.5; stroke-dasharray: 4 3; }`;

// Client: a sprint-pill click re-scopes via ?sprint= (full-page nav, mirrors the
// map's drill seam); a bar/row click opens Lane A's shared detail panel.
export const clientScript = `
  (function () {
    var root = document.querySelector(".ganttwrap");
    if (!root) return;
    root.querySelectorAll(".gpill").forEach(function (b) {
      b.addEventListener("click", function () {
        var q = new URLSearchParams(location.search);
        q.set("sprint", b.getAttribute("data-sprint"));
        location.search = q.toString();
      });
    });
    var svg = root.querySelector("svg.gantt");
    if (svg) {
      svg.addEventListener("click", function (e) {
        var g = e.target.closest("[data-id]");
        if (g && window.blazePanel) window.blazePanel.open(g.getAttribute("data-id"));
      });
      svg.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var g = e.target.closest("[data-id]");
        if (g && window.blazePanel) { e.preventDefault(); window.blazePanel.open(g.getAttribute("data-id")); }
      });
    }
  })();
`;
