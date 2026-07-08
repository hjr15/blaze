// scripts/model/search.mjs — the model-level search index for a ticket.
//
// searchText(ticket) returns the lowercased haystack a client-side search box
// matches a query against: the ticket's id, title, labels and assignee joined
// with spaces. Pure and dependency-free; the board/list renderers stamp its
// output onto each card/row as `data-search` so filtering is a plain substring
// test with zero server round-trip.
//
// Accepts either a board-model ticket ({ meta }) or a bare frontmatter object.
// Missing fields are dropped; a non-array `labels` is tolerated.
export function searchText(ticket) {
  const m = ticket && ticket.meta ? ticket.meta : ticket || {};
  const labels = Array.isArray(m.labels) ? m.labels : m.labels ? [m.labels] : [];
  return [m.id, m.title, ...labels, m.assignee]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
