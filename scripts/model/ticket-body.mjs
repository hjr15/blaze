// scripts/model/ticket-body.mjs — BLZ-729 (E3): a ticket's body and its acceptance criteria,
// as a caller with no checkout supplies them. Pure: the network boundary (`/api/new` today; the
// body and AC-append routes next) validates through these BEFORE any id is allocated or any row
// is written, so a refusal is a 422 that burns nothing.
import { Buffer } from "node:buffer";

/** The body `blaze new` gives a ticket when the caller supplies none (moved from new.mjs). */
export const SCAFFOLD_BODY = "## Context\n\n## Acceptance Criteria\n\n- [ ] \n\n## Notes\n";

/** The heading an AC section starts under — `applyToggleAc`'s rule (moved from edit.mjs). A
 *  `## AC` heading is NOT one: toggle, count and append all agree on that. */
export const AC_HEADING_RE = /^\s{0,3}#{1,6}\s+acceptance criteria\s*$/i;

/** The largest body a caller may send, in UTF-8 bytes (128 KiB). Measured on the body as
 *  given. A valid body can still exceed `readJsonBody`'s 256 KiB request cap once
 *  JSON-escaped, which the server answers `bad json body`; the client refuses that first. */
export const BODY_MAX_BYTES = 131072;
/** The longest one AC item may be, in UTF-8 bytes. */
export const AC_ITEM_MAX = 2000;
/** The most AC items one request may carry. */
export const AC_MAX_ITEMS = 100;

const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const CHECKBOX_RE = /^\s*- \[[ xX]\]\s/;           // applyToggleAc's rule for an AC line
const EMPTY_CHECKBOX_RE = /^\s*- \[ \]\s*$/;       // the scaffold's `- [ ] `
const NOTES_RE = /^\s{0,3}##\s+notes\s*$/i;

/** One trailing newline, whatever the input ended with. */
const endOne = (s) => `${s.replace(/\n+$/, "")}\n`;

/** A caller's body → `{ body }` (CRLF as LF, ending in exactly one `\n`) or `{ errors }`.
 *  A NUL is refused because a Postgres `text` column cannot hold one — it would fail only at
 *  the write, after the id was allocated. */
export function bodyOrErrors(v) {
  if (typeof v !== "string") return { errors: ["body must be a string"] };
  const errors = [];
  if (!v.trim()) errors.push("body must not be blank");
  const bytes = Buffer.byteLength(v, "utf8");
  if (bytes > BODY_MAX_BYTES) errors.push(`body is ${bytes} bytes; the limit is ${BODY_MAX_BYTES}`);
  if (v.includes("\0")) errors.push("body must not contain a NUL byte");
  if (errors.length) return { errors };
  return { body: endOne(v.replace(/\r\n/g, "\n")) };
}

/** A caller's AC list → `{ items: {text, checked}[] }` or `{ errors }`, each error naming the
 *  1-based item. A leading `- [ ] `, `- [x] `/`- [X] ` or `- ` is stripped; only `[x]`/`[X]`
 *  is checked. */
export function acItemsOrErrors(v) {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) return { errors: ["ac must be an array of strings"] };
  if (v.length < 1 || v.length > AC_MAX_ITEMS) return { errors: [`ac takes 1 to ${AC_MAX_ITEMS} items`] };
  const errors = [];
  const items = v.map((raw, i) => {
    const n = i + 1;
    let text = raw.trim();
    let checked = false;
    const box = /^- \[([ xX])\](?:\s+|$)/.exec(text);
    if (box) { checked = box[1] !== " "; text = text.slice(box[0].length); }
    else text = text.replace(/^-(?:\s+|$)/, "");
    text = text.trim();
    if (!text) errors.push(`ac item ${n} is blank`);
    else if (/[\r\n]/.test(text)) errors.push(`ac item ${n} spans more than one line`);
    else if (Buffer.byteLength(text, "utf8") > AC_ITEM_MAX) errors.push(`ac item ${n} is over ${AC_ITEM_MAX} bytes`);
    else if (text.includes("\0")) errors.push(`ac item ${n} must not contain a NUL byte`);
    return { text, checked };
  });
  return errors.length ? { errors } : { items };
}

const acLine = ({ text, checked }) => `- [${checked ? "x" : " "}] ${text}`;

/** The first AC heading's line index and the index of the next heading after it (or the
 *  line count), or null. */
function acSection(lines) {
  const start = lines.findIndex((l) => AC_HEADING_RE.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !HEADING_RE.test(lines[end])) end++;
  return { start, end };
}

/** `body` with its AC section's content replaced by `items`. With no AC heading, the section
 *  is inserted before the first `## Notes` heading, or appended. The result ends in one `\n`. */
export function withAcSection(body, items) {
  const block = items.map(acLine).join("\n");
  const lines = body.split("\n");
  const sec = acSection(lines);
  if (sec) {
    const head = lines.slice(0, sec.start + 1).join("\n");
    const tail = lines.slice(sec.end).join("\n");
    return endOne(`${head}\n\n${block}\n\n${tail}`);
  }
  const section = `## Acceptance Criteria\n\n${block}\n\n`;
  const notes = lines.findIndex((l) => NOTES_RE.test(l));
  if (notes !== -1) {
    const before = lines.slice(0, notes).join("\n");
    return endOne(`${before}${notes ? "\n" : ""}${section}${lines.slice(notes).join("\n")}`);
  }
  return endOne(`${body.replace(/\n*$/, "\n\n")}${section}`);
}

/** `body` with `- [ ] text` appended after the AC section's last checkbox — or as its first
 *  line, creating the section as `withAcSection` does. A LONE empty scaffold checkbox is
 *  replaced, not kept. `index` is the new item's 0-based ordinal (what `/api/ac` toggles). */
export function withAcAppended(body, text) {
  const item = acLine({ text, checked: false });
  const lines = body.split("\n");
  const sec = acSection(lines);
  if (!sec) return { body: withAcSection(body, [{ text, checked: false }]), index: 0 };
  const boxes = [];
  for (let i = sec.start + 1; i < sec.end; i++) if (CHECKBOX_RE.test(lines[i])) boxes.push(i);
  if (boxes.length === 1 && EMPTY_CHECKBOX_RE.test(lines[boxes[0]])) {
    lines[boxes[0]] = item;
    return { body: endOne(lines.join("\n")), index: 0 };
  }
  if (boxes.length) {
    lines.splice(boxes[boxes.length - 1] + 1, 0, item);
    return { body: endOne(lines.join("\n")), index: boxes.length };
  }
  const rest = lines.slice(sec.start + 1, sec.end);
  while (rest.length && rest[0].trim() === "") rest.shift();
  const out = [...lines.slice(0, sec.start + 1), "", item, "", ...rest, ...lines.slice(sec.end)];
  return { body: endOne(out.join("\n")), index: 0 };
}

/** The checkbox lines under the first AC heading, counted by `applyToggleAc`'s rule. */
export function acItemCount(body) {
  const lines = body.split("\n");
  const sec = acSection(lines);
  if (!sec) return 0;
  let n = 0;
  for (let i = sec.start + 1; i < sec.end; i++) if (CHECKBOX_RE.test(lines[i])) n++;
  return n;
}
