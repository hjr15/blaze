// scripts/model/ac-blocks.mjs — parsing a ticket's Acceptance Criteria section into
// ordered blocks (BLZ-279, design D6).
//
// Today `applyToggleAc` finds the heading, collects checkbox lines, and indexes into
// that list BY ORDINAL to flip one character. Insert a bullet, reorder two, or add a
// sub-bullet and the ordinal a browser tab loaded five minutes ago points somewhere
// else. Rows give stable identity; this is the parser that produces them.
//
// TWO measured findings shape it, both re-derived against the live 2,534-ticket
// corpus rather than taken from the design document:
//
// 1. THE HEADING MATCH MUST BE CASE-INSENSITIVE. 153 tickets spell it
//    `## Acceptance criteria` with a lower-case c. A case-sensitive matcher — which
//    is what the brief's own grep and today's regex both are — silently drops their
//    acceptance criteria during migration. No error, no warning. That is the single
//    most expensive defect found in the whole re-derivation, because it is invisible.
//
// 2. NOTHING IS REFUSED. 518 of 1,959 AC sections (26.4%) hold prose, plain bullets,
//    ordered items or wrapped continuations rather than only checkboxes. A
//    checkbox-only model would reject a quarter of the corpus. The design's earlier
//    figure of 51% was measured on a stale branch; the decision holds at either
//    number, and the corrected one is recorded here so it is not re-derived wrong.
//
// Heading variants in use, by count: `## Acceptance Criteria` 1714,
// `## Acceptance criteria` 134, `## Acceptance Criteria (mitigation)` 43,
// `## Acceptance` 22, `### Acceptance criteria` 19, `## AC` 16, plus 11 one-offs.

/** Exactly the canonical heading, any casing, any heading level 1–3. */
const HEADING_EXACT = /^#{1,3}[ \t]+Acceptance[ \t]+Criteria[ \t]*$/i;
/** The near-misses: a suffix, or a shortened form. Still an AC section. */
const HEADING_NEAR = /^#{1,3}[ \t]+(Acceptance\b.*|AC)[ \t]*$/i;
/** Any heading at all — where the section ends. */
const ANY_HEADING = /^#{1,6}[ \t]+\S/;

const CHECKBOX = /^([ \t]*)[-*][ \t]+\[([ xX])\][ \t]?(.*)$/;
const FENCE = /^[ \t]*```/;
const ORDERED = /^[ \t]*\d+[.)][ \t]+/;
const BULLET = /^[ \t]*[-*][ \t]+/;

/**
 * Locate the ticket's first AC section.
 * @returns { heading, lines, exact } | null
 */
export function findAcSection(body) {
  const lines = String(body ?? "").split("\n");
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const exact = HEADING_EXACT.test(lines[i]);
    if (!exact && !HEADING_NEAR.test(lines[i])) continue;
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (ANY_HEADING.test(lines[j])) break;
      out.push(lines[j]);
    }
    found.push({ heading: lines[i].trim(), lines: out, exact });
  }
  if (!found.length) return null;

  // BLZ-296. Returning found[0] unconditionally lost real criteria on 54 tickets.
  // `blaze new` writes a template stub — `## Acceptance Criteria` followed by a single
  // empty `- [ ]` — and a hand-written body then repeats the heading with the actual
  // criteria under it. 65 tickets carry more than one AC heading and 54 of those have
  // an EMPTY first section, so the importer loaded the placeholder and dropped
  // everything real. Silently: a ticket with one blank criterion is a valid ticket.
  //
  // The rule is therefore "the first section that says anything", falling back to the
  // first when none does — which leaves the 2,498 single-section tickets untouched.
  // "Content" means a line that SAYS something, not merely a line that exists. The
  // template stub is `- [ ] ` — non-empty as a string, empty as a criterion — so a
  // bare trim() test calls the placeholder content and keeps choosing it.
  const saysSomething = (l) => {
    const t = l.trim();
    if (t === "") return false;
    const m = t.match(/^[-*+][ \t]+\[[ xX]\][ \t]*(.*)$/);
    return m ? m[1].trim() !== "" : true;
  };
  const hasContent = (sec) => sec.lines.some(saysSomething);
  return found.find(hasContent) ?? found[0];
}

/**
 * Parse an AC section into ordered blocks.
 *
 * A block is `{ ord, kind: 'criterion'|'note', text, checked }`. A criterion is a
 * checkbox; everything else is carried verbatim as a note so the section round-trips.
 *
 * Soft-wrapped continuations are joined back onto the criterion they belong to — an
 * indented line following a checkbox is the same criterion, not a new note. That
 * recovers 2,751 lines across the corpus; without it a quarter of criteria would
 * arrive truncated at the wrap point.
 */
export function parseAcBlocks(body) {
  const sec = findAcSection(body);
  if (!sec) return { heading: null, blocks: [], exact: false };

  const blocks = [];
  let inFence = false;
  for (const line of sec.lines) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      blocks.push({ kind: "note", text: line });
      continue;
    }
    if (inFence) { blocks.push({ kind: "note", text: line }); continue; }

    const box = CHECKBOX.exec(line);
    if (box) {
      blocks.push({ kind: "criterion", text: box[3], checked: box[2].toLowerCase() === "x" });
      continue;
    }
    if (!line.trim()) continue;

    // An indented line right after a criterion is that criterion's wrapped tail —
    // unless it is itself a list item, which starts something new.
    const indented = /^[ \t]/.test(line);
    const prev = blocks[blocks.length - 1];
    if (indented && prev?.kind === "criterion" && !BULLET.test(line) && !ORDERED.test(line)) {
      prev.text = `${prev.text} ${line.trim()}`.trim();
      continue;
    }
    blocks.push({ kind: "note", text: line.trim() });
  }
  return {
    heading: sec.heading,
    exact: sec.exact,
    blocks: blocks.map((b, i) => ({ ord: i, checked: false, ...b })),
  };
}
