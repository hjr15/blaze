// scripts/model/import-plan.mjs — the deterministic import plan. BLZ-628,
// implementing design §5.1 and §5.2 (docs/design/csv-import-and-export.md).
//
// PURE CLASSIFICATION, ZERO WRITES OF ANY KIND. `planImport` reads no board
// from disk, opens no file and touches no write port: it is handed the rows
// and a board object and returns a plan. That is what makes the plan the seam
// BLZ-629's apply walks through an injected write port, and the seam a later
// repair-classification step (BLZ-634) can consume without re-deriving
// anything.
//
// TWO FUNCTIONS, TWO EXIT CLASSES, AND THE SPLIT IS THE DESIGN'S.
//
//   parseCanonicalCsv — "could not look" (exit 2) and "mapping incomplete"
//                       (exit 3). The FILE is not the format it claims:
//                       a wrong cell count, an unterminated quote, a header
//                       that is not the canonical 31, a schema_version this
//                       build cannot read. Nothing is validated, nothing is
//                       classified.
//   planImport        — "data refused" (exit 1). The file IS a canonical CSV
//                       and some row is wrong about the board.
//
// §5.1 separates the codes because the REMEDY differs — 1 means fix the data,
// 2 means fix the file, 3 means confirm a mapping — so folding them would make
// the message carry a distinction the code should.
//
// THE ECHO RULE (§5.2) IS IMPLEMENTED HERE AND NOWHERE ELSE, because it is the
// rule three separate drafts of the design got wrong in three different ways.
// One sentence: **echo the value only after it has passed a shape check.** A
// value that parsed as `<KEY>-<N>` cannot be a pasted paragraph; a value that
// merely failed to be one of thirteen statuses can be anything at all. This is
// why the messages below are written here rather than forwarded from
// `csv-schema.mjs`'s `validateCell`, `validateTaxonomy` or `decodePairList` —
// every one of those interpolates the offending cell, which is right for a CLI
// where the operator typed the value and wrong for an import where it came out
// of someone else's export.
import { parseCsv } from "./csv.mjs";
import {
  COLUMN_NAMES, COLUMNS, SCHEMA_VERSION, isCanonicalHeader,
  isValidId, validateCell,
} from "./csv-schema.mjs";
import { isHostileCell, exportRows } from "./export-rows.mjs";
import { LINK_TYPES } from "./links.mjs";
import { validateTicket } from "./rules.mjs";
import { validateSprintFields } from "./sprints.mjs";

/** Columns that are not frontmatter keys: the version constant, the directory
 *  and the body (design §1.1). Everything else in COLUMN_NAMES is a key. */
const NON_FRONTMATTER = new Set(["schema_version", "status", "description"]);

/** The grammar named in a SHAPE refusal, which reports the expectation and
 *  nothing of the cell. Keyed by the abstract type `csv-schema.mjs` declares. */
const GRAMMAR = {
  integer: "an integer (-?[0-9]+, no separators, no decimal point)",
  date: "a date (YYYY-MM-DD, exactly 10 characters)",
  id: "an id (<KEY>-<N>)",
  "project-key": "a project key (refused, never normalised — ADR-0025)",
};

// --- the reader --------------------------------------------------------------

/**
 * Record start offsets, so a format refusal can name a byte offset rather than
 * only a row number. A second, position-only scan of the same grammar
 * `parseCsv` implements: `parseCsv` returns cells, which is the right contract
 * for a format layer, and threading positions through it would make every
 * caller pay for one caller's error messages.
 *
 * @returns { starts, openQuoteAt } — `starts[i]` is the UTF-16 index the i-th
 *          record begins at; `openQuoteAt` is the index of a quote that was
 *          opened and never closed, or null.
 */
function recordPositions(text) {
  const starts = [0];
  let inQuotes = false;
  let openQuoteAt = null;
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { i += 2; continue; }
        inQuotes = false; openQuoteAt = null; i++; continue;
      }
      i++; continue;
    }
    if (ch === '"') { inQuotes = true; openQuoteAt = i; i++; continue; }
    if (ch === "\r" && text[i + 1] === "\n") { i += 2; starts.push(i); continue; }
    if (ch === "\n") { i++; starts.push(i); continue; }
    i++;
  }
  return { starts, openQuoteAt: inQuotes ? openQuoteAt : null };
}

