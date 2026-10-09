// scripts/migrate/verify-load.mjs — the migration gate's verdict (BLZ-679, spec §5.3).
//
// `zero-diff.mjs` (BLZ-281) had no production caller: it ran from migration TEST suites only.
// `blaze db verify` is that caller, and this is its pure half — given the source corpus, the
// loaded tickets (already fetched) and the loaded tables' row counts, it decides PASS or FAIL.
// The runner owns the I/O; nothing here opens a connection, so the verdict is unit-tested.
//
// It passes only if ALL FOUR hold (spec §5.3):
//   1. zeroDiff's `valueDiffs` is empty — no field VALUE changed — and, added here, every
//      ticket's UNKNOWN frontmatter keys (`extra_json`, BLZ-295's round-trip promise) agree:
//      zeroDiff's FIELDS list names only keys with a column, so it never looked at them;
//   2. the id set on each side is identical — nothing missing, nothing extra;
//   3. each table's row count equals what the loader's own row builder says it inserts;
//   4. acceptance criteria agree on every ticket, read by `ac-oracle-matcher.mjs` on the source
//      side, which shares no code with the importer's parser.
// `byteDiffs` (BLZ-253's field-order noise) is reported, never gated.
import { zeroDiff } from "./zero-diff.mjs";
import { corpusRows, relationRows } from "./load-corpus.mjs";
import { parseAcBlocks } from "../model/ac-blocks.mjs";
import { extraFields } from "../model/write-port.mjs";

/** Stable JSON: object keys sorted at every depth, so key order is never a difference. */
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object"
    ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
    : JSON.stringify(v));

/**
 * Condition 1's other half: the frontmatter keys that have no column, ticket by ticket, as the
 * file holds them and as the database reads them back. `extraFields` is the loader's own rule
 * for what goes to `extra_json`, applied to both sides.
 * @returns [{ id, field: "extra", source, loaded }] for each ticket whose extras differ
 */
export function extraDiffs(sourceTickets, loadedTickets) {
  const loaded = new Map(loadedTickets.map((t) => [String(t.frontmatter?.id), t]));
  const out = [];
  for (const t of sourceTickets) {
    const id = String(t.frontmatter?.id ?? "");
    const b = loaded.get(id);
    if (!id || !b) continue;   // a missing id is condition 2's finding, not this one's
    const want = canon(extraFields(t.frontmatter)), got = canon(extraFields(b.frontmatter));
    if (want !== got) out.push({ id, field: "extra", source: want, loaded: got });
  }
  return out;
}

/** The tables whose row counts gate, in the order they are printed. */
export const VERIFY_TABLES = ["ticket", "ticket_link", "worklog_entry", "ticket_label", "ticket_component"];

/**
 * What the loader inserts for this source, per table — computed by the SAME row builder
 * `blaze db load` ran (`corpusRows` + `relationRows`), so "the loader's tallies" are recomputed
 * rather than remembered. A load the database refused any row of was rolled back whole, so
 * every ticket the builder produced is expected.
 */
export function expectedCounts(source, projectsDir) {
  const { tickets } = corpusRows(source, projectsDir);
  const rel = relationRows(tickets, new Map(tickets.map((t) => [t.id, t.type])));
  const sum = (f) => tickets.reduce((n, t) => n + f(t), 0);
  return {
    ticket: tickets.length,
    ticket_link: rel.links.length,
    worklog_entry: sum((t) => t.worklog.length),
    ticket_label: sum((t) => t.labels.length),
    ticket_component: sum((t) => t.components.length),
  };
}

/**
 * What the LOADED side holds as acceptance criteria. Postgres keeps no criterion rows (spec
 * §5.2 — the `acceptance_criterion` index is SQLite-shadow-only), and every db-mode reader and
 * writer takes them from `body`, so the loaded criteria are the engine's own parser over the
 * loaded body. The oracle reads the SOURCE body with an independent matcher; agreement means
 * what db mode will show as criteria is what the files said.
 */
export function criteriaFromBody(body) {
  return parseAcBlocks(body ?? "").blocks
    .filter((b) => b.kind === "criterion")
    .map((b) => ({ text: b.text, checked: b.checked }));
}

/**
 * @param source         a SYNC read driver holding the original corpus (the filesystem)
 * @param sourceRoot     its projects directory
 * @param loadedTickets  every loaded ticket, ALREADY AWAITED — zeroDiff is synchronous
 * @param counts         { [table]: rows } for each of VERIFY_TABLES, as the database holds them
 * @param criteriaOf     (body) => [{ text, checked }]; injectable only so a test can prove the
 *                       criteria condition gates on its own
 * @returns { ok, failures: string[], report, expected, countDiffs }
 */
export function verifyLoad({ source, sourceRoot, loadedTickets, counts, criteriaOf = criteriaFromBody }) {
  const bodies = new Map(loadedTickets.map((t) => [String(t.frontmatter?.id), t.body ?? ""]));
  const report = zeroDiff(source, sourceRoot, { listTickets: () => loadedTickets },
                          { criteriaFor: (id) => criteriaOf(bodies.get(id)) });
  report.valueDiffs.push(...extraDiffs([...source.listTickets(sourceRoot)], loadedTickets));
  const expected = expectedCounts(source, sourceRoot);
  const countDiffs = VERIFY_TABLES
    .filter((t) => expected[t] !== counts[t])
    .map((t) => ({ table: t, expected: expected[t], loaded: counts[t] }));
  const failures = [];
  if (report.valueDiffs.length) failures.push(`${report.valueDiffs.length} value difference(s)`);
  if (report.missing.length || report.extra.length) {
    failures.push(`the id sets differ: ${report.missing.length} missing from the database, `
      + `${report.extra.length} only in the database`);
  }
  if (countDiffs.length) failures.push(`row counts differ in ${countDiffs.map((d) => d.table).join(", ")}`);
  if (report.criteriaDiffs.length) failures.push(`${report.criteriaDiffs.length} acceptance-criteria difference(s)`);
  return { ok: failures.length === 0, failures, report, expected, countDiffs };
}
