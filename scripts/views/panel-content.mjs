// scripts/views/panel-content.mjs — the card-detail panel's content model +
// renderer. Pure functions (panelModel / panelContentHtml) are unit-tested; the
// panelHtml wrapper does the file read the /api/panel route needs.
//
// The panel is a read + AC-toggle surface over the plain ticket file: rendered
// description, a full frontmatter table, parent breadcrumb + children list, and
// links. No new source of truth — relations come from the derived index, the
// body + full frontmatter from the ticket file itself.
import { readFileSync } from "node:fs";
import { buildIndex } from "../model/index.mjs";
import { parseTicket } from "../model/ticket.mjs";
import { fieldInputs } from "../model/fields.mjs";
import { esc, mdLite, prLink } from "./render-lib.mjs";

// Pure: assemble the panel model from the derived index + the ticket's parsed
// frontmatter/body. Returns null for an unknown id (with no ticket supplied).
export function panelModel(index, id, ticket) {
  const row = index.get(id);
  if (!row && !ticket) return null;
  const meta = (ticket && ticket.frontmatter) || {};
  const body = (ticket && ticket.body) || "";
  const parentId = row ? row.parent : meta.parent;
  const parentRow = parentId ? index.get(parentId) : null;
  const parent = parentId ? { id: parentId, title: parentRow ? parentRow.title ?? null : null } : null;
  const children = index.rows
    .filter((r) => r.parent === id)
    .map((r) => ({ id: r.id, title: r.title ?? null, status: r.status, type: r.type }));
  const links = index.linksFrom(id).map((l) => ({ type: l.type, target: l.target }));
  return { id, meta, bodyHtml: mdLite(body), parent, children, links };
}

// Pure: render the panel-content HTML fragment the client injects. All dynamic
// text is escaped; the body is rendered via mdLite (so AC checkboxes keep their
// data-ac-index) and wrapped in a data-ticket container so the existing
// delegated /api/ac change handler drives commit-on-edit unchanged.
export function panelContentHtml(model) {
  if (!model) return `<div class="panel-empty">Ticket not found.</div>`;
  const { id, meta, bodyHtml, parent, children, links } = model;
  const crumb = parent
    ? `<div class="panel-crumb">↳ <button type="button" class="panel-link" data-panel-open="${esc(parent.id)}">${esc(parent.id)}${parent.title ? " · " + esc(parent.title) : ""}</button></div>`
    : "";
  // Keys with their own dedicated surface (title heading, PR link, Links
  // section) are skipped by fieldInputs so the Fields table isn't a redundant
  // JSON dump. Allowlisted (EDITABLE_FIELDS) keys render as editable spans
  // that the document-delegated blazeEdit handler drives; the rest are
  // plain, read-only text.
  const fmRows = fieldInputs(meta)
    .map((f) => {
      const cell = f.editable
        ? `<span class="editable" data-edit="${esc(f.key)}" data-value="${esc(f.value)}">${esc(f.value || "—")}</span>`
        : esc(f.value);
      return `<tr><th>${esc(f.key)}</th><td>${cell}</td></tr>`;
    })
    .join("");
  const childrenHtml = children.length
    ? `<div class="panel-sec"><h4>Children</h4><ul class="panel-children">${children
        .map((c) => `<li><button type="button" class="panel-link" data-panel-open="${esc(c.id)}">${esc(c.id)}</button> ${esc(c.title || "")} <span class="panel-status">${esc(c.status)}</span></li>`)
        .join("")}</ul></div>`
    : "";
  const linksHtml = links.length
    ? `<div class="panel-sec"><h4>Links</h4><ul class="panel-links">${links
        .map((l) => `<li><span class="panel-linktype">${esc(l.type)}</span> ${esc(l.target)}</li>`)
        .join("")}</ul></div>`
    : "";
  const pr = prLink(meta.pr);
  return `<div class="panel-head" data-ticket="${esc(id)}">
      ${crumb}
      <div class="panel-id">${esc(id)}</div>
      <h3 class="panel-title"><span class="editable" data-edit="title" data-value="${esc(meta.title || "")}">${esc(meta.title || id)}</span></h3>
      ${pr ? `<div class="panel-pr">${pr}</div>` : ""}
    </div>
    <div class="panel-md body" data-ticket="${esc(id)}">${bodyHtml}</div>
    <div class="panel-sec"><h4>Fields</h4><table class="panel-fm" data-ticket="${esc(id)}">${fmRows}</table></div>
    ${childrenHtml}
    ${linksHtml}`;
}

// IO wrapper for the /api/panel route: resolve the ticket file, parse it, and
// render. Returns null (→ 404) for an unknown id.
export function panelHtml(projectsDir, id) {
  const index = buildIndex(projectsDir);
  const row = index.get(id);
  if (!row) return null;
  const { frontmatter, body } = parseTicket(readFileSync(row.file, "utf8"));
  return panelContentHtml(panelModel(index, id, { frontmatter, body }));
}
