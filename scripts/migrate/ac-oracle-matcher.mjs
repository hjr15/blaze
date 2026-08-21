// scripts/migrate/ac-oracle-matcher.mjs — a SECOND, deliberately independent reader of
// a ticket's Acceptance Criteria section (BLZ-296).
//
// WHY A SECOND ONE. The migration's criteria are parsed by model/ac-blocks.mjs. If the
// oracle that checks the migration used that same parser, it would agree with it by
// construction — including where it is wrong. The case-sensitivity defect is the
// worked example: 153 tickets spell the heading with a lower-case c, a case-sensitive
// matcher drops their criteria silently, and an oracle sharing that matcher would
// report a clean migration while 245 tickets' criteria went missing.
//
// So this shares NO CODE with ac-blocks.mjs, and deliberately uses a different
// mechanism. ac-blocks matches headings with alternating regexes; this normalises the
// heading to a canonical string first and then compares. Two implementations of the
// same rule can still both be wrong, but they are unlikely to be wrong the SAME WAY,
// which is the entire value of a second opinion.
//
// SCOPE, stated rather than assumed. This compares CHECKBOX criteria — their text,
// their order, and their checked state. It does not adjudicate what counts as a
// "note": that classification is genuinely fuzzy (prose, wrapped continuations, plain
// bullets), two honest readers can differ, and an oracle that reports a difference
// where two readings are both defensible is an oracle people learn to ignore.
// Checkbox criteria are unambiguous, and they are where silent loss actually hurts.

/** Strip the leading #s and normalise spacing/case. `##  Acceptance   Criteria ` -> `acceptance criteria`. */
function headingText(line) {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  if (i > 3 || line[i] !== "#") return null;          // >3 spaces of indent is not a heading
  let hashes = 0;
  while (i < line.length && line[i] === "#") { hashes++; i++; }
  if (hashes > 6) return null;
  if (i < line.length && line[i] !== " " && line[i] !== "\t") return null;  // `#foo` is not a heading
  return line.slice(i).trim().replace(/\s+/g, " ").toLowerCase();
}

/** Does this normalised heading open an Acceptance Criteria section? */
function opensAc(h) {
  if (h === null) return false;
  if (h === "ac") return true;
  if (!h.startsWith("acceptance")) return false;
  const rest = h.slice("acceptance".length);
  // "acceptance", "acceptance criteria", "acceptance criteria (mitigation)" — but not
  // "acceptance testing notes", which is a different section.
  return rest === "" || rest.startsWith(" criteria") || rest.startsWith(":");
}

/** A checkbox line: optional indent, a bullet marker, `[ ]` or `[x]`, then the text. */
function checkbox(line) {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  const indent = i;
  if (line[i] !== "-" && line[i] !== "*" && line[i] !== "+") return null;
  i++;
  if (line[i] !== " " && line[i] !== "\t") return null;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
  if (line[i] !== "[") return null;
  const mark = line[i + 1];
  if (line[i + 2] !== "]") return null;
  if (mark !== " " && mark !== "x" && mark !== "X") return null;
  return { indent, checked: mark !== " ", text: line.slice(i + 3).trim() };
}

function isBulletStart(t) {
  return (t[0] === "-" || t[0] === "*" || t[0] === "+") && (t[1] === " " || t[1] === "\t");
}
function isOrderedStart(t) {
  let i = 0;
  while (i < t.length && t[i] >= "0" && t[i] <= "9") i++;
  return i > 0 && (t[i] === "." || t[i] === ")") && (t[i + 1] === " " || t[i + 1] === "\t");
}

/**
 * Every checkbox criterion in the ticket's AC section, in order.
 * Returns [] when there is no AC section at all — which is a different fact from
 * "the section exists and is empty", so `hasSection` reports it separately.
 */
export function acCriteria(body) {
  const lines = String(body ?? "").split("\n");
  let inAc = false, inFence = false, hasSection = false, lastIndent = 0;
  // Whether a criterion is currently open to continuation lines. Any other bullet —
  // including `- [~]`, which is used in this corpus for "partially met" and is not a
  // checkbox to either reader — CLOSES it. Without that, the unrecognised bullet is
  // skipped, the criterion above stays open, and that bullet's own indented lines are
  // appended to the wrong criterion.
  let open = false;
  // Sections are collected separately and the first one with content wins. Collecting
  // them all into one list would merge a template stub with the real criteria and
  // report a count nobody wrote; taking the first unconditionally is the bug this
  // oracle found in the importer.
  const sections = [];
  let out = [];
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = headingText(line);
    if (h !== null) {
      // A heading always ends the previous section, whether or not it opens a new one.
      if (inAc && out.length) sections.push(out);
      out = []; open = false;
      if (opensAc(h)) { inAc = true; hasSection = true; }
      else inAc = false;
      continue;
    }
    if (!inAc) continue;
    const c = checkbox(line);
    // `head` is the bullet's OWN line; `text` adds whatever continues it. They are kept
    // apart because they carry different authority — see the note in zero-diff.mjs.
    if (c) { out.push({ head: c.text, text: c.text, checked: c.checked }); lastIndent = c.indent; open = true; continue; }

    // A wrapped continuation. Long criteria are split across lines in the corpus, and
    // reading only the first line truncates them — which the oracle caught on 1,801
    // criteria the first time this was written without it. A line continues the
    // previous criterion when it is non-blank, is not itself a bullet or an ordered
    // item, and there is a criterion open to continue.
    const t = line.trim();
    if (t === "") continue;

    // Indentation decides before shape does. A line starting at or left of the bullet's
    // own column is a new block — prose, a note — and ends the criterion. A line
    // indented PAST it continues the criterion even when it happens to begin with a
    // bullet character: the corpus wraps text onto lines starting with a literal `+`,
    // and reading that as a new bullet truncated the criterion mid-sentence.
    let lead = 0;
    while (lead < line.length && (line[lead] === " " || line[lead] === "\t")) lead++;
    if (lead <= lastIndent) {
      if (isBulletStart(t) || isOrderedStart(t)) open = false;
      continue;
    }
    if (!open || !out.length) continue;
    out[out.length - 1].text = `${out[out.length - 1].text} ${t}`.trim();
  }
  if (inAc && out.length) sections.push(out);
  // A section of bare `- [ ]` markers is a template stub, not the criteria. Choosing
  // it over the real section is the defect this oracle found in the importer.
  const nonEmpty = sections.find((sec) => sec.some((c) => c.text.trim() !== ""));
  return { criteria: nonEmpty ?? sections[0] ?? [], hasSection };
}
