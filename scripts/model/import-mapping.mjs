// scripts/model/import-mapping.mjs — the MAPPING LAYER's deterministic half.
// BLZ-634, implementing design §4.2, §5.2, §5.3 and §5.4
// (docs/design/csv-import-and-export.md).
//
// NO MODEL RUNS HERE, EVER — and that is the whole point of the split
// (ADR-0037 §2). This module only ever reads a mapping file a PERSON has
// already accepted, and turns an arbitrary CSV into the same row shape
// `planImport` takes from a canonical one. The proposer that WRITES a mapping
// file lives in `import-mapping-propose.mjs`, is reached only by `blaze import
// propose-mapping`, and is deliberately absent from this module's import graph
// so that `scripts/import-runner.mjs` cannot reach it at all (§4.3's surviving
// static assertion, pinned in tests/import-agent-boundary.test.mjs).
//
// THREE ARTEFACTS, and none of them is a cache (§6):
//
//   * `import-mappings/<name>.json`  — the accepted mapping. SOURCE.
//   * `source-ids/<name>.jsonl`      — source key → blaze id, an OUTCOME log
//                                      appended per row BETWEEN the ticket
//                                      write and that row's `done` (§5.3 step
//                                      6). Never pruned, never rewritten.
//   * `<map>.corrupt`, `<receipt>.corrupt` — parked bytes of a torn line,
//                                      written by `repair --apply` ALONE.
//
// THE ORDERING THIS FILE MUST NOT CHOOSE AGAIN. §4.2 spent a whole round on
// it and states it once, so it is restated here only as a pointer:
//
//   * the pair is appended AFTER the ticket write and BEFORE `done`, so
//     `done` IMPLIES pair and the re-import lookup can never be blind to a
//     ticket that exists. `import-apply.mjs` owns that placement via its
//     `onPair` hook; this module supplies the hook and does not move it.
//   * `repair --apply` runs PARK → TRUNCATE → PAIR → `resolved`, in that
//     order, because `resolved` is the record that LIFTS the exit-5 refusal
//     and must never exist without the pair it vouches for. A crash between
//     the two then keeps the refusal (one extra run) instead of lifting it
//     over a missing pair (a duplicated row).
import { join, basename, dirname, relative } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, truncateSync } from "node:fs";
import { appendRegularFileSync, readRegularFileSync } from "./regular-file.mjs";
import { COLUMN_NAMES, SCHEMA_VERSION } from "./csv-schema.mjs";
import { parseCsv } from "./csv.mjs";
import { planImport } from "./import-plan.mjs";
import {
  CANONICAL_NAME, RECEIPT_DIR, applyImport, inspectReceipt, latestReceiptFor,
  loadBoard, pruneReceipts, readReceipt, receiptPathFor, unresolvedIntents,
} from "./import-apply.mjs";
import { fsReadStorage } from "./read-storage.mjs";
import { commitOrQueue, commitSuffix } from "../commit-or-queue.mjs";

/** At the DATA ROOT beside `sprints.json`, committed and diffable — a mapping
 *  is SOURCE, not a regenerable cache, which is the line BLZ-110 drew for the
 *  sprint registry for the same reason (§4.2). */
export const MAPPING_DIR = "import-mappings";

/** The durable map, at the data root for the same reason and NEVER prunable:
 *  it outlives every individual run, and deleting it duplicates the board on
 *  the next re-import — the precise failure `sourceIdColumn` exists to
 *  prevent (§4.2). */
export const SOURCE_IDS_DIR = "source-ids";

/** Re-exported so a caller has one import for "the reserved name" rather than
 *  two spellings of it. It is `import-apply.mjs`'s constant; this module does
 *  not define a second. */
export const CANONICAL_MAPPING_NAME = CANONICAL_NAME;

const MAPPING_VERSION = 1;

export function mappingPathFor(dataRoot, name) {
  return join(dataRoot, MAPPING_DIR, `${name}.json`);
}

export function sourceIdsPathFor(dataRoot, name) {
  return join(dataRoot, SOURCE_IDS_DIR, `${name}.jsonl`);
}

// --- the closed transform vocabulary -----------------------------------------
//
// A CLOSED VOCABULARY, NOT AN EXPRESSION LANGUAGE (§4.2). An expression
// language here would be a second place a model's output becomes executable,
// and ADR-0037 §2 exists to have exactly one. Every entry is a total function
// from a string to a string or a refusal; none of them can reach the
// filesystem, the network or `eval`.
//
// UNIT JUDGEMENT, stated rather than buried: `days-to-minutes` is 1440 — a
// LITERAL day. A "working day" of 8h is a scheduling policy, and a transform
// that silently applied one would be inferring something about the source
// tracker, which is exactly what this layer exists not to do.

const MINUTES_PER = { "hours-to-minutes": 60, "seconds-to-minutes": 1 / 60, "days-to-minutes": 60 * 24 };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const THREE_PART = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/;

function pad(n) { return String(n).padStart(2, "0"); }

function dateFrom(cell, order) {
  const m = THREE_PART.exec(cell);
  if (!m) return null;
  const [a, b, c] = [m[1], m[2], m[3]];
  const [d, mo, y] = order === "dmy" ? [a, b, c] : [b, a, c];
  if (y.length !== 4) return null;
  const dn = Number(d); const mn = Number(mo);
  if (!(dn >= 1 && dn <= 31) || !(mn >= 1 && mn <= 12)) return null;
  return `${y}-${pad(mn)}-${pad(dn)}`;
}

/** name → (cell) => { ok, value } | { ok: false }. */
const TRANSFORMS = Object.freeze({
  identity: (v) => ({ ok: true, value: v }),
  trim: (v) => ({ ok: true, value: v.trim() }),
  "hours-to-minutes": (v) => minutes(v, "hours-to-minutes"),
  "seconds-to-minutes": (v) => minutes(v, "seconds-to-minutes"),
  "days-to-minutes": (v) => minutes(v, "days-to-minutes"),
  // The canonical compact list is ';'-joined (§2.4), so `split-semicolon` is
  // a re-emission and `split-comma` is a genuine conversion. Both trim their
  // members and drop empties, because "a, b" and "a,b" are the same list.
  "split-semicolon": (v) => list(v, ";"),
  "split-comma": (v) => list(v, ","),
  "iso-date": (v) => (ISO.test(v) ? { ok: true, value: v } : { ok: false }),
  "dmy-date": (v) => wrap(dateFrom(v, "dmy")),
  "mdy-date": (v) => wrap(dateFrom(v, "mdy")),
});

