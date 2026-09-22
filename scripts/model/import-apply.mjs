// scripts/model/import-apply.mjs — the import apply. BLZ-629, implementing
// design §5.3, §5.4, §5.5 and §6 (docs/design/csv-import-and-export.md).
//
// Walks BLZ-628's plan through an INJECTED WRITE PORT (ADR-0037 §1), so the
// same importer writes rows instead of files under BLAZE_WRITE_PORT=db with
// no change here. Nothing in this module places a ticket through node:fs.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE (§5.1, stated once as a
// post-condition over the whole run rather than per call site, because the
// design records the same bug being fixed at one call site and reintroduced
// at the next):
//
//     ONCE ANY TICKET HAS BEEN WRITTEN, NO LATER FAILURE MAY EXIT ANYTHING
//     BUT 4.
//
// It covers ticket writes, reservations, claims, STAGING and RECEIPT APPENDS
// alike. That is why the whole write loop and the staging call sit inside one
// `try` whose catch consults `boardChanged` — an uncaught throw from a
// per-row `appendRegularFileSync` on ENOSPC would otherwise exit 1, which
// §5.1 declares means "unchanged — nothing written".
//
// WHAT IS DELIBERATELY NOT HERE. The `source-ids` map, the `--mapping` layer
// and the `blaze import repair` verb are C1/BLZ-634's (design's ticket
// breakdown), and this module is the seam they plug into rather than a
// half-built version of them:
//
//   * step 6 of §5.3's sequence is an injected `onPair` hook, called between
//     the ticket write and `done` — the placement the design spent a whole
//     round arriving at, so C1 inherits the ordering rather than choosing it;
//   * `inspectReceipt` implements the FOUR-STATE rule in full, including the
//     `pair-without-ticket` state that is left for a person, so the verb that
//     consumes it does not have to re-derive the classification;
//   * `readReceipt`/`unresolvedIntents` already understand the `resolved`
//     entries repair appends, including the receipt-scoped
//     `torn-line-parked` one with `"seq": null`.
//
// DURABILITY. Every receipt append goes through `appendRegularFileSync`
// (`regular-file.mjs`) — `openSync` with `O_APPEND`, `appendFileSync` on the
// descriptor, `closeSync`. A `createWriteStream` receipt loses its buffered
// lines under SIGKILL, which would make the unmatched-`intent` set neither
// complete nor sound and the §5.1 SIGKILL assertion unsatisfiable. Each line
// is in the kernel's page cache before the call returns, and that is what
// SIGKILL cannot take back.
import { join, relative, dirname } from "node:path";
import { readdirSync, statSync, unlinkSync, mkdirSync } from "node:fs";
import { appendRegularFileSync, readRegularFileSync } from "./regular-file.mjs";
import { allocateId } from "./ids.mjs";
import { writeClaim } from "./claims.mjs";
import { slugify } from "./storage.mjs";
import { fsWritePort } from "./write-port.mjs";
import { fsReadStorage } from "./read-storage.mjs";
import { loadConfig, loadProject } from "../config.mjs";
import { loadProjectSchema } from "./schema-config.mjs";
import { loadSprints } from "./sprints.mjs";
import { PRIORITIES, TYPES } from "./schema.mjs";
import { RESOLUTIONS, statusesFor } from "./workflows.mjs";
import { parseCanonicalCsv, planImport } from "./import-plan.mjs";
import { commitOrQueue, commitSuffix } from "../commit-or-queue.mjs";

/** Beside `import-mappings/` at the DATA ROOT, and deliberately not under
 *  `.blaze/`: that directory holds regenerable caches `reindex.mjs` calls safe
 *  to delete, and a partial-apply record is neither derived nor regenerable
 *  (§5.3 mistake 2). */
export const RECEIPT_DIR = "import-receipts";

/** `canonical` is the reserved `<name>` a canonical-header import with no
 *  mapping file uses, so "this mapping's latest receipt" stays computable
 *  (§4.2). A mapping file may not be called this. */
export const CANONICAL_NAME = "canonical";

const RETENTION_DAYS = 90;

