// scripts/model/import-markdown.mjs — the markdown medium: a SECOND READER
// onto the same `planImport`, and the reverse serialization that closes its
// loop. BLZ-633, implementing design §4.5
// (docs/design/csv-import-and-export.md).
//
// WHAT §4.5 ASKS FOR, IN ITS OWN WORDS:
//
//     `blaze import --format markdown <dir-or-glob>` parses each file with
//     `parseTicket`, turning it into the **same in-memory row shape** the CSV
//     reader produces, and then runs the identical planner, validator and
//     writer. [...] BLZ-588's "literally the same code path" criterion is met
//     structurally: there is one `planImport(rows, board, opts)` and two
//     readers that produce `rows`.
//
// SO THERE IS NO VALIDATION IN THIS FILE. Not one enum check, not one grammar
// check, not one reference check, and no refusal message about any of them.
// This module's whole job is `parseTicket` → the 31 canonical cells; every
// judgement about those cells belongs to `planImport`, which is the only place
// they are worded (`import-plan.mjs`: "THE ECHO RULE IS IMPLEMENTED HERE AND
// NOWHERE ELSE"). `tests/import-shared-rule.test.mjs` compares the two
// readers' refusals WORD FOR WORD, which is what makes a validation rule
// smuggled in here impossible to add unnoticed.
//
// AND THERE IS NO SECOND ENCODER EITHER. The frontmatter → cells step goes
// through `exportRows`, one record at a time — the same function `blaze export
// --format csv` uses and the same function `import-plan.mjs`'s own
// `canonicalCells` uses to decide what "identical" means. That is not reuse
// for its own sake: `encodeList`, `encodePairList`, `encodeWorklog`, §2.6's
// empty-means-absent rule and §2.8's unknown-frontmatter-key refusal all come
// with it, and a hand-rolled encoder here would be a second opinion on all
// five.
//
// THE FOUR THINGS THE MEDIUM ITSELF HAS TO DECIDE, since §4.5 does not:
//
//   1. `status` is THE DIRECTORY. Design §1.1 is explicit that `status` is not
//      a frontmatter key — it is where the file sits — so the reader takes it
//      from the containing directory's name and the writer puts it there. A
//      markdown document that carried `status:` as a field would be inventing
//      a 29th key and giving the reader two sources for one value.
//   2. `project` comes from FRONTMATTER. `exportRows` reads it off the walk
//      because "frontmatter .project is NOT a substitute: it is absent on some
//      boards" (index.mjs, BLZ-271) — but a document that has left the corpus
//      has no walk to be read off, and `project` IS one of the canonical 28
//      keys. So the reader reads it from frontmatter and the writer STAMPS it
//      from the walk; otherwise a board whose tickets omit the key would
//      export markdown that its own reader refuses on a required column.
//   3. A markdown import is NOT a mapping. §4.5: "frontmatter needs no mapping
//      layer — it is already the canonical vocabulary — so `propose-mapping`
//      does not apply to it." It therefore shares the reserved `canonical`
//      receipt name rather than introducing a second one, and the runner
//      refuses `--format markdown --mapping` outright.
//   4. The markdown EXPORT is a function, not a verb, and writes nothing —
//      see `exportMarkdownDocs` at the bottom for why.
import { readdirSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { readRegularFileSync } from "./regular-file.mjs";
import { parseTicket, serializeTicket } from "./ticket.mjs";
import { exportRows, UnknownFrontmatterKeyError } from "./export-rows.mjs";
import { fsReadStorage } from "./read-storage.mjs";
import { COLUMN_NAMES } from "./csv-schema.mjs";
import { slugify } from "./storage.mjs";

export const MARKDOWN_EXT = ".md";

/** The three columns that are not frontmatter keys (design §1.1), derived from
 *  COLUMN_NAMES the way `export-rows.mjs` derives its own copy — from the one
 *  source, so the two cannot drift. */
const NON_FRONTMATTER = new Set(["schema_version", "status", "description"]);
const KNOWN_FRONTMATTER_KEYS = new Set(COLUMN_NAMES.filter((n) => !NON_FRONTMATTER.has(n)));

/** The numeric part of an id, for ordering — `exportRows`'s own rule, so a
 *  markdown export lists tickets in the canonical CSV's row order. */
function idNum(id) {
  const n = Number(String(id ?? "").split("-").pop());
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

// --- collecting the input ----------------------------------------------------

/**
 * `<dir-or-glob>` → the markdown files to read, in a deterministic order.
 *
 * A DIRECTORY is walked recursively; a `.md` FILE is taken as itself. A glob
 * is the shell's job, which is why several paths are accepted: `blaze import
 * --format markdown out/*` arrives here as a list. Sorted by path, so the row
 * numbers a refusal names are stable across runs and across filesystems.
 *
 * Hidden entries (`.git`, `.blaze`, `.ids`) are skipped: a board's own
 * directory is a legitimate thing to point this at, and `.ids/` holds claim
 * files, not tickets.
 */
export function collectMarkdownFiles(paths) {
  const out = [];
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); out.push(p); } };

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).slice().sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(MARKDOWN_EXT)) add(abs);
    }
  };

  for (const p of paths) {
    let entries;
    try {
      entries = readdirSync(p, { withFileTypes: true });
    } catch {
      // Not a directory (or unreadable as one): take it as a file and let the
      // read below report what is actually wrong with it.
      add(p);
      continue;
    }
    void entries;
    walk(p);
  }
  return out.sort();
}