function wrap(value) { return value === null ? { ok: false } : { ok: true, value }; }

function minutes(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false };
  const out = n * MINUTES_PER[name];
  if (!Number.isInteger(out)) return { ok: false };
  return { ok: true, value: String(out) };
}

function list(v, sep) {
  const members = v.split(sep).map((m) => m.trim()).filter((m) => m !== "");
  if (members.some((m) => m.includes(";"))) return { ok: false };
  return { ok: true, value: members.join(";") };
}

export const TRANSFORM_NAMES = Object.freeze(Object.keys(TRANSFORMS));

/**
 * Run one transform. An EMPTY CELL IS ABSENT and stays empty on every
 * transform (§2.6: "empty and absent are one thing") — converting "" to a 0
 * would materialise a value the source never carried, which is the defect
 * that breaks round-trip gate 1.
 */
export function applyTransform(name, cell) {
  if (cell === "") return { ok: true, value: "" };
  const fn = TRANSFORMS[name];
  if (!fn) return { ok: false };
  return fn(cell);
}

// --- the mapping file --------------------------------------------------------

/**
 * The digest `source.sha256` carries.
 *
 * JUDGEMENT CALL, because §4.2 says only "`source.columns` is the verbatim
 * header row and `source.sha256` is its digest". It is the digest of the
 * HEADER, not of the file: a file digest would bind a mapping to exactly one
 * export and make the second import of the same tracker a refusal, which is
 * the opposite of what §4.2 wants ("a source export whose HEADER has changed
 * is a refusal"). It is taken over the header's canonical CSV re-emission, so
 * two files that quote the same header differently agree.
 */
export function headerDigest(header) {
  const canonical = header.map((h) => JSON.stringify(String(h))).join(",");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function refuse(exitCode, ...errors) { return { ok: false, exitCode, errors, mapping: null }; }

/**
 * Read and validate `import-mappings/<name>.json` AS A FILE — everything
 * decidable without the CSV in hand.
 *
 * Exit 2 for a file that is not JSON (it is not the format it claims), exit 3
 * for every structural refusal: the remedy is "confirm a mapping", which is a
 * different action from "fix the file" (§5.1).
 */
export function loadMapping(path, opts = {}) {
  let text = opts.text;
  try {
    // BLZ-635: `text` lets the PROPOSER put a candidate through exactly these
    // rules before it writes one, so a mapping the importer would refuse never
    // reaches disk. It is the same function, not a second copy — two copies of
    // "what a valid mapping is" is how the proposer and the importer drift.
    if (text === undefined) text = readRegularFileSync(path);
  } catch (e) {
    if (e && e.code === "ENOENT") {
      return refuse(3,
        `blaze import: the mapping file ${basename(path)} is absent (looked in ${dirname(path)}). `
        + `A mapping is SOURCE and is committed beside sprints.json — write one with `
        + `\`blaze import propose-mapping\`, review it, and pass it with --mapping (design §4.2)`);
    }
    return refuse(2, `blaze import: cannot read the mapping ${basename(path)} — ${e.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return refuse(2,
      `blaze import: ${basename(path)} is not JSON — ${e.message}. The file is not the format it `
      + `claims, so nothing was validated and nothing was written`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse(2, `blaze import: ${basename(path)} is not a JSON object (design §4.2)`);
  }

  const errors = [];
  const expected = basename(path).replace(/\.json$/, "");

  if (raw.mappingVersion !== MAPPING_VERSION) {
    errors.push(`\`mappingVersion\` is ${JSON.stringify(raw.mappingVersion)}, not ${MAPPING_VERSION}`);
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`\`schemaVersion\` is ${JSON.stringify(raw.schemaVersion)}, not ${SCHEMA_VERSION} — `
      + `this build reads exactly one canonical schema version (design §2.2)`);
  }
  // The `name`-equals-basename rule. Three artefacts are keyed on `<name>` —
  // the mapping, `source-ids/<name>.jsonl` and `import-receipts/<ISO>-<name>.jsonl`
  // — and "this mapping's latest receipt" is only computable if the three
  // agree. A mapping with two names has two histories.
  if (raw.name !== expected) {
    errors.push(`\`name\` is ${JSON.stringify(raw.name)} but the file's basename is `
      + `${JSON.stringify(expected)}. They must be the same string: the map (source-ids/<name>.jsonl) `
      + `and every receipt (import-receipts/<ISO>-<name>.jsonl) are keyed on it`);
  }
  if (raw.name === CANONICAL_MAPPING_NAME) {
    errors.push(`\`canonical\` is RESERVED — it is the <name> a canonical-header import with no `
      + `mapping file uses for its receipt, so a mapping file may not be called it (design §4.2)`);
  }

  const source = raw.source;
  if (!source || typeof source !== "object" || !Array.isArray(source.columns)
    || typeof source.sha256 !== "string") {
    errors.push("`source` must be `{ columns: [...the verbatim header row...], sha256: \"...\" }`");
  }

  const columns = raw.columns;
  if (!columns || typeof columns !== "object" || Array.isArray(columns)) {
    errors.push("`columns` must be an object mapping a canonical column name to its source");
  } else {
    const canonical = new Set(COLUMN_NAMES);
    for (const [target, spec] of Object.entries(columns)) {
      if (!canonical.has(target)) {
        errors.push(`\`columns.${target}\` is not one of the ${COLUMN_NAMES.length} canonical columns `
          + `(design §2.2)`);
        continue;
      }
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        errors.push(`\`columns.${target}\` must be \`{ "from": "<source column>" }\` or `
          + `\`{ "constant": "<value>" }\``);
        continue;
      }
      const hasFrom = typeof spec.from === "string";
      const hasConstant = typeof spec.constant === "string";
      if (hasFrom === hasConstant) {
        errors.push(`\`columns.${target}\` needs exactly one of \`from\` and \`constant\``);
      }
      if (spec.transform !== undefined && !Object.hasOwn(TRANSFORMS, spec.transform)) {
        // The CLOSED vocabulary, named in the refusal because it is what the
        // operator acts on. A mapping naming a transform outside the list is
        // refused rather than interpreted — this is not an expression language.
        errors.push(`\`columns.${target}.transform\` is ${JSON.stringify(spec.transform)}, which is `
          + `not one of the ${TRANSFORM_NAMES.length} transforms this build has: `
          + `${TRANSFORM_NAMES.join(", ")} (design §4.2)`);
      }
    }
  }

  if (!Array.isArray(raw.unmapped)) {
    errors.push("`unmapped` is REQUIRED and must be an array — every source column is either in "
      + "`columns` or in `unmapped`, so a column cannot be dropped by omission (design §4.2)");
  }
  if (raw.values !== undefined && (!raw.values || typeof raw.values !== "object" || Array.isArray(raw.values))) {
    errors.push("`values` must be an object of per-column translation tables");
  }
  if (raw.sourceIdColumn !== undefined && raw.sourceIdColumn !== null
    && typeof raw.sourceIdColumn !== "string") {
    errors.push("`sourceIdColumn`, when present, names a column of the source header");
  }

  if (errors.length) {
    return refuse(3, ...errors.map((e) => `blaze import: ${basename(path)}: ${e}`));
  }
  return {
    ok: true,
    exitCode: 0,
    errors: [],
    mapping: {
      ...raw,
      sourceIdColumn: raw.sourceIdColumn ?? null,
      values: raw.values ?? {},
    },
  };
}