/** `import-receipts/<ISO>-<name>.jsonl`. The colons of a bare ISO-8601 stamp
 *  are replaced with `-` so the name is a legal filename everywhere; the
 *  remaining order is still lexical, which is what makes "the lexically last
 *  receipt with this name" mean "the latest" (§5.3). */
export function receiptPathFor(dataRoot, { name = CANONICAL_NAME, now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/:/g, "-");
  return join(dataRoot, RECEIPT_DIR, `${stamp}-${name}.jsonl`);
}

// --- reading the receipt -----------------------------------------------------

/**
 * Read a receipt. READ-ONLY, ALWAYS — it parses, and it does not park.
 *
 * Parking is a write, and every reader that runs BEFORE a ticket write (the
 * prune, and C1's map lookup) must be read-only: a park that failed in the
 * pre-write phase would fall under no exit code at all, which is the defect
 * §5.3 has already fixed twice. Quarantine happens only when an operator runs
 * `blaze import repair --apply`, which is a write they asked for.
 *
 * A line that will not parse is COUNTED, not silently skipped — presenting a
 * partial read as a complete one is what ADR-0030 forbids.
 *
 * @returns { entries, dropped, parsedCompletely, exists }
 */
export function readReceipt(path) {
  let text;
  try {
    text = readRegularFileSync(path);
  } catch (e) {
    if (e && e.code === "ENOENT") return { entries: [], dropped: 0, parsedCompletely: true, exists: false };
    throw e;
  }
  const entries = [];
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) entries.push(v);
      else dropped++;
    } catch { dropped++; }
  }
  return { entries, dropped, parsedCompletely: dropped === 0, exists: true };
}

/**
 * The set to inspect: every `intent` with neither a `done` nor a `resolved`
 * (§5.3, and §5.1's exit-5 check reads exactly this).
 *
 * Keyed by `seq`, never by id: an `intent` killed before its `allocated` has
 * `"id": null`, and a set keyed by id would silently drop it — which is the
 * row most worth naming.
 *
 * An unparseable line counts as unresolved UNLESS a receipt-scoped
 * `torn-line-parked` `resolved` follows it, so a torn receipt is a refusal
 * until `repair --apply` has parked it and never a refusal that cannot be
 * lifted.
 */
export function unresolvedIntents({ entries, parsedCompletely }) {
  const done = new Set();
  const resolved = new Set();
  let tornParked = false;
  for (const e of entries) {
    if (e.phase === "done") done.add(e.seq);
    else if (e.phase === "resolved") {
      if (e.seq === null || e.seq === undefined) {
        if (e.state === "torn-line-parked") tornParked = true;
      } else resolved.add(e.seq);
    }
  }
  const out = [];
  for (const e of entries) {
    if (e.phase !== "intent") continue;
    if (done.has(e.seq) || resolved.has(e.seq)) continue;
    out.push({ seq: e.seq, id: e.id ?? null, source: e.source ?? null, row: e.row ?? null });
  }
  if (!parsedCompletely && !tornParked) {
    // A torn `intent` IS an unmatched intent. Without this the prune reads a
    // file whose only evidence of a partial apply is its torn last line as
    // "every intent matched" and deletes exactly the receipt it exists to
    // keep (§5.3 item 2).
    out.push({ seq: null, id: null, source: null, row: null, torn: true });
  }
  return out;
}

/**
 * Whether every `intent` in a receipt has a matching `done`.
 *
 * DELIBERATELY NOT `unresolvedIntents`, and the difference is the whole of
 * §5.3's last word on retention: **a `resolved` lifts the exit-5 refusal but
 * never makes a receipt prunable.** The prune requires a DONE. A
 * partial-apply receipt is evidence, and evidence is kept regardless of age
 * and regardless of having been repaired.
 */
function everyIntentHasDone(entries) {
  const done = new Set();
  for (const e of entries) if (e.phase === "done") done.add(e.seq);
  return entries.every((e) => e.phase !== "intent" || done.has(e.seq));
}

