// scripts/views/list.mjs — the List (Linear-style grouped rows) view.
import { esc, mdLite, metaPieces } from "./render-lib.mjs";
import { searchText } from "../model/search.mjs";

// A compact one-line row for the List view (Linear-style). Same expandable body.
export function row(t) {
  const m = t.meta;
  const prio = m.priority || "none";
  const labels = (m.labels || [])
    .map((l) => `<span class="label">${esc(l)}</span>`)
    .join("");
  const meta = metaPieces(m).join(" · ");
  return `
    <details class="row prio-${esc(prio)}" draggable="true" data-id="${esc(m.id || t.file)}" data-search="${esc(searchText(t))}">
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

export function render(model) {
  const cols = model.columns;
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
  return `<div class="list">${groupsHtml}</div>`;
}

// List-container CSS moved verbatim from serve.mjs.
//
// NOTE on scope: the brief's CSS callout says these row-shared rules must
// STAY in serve.mjs's base <style> (they move to page.mjs in Task 7):
// .prlink, #live, .proj/.proj:hover/.proj.on, #toast/#toast.show,
// .card[draggable]/.row[draggable], .col.drop-hover/.group.drop-hover.
// In the *original* CSS block those base rules are textually interleaved
// between list-scoped rules rather than contiguous with them — after this
// contiguous span (.list … .row .rmeta) the source continues
// .prlink/.prlink:hover (base), then .row > .body / .row.prio-* (list-
// scoped again), then #live/.proj* (base), then the row @media rule (list-
// scoped), then #toast*/draggable/drop-hover (base).
//
// `list.styles` is spliced at a single point in serve.mjs's template
// literal (same pattern as `board.styles`/`live.styles`). Moving `.row >
// .body`, `.row.prio-*`, and the `@media (max-width: 640px)` row rule here
// too would require either a second insertion point (duplicating/
// reordering output — breaks the byte-identical golden) or pulling the
// interleaved base rules into this module (which the brief's callout
// explicitly forbids). Per the brief's own fallback guidance, this export
// stays to the one clean contiguous span and leaves those three list-
// scoped bits as literal residue in serve.mjs's base <style> — flagged for
// Task 7 (page.mjs) to fold in properly once the base/view CSS split is
// reworked wholesale.
export const styles = `

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
  .row .rmeta { color: #7d8590; font-size: 11px; white-space: nowrap; }`;

export const clientScript = "";