/** The 1-based LINE a UTF-16 index sits on, and the UTF-8 BYTE offset of it.
 *  Bytes, not characters, because that is what an operator's editor and
 *  `dd`/`head -c` agree on — and a CSV carrying an em-dash (every `pr` value
 *  on the live board does) makes the two differ. */
function locate(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return { line, byteOffset: Buffer.byteLength(text.slice(0, index), "utf8") };
}

/**
 * CSV text → the row shape `planImport` takes, or a FORMAT refusal.
 *
 * @returns { ok: true, rows } where a row is
 *          `{ row, line, cells }` — `row` the 1-based DATA row number (the
 *          number §5.2's messages mean), `line` the file line the record
 *          starts on, `cells` a column-name → raw-string map.
 * @returns { ok: false, exitCode, errors } otherwise. `exitCode` is 2 for a
 *          file that is not the format it claims and 3 for a header with no
 *          confirmed mapping.
 */
export function parseCanonicalCsv(text) {
  const refuse = (exitCode, ...errors) => ({ ok: false, exitCode, errors, rows: [] });

  if (text === "") {
    return refuse(2, "blaze import: the file is empty — a canonical CSV's first line is its header (design §2.1)");
  }

  const pos = recordPositions(text);
  let grid;
  try {
    grid = parseCsv(text);
  } catch (e) {
    // The only throw `parseCsv` has, and the design names it as exit 2
    // ("wrong cell count, or an unterminated quote").
    const at = locate(text, pos.openQuoteAt ?? text.length);
    return refuse(2,
      `blaze import: unterminated quoted field — a '"' was opened at line ${at.line}, `
      + `byte offset ${at.byteOffset}, and never closed before end of input. The file is not `
      + `the format it claims, so nothing was validated and nothing was written (${e.message})`);
  }

  const [header, ...dataRows] = grid;
  if (!header) {
    return refuse(2, "blaze import: the file has no header row (design §2.1)");
  }
  if (!isCanonicalHeader(header)) {
    const known = new Set(COLUMN_NAMES);
    const unknown = header.filter((h) => !known.has(h));
    const missing = COLUMN_NAMES.filter((n) => !header.includes(n));
    const parts = [];
    if (unknown.length) parts.push(`columns with no canonical name: ${unknown.join(", ")}`);
    if (missing.length) parts.push(`canonical columns absent: ${missing.join(", ")}`);
    if (!parts.length) parts.push("the 31 canonical columns are present but not in canonical order");
    // Exit 3, not 2: the remedy is "confirm a mapping", which is a different
    // action from "fix the file". §5.2's first row — name the column and both
    // places it could be declared.
    return refuse(3,
      `blaze import: this file's header is not the canonical 31 columns in canonical order — `
      + `${parts.join("; ")}. Either supply a confirmed mapping (--mapping import-mappings/<name>.json, `
      + `written by \`blaze import propose-mapping\`, in which every source column is declared in `
      + `\`columns\` or in \`unmapped\`) or re-export the file canonically`);
  }

  const versionIdx = COLUMN_NAMES.indexOf("schema_version");
  const rows = [];
  for (const [i, cellsArr] of dataRows.entries()) {
    const at = locate(text, pos.starts[i + 1] ?? text.length);
    if (cellsArr.length !== COLUMN_NAMES.length) {
      return refuse(2,
        `blaze import: row ${i + 1} (line ${at.line}, byte offset ${at.byteOffset}) has `
        + `${cellsArr.length} cells, not ${COLUMN_NAMES.length}. Every row of a canonical CSV has `
        + `exactly ${COLUMN_NAMES.length} cells (design §2.1), so the file is not the format it `
        + `claims — nothing was validated and nothing was written`);
    }
    const version = cellsArr[versionIdx];
    if (version !== String(SCHEMA_VERSION)) {
      return refuse(2,
        `blaze import: row ${i + 1} (line ${at.line}) declares schema_version ${JSON.stringify(version)}, `
        + `not ${JSON.stringify(String(SCHEMA_VERSION))}. Every row carries the version and they must `
        + `agree; a file this build cannot read as the format it declares is refused rather than `
        + `misread (design §2.2)`);
    }
    const cells = {};
    for (const [j, name] of COLUMN_NAMES.entries()) cells[name] = cellsArr[j];
    rows.push({ row: i + 1, line: at.line, cells });
  }
  return { ok: true, rows };
}