/**
 * §5.3's FOUR-STATE inspection rule, over the unmatched-`intent` set.
 *
 * | ticket | pair | meaning                          | resolved state      |
 * |--------|------|----------------------------------|---------------------|
 * | no     | no   | steps 5-7 did not land           | orphan-reservation  |
 * | YES    | no   | the ticket-without-pair window   | pair-appended       |
 * | yes    | yes  | only step 7 is missing           | nothing-to-repair   |
 * | no     | YES  | not a state the sequence produces| (none — A PERSON)   |
 *
 * The second row is the one a re-import would DUPLICATE and the one an
 * inspection path that checked only "is the ticket on disk" would have called
 * "only `done` is missing" and left alone. The fourth is the one "ticket
 * absent ⇒ re-created on re-import" gets wrong: the pair governs the lookup,
 * so a re-import finds the key and SKIPS the row — it is neither re-created
 * nor duplicated, it is silently absent. It is left for a person, gets no
 * `resolved` entry, and exit 5 keeps firing until it has been examined again.
 *
 * Without `sourceIdColumn` there is no map and the pair column does not
 * apply: only the first and third rows occur.
 *
 * Claims do not appear because step 4 precedes step 5 — a ticket on disk has
 * its claim, and a missing ticket's orphan claim is the same residue as its
 * orphan reservation (§5.5).
 *
 * @returns Map<seq, { seq, id, source, state, resolvedState, needsPerson }>
 */
export function inspectReceipt(entries, { hasTicket, hasPair = () => false, sourceIdColumn = null }) {
  const unresolved = unresolvedIntents({ entries, parsedCompletely: true });
  // BLZ-634: the id comes from the `intent` on the explicit-id path and from
  // the `allocated` on the allocate path — §5.3's second row says so in as
  // many words ("`source` from the `intent`, `id` from the `allocated` (or
  // from the `intent` on the explicit-id path)"), and `unresolvedIntents`
  // reads only the `intent`, whose `id` is null exactly when step 2 ran.
  // Without this merge EVERY `--allocate-ids` row classified as an orphan
  // reservation — the state whose repair is "none" — so the ticket-without-
  // pair window, the one state a re-import would DUPLICATE, was never
  // detected on the one path that opens it. `unresolvedIntents` itself is
  // left alone: §5.1's exit-5 check reads it for the SET, not for the ids.
  const allocated = new Map();
  for (const e of entries) {
    if (e.phase === "allocated" && e.seq !== undefined && e.id) allocated.set(e.seq, e.id);
  }
  const out = new Map();
  for (const u of unresolved) {
    if (u.seq === null) continue;
    u.id = u.id ?? allocated.get(u.seq) ?? null;
    const ticket = u.id !== null && hasTicket(u.id);
    const pair = sourceIdColumn ? Boolean(u.source) && hasPair(u.source) : false;
    let state;
    let needsPerson = false;
    if (!sourceIdColumn) {
      state = ticket ? "nothing-to-repair" : "orphan-reservation";
    } else if (ticket && pair) state = "nothing-to-repair";
    else if (ticket && !pair) state = "pair-appended";
    else if (!ticket && !pair) state = "orphan-reservation";
    else { state = "pair-without-ticket"; needsPerson = true; }
    out.set(u.seq, {
      seq: u.seq, id: u.id, source: u.source, state, needsPerson,
      // The fourth row gets NO `resolved` entry — that is what keeps exit 5
      // firing until a person has acted.
      resolvedState: needsPerson ? null : state,
    });
  }
  return out;
}

/** The lexically last `import-receipts/<ISO>-<name>.jsonl` with this name —
 *  ISO-8601 sorts by time (§5.3). Checked BEFORE the current run opens its
 *  own receipt; after, "latest" would be the empty file the run just created
 *  and the check would never fire. */
export function latestReceiptFor(dataRoot, name) {
  const dir = join(dataRoot, RECEIPT_DIR);
  let entries = [];
  try { entries = readdirSync(dir); } catch { return null; }
  const suffix = `-${name}.jsonl`;
  const hits = entries.filter((e) => e.endsWith(suffix)).sort();
  return hits.length ? join(dir, hits[hits.length - 1]) : null;
}

