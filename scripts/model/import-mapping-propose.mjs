// scripts/model/import-mapping-propose.mjs — THE ONE PLACE A MODEL RUNS.
// BLZ-635, implementing design §4.3 and §4.4
// (docs/design/csv-import-and-export.md), under ADR-0037 §2 and §3.
//
// WHAT THIS MODULE MAY DO, exhaustively: read a CSV's header and a bounded
// sample of its rows, spawn the configured `agentCommand` ONCE, render what
// came back for a person to read, and — if that person says yes — write
// `import-mappings/<name>.json`. That is the entire list.
//
// WHAT IT MAY NEVER DO, and why each one is a separate sentence rather than a
// summary: it never creates a ticket, never allocates an id, never resolves
// one, never reads the corpus, never touches a write port, and never stages
// anything. ADR-0037 §2's whole decision is that "a model may produce a
// mapping; it may never produce a row", and §3's is that "acceptance is a
// separate invocation that writes a file and nothing else". The operator is
// agreeing to a FILE, not to a run — which is what makes the acceptance
// meaningful, because a confirmation prompt immediately followed by 2,800
// writes is a confirmation nobody reads.
//
// THE MODEL'S OUTPUT IS DATA, NEVER CODE. It is parsed as JSON and then put
// through BLZ-634's own `loadMapping` before it is written, so a candidate
// the deterministic importer would refuse never reaches disk — a mapping file
// the importer cannot load is not a proposal, it is a trap laid for the next
// run. `transform` is a closed vocabulary for the same reason (§4.2): an
// expression language here would be a second place a model's output becomes
// executable, and ADR-0037 §2 exists to have exactly one.
//
// THE CONFIRMATION IS NOT A FLAG. `propose-mapping` takes no `--apply`; the
// operator's answer at the prompt is the gate (ADR-0037 §4, which names this
// as the exception its own heading has to state). A `--yes` flag is rejected
// in that ADR's Alternatives: "a flag that exists is a flag that ends up in a
// script".
//
// WHY THE SPAWN IS SHAPED LIKE THE GROOMER'S. `loops/groomer.mjs:568` is
// `const [cmd, ...args] = cfg.agentCommand.split(" ")` followed by
// `spawnSync(cmd, [...args, prompt], …)`, and this is the same seam rather
// than a second one. Two consequences are load-bearing and are pinned in
// tests/import-agent-boundary.test.mjs rather than asserted here:
//   * with `BLAZE_AGENT_COMMAND` set, `config.mjs:279` OVERRIDES
//     `cfg.agentCommand` outright, so `cmd` is whatever that names — an
//     absolute path bypasses `PATH` entirely;
//   * unset, `cfg.agentCommand` is the built-in `"claude -p"`
//     (`config.mjs:29`) and the BARE name `claude` is resolved through
//     `PATH`. Those are two different arms, they are exercised by two
//     different configurations, and a guard with one sentinel cannot tell
//     them apart.
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { writeRegularFileSync, readRegularFileSync } from "./regular-file.mjs";
import { parseCsv } from "./csv.mjs";
import { COLUMNS, COLUMN_NAMES } from "./csv-schema.mjs";
import {
  CANONICAL_MAPPING_NAME, MAPPING_DIR, headerDigest, loadMapping, mappingPathFor,
} from "./import-mapping.mjs";

/** How many data rows the model is shown. Bounded, because the prompt is not
 *  the corpus: a 10,000-row export must not become a 10,000-row prompt, and
 *  nothing about inferring what a COLUMN means gets better past a couple of
 *  dozen examples. */
export const SAMPLE_ROWS = 25;

/** Wall-clock and output caps, the groomer's own defaults in spirit: a spawn
 *  with neither is a verb that can hang an operator's terminal forever. */
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 8 * 1024 * 1024;

export function sampleOf(rows) {
  return rows.slice(0, SAMPLE_ROWS);
}