// --- the canonical identity of a ticket --------------------------------------

/**
 * A ticket record → its 31 canonical cells, THROUGH THE EXPORTER.
 *
 * This is what "identical" means in §5.2's skip rule, and reusing
 * `exportRows` rather than writing a second comparator is deliberate: a
 * comparator written by the same hand as the exporter agrees with it by
 * construction, INCLUDING WHERE IT IS WRONG — the failure `zero-diff.mjs`
 * already names for the AC matcher. Defining "identical" as "would export to
 * these bytes" also makes the re-run-is-a-no-op guarantee and the §3 round
 * trip the same property rather than two that can drift apart.
 *
 * The `null` projectsDir is never read: `exportRows` passes it only to
 * `storage.listTickets`, and the storage here is a one-record stub.
 */
function canonicalCells(record) {
  const { rows } = exportRows(null, { storage: { listTickets: () => [record] } });
  return rows[0];
}

// --- per-row cell decoding ---------------------------------------------------

/** The `allowed` set for an enum column, resolved per row (design §1.2/§2.2 —
 *  never a hardcoded list). `status` depends on the row's own `type`, so it is
 *  resolvable only once the type is known to be legal. */
function allowedFor(column, board, type) {
  switch (column) {
    case "type": return new Set(Object.keys(board.types));
    case "priority": return new Set(board.priorities);
    case "resolution": return new Set(board.resolutions);
    case "status": return type == null ? null : new Set(board.statusesFor(type));
    default: return null;
  }
}

/** The nearest legal estimates either side of a non-multiple-of-5 integer. */
function nearestMultiplesOfFive(n) {
  const lo = Math.floor(n / 5) * 5;
  return [lo, lo + 5];
}

/**
 * Decode one row's cells into a ticket record, collecting refusals.
 * @returns { errors, values } — `values` is column → decoded value (null for
 *          an absent optional cell). `errors` are already echo-rule-correct.
 */