/**
 * The 90-day prune. BEFORE ANY WRITE, BEST-EFFORT, AND NEVER AFFECTING THE
 * EXIT CODE — its placement is the whole of its specification, because both
 * other placements are wrong. Inside the exit-4 guard, an EACCES unlinking a
 * 91-day-old file after 500 tickets landed would tell the operator the board
 * is partially applied when it is not. After the writes but outside the
 * guard, the same EACCES exits 1, violating the post-condition on the very
 * run the guard protects.
 *
 * Eligibility is: older than 90 days AND every `intent` has a `done` AND the
 * file parsed completely. A receipt with any unmatched `intent` is never
 * pruned at any age — that is the evidence of a partial apply and the whole
 * reason the file exists — and a `resolved` lifts the exit-5 refusal without
 * ever making a receipt prunable.
 */
export function pruneReceipts(dataRoot, { now = new Date(), days = RETENTION_DAYS } = {}) {
  const dir = join(dataRoot, RECEIPT_DIR);
  const pruned = [];
  const warnings = [];
  let entries = [];
  try { entries = readdirSync(dir); } catch { return { pruned, warnings }; }
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs >= cutoff) continue;
      const r = readReceipt(p);
      if (!r.parsedCompletely) continue;                  // unreadable ≠ clean: keep
      if (!everyIntentHasDone(r.entries)) continue;       // the evidence of a partial apply
      unlinkSync(p);
      pruned.push(p);
    } catch (e) {
      warnings.push(`blaze import: could not prune ${name} (${e.message}) — continuing; a receipt `
        + `that outlives its retention window costs disk rather than correctness`);
    }
  }
  return { pruned, warnings };
}

// --- the board the planner resolves against ----------------------------------

/**
 * Everything `planImport` needs to judge a row, read through the existing
 * read seam (ADR-0009) and the ordinary config loaders. The planner itself
 * stays pure; this is the one place that looks at a board.
 *
 * `typesFor` resolves the registry PER PROJECT via `loadProjectSchema`,
 * exactly as `applyNew` does (`new.mjs:82-84`) and exactly as design §1.2
 * requires — "never against a hardcoded list". Workflows stay ambient, which
 * is also what `applyNew` does (`initialStatus` reads the module-level
 * `WORKFLOWS`); matching the engine's existing resolution beats inventing a
 * second one on the import path.
 */
export function loadBoard(projectsDir, { dataRoot, readStorage = fsReadStorage, config = undefined } = {}) {
  const root = dataRoot ?? dirname(projectsDir);
  let cfg = config;
  if (cfg === undefined) {
    try { cfg = loadConfig({ root }); } catch { cfg = null; }
  }

  const byId = new Map();
  for (const t of readStorage.listTickets(projectsDir)) {
    const id = t.frontmatter?.id;
    if (id) byId.set(String(id), t);
  }

  const typeCache = new Map();
  const typesFor = (key) => {
    if (!typeCache.has(key)) {
      let types = TYPES;
      try { types = loadProjectSchema(projectsDir, key, { config: cfg }).types ?? TYPES; }
      catch { types = TYPES; }
      typeCache.set(key, types);
    }
    return typeCache.get(key);
  };

  const projectCache = new Map();
  const projectFor = (key) => {
    if (!projectCache.has(key)) {
      let p = null;
      try { p = loadProject(key, { root, projectsDir, allowMissing: true }); } catch { p = null; }
      projectCache.set(key, p);
    }
    return projectCache.get(key);
  };

  let sprintIds = new Set();
  try { sprintIds = new Set(loadSprints({ root }).sprints.map((s) => s.id)); } catch { /* no registry */ }

  return {
    byId, typesFor, types: TYPES, statusesFor,
    priorities: PRIORITIES, resolutions: RESOLUTIONS,
    sprintIds, projectFor,
  };
}

// --- the apply ---------------------------------------------------------------

/** The numeric half of `<KEY>-<N>`. The planner has already proved the shape. */
function idNumber(id) { return Number(String(id).split("-").pop()); }