/**
 * Bind a loaded mapping to an ACTUAL file's header: the `sha256` check, the
 * added/removed columns, and `unmapped` completeness.
 *
 * A header that has changed since the mapping was confirmed is a REFUSAL, not
 * a best-effort re-map — that is the case where silently continuing produces
 * the wrong-but-plausible board (§4.2).
 */
export function bindMapping(mapping, header, opts = {}) {
  const errors = [];
  const declared = mapping.source?.columns ?? [];
  const digest = opts.sha256 ?? headerDigest(header);

  if (digest !== mapping.source?.sha256) {
    const have = new Set(header);
    const had = new Set(declared);
    const added = header.filter((h) => !had.has(h));
    const removed = declared.filter((h) => !have.has(h));
    const parts = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
    if (!parts.length) parts.push("the column NAMES are unchanged, so the order or the spelling moved");
    errors.push(
      `blaze import: this file's header does not match the one ${mapping.name} was confirmed against `
      + `— its sha256 digest differs (${parts.join("; ")}). Refused: a mapping is NOT re-derived and `
      + `there is no fall back to name matching, because silently continuing here produces the `
      + `wrong-but-plausible board (design §4.2, §5.2). Re-run \`blaze import propose-mapping\` `
      + `against the new export and review the result`);
    return { ok: false, exitCode: 3, errors };
  }

  const sourceColumns = new Set(header);
  const mapped = new Set();
  for (const [target, spec] of Object.entries(mapping.columns)) {
    if (typeof spec.from !== "string") continue;
    mapped.add(spec.from);
    if (!sourceColumns.has(spec.from)) {
      errors.push(`blaze import: ${mapping.name} maps \`${target}\` from a source column `
        + `"${spec.from}" that this file's header does not have`);
    }
  }
  const unmapped = new Set(mapping.unmapped);
  // `sourceIdColumn` is a THIRD declaration site, and the design does not say
  // so in as many words — a judgement this module makes rather than hides.
  // §4.2's own example maps `Issue key` to `id` AND declares it as the source
  // key, but it also says "a tracker whose keys do not parse as <KEY>-<N> uses
  // `sourceIdColumn` alone" — a column that is USED as the row's identity.
  // Listing it in `unmapped` would be a lie, because §4.4 renders `unmapped`
  // as "will be DISCARDED" and this column is the one thing that survives a
  // re-import; leaving it undeclared would break completeness. So it counts as
  // declared, and nothing is silently ignored.
  const undeclared = header.filter((h) =>
    !mapped.has(h) && !unmapped.has(h) && h !== mapping.sourceIdColumn);
  if (undeclared.length) {
    errors.push(
      `blaze import: ${undeclared.length} source column(s) are declared in NEITHER \`columns\` nor `
      + `\`unmapped\`: ${undeclared.join(", ")}. Every source column must be one or the other, so a `
      + `column cannot be dropped by omission — map it in \`columns\`, or add it to \`unmapped\` to `
      + `say out loud that it is discarded (design §4.2, §5.2)`);
  }
  if (mapping.sourceIdColumn && !sourceColumns.has(mapping.sourceIdColumn)) {
    errors.push(`blaze import: ${mapping.name} declares \`sourceIdColumn\` `
      + `"${mapping.sourceIdColumn}", which this file's header does not have`);
  }
  return errors.length ? { ok: false, exitCode: 3, errors } : { ok: true, exitCode: 0, errors: [] };
}

/**
 * A source grid (header + data rows) → the `{ row, line, cells, source }`
 * shape `planImport` takes. The SAME shape the canonical reader produces,
 * which is what makes "one planner, several front ends" structural rather
 * than promised (§4.5).
 *
 * The mapping layer NEVER invents a translation: a value with no entry in
 * `values` passes through unchanged and the planner refuses it against the
 * legal set (§5.2). Guessing here is precisely the failure ADR-0037 exists to
 * prevent.
 */
