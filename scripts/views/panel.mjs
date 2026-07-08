// scripts/views/panel.mjs — shared card-detail panel.
//
// CONTRACT (stable seam for other views to build against):
//   window.blazePanel.open(ticketId)  — open the panel for a ticket
//   window.blazePanel.close()         — close it
// This module owns the panel's markup/styles/behaviour; other views call
// window.blazePanel.open(id) on click/edit interactions.
// Module exports follow the view contract: render / styles / clientScript.

export function render() {
  return `<div id="blaze-panel" class="panel" hidden>
    <div class="panel-backdrop" data-panel-close></div>
    <aside class="panel-body" role="dialog" aria-label="Ticket detail">
      <button type="button" class="panel-x" data-panel-close aria-label="Close">×</button>
      <div class="panel-content"></div>
    </aside>
  </div>`;
}

export const styles = `
  .panel[hidden] { display: none; }
  .panel { position: fixed; inset: 0; z-index: 30; }
  .panel-backdrop { position: absolute; inset: 0; background: #0008; }
  .panel-body { position: absolute; top: 0; right: 0; height: 100%; width: min(520px, 92vw);
    background: #161b22; border-left: 1px solid #21262d; padding: 16px 20px; overflow: auto; }
  .panel-x { position: absolute; top: 10px; right: 12px; background: none; border: 0; color: #7d8590;
    font-size: 20px; cursor: pointer; }
  .panel-content { color: #c9d1d9; }
  .panel-crumb { font-size: 12px; margin-bottom: 6px; }
  .panel-id { color: #7d8590; font-family: ui-monospace, monospace; font-size: 12px; font-weight: 600; }
  .panel-title { margin: 2px 0 10px; font-size: 16px; color: var(--neutral); }
  .panel-pr { margin-bottom: 8px; }
  .panel-md { margin: 6px 0 14px; }
  .panel-sec { margin: 12px 0; }
  .panel-sec h4 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; color: #adbac7; letter-spacing: .4px; }
  .panel-fm { width: 100%; border-collapse: collapse; font-size: 12px; }
  .panel-fm th { text-align: left; color: #7d8590; font-weight: 600; padding: 3px 8px 3px 0; vertical-align: top; white-space: nowrap; width: 1%; }
  .panel-fm td { color: #c9d1d9; padding: 3px 0; word-break: break-word; }
  .panel-children, .panel-links { list-style: none; margin: 0; padding: 0; font-size: 13px; }
  .panel-children li, .panel-links li { padding: 3px 0; }
  .panel-link { appearance: none; background: none; border: 0; padding: 0; cursor: pointer;
    color: #58a6ff; font: inherit; font-weight: 600; }
  .panel-link:hover { text-decoration: underline; }
  .panel-status { color: #7d8590; font-size: 11px; }
  .panel-linktype { color: var(--blaze-amber); font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .panel-empty { color: #7d8590; padding: 24px 0; text-align: center; }
`;

// The panel fetches server-rendered (escaped) HTML from /api/panel — it no
// longer DOM-clones the board card body (which was unescaped and wrong in List
// view). Parent/children breadcrumbs carry data-panel-open for in-panel drill.
export const clientScript = `
  window.blazePanel = {
    async open(id) {
      const p = document.getElementById("blaze-panel"); if (!p || !id) return;
      const content = p.querySelector(".panel-content");
      content.innerHTML = '<div class="panel-empty">Loading…</div>';
      p.hidden = false;
      try {
        const res = await fetch("/api/panel?id=" + encodeURIComponent(id));
        content.innerHTML = res.ok ? await res.text()
          : '<div class="panel-empty">Ticket not found.</div>';
      } catch (err) {
        // Static message — never interpolate id into innerHTML (dataset decodes
        // the server's escaping, so a markup-bearing id would execute here).
        content.innerHTML = '<div class="panel-empty">Failed to load ticket.</div>';
      }
    },
    close() { const p = document.getElementById("blaze-panel"); if (p) p.hidden = true; },
  };
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-panel-close]")) { window.blazePanel.close(); return; }
    const drill = e.target.closest("[data-panel-open]");
    if (drill) { e.preventDefault(); window.blazePanel.open(drill.getAttribute("data-panel-open")); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const p = document.getElementById("blaze-panel");
    if (p && !p.hidden) window.blazePanel.close();   // no-op when already closed
  });
`;