/**
 * Walk a plan through the injected write port, running §5.3's seven-step
 * sequence for every created row and steps 1/5/7 for every updated one.
 *
 * @param ctx.writePort      injected (ADR-0037 §1). Defaults to `fs`.
 * @param ctx.receiptPath    already established by the caller's pre-write
 *                           phase — `applyImport` does not decide exit 5.
 * @param ctx.onPair         §5.3 step 6, called BETWEEN the ticket write and
 *                           `done` so that `done` implies pair. C1's seam.
 * @param ctx.stage          §5.4, injected so a staging failure is testable
 *                           without a git tree. Defaults to `commitOrQueue`.
 * @param ctx.appendReceipt  the append primitive, injected for fault
 *                           injection only. Defaults to `appendRegularFileSync`.
 *
 * @returns { exitCode, written, notWritten, files, staged, commit, errors }
 */
export async function applyImport(plan, ctx) {
  const {
    projectsDir, dataRoot, receiptPath,
    writePort = fsWritePort(projectsDir),
    onPair = null,
    stage = commitOrQueue,
    appendReceipt = appendRegularFileSync,
    commitMode = "per-op",
    message = null,
  } = ctx;

  const append = (obj) => appendReceipt(receiptPath, `${JSON.stringify(obj)}\n`);
  const written = [];
  const notWritten = [];
  const files = [];
  const ids = [];
  let boardChanged = false;
  let commit = null;

  const pending = plan.rows.filter((r) => r.op === "create" || r.op === "update");

  try {
    for (const [i, entry] of pending.entries()) {
      const { seq, row, op, ticket } = entry;
      const project = ticket.project;

      // --- step 1: intent → receipt. BEFORE the write, and before
      // allocation, so a crash between reservation and record still leaves
      // the row named. A record written before the event is not an outcome —
      // which is why `done` exists as well.
      append({ seq, phase: "intent", row, source: entry.source ?? null, id: entry.id, op });

      if (op === "update") {
        // An existing ticket keeps whatever claim it has; §5.5's promise is a
        // claim per CREATED ticket.
        boardChanged = true;
        const { file } = await writePort.write({ ...ticket, currentFile: entry.currentFile });
        files.push(file);
        written.push(entry.id);
        ids.push(entry.id);
        append({ seq, phase: "done", id: entry.id, file: relative(dataRoot, file), claim: false });
        continue;
      }

      // From here the run may touch board state — the reservation directory
      // and `.ids/` are board state too (§5.3), so the invariant arms now.
      boardChanged = true;

      let id = entry.id;
      let n;
      if (entry.allocate) {
        // --- step 2: allocate → reservation. `remoteMax: 0` is the
        // KNOWN-EMPTY value, not the could-not-read `null`: ADR-0037 §3
        // promises the import runs with no network, so `remoteMaxClaim`'s
        // `git fetch` is never called. The cost is stated rather than hidden
        // — BLZ-136's cross-machine collision AVOIDANCE is not consulted here,
        // and an operator who wants it runs `git fetch` before `--apply`.
        const allocated = allocateId(projectsDir, project, { dataRoot, remoteMax: 0 });
        id = allocated.id;
        n = allocated.n;
        // --- step 3: allocated → receipt, immediately, so the window in
        // which a number is reserved but unrecorded is one append wide.
        append({ seq, phase: "allocated", id });
      } else {
        n = idNumber(id);
      }

      const frontmatter = { ...ticket.frontmatter, id };

      // --- step 4: claim → `.ids/`. ON BOTH PATHS, and BEFORE the ticket —
      // a deliberate departure from `new.mjs`, which writes the ticket and
      // then the claim. `applyNew` holds an O_EXCL reservation so its number
      // is protected either way; the explicit-id path has no reservation, so
      // the claim is the only ledger entry that number will ever get. The
      // crash residue is then the harmless one (a claim with no ticket, which
      // only advances the allocation floor) rather than the damaging one (a
      // ticket with no claim, which is a `missingClaimErrors` ERROR on the
      // operator's board after every partial apply).
      const claimFile = writeClaim(projectsDir, project, n, slugify(frontmatter.title));
      files.push(claimFile);

      // --- step 5: write → board, at the DECLARED status, directly through
      // the port. Not `applyNew` + `applyMove`: those force `initialStatus`
      // and walk transitions, fabricating up to three transitions and three
      // `updated` stamps per imported row (ADR-0037 §1).
      const { file } = await writePort.write({ ...ticket, frontmatter });
      files.push(file);
      written.push(id);
      ids.push(id);

      // --- step 6: pair → map, BETWEEN the write and `done`, so `done`
      // implies pair. C1/BLZ-634 owns the map itself; the ordering is fixed
      // here so it cannot be chosen again.
      if (onPair && entry.source) onPair({ source: entry.source, id, seq });

      // --- step 7: done → receipt.
      append({ seq, phase: "done", id, file: relative(dataRoot, file), claim: true });

      void i;
    }
  } catch (e) {
    for (const entry of pending) {
      const id = entry.id ?? `row ${entry.row}`;
      if (!written.includes(entry.id)) notWritten.push(id);
    }
    // The post-condition, in one place. `boardChanged` is false only when
    // nothing was ever attempted, in which case the failure is a record
    // failure with the board untouched — which is exit 5's definition, not
    // exit 1's "data refused".
    return {
      exitCode: boardChanged ? 4 : 5,
      written, notWritten, files, staged: false, commit: null,
      errors: [e.message],
    };
  }

  if (files.length === 0) {
    return { exitCode: 0, written, notWritten, files, staged: false, commit: null, errors: [] };
  }

  // --- staging (§5.4). Scoped to exactly the files it wrote, never
  // `git add -A`. The receipt goes with them: it is a record, not a cache.
  try {
    commit = stage({
      root: dataRoot,
      mode: commitMode,
      op: "import",
      id: ids[0] ?? null,
      ids,
      message: message ?? `import: ${written.length} ticket(s) from CSV`,
      files: [...files, receiptPath],
    });
  } catch (e) {
    // Every write landed and staging failed — still 4. `commitOrQueue`
    // throws on an op absent from OP_LABEL and via `assertWritable`, and an
    // uncaught throw here would exit 1.
    return { exitCode: 4, written, notWritten, files, staged: false, commit: null, errors: [e.message] };
  }
  if (commit && commit.ok === false) {
    return { exitCode: 4, written, notWritten, files, staged: false, commit, errors: ["staging failed"] };
  }
  return { exitCode: 0, written, notWritten, files, staged: true, commit, errors: [] };
}