export function mapRows(mapping, grid) {
  const [header, ...dataRows] = grid;
  const index = new Map(header.map((h, i) => [h, i]));
  const rows = [];
  const errors = [];

  for (const [i, cellsArr] of dataRows.entries()) {
    const rowNo = i + 1;
    if (cellsArr.length !== header.length) {
      return {
        ok: false, exitCode: 2, rows: [],
        errors: [`blaze import: source row ${rowNo} has ${cellsArr.length} cells, not the `
          + `${header.length} its header declares. The file is not the format it claims, so nothing `
          + `was validated and nothing was written (design §5.2)`],
      };
    }
    const cells = {};
    for (const name of COLUMN_NAMES) cells[name] = "";
    cells.schema_version = String(SCHEMA_VERSION);

    for (const [target, spec] of Object.entries(mapping.columns)) {
      let value = typeof spec.constant === "string" ? spec.constant : cellsArr[index.get(spec.from)] ?? "";
      if (spec.transform && spec.transform !== "identity") {
        const t = applyTransform(spec.transform, value);
        if (!t.ok) {
          // The echo rule (§5.2): the value FAILED its shape check, so the
          // message names the row, the column and the transform, and nothing
          // of the cell.
          errors.push(`blaze import: row ${rowNo}: \`${target}\` could not be converted by the `
            + `\`${spec.transform}\` transform. The cell is not echoed — a value that failed a shape `
            + `check can be anything at all (design §5.2)`);
          continue;
        }
        value = t.value;
      }
      const table = mapping.values?.[target];
      if (table && Object.hasOwn(table, value)) value = table[value];
      cells[target] = value;
    }

    rows.push({
      row: rowNo,
      line: rowNo + 1,
      cells,
      // The source's own key rides on the row so the receipt's `intent` can
      // carry it (§5.3) and the map can be keyed on it.
      source: mapping.sourceIdColumn ? cellsArr[index.get(mapping.sourceIdColumn)] ?? null : null,
    });
  }

  if (errors.length) return { ok: false, exitCode: 1, rows: [], errors };
  return { ok: true, exitCode: 0, rows, errors: [] };
}

// --- the durable source-ids map ----------------------------------------------

/**
 * Open the map for append BEFORE any ticket write, alongside the receipt. If
 * it cannot be opened the run does not start — EXIT 5, board unchanged,
 * nothing attempted (§4.2, §5.1). It throws rather than returning a code so
 * the caller's own pre-write phase decides, exactly as the receipt's open
 * does in `import-apply.mjs`.
 */
export function openSourceIds(path) {
  mkdirSync(dirname(path), { recursive: true });
  appendRegularFileSync(path, "");
}

/** One line, through `appendRegularFileSync` — the same FIFO-safe, unbuffered,
 *  SIGKILL-durable primitive the receipt uses, for the same reason: a buffered
 *  pair is a pair that is not there when the process dies (§5.1). */
export function appendPair(path, { source, id, seq }) {
  appendRegularFileSync(path, `${JSON.stringify({ source, id, seq })}\n`);
}

/**
 * Read the map. READ-ONLY, ALWAYS — the lookup runs before any ticket write,
 * and a park that failed there would fall under no exit code at all (§4.2).
 * Parking is `repair --apply`'s job.
 *
 * FIRST-OCCURRENCE lookup: a source key that already has a line keeps it, so
 * a later accidental duplicate line can never remap a row.
 *
 * @returns { exists, pairs: Map<source, {id, seq}>, torn, text }
 *          `torn` is `{ line, bytes, offset }` for the first unparseable or
 *          incomplete line, or null. A torn map is a REFUSAL (exit 5): the
 *          pair was cut mid-append with its ticket already on disk, so the map
 *          does not know a ticket that exists and a re-import would create it
 *          again.
 */
export function readSourceIds(path) {
  let text;
  try {
    text = readRegularFileSync(path);
  } catch (e) {
    if (e && e.code === "ENOENT") return { exists: false, pairs: new Map(), torn: null, text: "" };
    throw e;
  }
  const pairs = new Map();
  let torn = null;
  let offset = 0;
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    const last = i === lines.length - 1;
    if (line === "" && last) break;
    if (torn === null) {
      // A final line with no newline after it is a line cut mid-append, even
      // when what landed happens to parse.
      if (last) torn = { line: i + 1, bytes: line, offset };
      else {
        try {
          const v = JSON.parse(line);
          if (v && typeof v === "object" && typeof v.source === "string") {
            if (!pairs.has(v.source)) pairs.set(v.source, { id: v.id ?? null, seq: v.seq ?? null });
          } else torn = { line: i + 1, bytes: line, offset };
        } catch { torn = { line: i + 1, bytes: line, offset }; }
      }
    }
    offset += Buffer.byteLength(line, "utf8") + (last ? 0 : 1);
  }
  return { exists: true, pairs, torn, text };
}

/** `<ISO>-<name>.jsonl` → `<name>`, or null when the filename is not a
 *  receipt's. The stamp is an ISO-8601 instant with its colons replaced by
 *  `-` (`import-apply.mjs`'s `receiptPathFor`), so it is a fixed-width prefix
 *  ending in `Z` and the rest is the name — which may itself contain `-`. */
export function nameFromReceiptPath(path) {
  const m = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-(.+)\.jsonl$/.exec(basename(path));
  return m ? m[1] : null;
}

// --- `blaze import --mapping <m.json> <file.csv>` ----------------------------

/**
 * A mapped import. The SAME planner, the SAME apply and the SAME receipt as a
 * canonical one — this composes `import-apply.mjs`'s exported pieces rather
 * than forking them, which is what keeps "one `planImport`, several readers"
 * (§4.5) structural. The only things it adds are the mapping (which turns an
 * arbitrary header into canonical cells) and the `source-ids` map (which is
 * what makes a re-import of a foreign export idempotent).
 *
 * The pre-write phase is BLZ-629's, in its order, plus one step:
 *   1. the prune — best-effort, read-only, exit-code-neutral;
 *   2. the exit-5 check over this mapping's LATEST receipt, before this run
 *      opens its own;
 *   3. open this run's receipt for append — a failure is exit 5;
 *   4. open `source-ids/<name>.jsonl` for append — a failure is exit 5 too,
 *      and for the same reason: §5.1's exit-4 invariant is conditioned on a
 *      ticket having been written, so a record the run could not establish
 *      BEFORE it writes falls under no other code (§4.2).
 */