function decodeRow(entry, board) {
  const errors = [];
  const values = {};
  const at = `row ${entry.row}`;

  // §2.5 first, on the RAW cells and on every column, because a hostile cell
  // is a refusal regardless of whether its column's grammar would accept it.
  for (const name of COLUMN_NAMES) {
    if (isHostileCell(entry.cells[name])) {
      errors.push(
        `${at}: \`${name}\` begins with '=' or '@' after leading whitespace is stripped, which a `
        + `spreadsheet evaluates as a formula on open. Refused (design §2.5). The cell's contents `
        + `are deliberately not reproduced here`);
    }
  }

  // `type` first: `status`'s legal set is a function of it.
  const typeCell = entry.cells.type;
  const typeOk = typeCell !== "" && Object.hasOwn(board.types, typeCell);
  if (!typeOk) {
    errors.push(
      `${at}: \`type\` is not one of ${Object.keys(board.types).join(", ")} — a value outside the `
      + `resolved registry is a refusal, never a coercion. The cell is not echoed: \`type\` carries `
      + `no shape constraint, so a failing value can be anything at all (design §5.2)`);
  }

  for (const col of COLUMNS) {
    const name = col.name;
    if (name === "schema_version") { values[name] = SCHEMA_VERSION; continue; }
    const raw = entry.cells[name];
    if (name === "id" && raw === "") {
      // `id` is the one REQUIRED column whose emptiness is not settled here.
      // §5.2 refuses an id-less row BY DEFAULT and accepts it under
      // `--allocate-ids`, and this function does not know the flag — so the
      // cell decodes to null and `planImport` below applies the rule. Letting
      // the column-level required check fire would refuse the row with a
      // message that never names the flag that accepts it.
      values.id = null;
      continue;
    }
    const allowed = allowedFor(name, board, typeOk ? typeCell : null);
    if (col.type === "enum" && allowed === null) {
      // `status` with an unresolvable type: the type refusal above is the
      // actionable one, and a second message about a legal set nobody can
      // compute would be noise.
      values[name] = raw === "" ? null : raw;
      continue;
    }
    const r = validateCell(name, raw, allowed ? { allowed } : {});
    if (r.ok) { values[name] = r.value; continue; }

    // NOT `r.error`: every message `validateCell` produces interpolates the
    // cell. Re-authored here per the echo rule.
    if (raw === "") {
      errors.push(`${at}: \`${name}\` is required and cannot be empty (design §2.2)`);
    } else if (col.type === "enum") {
      errors.push(
        `${at}: \`${name}\` is not one of ${[...allowed].join(", ")}. Refused, never coerced; the `
        + `cell is not echoed (design §5.2's echo rule — \`${name}\` has no shape constraint)`);
    } else if (col.type === "pair-list") {
      errors.push(
        `${at}: \`links\` is not a ';'-separated list of \`Type:TARGET\` pairs with Type one of `
        + `${[...LINK_TYPES].join(", ")} and TARGET an id (<KEY>-<N>). The cell is not echoed: a link `
        + `type has no shape constraint and a malformed member is unbounded text (design §5.2)`);
    } else if (col.type === "json-array") {
      errors.push(
        `${at}: \`worklog\` is not a JSON array of objects (RFC 8259), each `
        + `{"date":…,"minutes":…,"note":…}. The cell is not echoed: \`worklog.note\` is free text `
        + `(design §5.2)`);
    } else {
      errors.push(
        `${at}: \`${name}\` is not ${GRAMMAR[col.type] ?? "the expected shape"}. The cell is not `
        + `echoed — a value that FAILED its shape check has by definition not been bounded, so it `
        + `may be pasted data (design §5.2)`);
    }
    values[name] = null;
  }

  // Grammar passed; now the MEMBERSHIP checks whose values ARE echoed, because
  // they have already been bounded by a shape.
  if (typeof values.estimate === "number" && values.estimate % 5 !== 0) {
    const [lo, hi] = nearestMultiplesOfFive(values.estimate);
    errors.push(
      `${at}: \`estimate\` is ${values.estimate}, which is not a multiple of 5 minutes — the `
      + `nearest legal values are ${lo} and ${hi}. Refused, not rounded: rounding is \`blaze new\`'s `
      + `INPUT policy and it invents (design §5.2)`);
  }
  // A link target must be a well-formed id before it can be looked up. The
  // pair-list grammar constrains the TYPE half and the member count; the
  // target half is an id by §2.3 and is checked here.
  for (const pair of values.links ?? []) {
    if (!isValidId(pair.target)) {
      errors.push(
        `${at}: a \`links\` entry has type ${JSON.stringify(pair.type)} and a target that is not an `
        + `id (<KEY>-<N>). A link with no usable target is refused rather than dropped — an importer `
        + `that dropped it would launder corruption into a clean-looking board (design §5.2)`);
    }
  }
  return { errors, values };
}

/** Decoded cells → the record a write port takes. An absent optional value is
 *  an ABSENT KEY, never a default (design §2.6): materialising `medium` or
 *  `unassigned` here is the exact defect that breaks round-trip gate 1. */
function recordFrom(values) {
  const frontmatter = {};
  for (const name of COLUMN_NAMES) {
    if (NON_FRONTMATTER.has(name)) continue;
    const v = values[name];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    frontmatter[name] = v;
  }
  return {
    project: values.project,
    status: values.status,
    frontmatter,
    body: values.description ?? "",
  };
}

// --- the plan ----------------------------------------------------------------

/**
 * rows + board → the create/update/skip/refuse plan. PURE.
 *
 * @param rows   `parseCanonicalCsv(...).rows`, or the same shape from any
 *               other front end — the markdown reader (BLZ-588) and the
 *               mapping layer (BLZ-634) both produce it, which is what makes
 *               "literally the same code path" structural rather than
 *               promised.
 * @param board  `{ byId, types, statusesFor, priorities, resolutions,
 *                  sprintIds, projectFor }`. Everything the planner needs to
 *               resolve against, and nothing that would make it impure.
 * @param opts   `{ allocateIds, update }`.
 *
 * @returns a plan:
 *   {
 *     ok,          // no refusals
 *     applicable,  // === ok: validation is all-or-nothing, so one bad row
 *                  //   means ZERO writes (§5.3)
 *     exitCode,    // 0 or 1
 *     rows: [ { seq, row, line, id, source, op, allocate,
 *               ticket?, currentFile?, changedColumns?, errors? } ],
 *     refusals: [ { seq, row, message } ],
 *     counts: { create, update, skip, refuse },
 *   }
 *
 * `rows` is in FILE ORDER and every entry carries a stable `seq`, because two
 * consumers depend on walking it deterministically: BLZ-629's apply, which
 * writes `seq` into every receipt entry, and the repair verb, which matches a
 * receipt's `seq` back to the row it describes.
 */
