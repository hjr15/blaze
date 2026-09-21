// scripts/model/export-rows.mjs — corpus → canonical CSV rows. BLZ-627,
// implementing design §2.7-§2.8 and §3.2 (docs/design/csv-import-and-export.md).
//
// Read-only: walks the corpus through the existing read seam (`fsReadStorage`,
// ADR-0009) — the same seam `blaze audit`/`blaze rollup` use — and never
// touches a write port. No board semantics beyond what the canonical schema
// (csv-schema.mjs, BLZ-626) already declares: this module's whole job is
// picking the right cell for each of the 31 columns and sorting the rows.
import { fsReadStorage } from "./read-storage.mjs";
import { writeCsv } from "./csv.mjs";
import {
  COLUMN_NAMES, SCHEMA_VERSION, encodeList, encodePairList, encodeWorklog,
} from "./csv-schema.mjs";

/**
 * The 28 frontmatter keys a canonical row can express — every COLUMN_NAMES
 * entry except the three that are NOT frontmatter: `schema_version` (a
 * constant this module stamps), `status` (the directory, not a field —
 * design §1.1) and `description` (the ticket body, not frontmatter — design
 * §1.1). Derived from COLUMN_NAMES rather than duplicated, so the two lists
 * cannot drift the way two independently-maintained key lists always do.
 */
const NON_FRONTMATTER_COLUMNS = new Set(["schema_version", "status", "description"]);
const KNOWN_FRONTMATTER_KEYS = new Set(
  COLUMN_NAMES.filter((name) => !NON_FRONTMATTER_COLUMNS.has(name)));

/** design §2.8: an export that met a 29th key would have nowhere honest to put
 * it — dropping it silently or inventing a column are both worse than refusing
 * the whole export and naming the ticket and the key. */
export class UnknownFrontmatterKeyError extends Error {
  constructor(message, { ticketId, key }) {
    super(message);
    this.name = "UnknownFrontmatterKeyError";
    this.ticketId = ticketId;
    this.key = key;
  }
}

/**
 * design §2.5's hostile predicate, applied identically on export (which only
 * WARNS) and, eventually, on import (which refuses) — the whole point of the
 * design's "one character set, one predicate, used by both sides" fix.
 * Stripping leading whitespace FIRST is what stops a leading tab or space
 * from smuggling `=`/`@` past a first-character-only check.
 *
 * BLZ-628 EXPORTS it rather than letting the import side copy it. Design
 * §2.5's whole fix is "one character set, one predicate, used by BOTH sides",
 * and the defect it closes is two implementations drifting — export warning
 * about a leading tab that import then accepted. A second copy reinstates
 * that on the first edit to either one.
 */
const LEADING_WS_RE = /^[ \t\r\n ]+/;
export function isHostileCell(cell) {
  const stripped = cell.replace(LEADING_WS_RE, "");
  return stripped.length > 0 && (stripped[0] === "=" || stripped[0] === "@");
}

/** The numeric part of an id, for row ordering. Non-numeric/absent sorts last
 * rather than throwing — a malformed id is someone else's finding (`blaze
 * audit`), not this module's business to crash over. */
function idNum(id) {
  const n = Number(String(id ?? "").split("-").pop());
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function cellFor(columnName, { fm, body, status, project }) {
  switch (columnName) {
    case "schema_version": return String(SCHEMA_VERSION);
    case "status": return status ?? "";
    case "description": return body ?? "";
    // `project` is read off the WALK, not off frontmatter — index.mjs's own
    // rule (BLZ-271): "frontmatter .project is NOT a substitute: it is absent
    // on some boards, while the directory is always present."
    case "project": return project ?? "";
    case "labels": return encodeList(fm.labels ?? []);
    case "components": return encodeList(fm.components ?? []);
    case "links": return encodePairList(fm.links ?? []);
    case "worklog": return encodeWorklog(fm.worklog ?? []);
    default: {
      const v = fm[columnName];
      return v === undefined || v === null || v === "" ? "" : String(v);
    }
  }
}

/**
 * Corpus → { rows, warnings }. `rows` is string[][] in canonical column order
 * (csv-schema.mjs's COLUMN_NAMES), sorted per design §3.2: project ascending,
 * then the NUMERIC part of id ascending (`BLZ-9` before `BLZ-10`).
 *
 * Throws `UnknownFrontmatterKeyError` — refusing the WHOLE export, not a
 * partial file with the key dropped — the moment any ticket's frontmatter
 * carries a key outside the declared 28 (design §2.8).
 *
 * `warnings` names every hostile cell (design §2.5) — ticket id, column, and
 * the excerpt — for the caller to print. Export never mutates a value and
 * never refuses on this account; only import does.
 */
export function exportRows(projectsDir, { storage = fsReadStorage } = {}) {
  const tickets = [...storage.listTickets(projectsDir)];
  const sorted = tickets.slice().sort((a, b) => {
    const pa = a.project ?? "", pb = b.project ?? "";
    if (pa !== pb) return pa < pb ? -1 : 1;
    return idNum(a.frontmatter?.id) - idNum(b.frontmatter?.id);
  });

  const rows = [];
  const warnings = [];
  for (const t of sorted) {
    const fm = t.frontmatter ?? {};
    for (const key of Object.keys(fm)) {
      if (!KNOWN_FRONTMATTER_KEYS.has(key)) {
        throw new UnknownFrontmatterKeyError(
          `blaze export: ticket ${fm.id ?? "?"} carries frontmatter key ${JSON.stringify(key)}, `
          + `which is outside the declared 28 canonical keys (design §2.8) — refusing the whole `
          + `export rather than silently dropping it or inventing a 32nd column.`,
          { ticketId: fm.id ?? null, key });
      }
    }
    const ctx = { fm, body: t.body, status: t.status, project: t.project };
    const row = COLUMN_NAMES.map((name) => cellFor(name, ctx));
    row.forEach((cell, i) => {
      if (isHostileCell(cell)) {
        const excerpt = cell.length > 40 ? `${cell.slice(0, 40)}…` : cell;
        warnings.push(
          `${fm.id ?? "?"}: column '${COLUMN_NAMES[i]}' is a spreadsheet-formula hazard `
          + `(starts with '=' or '@' after stripping leading whitespace): ${JSON.stringify(excerpt)}`);
      }
    });
    rows.push(row);
  }
  return { rows, warnings };
}

/** rows + the canonical header → canonical CSV text (design §2.1's writer). */
export function exportCsv(projectsDir, opts = {}) {
  const { rows, warnings } = exportRows(projectsDir, opts);
  const text = writeCsv([COLUMN_NAMES.slice(), ...rows]);
  return { text, warnings };
}
