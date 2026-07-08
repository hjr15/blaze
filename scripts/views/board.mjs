// scripts/views/board.mjs — the Board (kanban columns) view.
import { esc, mdLite, metaPieces } from "./render-lib.mjs";
import { formatMinutes } from "../model/time.mjs";
import { searchText } from "../model/search.mjs";

export function card(t, rollup) {
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
    <details class="card prio-${esc(prio)}" draggable="true" data-id="${esc(m.id || t.file)}" data-search="${esc(searchText(t))}">
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

export function render(model) {
  const { columns: cols, rollup } = model;
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
  return `<div class="board">${columnsHtml}</div>`;
}

// Board-container CSS moved verbatim from serve.mjs.
//
// NOTE on scope: the brief's CSS note says the card/row-shared rules
// (.body, .body *, .prio*, .label, .editmeta, .editable, .prlink) should stay
// in serve.mjs's base <style> since they're reused by the List view's row()
// too — they move to page.mjs in a later task. In the *original* CSS block,
// though, those shared rules (.count, .id, .prio/.type/.label, .labels,
// .cardmeta, .rollup, .editmeta, .editable, .prio.prio-* pill colors) are
// textually interleaved between the board-container rules (.board..card-top,
// .title/.badges, .card.prio-* borders) rather than contiguous with them.
// Splitting them out would require re-ordering the emitted <style> text,
// which would break the byte-level golden snapshot. To stay behaviour-
// identical, this export keeps the whole contiguous span verbatim (still
// ending right before `.body`, which *is* cleanly separable and stays in
// base per the note) — a physical grouping the byte-identical requirement
// forces, tidied up when Task 7 reworks the CSS split in page.mjs.
export const styles = `
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
  .card.prio-medium { border-left-color: var(--blaze-amber); }`;

export const clientScript = "";