// --- the verb ----------------------------------------------------------------

function report(plan, { apply }) {
  const lines = [];
  const heading = (label, op) => {
    const hits = plan.rows.filter((r) => r.op === op);
    if (!hits.length) return;
    lines.push(`${label} — ${hits.length}`);
    for (const h of hits) {
      lines.push(`  row ${h.row}  ${h.id ?? "(id to be allocated)"}`
        + (h.changedColumns ? `  [${h.changedColumns.join(", ")}]` : ""));
    }
  };
  heading(apply ? "CREATED" : "WOULD CREATE", "create");
  heading(apply ? "UPDATED" : "WOULD UPDATE", "update");
  heading("SKIPPED (identical — a re-run is a no-op)", "skip");
  return lines;
}

/**
 * The whole verb, so the runner is argument parsing and printing only and
 * every decision stays behind the coverage gate (design §6).
 *
 * The PRE-WRITE PHASE runs in this order and the order is load-bearing:
 *   1. the prune — best-effort, read-only, exit-code-neutral;
 *   2. the exit-5 check over the mapping's LATEST receipt — before this run
 *      opens its own, or "latest" would be the empty file it just created;
 *   3. open this run's receipt for append — a failure here is exit 5, and the
 *      board is unchanged with nothing attempted.
 */
