// scripts/views/metrics.mjs — the Metrics view: five summary tiles plus a
// hand-rolled cumulative-flow diagram (CFD) driven by `metricsModel(...)`
// (`{ tiles, series }`, ../model/metrics.mjs). No chart library — the client
// draws stacked-area <path>s straight from the embedded #cfd-series JSON.

import { esc } from "./render-lib.mjs";
import { formatMinutes } from "../model/time.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// Reused across the SSR legend swatches and the client-side path fill so a
// status always gets the same colour in both places (index into the same
// array, in STATUS_ORDER — the key order metricsModel's series carries).
const PALETTE = ["#79c0ff", "#3fb950", "#d29922", "#f85149", "#a371f7", "#56d4dd", "#ffa657", "#7ee787"];
const RANGES = ["30", "90", "180", "all"];

// medianCycleTime arrives in ms. Sub-day durations read as "Xh Ym" via the
// existing formatMinutes; day-plus durations (the common case for cycle
// time) read as "Xd Yh" instead of an unwieldy "72h 0m".
function formatCycleTime(ms) {
  if (ms === null || ms === undefined) return "—";
  const days = ms / DAY_MS;
  if (days >= 1) {
    const whole = Math.floor(days);
    const remHours = Math.round((days - whole) * 24);
    return remHours > 0 ? `${whole}d ${remHours}h` : `${whole}d`;
  }
  return formatMinutes(Math.round(ms / 60000)) || "0m";
}

function tile(label, value) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div></div>`;
}

function tilesHtml(tiles) {
  const t = tiles || {};
  return `<div class="tiles">${[
    tile("Total", t.total ?? 0),
    tile("In Flight", t.inFlight ?? 0),
    tile("Done %", `${t.donePct ?? 0}%`),
    tile("Throughput (14d)", t.throughput14d ?? 0),
    tile("Median Cycle Time", formatCycleTime(t.medianCycleTime ?? null)),
  ].join("")}</div>`;
}

function rangeButtonsHtml() {
  return `<div class="mrange-group" role="group" aria-label="Range">${RANGES.map(
    (r) =>
      `<button type="button" class="mrange${r === "all" ? " on" : ""}" data-range="${esc(r)}">${
        r === "all" ? "All" : `${esc(r)}d`
      }</button>`,
  ).join("")}</div>`;
}

function legendHtml(series) {
  if (!series.length) return `<div class="cfd-legend"></div>`;
  const statuses = Object.keys(series[0].counts);
  return `<div class="cfd-legend">${statuses
    .map(
      (s, i) =>
        `<span class="cfd-legend-item"><span class="cfd-swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(s)}</span>`,
    )
    .join("")}</div>`;
}

export function render(model) {
  const tiles = (model && model.tiles) || {};
  const series = (model && model.series) || [];
  const hasData = series.length > 0;
  return `${tilesHtml(tiles)}
<div class="metrics${hasData ? "" : " no-data"}">
  ${rangeButtonsHtml()}
  <svg class="cfd" viewBox="0 0 800 300" preserveAspectRatio="none" role="img" aria-label="Cumulative flow diagram"></svg>
  <div class="cfd-empty empty">No data yet.</div>
  ${legendHtml(series)}
