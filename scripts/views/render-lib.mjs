// scripts/views/render-lib.mjs — shared HTML render primitives for the board views.
import { formatMinutes } from "../model/time.mjs";

export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

// Minimal markdown for the ticket body: headings, lists, checkboxes, bold, code.
// AC checkboxes (under `## Acceptance Criteria`) are live: they carry data-ac-index
// matching the ordinal used by applyToggleAc (0-based, AC section only).
// Checkboxes outside the AC section remain disabled.
export function mdLite(src) {
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

export const inline = (s) =>
  s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

// Render the `pr:` frontmatter field ("#843 — https://…/pull/843") as a link.
export function prLink(pr) {
  if (!pr) return "";
  const url = (pr.match(/https?:\/\/\S+/) || [])[0];
  const num = (pr.match(/#(\d+)/) || [])[1];
  if (!url) return "";
  return `<a class="prlink" href="${esc(url)}" target="_blank" rel="noopener">🔗 PR${num ? ` #${esc(num)}` : ""}</a>`;
}

// Build the dot-separated meta line as HTML pieces (text escaped, links raw).
export function metaPieces(m) {
  return [
    m.assignee && m.assignee !== "unassigned" ? `@${esc(m.assignee)}` : "",
    m.estimate ? esc(formatMinutes(m.estimate)) : "",
    m.parent ? `↳ ${esc(m.parent)}` : "",
    m.project ? esc(m.project) : "",
    prLink(m.pr),
  ].filter(Boolean);
}