export async function runImport(opts) {
  const {
    file, projectsDir, dataRoot,
    apply = false, update = false, allocateIds = false,
    name = CANONICAL_NAME, sourceIdColumn = null,
    now = new Date(), commitMode = "per-op",
    writePort = undefined, readStorage = fsReadStorage,
    stage = commitOrQueue, appendReceipt = appendRegularFileSync,
    onPair = null,
  } = opts;

  const out = [];
  const say = (...l) => out.push(...l);
  const done = (exitCode) => ({ exitCode, report: out.join("\n"), plan: null });

  // The input, through `readRegularFileSync` per ADR-0031 — never opened
  // blind, because a FIFO with no writer blocks forever, with no error, no
  // timeout and nothing on stderr.
  let text;
  try {
    text = readRegularFileSync(file);
  } catch (e) {
    say(`blaze import: cannot read ${relative(dataRoot, file) || file} — ${e.message}`);
    return done(2);
  }

  const parsed = parseCanonicalCsv(text);
  if (!parsed.ok) {
    say(...parsed.errors);
    return done(parsed.exitCode);
  }

  const board = loadBoard(projectsDir, { dataRoot, readStorage });
  const plan = planImport(parsed.rows, board, { allocateIds, update });

  if (!plan.ok) {
    say(`blaze import: refusing ${plan.counts.refuse} row(s) — nothing was written.`);
    for (const r of plan.refusals) say(`  ${r.message}`);
    return { exitCode: 1, report: out.join("\n"), plan };
  }

  say(...report(plan, { apply }));

  if (!apply) {
    say("", `dry run — nothing written. Re-run with --apply to perform the import.`);
    if (allocateIds && !sourceIdColumn) {
      // §7's stated-rather-than-papered-over forfeit.
      say(`NOTE: --allocate-ids with no identity column forfeits the re-run-is-a-no-op `
        + `guarantee — a second run of this file DUPLICATES every id-less row.`);
    }
    return { exitCode: 0, report: out.join("\n"), plan };
  }

  // --- pre-write phase, step 1: the prune.
  for (const w of pruneReceipts(dataRoot, { now }).warnings) say(w);

  // --- pre-write phase, step 2: the exit-5 check. Scoped to
  // `sourceIdColumn`, because only the source-key lookup can be blind to a
  // ticket that exists — an explicit-id import finds it on the board and
  // compares (§5.1).
  if (sourceIdColumn) {
    const latest = latestReceiptFor(dataRoot, name);
    if (latest) {
      const r = readReceipt(latest);
      const unresolved = unresolvedIntents(r);
      if (unresolved.length) {
        say(`blaze import: ${relative(dataRoot, latest)} carries ${unresolved.length} row(s) with `
          + `neither a \`done\` nor a \`resolved\` — a re-import that proceeded would recreate any `
          + `row whose ticket landed but whose pair did not. Nothing was written.`);
        for (const u of unresolved) {
          say(`  ${u.torn ? "a torn line" : `seq ${u.seq}${u.source ? ` (source ${u.source})` : ""}`}`);
        }
        say(`  Lift it with: blaze import repair --apply ${relative(dataRoot, latest)}`);
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
    say(`blaze import: cannot open the run's receipt ${relative(dataRoot, receiptPath)} for append `
      + `(${e.message}) — the run does not start. The board is unchanged and nothing was attempted.`);
    return done(5);
  }

  const r = await applyImport(plan, {
    projectsDir, dataRoot, receiptPath, writePort, onPair, stage, appendReceipt, commitMode,
  });

  if (r.exitCode === 4) {
    say("", `blaze import: the board CHANGED and the run did not finish cleanly.`);
    say(`  written (${r.written.length}): ${r.written.join(", ") || "(none)"}`);
    say(`  NOT written (${r.notWritten.length}): ${r.notWritten.join(", ") || "(none)"}`);
    say(`  receipt: ${relative(dataRoot, receiptPath)} — its unmatched \`intent\` entries are the `
      + `record of what this run left behind. Nothing is rolled back.`);
    for (const e of r.errors) say(`  ${e}`);
  } else if (r.exitCode === 0) {
    say("", `imported ${r.written.length} ticket(s)${r.commit ? commitSuffix(r.commit) : ""}`);
    say(`  receipt: ${relative(dataRoot, receiptPath)}`);
  } else {
    for (const e of r.errors) say(`  ${e}`);
  }
  return { exitCode: r.exitCode, report: out.join("\n"), plan, result: r, receiptPath };
}
