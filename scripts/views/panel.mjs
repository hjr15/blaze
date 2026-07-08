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
  .panel-body { position: absolute; top: 0; right: 0; height: 100%; width: min(480px, 90vw);
    background: #161b22; border-left: 1px solid #21262d; padding: 16px 20px; overflow: auto; }
  .panel-x { position: absolute; top: 10px; right: 12px; background: none; border: 0; color: #7d8590;
    font-size: 20px; cursor: pointer; }
`;

export const clientScript = `
  window.blazePanel = {
    open(id) {
      const p = document.getElementById("blaze-panel"); if (!p) return;
      const src = document.querySelector('[data-id="' + (window.CSS ? CSS.escape(id) : id) + '"] .body');
      p.querySelector(".panel-content").innerHTML = src ? src.innerHTML
        : '<div class="empty">' + id + '</div>';
      p.hidden = false;
    },
    close() { const p = document.getElementById("blaze-panel"); if (p) p.hidden = true; },
  };
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-panel-close]")) window.blazePanel.close();
  });
`;