function promptFor(header, rows, name) {
  return [
    "You are proposing a COLUMN MAPPING for a CSV that a person will review before anything",
    "is imported. You are not importing anything and you have no access to the board.",
    "",
    "Answer with a single JSON object and nothing else, in this shape:",
    '  { "mappingVersion": 1, "schemaVersion": 1, "name": "<a short slug>",',
    '    "sourceIdColumn": "<the source\'s own key column, or null>",',
    '    "columns": { "<canonical column>": { "from": "<source column>" } | { "constant": "<value>" } },',
    '    "values": { "<canonical column>": { "<source value>": "<canonical value>" } },',
    '    "unmapped": ["<every source column you did not map>"] }',
    "",
    `The canonical columns are, exactly: ${COLUMN_NAMES.join(", ")}.`,
    "A `transform` on a column, when you need one, must be one of exactly:",
    "  identity, hours-to-minutes, seconds-to-minutes, days-to-minutes, trim,",
    "  split-semicolon, split-comma, iso-date, dmy-date, mdy-date.",
    "Every source column must appear either in `columns` (as a `from`) or in `unmapped`,",
    "or be the `sourceIdColumn`: a column you leave out of all three is a refusal.",
    "Do not invent a translation you are not confident in — a value you leave out of `values`",
    "is shown to the person for them to decide, which is the safe outcome.",
    `A reasonable \`name\` for this file is ${JSON.stringify(name)}.`,
    "",
    `HEADER: ${JSON.stringify(header)}`,
    "SAMPLE ROWS:",
    ...rows.map((r) => `  ${JSON.stringify(r)}`),
  ].join("\n");
}

/** The first balanced JSON object in a blob of text. A model that wraps its
 *  answer in prose or a ```json fence has still answered; a model that
 *  answered something that is not an object has not, and that is a refusal
 *  rather than a repair. */
function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        const v = JSON.parse(text.slice(start, i + 1));
        return v && typeof v === "object" && !Array.isArray(v) ? v : null;
      } catch { return null; }
    }
  }
  return null;
}

/**
 * Spawn the agent command ONCE and read a candidate mapping out of what it
 * said. Returns `{ ok, candidate, errors }` — never throws, because the
 * failure of an external command is an outcome this verb reports rather than
 * a crash.
 *
 * The failure message CARRIES THE COMMAND'S OWN OUTPUT, deliberately: §4.3's
 * positive control asserts that a stubbed command's sentinel string reaches
 * the error, and without that a negative result cannot be attributed to the
 * stub rather than to the harness.
 */
export function proposeMapping(header, rows, { agentCommand, spawn = spawnSync, name = "mapping" } = {}) {
  const fail = (...errors) => ({ ok: false, candidate: null, errors });
  const command = String(agentCommand ?? "").trim();
  if (command === "") {
    return fail("blaze import propose-mapping: no agent command is configured — set `agentCommand` "
      + "in blaze.config.json or BLAZE_AGENT_COMMAND in the environment");
  }

  // The groomer's split, not a second one (`loops/groomer.mjs:568`). A bare
  // `cmd` is resolved through PATH by every spawn family member; an absolute
  // one is not, and that is deliberate (§4.3).
  const [cmd, ...args] = command.split(" ").filter((p) => p !== "");
  const r = spawn(cmd, [...args, promptFor(header, sampleOf(rows), name)], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER,
  });

  if (r.error) {
    return fail(`blaze import propose-mapping: could not run the agent command \`${command}\` — `
      + `${r.error.message}`);
  }
  if (r.status !== 0) {
    const said = [r.stdout, r.stderr].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n");
    return fail(
      `blaze import propose-mapping: the agent command \`${command}\` exited `
      + `${r.status === null ? `on signal ${r.signal}` : r.status} and no mapping was proposed. `
      + `Nothing was written.`,
      ...(said ? [`  it said: ${said}`] : []));
  }

  const candidate = firstJsonObject(String(r.stdout ?? ""));
  if (candidate === null) {
    return fail(`blaze import propose-mapping: the agent command \`${command}\` did not answer with `
      + `a JSON mapping object. Its answer is DATA, not code, and an answer this verb cannot read `
      + `as a mapping is a refusal rather than a repair. Nothing was written`);
  }

  // The header and its digest are MEASURED HERE, never taken from the model:
  // a model-supplied digest would make §4.2's header check vouch for nothing.
  candidate.source = { columns: header.slice(), sha256: headerDigest(header) };
  candidate.mappingVersion = candidate.mappingVersion ?? 1;
  candidate.schemaVersion = candidate.schemaVersion ?? 1;
  return { ok: true, candidate, errors: [] };
}

// --- §4.4, what the operator is shown ----------------------------------------

