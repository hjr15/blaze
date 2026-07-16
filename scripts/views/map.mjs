// scripts/views/map.mjs — the Map view: a ticket's 1-hop DEPENDENCY neighbourhood
// as a hand-rolled, server-positioned SVG (BLZ-108). graphModel
// (../model/graph.mjs) lays nodes out in role columns — upstream blockers left,
// anchor centre, downstream blocked right, related below; this module paints them
// and wires zoom/pan + node-click via the unchanged clientScript. Node-click calls
// Lane A's window.blazePanel.open(id); the per-neighbour "→" re-focuses the map on
// that ticket (data-drill seam, shared with the board). Contract: render(gm) →
// section HTML; styles → CSS; clientScript → browser JS.
import { esc } from "./render-lib.mjs";

// Node stroke colour by type (falls back for unknown types).
const TYPE_COLORS = {
  goal: "#a371f7", epic: "#58a6ff", risk: "#f85149",
  story: "#3fb950", task: "#3fb950", bug: "#d29922", subtask: "#56d4dd",
};
const DEFAULT_COLOR = "#7d8590";

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function render(gm) {
  const g = gm && Array.isArray(gm.nodes)
    ? gm : { nodes: [], edges: [], width: 80, height: 80, unresolved: [], anchor: null };
  const unresolved = g.unresolved ?? [];

  // No focus / unresolved focus: nothing to map — prompt instead of an empty frame.
  if (!g.anchor) {
    return `<div class="mapwrap no-data">
    <div class="map-empty empty">Select a ticket to see its dependencies.</div>
  </div>`;
  }

  const noLinks = g.nodes.filter((n) => !n.anchor).length === 0;

  const edgesSvg = g.edges.map((e) => {
    const color = e.directed ? "#8b949e" : "#495366";
    const dash = e.directed ? "" : ' stroke-dasharray="4 3"';
    const marker = e.directed ? ' marker-end="url(#arrow)"' : "";
    const line = `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${color}" stroke-width="1.5"${dash}${marker} />`;
    const label = e.type
      ? `<text class="edge-label" x="${(e.x1 + e.x2) / 2}" y="${(e.y1 + e.y2) / 2 - 2}" text-anchor="middle">${esc(e.type)}</text>`
      : "";
    return line + label;
  }).join("");

  const nodesSvg = g.nodes.map((n) => {
    const color = TYPE_COLORS[n.type] || DEFAULT_COLOR;
    const cls = "node" + (n.anchor ? " anchor" : "");
    // Non-anchor neighbours carry a re-focus affordance: it re-centres the map on
    // THAT ticket's neighbourhood (drillTo → ?focus=). Reuses the BLZ-35 data-drill
    // seam (clientScript unchanged), so the pointer/keyboard regression tests hold.
    const focusAff = !n.anchor
      ? `<g class="drill" data-drill="${esc(n.id)}" tabindex="0" role="button" aria-label="Focus dependencies of ${esc(n.id)}">`
        + `<rect x="${n.w - 30}" y="${n.h - 18}" width="24" height="14" rx="7" fill="#21262d" />`
        + `<text class="drill-n" x="${n.w - 18}" y="${n.h - 7}" text-anchor="middle">→</text>`
        + `</g>`
      : "";
    return `<g class="${cls}" data-node-id="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.id)}: ${esc(n.title)}" transform="translate(${n.x},${n.y})">`
      + `<rect width="${n.w}" height="${n.h}" rx="8" fill="#161b22" stroke="${color}" stroke-width="1.5" />`
      + `<rect width="4" height="${n.h}" rx="2" fill="${color}" />`
      + `<text class="node-id" x="12" y="18">${esc(n.id)}</text>`
      + `<text class="node-title" x="12" y="34">${esc(clip(n.title, 22))}</text>`
      + focusAff
      + `</g>`;
  }).join("");

  const noLinksHtml = noLinks && !unresolved.length
    ? `<div class="map-note" role="status">No links on this ticket — nothing blocks it and it blocks nothing.</div>`
    : "";
  const unresolvedHtml = unresolved.length
    ? `<div class="map-note map-warn" role="status">${unresolved.length} link${unresolved.length === 1 ? "" : "s"} on this ticket couldn’t be resolved.</div>`
    : "";

  return `<div class="mapwrap">
  ${noLinksHtml}${unresolvedHtml}
  <div class="mapzoom" role="group" aria-label="Zoom">
    <button type="button" class="mzoom" data-zoom="in" aria-label="Zoom in">+</button>
    <button type="button" class="mzoom" data-zoom="out" aria-label="Zoom out">−</button>
    <button type="button" class="mzoom" data-zoom="reset">Reset</button>
  </div>
  <svg class="graph" viewBox="0 0 ${g.width} ${g.height}" data-w="${g.width}" data-h="${g.height}" role="img" aria-label="Dependency map">
    <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#8b949e" /></marker></defs>
    <g class="graph-pan">${edgesSvg}${nodesSvg}</g>
  </svg>
</div>`;
}