export async function runMappedImport(opts) {
  const {
    file, mappingPath, projectsDir, dataRoot,
    apply = false, update = false, allocateIds = false,
    now = new Date(), commitMode = "per-op",
    writePort = undefined, readStorage = fsReadStorage,
    stage = commitOrQueue, appendReceipt = appendRegularFileSync,
    appendMapLine = appendPair, openMap = openSourceIds,
  } = opts;

  const out = [];
  const say = (...l) => out.push(...l);
  const rel = (p) => relative(dataRoot, p) || p;
  const done = (exitCode) => ({ exitCode, report: out.join("\n"), plan: null });

  const loaded = loadMapping(mappingPath);
  if (!loaded.ok) { say(...loaded.errors); return done(loaded.exitCode); }
  const mapping = loaded.mapping;
  const name = mapping.name;

  // The input, through `readRegularFileSync` per ADR-0031 — never opened
  // blind, because a FIFO with no writer blocks forever.
  let text;
  try {
    text = readRegularFileSync(file);
  } catch (e) {
    say(`blaze import: cannot read ${rel(file)} — ${e.message}`);
    return done(2);
  }

  let grid;
  try {
    grid = parseCsv(text);
  } catch (e) {
    say(`blaze import: ${rel(file)} is not readable as CSV — ${e.message}. The file is not the `
      + `format it claims, so nothing was validated and nothing was written`);
    return done(2);
  }
  if (grid.length === 0) {
    say(`blaze import: ${rel(file)} is empty — a CSV's first line is its header (design §2.1)`);
    return done(2);
  }

  const bound = bindMapping(mapping, grid[0]);
  if (!bound.ok) { say(...bound.errors); return done(bound.exitCode); }

  const mapped = mapRows(mapping, grid);
  if (!mapped.ok) {
    say(`blaze import: refusing ${mapped.errors.length} row(s) — nothing was written.`);
    say(...mapped.errors.map((e) => `  ${e}`));
    return done(mapped.exitCode);
  }
  const rows = mapped.rows;

  // --- the source-key lookup. READ-ONLY, and it runs before anything is
  // written: a torn line is a refusal (exit 5), never a park (§4.2).
  const mapPath = sourceIdsPathFor(dataRoot, name);
  let pairs = new Map();
  if (mapping.sourceIdColumn) {
    let store;
    try {
      store = readSourceIds(mapPath);
    } catch (e) {
      say(`blaze import: cannot read the map ${rel(mapPath)} — ${e.message}. The run does not `
        + `start; the board is unchanged and nothing was attempted`);
      return done(5);
    }
    if (store.torn) {
      say(`blaze import: ${rel(mapPath)} line ${store.torn.line} is a torn pair — a line cut `
        + `mid-append, whose ticket is already on disk. The map therefore does not know a ticket `
        + `that exists, and a re-import that proceeded would create it a second time. Nothing was `
        + `written and nothing was parked: the lookup is read-only.`);
      say(`  Repair it with: blaze import repair --apply <the run's receipt>`);
      return done(5);
    }
    pairs = store.pairs;

    const keyless = rows.filter((r) => !r.source);
    if (keyless.length) {
      say(`blaze import: ${keyless.length} row(s) have no value in \`${mapping.sourceIdColumn}\`, `
        + `the column ${name} declares as \`sourceIdColumn\`: rows `
        + `${keyless.map((r) => r.row).join(", ")}. Under a mapping that declares one, the source `
        + `key is the row's identity and a row without it cannot be matched on a re-import `
        + `(design §4.2). The cells are not echoed`);
      return done(1);
    }
    // A source key the map already knows resolves to ITS blaze id, so the
    // planner compares the row against the ticket that key already produced
    // and classifies it skip / update / refuse exactly as an explicit-id row.
    // This is the whole of "the skip is keyed on the source's own key even
    // though blaze allocated the ids" (ADR-0037 §3).
    for (const r of rows) {
      const hit = pairs.get(r.source);
      if (hit && hit.id) r.cells.id = hit.id;
    }
  }

  const board = loadBoard(projectsDir, { dataRoot, readStorage });
  const plan = planImport(rows, board, { allocateIds, update });
  if (!plan.ok) {
    say(`blaze import: refusing ${plan.counts.refuse} row(s) — nothing was written.`);
    for (const r of plan.refusals) say(`  ${r.message}`);
    return { exitCode: 1, report: out.join("\n"), plan };
  }

  const heading = (label, op) => {
    const hits = plan.rows.filter((r) => r.op === op);
    if (!hits.length) return;
    say(`${label} — ${hits.length}`);
    for (const h of hits) {
      say(`  row ${h.row}  ${h.source ? `${h.source} → ` : ""}${h.id ?? "(id to be allocated)"}`
        + (h.changedColumns ? `  [${h.changedColumns.join(", ")}]` : ""));
    }
  };
  say(`mapping: ${rel(mappingPath)} (${name})`);
  heading(apply ? "CREATED" : "WOULD CREATE", "create");
  heading(apply ? "UPDATED" : "WOULD UPDATE", "update");
  heading("SKIPPED (identical — a re-run is a no-op)", "skip");

  if (!apply) {
    say("", "dry run — nothing written. Re-run with --apply to perform the import.");
    if (allocateIds && !mapping.sourceIdColumn) {
      // §5.2's forfeit, stated rather than papered over.
      say(`NOTE: --allocate-ids under a mapping with no \`sourceIdColumn\` forfeits the `
        + `re-run-is-a-no-op guarantee — a second run of this file DUPLICATES every id-less row.`);
    }
    return { exitCode: 0, report: out.join("\n"), plan };
  }

  // --- pre-write phase, step 1: the prune.
  for (const w of pruneReceipts(dataRoot, { now }).warnings) say(w);

  // --- pre-write phase, step 2: the exit-5 check over the LATEST receipt for
  // this mapping — before this run opens its own, or "latest" would be the
  // empty file it just created and the check would never fire. Scoped to
  // `sourceIdColumn`, because only the source-key lookup can be blind to a
  // ticket that exists (§5.1).
  if (mapping.sourceIdColumn) {
    const latest = latestReceiptFor(dataRoot, name);
    if (latest) {
      const unresolved = unresolvedIntents(readReceipt(latest));
      if (unresolved.length) {
        say(`blaze import: ${rel(latest)} carries ${unresolved.length} row(s) with neither a `
          + `\`done\` nor a \`resolved\` — a re-import that proceeded would recreate any row whose `
          + `ticket landed but whose pair did not. Nothing was written.`);
        for (const u of unresolved) {
          say(`  ${u.torn ? "a torn line" : `seq ${u.seq}${u.source ? ` (source ${u.source})` : ""}`}`);
        }
        say(`  Lift it with: blaze import repair --apply ${rel(latest)}`);
        return done(5);
      }
    }
  }

  // --- pre-write phase, step 3: establish this run's receipt.
  const receiptPath = receiptPathFor(dataRoot, { name, now });
  try {
    mkdirSync(join(dataRoot, RECEIPT_DIR), { recursive: true });
    appendReceipt(receiptPath, "");
  } catch (e) {
    say(`blaze import: cannot open the run's receipt ${rel(receiptPath)} for append (${e.message}) `
      + `— the run does not start. The board is unchanged and nothing was attempted.`);
    return done(5);
  }

  // --- pre-write phase, step 4: establish the map, ALONGSIDE the receipt and
  // before any ticket write. "If either cannot be opened, the run does not
  // start — exit 5, board unchanged" (§4.2).
  if (mapping.sourceIdColumn) {
    try {
      openMap(mapPath);
    } catch (e) {
      say(`blaze import: cannot open the map ${rel(mapPath)} for append (${e.message}) — the run `
        + `does not start. The board is unchanged and nothing was attempted. This is exit 5, not `
        + `exit 1: the remedy is to repair the run's own records, not to fix the data (design §5.1).`);
      return done(5);
    }
  }

  const r = await applyImport(plan, {
    projectsDir, dataRoot, receiptPath, writePort, appendReceipt, commitMode,
    // §5.3 step 6, BETWEEN the ticket write and `done`. The placement is
    // BLZ-629's and is not re-chosen here.
    onPair: mapping.sourceIdColumn
      ? ({ source, id, seq }) => appendMapLine(mapPath, { source, id, seq })
      : null,
    // The map is a committed record (§6), so it is staged with the tickets
    // and the receipt rather than left for the operator to notice.
    stage: mapping.sourceIdColumn
      ? (args) => stage({ ...args, files: [...args.files, mapPath] })
      : stage,
  });

  if (r.exitCode === 4) {
    say("", "blaze import: the board CHANGED and the run did not finish cleanly.");
    say(`  written (${r.written.length}): ${r.written.join(", ") || "(none)"}`);
    say(`  NOT written (${r.notWritten.length}): ${r.notWritten.join(", ") || "(none)"}`);
    say(`  receipt: ${rel(receiptPath)} — its unmatched \`intent\` entries are the record of what `
      + `this run left behind. Nothing is rolled back.`);
    if (mapping.sourceIdColumn) {
      say(`  repair it with: blaze import repair --apply ${rel(receiptPath)}`);
    }
    for (const e of r.errors) say(`  ${e}`);
  } else if (r.exitCode === 0) {
    say("", `imported ${r.written.length} ticket(s)${r.commit ? commitSuffix(r.commit) : ""}`);
    say(`  receipt: ${rel(receiptPath)}`);
    if (mapping.sourceIdColumn) say(`  map: ${rel(mapPath)}`);
  } else {
    for (const e of r.errors) say(`  ${e}`);
  }
  return { exitCode: r.exitCode, report: out.join("\n"), plan, result: r, receiptPath };
}