// --- the reader --------------------------------------------------------------

/**
 * markdown documents → the row shape `planImport` takes.
 *
 * @returns `{ ok: true, rows, files, legend }` where a row is
 *          `{ row, line, cells, file }` — the SAME shape
 *          `parseCanonicalCsv(...).rows` returns, plus the `file` a refusal's
 *          `row N` refers to. `legend` is the row → file listing the verb
 *          prints, because "row 7" is not actionable when the rows came from
 *          seven files rather than from seven lines of one.
 * @returns `{ ok: false, exitCode, errors }` otherwise, with `exitCode`
 *          following §5.1's split exactly as the CSV reader's does:
 *
 *            2 — COULD NOT LOOK. A file that will not open, or will not parse
 *                as a ticket at all (no `---` frontmatter block). The file is
 *                not the format it claims.
 *            1 — DATA REFUSED. The document parsed and says something the
 *                canonical vocabulary cannot express: a 29th frontmatter key
 *                (§2.8), or a link whose TYPE is outside `LINK_TYPES` (§1.4).
 *                Both come out of `exportRows`, which is where the canonical
 *                vocabulary is enforced for the CSV side too.
 *
 * The two classes are collected in two passes rather than short-circuiting on
 * the first error, because a directory of 300 documents with three bad ones is
 * three things to fix, not three runs.
 */
export function readMarkdownRows(paths, { dataRoot = null } = {}) {
  const rel = (p) => (dataRoot ? relative(dataRoot, p) || p : p);
  const files = collectMarkdownFiles(Array.isArray(paths) ? paths : [paths]);

  if (files.length === 0) {
    return { ok: false, exitCode: 2, errors: [
      `blaze import: no ${MARKDOWN_EXT} files under ${paths.map(rel).join(", ")} — a markdown `
      + `import reads a directory of ticket documents, or the paths a shell glob expanded to `
      + `(design §4.5). Nothing was read and nothing was written`] };
  }

  // --- pass 1: open and parse. Exit 2 — "could not look".
  const parsed = [];
  const formatErrors = [];
  for (const file of files) {
    let text;
    try {
      // Through `readRegularFileSync` per ADR-0031, never opened blind: a FIFO
      // with no writer blocks forever, with no error and nothing on stderr.
      text = readRegularFileSync(file);
    } catch (e) {
      formatErrors.push(`blaze import: cannot read ${rel(file)} — ${e.message}`);
      continue;
    }
    try {
      const { frontmatter, body } = parseTicket(text);
      parsed.push({ file, frontmatter, body });
    } catch (e) {
      formatErrors.push(
        `blaze import: ${rel(file)} is not a ticket document — ${e.message}. A markdown source `
        + `is a frontmatter block delimited by '---' on line 1 plus a body (design §1.5), so the `
        + `file is not the format it claims: nothing was validated and nothing was written`);
    }
  }
  if (formatErrors.length) return { ok: false, exitCode: 2, errors: formatErrors };

  // --- pass 2: the canonical cells, THROUGH THE EXPORTER. Exit 1 — the
  // document parsed and carries something the 31 columns cannot express.
  const rows = [];
  const legend = [];
  const dataErrors = [];
  for (const [i, doc] of parsed.entries()) {
    const row = i + 1;
    const record = {
      // §1.1: the DIRECTORY, not a field. A document in no directory at all
      // yields "", which `planImport` refuses as a required column — with its
      // own message, which is the point.
      status: statusOf(doc.file),
      // BLZ-271's rule, inverted for a document that has left the corpus.
      project: doc.frontmatter.project ?? "",
      frontmatter: doc.frontmatter,
      body: doc.body,
      file: doc.file,
    };
    let cellsArr;
    try {
      cellsArr = exportRows(null, { storage: { listTickets: () => [record] } }).rows[0];
    } catch (e) {
      // `UnknownFrontmatterKeyError` (§2.8) and `encodePairList`'s
      // unknown-link-type refusal (§1.4) both land here. Neither is echoed
      // beyond what the thrown message already names — a key name and a link
      // type are both bounded by having been parsed as one.
      dataErrors.push(
        `blaze import: row ${row} (${rel(doc.file)}): ${e.message}`
        + (e instanceof UnknownFrontmatterKeyError
          ? ` The markdown medium CAN hold a 29th key and the canonical schema cannot, so `
            + `dropping it silently here would launder it out of the corpus.`
          : ""));
      continue;
    }
    const cells = {};
    for (const [j, name] of COLUMN_NAMES.entries()) cells[name] = cellsArr[j];
    // `line: 1` and not the frontmatter's own line: one document is one row,
    // and every `planImport` message names the ROW.
    rows.push({ row, line: 1, cells, file: doc.file });
    legend.push(`  row ${row}  ${rel(doc.file)}`);
  }
  if (dataErrors.length) return { ok: false, exitCode: 1, errors: dataErrors };

  return {
    ok: true, rows, files: parsed.map((d) => d.file),
    legend: [`markdown: ${rows.length} document(s)`, ...legend],
  };
}