export function planImport(rows, board, opts = {}) {
  const { allocateIds = false, update = false } = opts;
  const entries = [];
  const refusals = [];

  // Pass 1 — per-row grammar, then the id set. Both need to be complete
  // before any row is judged: a forward reference is only resolvable once
  // every id in the file is known, which is why §7 rules out streaming.
  const decoded = rows.map((entry) => ({ entry, ...decodeRow(entry, board) }));

  const rowsById = new Map();
  for (const d of decoded) {
    const id = d.values.id;
    if (typeof id !== "string") continue;
    if (!rowsById.has(id)) rowsById.set(id, []);
    rowsById.get(id).push(d);
  }
  for (const [id, hits] of rowsById) {
    if (hits.length < 2) continue;
    const msg =
      `duplicate id ${id}: rows ${hits.map((h) => h.entry.row).join(", ")} all carry it. Refused — `
      + `never "last row wins", which is how a silent collapse once hid open work behind a closed `
      + `ticket on a real board (design §5.2)`;
    for (const h of hits) h.errors.push(msg);
  }

  // The id set the file itself will bring into existence, plus the board's.
  // A row with a refused id contributes nothing, so a reference to it still
  // dangles — which is correct: that row is not going to be written.
  const fileIds = new Map();
  for (const d of decoded) {
    if (d.errors.length) continue;
    const id = d.values.id;
    if (typeof id === "string") fileIds.set(id, d);
  }
  const lookup = (id) => {
    const inFile = fileIds.get(id);
    if (inFile) return { frontmatter: inFile.values, body: inFile.values.description ?? "" };
    const onBoard = board.byId.get(id);
    return onBoard ? { frontmatter: onBoard.frontmatter, body: onBoard.body } : null;
  };
  const known = (id) => fileIds.has(id) || board.byId.has(id);

  // Pass 2 — references, model rules, classification.
  for (const d of decoded) {
    const { entry, values } = d;
    const errors = d.errors;
    const at = `row ${entry.row}`;

    if (values.parent && !known(values.parent)) {
      errors.push(
        `${at}: \`parent\` ${values.parent} is in neither this file nor the board. Refused, never `
        + `silently dropped. A forward reference WITHIN the file resolves — the whole file is read `
        + `before any row is judged — so this reference has no row to resolve to (design §5.2)`);
    }
    for (const pair of values.links ?? []) {
      if (isValidId(pair.target) && !known(pair.target)) {
        errors.push(
          `${at}: \`links\` names ${pair.target} (${pair.type}), which is in neither this file nor `
          + `the board. Refused, never silently dropped (design §5.2)`);
      }
    }

    if (errors.length === 0) {
      const record = recordFrom(values);

      // Membership against the model's own rules, reusing the engine's
      // validators. Three of their messages interpolate the cell, so those
      // three are dropped here and re-authored above, per the echo rule.
      const modelErrors = validateTicket(
        { frontmatter: record.frontmatter, body: record.body }, lookup, { types: board.types });
      for (const m of modelErrors) {
        if (/^parent not found:/.test(m)) continue;        // named above, with the echo rule applied
        if (/^invalid priority:/.test(m)) continue;        // named above
        if (/^invalid resolution:/.test(m)) continue;      // named above
        if (/^unknown or missing type:/.test(m)) continue; // named above
        errors.push(`${at}: ${m}`);
      }

      const projectCfg = board.projectFor?.(record.project) ?? null;
      for (const field of ["labels", "components"]) {
        const declared = projectCfg?.[field] ?? [];
        if (declared.length === 0) continue;
        const off = (record.frontmatter[field] ?? []).filter((v) => !declared.includes(v));
        if (off.length === 0) continue;
        // NOT `validateTaxonomy`'s message: it interpolates the value
        // (`taxonomy.mjs:14`), which is right for `blaze new` where the
        // operator typed it and wrong for an import where it came from
        // someone else's export.
        errors.push(
          `${at}: ${off.length} \`${field}\` value(s) are not in the taxonomy `
          + `projects/${record.project}/project.json declares (${declared.join(", ")}) — add them `
          + `there first. The offending values are not echoed (design §5.2)`);
      }

      for (const m of validateSprintFields(record.frontmatter, { sprintIds: board.sprintIds })) {
        if (/^sprint /.test(m)) {
          // Same rule: a sprint id has no shape constraint, so the registered
          // set is named and the cell is not.
          errors.push(
            `${at}: \`sprint\` is not in the registry. Registered sprint ids: `
            + `${[...board.sprintIds].join(", ") || "(none)"} (sprints.json). The cell is not `
            + `echoed (design §5.2)`);
          continue;
        }
        // The remaining messages compare two dates that both PASSED their
        // shape check, so echoing them is exactly what the rule allows.
        errors.push(`${at}: ${m}`);
      }
    }

    const seq = entry.row;
    const idValue = typeof values.id === "string" ? values.id : null;
    const base = { seq, row: entry.row, line: entry.line, id: idValue, source: entry.source ?? null };

    if (values.id === null && !allocateIds) {
      errors.push(
        `${at}: \`id\` is empty. It is required on import, because the re-run-is-a-no-op guarantee `
        + `is keyed on it: an id-less row has nothing to compare against and would allocate a fresh `
        + `id on every run. \`--allocate-ids\` accepts it and forfeits that guarantee (design §5.2)`);
    }

    if (errors.length) {
      entries.push({ ...base, op: "refuse", allocate: false, errors });
      for (const message of errors) refusals.push({ seq, row: entry.row, message });
      continue;
    }

    const record = recordFrom(values);

    if (idValue === null) {
      // `--allocate-ids`: the id is drawn at apply time, step 2 of §5.3's
      // sequence. The planner does not allocate — allocation is an
      // irreversible side effect and this module writes nothing.
      entries.push({ ...base, op: "create", allocate: true, ticket: record });
      continue;
    }

    const existing = board.byId.get(idValue);
    if (!existing) {
      entries.push({ ...base, op: "create", allocate: false, ticket: record });
      continue;
    }

    let before;
    try {
      before = canonicalCells(existing);
    } catch (e) {
      const message =
        `${at}: ${idValue} already exists on the board but cannot be compared against this row — `
        + `${e.message}`;
      entries.push({ ...base, op: "refuse", allocate: false, errors: [message] });
      refusals.push({ seq, row: entry.row, message });
      continue;
    }
    const after = canonicalCells({ ...record, file: existing.file });
    const changedColumns = COLUMN_NAMES.filter((_, i) => before[i] !== after[i]);

    if (changedColumns.length === 0) {
      entries.push({ ...base, op: "skip", allocate: false, ticket: record, currentFile: existing.file });
      continue;
    }
    if (!update) {
      const message =
        `${at}: ${idValue} already exists on the board and differs in `
        + `${changedColumns.join(", ")}. Pass --update to apply the change; the differing VALUES are `
        + `not reproduced here (design §5.2). "Identical" means all ${COLUMN_NAMES.length} canonical `
        + `columns, \`status\` and \`description\` included`;
      entries.push({ ...base, op: "refuse", allocate: false, errors: [message], changedColumns });
      refusals.push({ seq, row: entry.row, message });
      continue;
    }
    entries.push({
      ...base, op: "update", allocate: false, ticket: record,
      currentFile: existing.file, changedColumns,
    });
  }

  const counts = { create: 0, update: 0, skip: 0, refuse: 0 };
  for (const e of entries) counts[e.op]++;
  const ok = counts.refuse === 0;
  return {
    ok,
    // Validation is all-or-nothing and that guarantee is TOTAL (§5.3): 500
    // good rows and 3 bad ones exits 1 with the 3 named and 497 untouched.
    applicable: ok,
    exitCode: ok ? 0 : 1,
    rows: entries,
    refusals,
    counts,
  };
}