// --- `blaze import repair <receipt>` -----------------------------------------

/** Park raw BYTES, never a re-encoded string: `toString("utf8")` maps an
 *  incomplete trailing multibyte sequence to U+FFFD, which re-encodes as
 *  different bytes — and a torn line is exactly where that happens. The
 *  buffer-in/bytes-out discipline is `pending-ledger.mjs`'s
 *  `quarantineDropped`, followed here rather than reinvented. */
function parkBytes(path, bytes, append) {
  const stamp = Buffer.from(`${new Date().toISOString()}\t`, "utf8");
  append(`${path}.corrupt`, Buffer.concat([stamp, bytes, Buffer.from("\n", "utf8")]));
  return `${path}.corrupt`;
}

/** The raw bytes of a receipt's unparseable lines, in file order. */
function tornReceiptBytes(path) {
  let buf;
  try { buf = readRegularFileSync(path, null); } catch { return { lines: [], endsWithNewline: true }; }
  const lines = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i !== buf.length && buf[i] !== 0x0a) continue;
    const slice = buf.subarray(start, i);
    start = i + 1;
    if (slice.length === 0) continue;
    try {
      const v = JSON.parse(slice.toString("utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) lines.push(slice);
    } catch { lines.push(slice); }
  }
  return { lines, endsWithNewline: buf.length === 0 || buf[buf.length - 1] === 0x0a };
}

/**
 * `blaze import repair <receipt>` — §5.3's inspection path, made a verb.
 *
 * DRY RUN BY DEFAULT, writing only under `--apply` (ADR-0037 §4, which covers
 * every writing subcommand of `import` and not the top-level verb alone). The
 * dry run exits with THE CODE THE APPLY WOULD (§5.2), so an operator learns
 * whether anything would still be unresolved without writing anything.
 *
 * It reads no CSV, builds no plan, RUNS NO MODEL and writes no ticket. Its
 * files are at most four — `<receipt>.corrupt`, `<map>.corrupt`, the map, the
 * receipt — and every one of them is a committed record (§6), so they are
 * staged through `commitOrQueue` under the `import-repair` op (§5.4).
 *
 * THE ORDER IS LOAD-BEARING AND IS NOT A STYLE CHOICE:
 *
 *     park → truncate → pair → `resolved`
 *
 * `resolved` is the record that LIFTS the exit-5 refusal, and it must never
 * exist without the pair it vouches for. In this order a crash between the
 * two appends leaves the pair present and the row still unresolved: the next
 * import refuses again, the next `repair` finds ticket and pair present,
 * records `nothing-to-repair`, and the refusal lifts — nothing lost, one
 * extra run. In the reverse order the same crash lifts the refusal over a
 * missing pair, the lookup misses the key, and the re-import creates the row
 * a second time.
 */