/** The containing directory's name. `""` when the file sits at a filesystem
 *  root, which `planImport` then refuses as an empty required column. */
function statusOf(file) {
  const parent = basename(dirname(file));
  return parent === "" || parent === sep ? "" : parent;
}

// --- the writer, which closes the loop ---------------------------------------

/**
 * A corpus → one markdown document per ticket, in the board's own layout.
 *
 * READ-ONLY AND WRITES NOTHING. It returns `{ path, text }` and leaves placing
 * them to the caller, for the same reason `exportRows` returns rows and
 * `exportCsv` returns text: a model function that wrote a directory tree would
 * be a third writer in this lane for no requirement — §4.5 specifies a
 * markdown READER and no export verb at all. `blaze export --format csv`
 * remains the only export verb; this is the reverse serialization the round
 * trip needs, and `tests/markdown-round-trip.test.mjs` is what consumes it.
 *
 * `path` is `<project>/<status>/<id>-<slug>.md`, relative — the corpus's own
 * layout, so the directory this produces is one `readMarkdownRows` reads back
 * and one an operator recognises.
 *
 * Throws `UnknownFrontmatterKeyError` — refusing the WHOLE export, exactly as
 * `exportRows` does (§2.8) — rather than emitting a document whose 29th key
 * the reader would then have to refuse one at a time.
 */
export function exportMarkdownDocs(projectsDir, { storage = fsReadStorage } = {}) {
  const tickets = [...storage.listTickets(projectsDir)];
  const sorted = tickets.slice().sort((a, b) => {
    const pa = a.project ?? "", pb = b.project ?? "";
    if (pa !== pb) return pa < pb ? -1 : 1;
    return idNum(a.frontmatter?.id) - idNum(b.frontmatter?.id);
  });

  const docs = [];
  for (const t of sorted) {
    const fm = t.frontmatter ?? {};
    for (const key of Object.keys(fm)) {
      if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
      throw new UnknownFrontmatterKeyError(
        `blaze export: ticket ${fm.id ?? "?"} carries frontmatter key ${JSON.stringify(key)}, `
        + `which is outside the declared 28 canonical keys (design §2.8) — refusing the whole `
        + `export rather than silently dropping it.`,
        { ticketId: fm.id ?? null, key });
    }
    // The one field the export adds: `project`, from the walk. See the header.
    const frontmatter = { ...fm, project: t.project ?? fm.project };
    docs.push({
      id: fm.id ?? null,
      path: [t.project ?? "", t.status ?? "", `${fm.id ?? "unknown"}-${slugify(fm.title ?? "")}.md`]
        .join("/"),
      text: serializeTicket({ frontmatter, body: t.body ?? "" }),
    });
  }
  return { docs };
}