export const styles = `
  .mapwrap { position: relative; padding: 0 20px 20px; }
  svg.graph {
    display: block; width: 100%; height: auto; max-width: 100%; min-height: 320px;
    background: #0d1117; border: 1px solid #21262d; border-radius: 10px;
    cursor: grab; touch-action: none;
  }
  svg.graph.panning { cursor: grabbing; }
  .mapwrap.no-data svg.graph { display: none; }
  .node { cursor: pointer; }
  .node:focus { outline: none; }
  .node:focus rect:first-of-type { stroke-width: 2.5; }
  .node-id { fill: #7d8590; font: 600 10px ui-monospace, monospace; }
  .node-title { fill: #c9d1d9; font: 12px ui-sans-serif, system-ui, sans-serif; }
  .edge-label { fill: #8b949e; font: 9px ui-sans-serif, system-ui, sans-serif; }
  .mapzoom { position: absolute; top: 8px; right: 28px; display: flex; gap: 4px; z-index: 2; }
  .mzoom {
    appearance: none; border: 1px solid #21262d; background: #161b22; color: #adbac7;
    font: inherit; font-size: 13px; font-weight: 600; width: 28px; height: 28px;
    border-radius: 6px; cursor: pointer;
  }
  .mzoom[data-zoom="reset"] { width: auto; padding: 0 8px; }
  .mzoom:hover { color: var(--neutral); border-color: #30363d; }
  .map-empty {
    display: none; color: #444c56; text-align: center; padding: 40px 0;
    border: 1px dashed #21262d; border-radius: 10px;
  }
  .mapwrap.no-data .map-empty { display: block; }
  .map-note { color: #7d8590; font-size: 12px; padding: 4px 0 8px; }
  .map-warn { color: #d29922; }
  .node.anchor > rect:first-of-type { stroke-width: 3; }
  .drill { cursor: pointer; }
  .drill-n { fill: #adbac7; font: 600 11px ui-monospace, monospace; }`;

// Client: viewBox zoom (buttons + wheel) and drag-pan; a click distinguished
// from a drag (movement threshold) opens Lane A's shared panel. All work is
// no-op unless the Map view is active or the interaction starts on the svg.
export const clientScript = `
  (function () {
    var svg = document.querySelector("svg.graph");
    if (!svg) return;
    var W = Number(svg.dataset.w) || 0, H = Number(svg.dataset.h) || 0;
    var vb = { x: 0, y: 0, w: W || 1, h: H || 1 };
    function apply() { svg.setAttribute("viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h); }
    function zoomAt(factor, cx, cy) {
      var scale = W / (vb.w * factor);
      if (scale < 0.2 || scale > 8) return;
      vb.x = cx - (cx - vb.x) * factor;
      vb.y = cy - (cy - vb.y) * factor;
      vb.w *= factor; vb.h *= factor; apply();
    }
    function reset() { vb = { x: 0, y: 0, w: W || 1, h: H || 1 }; apply(); }
    // Full-page drill nav (BLZ-89) — project/view params ride along; the
    // saved-view mechanism restores the map at the new level. Shared by the
    // pointer and keyboard paths so they can't drift.
    function drillTo(id) {
      var q = new URLSearchParams(location.search);
      q.set("focus", id);
      location.search = q.toString();
    }
    function toVb(clientX, clientY) {
      var r = svg.getBoundingClientRect();
      return { x: vb.x + ((clientX - r.left) / r.width) * vb.w, y: vb.y + ((clientY - r.top) / r.height) * vb.h };
    }
    document.querySelectorAll(".mzoom").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.zoom === "reset") return reset();
        zoomAt(b.dataset.zoom === "in" ? 0.8 : 1.25, vb.x + vb.w / 2, vb.y + vb.h / 2);
      });
    });
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var p = toVb(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? 0.9 : 1.111, p.x, p.y);
    }, { passive: false });
    var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0, downNode = null, downDrill = null;
    svg.addEventListener("pointerdown", function (e) {
      dragging = true; moved = false; sx = e.clientX; sy = e.clientY; ox = vb.x; oy = vb.y;
      downNode = e.target.closest("[data-node-id]");
      downDrill = e.target.closest("[data-drill]");
      svg.classList.add("panning");
      try { svg.setPointerCapture(e.pointerId); } catch (x) {}
    });
    svg.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 4) moved = true;
      var r = svg.getBoundingClientRect();
      vb.x = ox - ((e.clientX - sx) / r.width) * vb.w;
      vb.y = oy - ((e.clientY - sy) / r.height) * vb.h;
      apply();
    });
    svg.addEventListener("pointerup", function (e) {
      dragging = false; svg.classList.remove("panning");
      try { svg.releasePointerCapture(e.pointerId); } catch (x) {}
      if (moved) { downNode = null; downDrill = null; return; } // it was a pan, not a click
      if (downDrill) {
        drillTo(downDrill.getAttribute("data-drill"));
      } else if (downNode && window.blazePanel) {
        window.blazePanel.open(downNode.getAttribute("data-node-id"));
      }
      downNode = null; downDrill = null;
    });
    svg.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      // Drill must win over the node, matching the pointer path's downDrill
      // precedence — the drill <g> nests inside the node <g>.
      var d = e.target.closest("[data-drill]");
      if (d) { e.preventDefault(); drillTo(d.getAttribute("data-drill")); return; }
      var g = e.target.closest("[data-node-id]");
      if (g && window.blazePanel) { e.preventDefault(); window.blazePanel.open(g.getAttribute("data-node-id")); }
    });
  })();
`;