</div>
<script type="application/json" id="cfd-series">${JSON.stringify(series)}</script>`;
}

// CSS: dark-palette tokens shared with the rest of the board; tiles row
// wraps so it degrades on mobile instead of overflowing; the SVG scales via
// width:100%/height:auto + viewBox so it never forces horizontal scroll.
export const styles = `
  .tiles { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px 20px; }
  .tile {
    flex: 1 1 140px; min-width: 120px; background: #161b22; border: 1px solid #21262d;
    border-radius: 10px; padding: 10px 14px;
  }
  .tile-label { color: #7d8590; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; }
  .tile-value { margin-top: 4px; font-size: 20px; font-weight: 700; color: var(--neutral); }
  .metrics { padding: 0 20px 20px; }
  .mrange-group { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
  .mrange {
    appearance: none; border: 1px solid #21262d; background: #161b22; color: #7d8590;
    font: inherit; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 6px; cursor: pointer;
  }
  .mrange:hover { color: #adbac7; }
  .mrange.on { color: var(--charcoal); background: var(--blaze-orange); border-color: var(--blaze-orange); }
  svg.cfd {
    display: block; width: 100%; height: auto; max-width: 100%;
    background: #161b22; border: 1px solid #21262d; border-radius: 10px;
  }
  .metrics.no-data svg.cfd { display: none; }
  .cfd-empty {
    display: none; color: #444c56; text-align: center; padding: 30px 0;
    border: 1px dashed #21262d; border-radius: 10px;
  }
  .metrics.no-data .cfd-empty { display: block; }
  .cfd-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; font-size: 12px; color: #adbac7; }
  .cfd-legend-item { display: flex; align-items: center; gap: 5px; }
  .cfd-swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }`;

// Client-side: parse #cfd-series once, draw a hand-rolled stacked-area CFD
// (no chart lib), and redraw on data-range clicks. Guarded (mirrors
// live.mjs's pollLive guard) to skip drawing work unless the Metrics view is
// actually active — cheap no-op call at parse time, real work on view-toggle
// click or range-button click.
export const clientScript = `
    (function () {
      var PALETTE = ${JSON.stringify(PALETTE)};
      var DAY_MS = 24 * 60 * 60 * 1000;
      var currentRange = "all";

      function readSeries() {
        var el = document.getElementById("cfd-series");
        if (!el) return [];
        try { return JSON.parse(el.textContent || "[]"); } catch (e) { return []; }
      }

      function windowed(series, range) {
        if (range === "all" || !series.length) return series;
        var days = Number(range);
        var lastMs = Date.parse(series[series.length - 1].date + "T00:00:00Z");
        var cutoff = lastMs - (days - 1) * DAY_MS;
        return series.filter(function (d) { return Date.parse(d.date + "T00:00:00Z") >= cutoff; });
      }

      function drawCfd() {
        if (document.documentElement.dataset.view !== "metrics") return;
        var wrap = document.querySelector(".metrics");
        var host = document.querySelector("svg.cfd");
        if (!wrap || !host) return;
        var series = windowed(readSeries(), currentRange);
        while (host.firstChild) host.removeChild(host.firstChild);
        if (!series.length) { wrap.classList.add("no-data"); return; }
        wrap.classList.remove("no-data");

        var statuses = Object.keys(series[0].counts);
        var W = 800, H = 300;
        var maxTotal = 1;
        series.forEach(function (d) {
          var total = statuses.reduce(function (a, s) { return a + (d.counts[s] || 0); }, 0);
          if (total > maxTotal) maxTotal = total;
        });
        var n = series.length;
        var xStep = n > 1 ? W / (n - 1) : W;
        var ns = "http://www.w3.org/2000/svg";
        var cumBottom = series.map(function () { return 0; });
        statuses.forEach(function (status, i) {
          var topPts = [], botPts = [];
          series.forEach(function (d, idx) {
            var v = d.counts[status] || 0;
            var bottom = cumBottom[idx];
            var top = bottom + v;
            cumBottom[idx] = top;
            var x = n > 1 ? idx * xStep : W / 2;
            topPts.push([x, H - (top / maxTotal) * H]);
            botPts.push([x, H - (bottom / maxTotal) * H]);
          });
          var pts = topPts.concat(botPts.slice().reverse());
          var d0 = pts.map(function (p, idx2) {
            return (idx2 === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1);
          }).join(" ") + " Z";
          var path = document.createElementNS(ns, "path");
          path.setAttribute("d", d0);
          path.setAttribute("fill", PALETTE[i % PALETTE.length]);
          path.setAttribute("stroke", "none");
          path.setAttribute("data-status", status);
          host.appendChild(path);
        });
      }

      document.querySelectorAll(".mrange").forEach(function (btn) {
        btn.addEventListener("click", function () {
          currentRange = btn.dataset.range;
          document.querySelectorAll(".mrange").forEach(function (b) { b.classList.toggle("on", b === btn); });
          drawCfd();
        });
      });
      drawCfd();
    })();
  `;