const REQUIRED = COLUMNS.filter((c) => c.required).map((c) => c.name);

/**
 * §4.4's four blocks, then the question.
 *
 * This render is the ONE EXEMPTION from §5.2's no-echo rule, and it says so
 * where the rule is stated too: `Status: "Blocked" (3 rows)` is the entire
 * point of the fourth block. An unmapped status the operator cannot see is a
 * mapping they cannot fix. The echo rule governs REFUSAL MESSAGES, which go
 * to stderr and get logged; this is an interactive display of the operator's
 * own file, on screen, at their request.
 */
export function renderProposal(candidate, header, rows) {
  const columns = candidate.columns ?? {};
  const values = candidate.values ?? {};
  const unmapped = candidate.unmapped ?? [];
  const out = [];

  const entries = Object.entries(columns);
  const width = Math.max(10, ...header.map((h) => h.length));
  out.push(`MAPPED — ${entries.length} of ${header.length} source columns`);
  for (const [target, spec] of entries) {
    const from = typeof spec.constant === "string" ? "(constant)" : spec.from;
    const tail = [];
    if (typeof spec.constant === "string") tail.push(spec.constant);
    if (spec.transform && spec.transform !== "identity") tail.push(`via ${spec.transform}`);
    for (const [k, v] of Object.entries(values[target] ?? {})) tail.push(`${k}→${v}`);
    out.push(`  ${String(from).padEnd(width)} → ${target.padEnd(12)}${tail.join("  ")}`.trimEnd());
  }
  if (candidate.sourceIdColumn) {
    out.push(`  ${String(candidate.sourceIdColumn).padEnd(width)} → (source key)  `
      + `re-importing this export is a no-op, keyed on this column`);
  }

  out.push("");
  out.push(`UNMAPPED — ${unmapped.length} source column${unmapped.length === 1 ? "" : "s"} `
    + "will be DISCARDED");
  out.push(`  ${unmapped.length ? unmapped.join(", ") : "(none)"}`);

  out.push("");
  // `id` is not listed when the mapping declares a source key: the id is
  // allocated and the SOURCE key is what the skip is keyed on (§4.2), so
  // naming it here would send the operator looking for a column that must not
  // exist. `schema_version` is never listed — this layer supplies it.
  const unfilled = REQUIRED.filter((name) =>
    name !== "schema_version"
    && !(name === "id" && candidate.sourceIdColumn)
    && !Object.hasOwn(columns, name));
  out.push("REQUIRED AND UNFILLED — the import cannot run");
  out.push(`  ${unfilled.length ? unfilled.join(", ") : "(none)"}`);

  out.push("");
  const untranslated = [];
  for (const [target, spec] of entries) {
    const table = values[target];
    if (!table || typeof spec.from !== "string") continue;
    const idx = header.indexOf(spec.from);
    if (idx === -1) continue;
    const counts = new Map();
    for (const row of rows) {
      const v = row[idx];
      if (v === undefined || v === "" || Object.hasOwn(table, v)) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (const [v, n] of counts) {
      untranslated.push(`  ${spec.from}: ${JSON.stringify(v)} (${n} row${n === 1 ? "" : "s"}) — `
        + `no ${target} maps to this`);
    }
  }
  out.push(`VALUES SEEN BUT NOT TRANSLATED — ${untranslated.length}`);
  out.push(...(untranslated.length ? untranslated : ["  (none)"]));

  out.push("");
  out.push(`Write ${MAPPING_DIR}/${candidate.name}.json? [y/N]`);
  return out.join("\n");
}

// --- the verb ----------------------------------------------------------------

/** A mapping's `name` is a BASENAME, and the model does not get to choose a
 *  path. `name` is also what `source-ids/<name>.jsonl` and every receipt are
 *  keyed on, so a name with a separator in it would key three artefacts on
 *  something that is not a filename. */
function nameProblem(name) {
  if (typeof name !== "string" || name === "") return "it is missing";
  if (name !== basename(name) || name.includes("/") || name.includes("\\")) {
    return "it is a path, not a name";
  }
  if (name === "." || name === "..") return "it is a directory reference";
  if (/[^A-Za-z0-9._-]/.test(name)) return "it has a character outside [A-Za-z0-9._-]";
  if (name.endsWith(".json")) return "the `.json` is the file's, not the name's";
  if (name === CANONICAL_MAPPING_NAME) {
    return "`canonical` is RESERVED — it is the <name> a canonical-header import with no mapping "
      + "file uses for its receipt (design §4.2)";
  }
  return null;
}

/**
 * `blaze import propose-mapping <file.csv>`.
 *
 * @param opts.confirm  reads the operator's answer. Injected so the module
 *                      stays testable; the runner supplies the real terminal
 *                      read. There is no flag that stands in for it.
 * @param opts.say      where the render goes. Defaults to stdout, because
 *                      §4.4's blocks are what the operator is being asked
 *                      about and a report they cannot see is not a proposal.
 */
export function runProposeMapping(opts) {
  const {
    file, dataRoot, agentCommand,
    spawn = spawnSync,
    confirm,
    say = (line) => console.log(line),
  } = opts;

  const report = [];
  const problem = (...lines) => {
    report.push(...lines);
    return { exitCode: 1, report: report.join("\n"), written: null };
  };

  let text;
  try {
    text = readRegularFileSync(file);
  } catch (e) {
    report.push(`blaze import propose-mapping: cannot read ${file} — ${e.message}`);
    return { exitCode: 2, report: report.join("\n"), written: null };
  }

  let grid;
  try {
    grid = parseCsv(text);
  } catch (e) {
    report.push(`blaze import propose-mapping: ${file} is not readable as CSV — ${e.message}`);
    return { exitCode: 2, report: report.join("\n"), written: null };
  }
  if (grid.length === 0) {
    report.push(`blaze import propose-mapping: ${file} is empty — a CSV's first line is its header`);
    return { exitCode: 2, report: report.join("\n"), written: null };
  }

  const [header, ...rows] = grid;
  const suggested = basename(String(file)).replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]/g, "-");
  const proposed = proposeMapping(header, rows, { agentCommand, spawn, name: suggested });
  if (!proposed.ok) return problem(...proposed.errors);

  const candidate = proposed.candidate;
  const why = nameProblem(candidate.name);
  if (why !== null) {
    return problem(`blaze import propose-mapping: the proposed \`name\` `
      + `${JSON.stringify(candidate.name)} cannot be used — ${why}. Nothing was written`);
  }

  // The candidate is put through the DETERMINISTIC loader's own rules before
  // the operator is asked, so the question is never "shall I write a file the
  // importer will refuse?".
  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  const dryCheck = checkAgainstLoader(candidate, serialized);
  if (dryCheck !== null) {
    return problem(`blaze import propose-mapping: the proposed mapping is not one `
      + `\`blaze import --mapping\` would accept, so it is not written:`, ...dryCheck);
  }

  say(renderProposal(candidate, header, rows));

  const answer = String(confirm(`Write ${MAPPING_DIR}/${candidate.name}.json? [y/N] `) ?? "");
  if (answer.trim().toLowerCase() !== "y") {
    report.push(`declined — nothing was written. The mapping was not saved; re-run to propose again.`);
    return { exitCode: 0, report: report.join("\n"), written: null };
  }

  const target = mappingPathFor(dataRoot, candidate.name);
  try {
    mkdirSync(`${dataRoot}/${MAPPING_DIR}`, { recursive: true });
    writeRegularFileSync(target, serialized);
  } catch (e) {
    return problem(`blaze import propose-mapping: cannot write ${target} — ${e.message}. `
      + `Nothing else was written either: this verb's entire effect on disk is this one file`);
  }

  report.push(`wrote ${MAPPING_DIR}/${candidate.name}.json`);
  report.push(`  No ticket was created, no id was allocated, nothing was staged. Review the file, `
    + `then run: blaze import --mapping ${MAPPING_DIR}/${candidate.name}.json <file.csv>`);
  return { exitCode: 0, report: report.join("\n"), written: target };
}

/** Run the candidate through the DETERMINISTIC loader's own rules without
 *  writing it first, by handing that loader the bytes it would have read.
 *  A thin call rather than a second copy of the rules, so the proposer's idea
 *  of a valid mapping and the importer's cannot drift apart. Returns null
 *  when it loads, or the loader's own refusals. */
function checkAgainstLoader(candidate, serialized) {
  const r = loadMapping(mappingPathFor("", candidate.name), { text: serialized });
  return r.ok ? null : r.errors;
}