export async function runRepair(opts) {
  const {
    receipt, projectsDir, dataRoot,
    apply = false, commitMode = "per-op",
    readStorage = fsReadStorage, stage = commitOrQueue,
    appendMapLine = appendPair,
  } = opts;

  // The two record primitives, written as a call to the real one rather than
  // as a defaulted parameter, so that the write-seam guard's reachability
  // walk (tests/model/seam-closure.test.mjs) SEES this verb reach them. The
  // override exists only for fault injection — §4.2's test 2 kills the run
  // between the pair append and the `resolved` append, which is unreachable
  // without a seam here — and a verb whose writes are invisible to the guard
  // is exactly what that guard exists to prevent.
  const append = (p, data) => (opts.append ? opts.append(p, data) : appendRegularFileSync(p, data));
  const truncate = (p, len) => (opts.truncate ? opts.truncate(p, len) : truncateSync(p, len));

  const out = [];
  const say = (...l) => out.push(...l);
  const rel = (p) => relative(dataRoot, p) || p;
  const done = (exitCode) => ({ exitCode, report: out.join("\n") });

  // --- the receipt is `repair`'s INPUT, so it takes the input's rule: never
  // opened blind, and missing / a directory / a FIFO / a socket is exit 2.
  let read;
  try {
    read = readReceipt(receipt);
  } catch (e) {
    say(`blaze import repair: cannot read ${rel(receipt)} — ${e.message}. Nothing was written`);
    return done(2);
  }
  if (!read.exists) {
    say(`blaze import repair: ${rel(receipt)} does not exist. The argument is a receipt path — `
      + `they live in ${RECEIPT_DIR}/<ISO>-<name>.jsonl (design §5.3)`);
    return done(2);
  }

  const name = nameFromReceiptPath(receipt);
  if (name === null) {
    say(`blaze import repair: ${basename(receipt)} is not a receipt filename — they are `
      + `<ISO>-<name>.jsonl, and <name> is what the mapping and the map are keyed on (§5.3). `
      + `Nothing was written`);
    return done(2);
  }

  // --- `repair` needs the mapping file and refuses without it. Without it
  // it cannot know whether `sourceIdColumn` was in force, so it cannot tell
  // an orphan reservation (row 1) from a pair-without-ticket row (row 4) —
  // it does not know whether a pair was ever expected. BEFORE ANY WRITE.
  let sourceIdColumn = null;
  if (name !== CANONICAL_NAME) {
    const loaded = loadMapping(mappingPathFor(dataRoot, name));
    if (!loaded.ok) {
      say(...loaded.errors.map((e) => e.replace(/^blaze import:/, "blaze import repair:")));
      say(`  \`repair\` reads ${MAPPING_DIR}/${name}.json to learn whether \`sourceIdColumn\` was `
        + `in force. Without it an orphan reservation and a pair-without-ticket row are `
        + `indistinguishable, so it refuses before writing anything (design §5.3)`);
      return done(loaded.exitCode);
    }
    sourceIdColumn = loaded.mapping.sourceIdColumn;
  }

  // --- the map. Opened before the importing run's first write (§4.2), so a
  // receipt under a `sourceIdColumn` mapping with no map at all means
  // something outside the sequence removed it — exit 5, before any write.
  const mapPath = sourceIdsPathFor(dataRoot, name);
  let store = { exists: false, pairs: new Map(), torn: null, text: "" };
  if (sourceIdColumn) {
    try {
      store = readSourceIds(mapPath);
    } catch (e) {
      say(`blaze import repair: cannot read ${rel(mapPath)} — ${e.message}. Nothing was written`);
      return done(5);
    }
    if (!store.exists) {
      say(`blaze import repair: ${name} declares \`sourceIdColumn\` but ${rel(mapPath)} is absent. `
        + `The map is opened before the run's first write, so a receipt for this mapping and no `
        + `map means something outside the sequence removed it. This needs a person; nothing was `
        + `written (design §5.3)`);
      return done(5);
    }
  }

  const byId = loadBoard(projectsDir, { dataRoot, readStorage }).byId;
  const states = inspectReceipt(read.entries, {
    hasTicket: (id) => byId.has(id),
    hasPair: (source) => store.pairs.has(source),
    sourceIdColumn,
  });

  const rowsOf = (state) => [...states.values()].filter((s) => s.state === state);
  const orphans = rowsOf("orphan-reservation");
  const toAppend = rowsOf("pair-appended");
  const nothing = rowsOf("nothing-to-repair");
  const people = rowsOf("pair-without-ticket");

  const tornReceipt = read.parsedCompletely ? null : tornReceiptBytes(receipt);
  const tornReceiptPending = tornReceipt !== null && tornReceipt.lines.length > 0
    && !read.entries.some((e) => e.phase === "resolved" && (e.seq === null || e.seq === undefined)
      && e.state === "torn-line-parked");

  say(`receipt: ${rel(receipt)} (${name})`);
  if (store.torn) {
    say(apply
      ? `PARKED — ${rel(mapPath)} line ${store.torn.line} was torn; its bytes are in `
        + `${rel(mapPath)}.corrupt and the map is truncated back to its last complete line`
      : `WOULD PARK — ${rel(mapPath)} line ${store.torn.line} is torn; its bytes would go to `
        + `${rel(mapPath)}.corrupt and the map would be truncated back to its last complete line `
        + `BEFORE any pair is appended (design §4.2)`);
  }
  if (tornReceiptPending) {
    say(apply
      ? `PARKED — ${tornReceipt.lines.length} unparseable line(s) of the receipt; their bytes are `
        + `in ${rel(receipt)}.corrupt, the receipt now ends cleanly, and a \`torn-line-parked\` `
        + `entry records it`
      : `WOULD PARK — ${tornReceipt.lines.length} unparseable line(s) of the receipt; their bytes `
        + `would go to ${rel(receipt)}.corrupt, a single \`\\n\` would close the fragment, and a `
        + `\`torn-line-parked\` entry would record it (design §5.3)`);
  }

  const list = (label, rows) => {
    if (!rows.length) return;
    say(`${label} — ${rows.length}`);
    for (const r of rows) say(`  seq ${r.seq}  ${r.source ?? "(no source key)"} → ${r.id ?? "(no id)"}`);
  };
  list("ORPHAN RESERVATION", orphans);
  list(apply ? "APPENDED" : "WOULD APPEND", toAppend);
  list("NOTHING TO REPAIR", nothing);
  if (people.length) {
    say(`NEEDS A PERSON — ${people.length}`);
    for (const r of people) {
      say(`  seq ${r.seq}  ${r.source} → ${r.id ?? "(no id)"}: the map has the pair and the board `
        + `has no such ticket. The sequence does not produce this state — only a power loss that `
        + `lost the ticket's bytes and kept the pair's, or a manual deletion, reaches it. Restore `
        + `the ticket file, or park and remove the pair line; \`repair\` appends nothing for it `
        + `(design §5.3)`);
    }
  }

  // The dry run exits WITH THE CODE THE APPLY WOULD (§5.2): 0 when nothing
  // would remain unresolved, 5 when something would.
  const wouldRemain = people.length > 0;

  if (!apply) {
    say("", "dry run — nothing written, nothing parked, nothing truncated. "
      + "Re-run with --apply to perform the repair.");
    return done(wouldRemain ? 5 : 0);
  }

  const files = [];
  try {
    // --- 1. PARK the map's torn bytes, then TRUNCATE it back to its last
    // complete line. Park before you clear (BLZ-531), and truncate before any
    // append: appending onto a fragment with no newline glues the pair to it
    // and makes the pair unparseable too (§4.2). This is the ONE place the
    // map is not append-only, and it is an operator action.
    if (store.torn) {
      files.push(parkBytes(mapPath, Buffer.from(store.torn.bytes, "utf8"), append));
      truncate(mapPath, store.torn.offset);
      files.push(mapPath);
    }

    // --- 2. The receipt's own torn line: park, close it with a single `\n`,
    // and record the fifth state. The receipt is EVIDENCE and is never
    // truncated — the fragment stays as an unparseable line, reported as
    // dropped by every later read (ADR-0030) and keeping the receipt
    // un-prunable. The `\n` is appended ONLY if the file does not already end
    // with one, so a `repair --apply` killed after it lands does not glue a
    // second one on when it resumes.
    if (tornReceiptPending) {
      for (const bytes of tornReceipt.lines) files.push(parkBytes(receipt, bytes, append));
      if (!tornReceipt.endsWithNewline) append(receipt, "\n");
      append(receipt, `${JSON.stringify({ phase: "resolved", seq: null, state: "torn-line-parked" })}\n`);
      files.push(receipt);
    }

    // --- 3. PAIR, then `resolved` — in that order, per row. The record that
    // lifts the refusal is written LAST, after the record it vouches for.
    for (const r of [...states.values()].sort((a, b) => a.seq - b.seq)) {
      if (r.needsPerson) continue;
      if (r.state === "pair-appended") {
        appendMapLine(mapPath, { source: r.source, id: r.id, seq: r.seq });
        files.push(mapPath);
      }
      append(receipt, `${JSON.stringify({ seq: r.seq, phase: "resolved", state: r.resolvedState })}\n`);
      files.push(receipt);
    }
  } catch (e) {
    // The records are what this verb writes, so a failure part way through
    // leaves some of them on disk — §5.1's rule applies here exactly as it
    // does to the importer: once a record has been written, the failure is a
    // 4. Rows that never reached their `resolved` stay unresolved, which is
    // the safe direction: the refusal keeps firing until a later run lifts it.
    say("", `blaze import repair: the repair did not finish cleanly — ${e.message}`);
    say(`  ${files.length ? "some records were written" : "nothing was written"}; re-run `
      + `\`blaze import repair --apply ${rel(receipt)}\`, which is idempotent: a row whose pair is `
      + `already present re-examines as \`nothing-to-repair\``);
    return done(files.length ? 4 : 5);
  }

  let commit = null;
  let staged = false;
  if (files.length) {
    try {
      commit = stage({
        root: dataRoot, mode: commitMode, op: "import-repair",
        id: null, ids: [],
        message: `import repair: ${states.size} row(s) examined for ${name}`,
        files: [...new Set(files)],
      });
      staged = !(commit && commit.ok === false);
    } catch (e) {
      // Every write landed and staging failed: the records are on disk and
      // the refusal is lifted, only the commit is missing. Exit 4 — and it
      // WINS over the exit-5 `NEEDS A PERSON` row, because nothing durable
      // reached git and every other writer touching this data root needs to
      // know that before anything else (§5.2's precedence rule). The trailer
      // names both conditions regardless.
      say("", `blaze import repair: every record was written and STAGING FAILED — ${e.message}`);
      if (wouldRemain) say(`  ${people.length} row(s) still need a person, named above`);
      return done(4);
    }
    if (!staged) {
      say("", "blaze import repair: every record was written and STAGING FAILED");
      if (wouldRemain) say(`  ${people.length} row(s) still need a person, named above`);
      return done(4);
    }
  }

  say("", `repaired ${states.size - people.length} row(s)${commit ? commitSuffix(commit) : ""}`);
  if (wouldRemain) {
    say(`  ${people.length} row(s) still need a person and were left unresolved — the exit-5 `
      + `refusal keeps firing on them until they have been examined again (design §5.2)`);
  }
  return done(wouldRemain ? 5 : 0);
}
