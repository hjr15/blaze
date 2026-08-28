// scripts/model/audit.mjs — pure: corpus hygiene findings over an already-loaded set of
// tickets. No filesystem, no git. The runner (`blaze audit`) walks the board and hands the
// tickets in; everything below is a function of its arguments.
//
// Ported from the blaze-pm board's `scripts/metadata_audit.py` (BLZ-137), which could only
// ever run against that one board. The semantics are carried over deliberately, including
// the split that makes the gate usable:
//
//   HARD — the corpus is WRONG. An off-taxonomy value, a link that resolves to nothing, an
//          illegal parent pair. These fail the run.
//   SOFT — a FILL QUEUE. Empty metadata, an orphan. These are reported and never fail a run.
//
// That split is blaze-pm ADR-0011's soft gate, and it is load-bearing: a gate that fails on
// the fill queue is a gate people learn to skip, which costs the hard findings too.
import { resolveSchema, collectSchemaProblems } from "./schema-config.mjs";
import { LINK_TYPES } from "./links.mjs";

/** Every soft kind this module can emit. Exported so `blaze audit --help` prints what exists
 *  rather than a hand-kept list, which went stale twice — once for `schema-invalid` and
 *  `schedule-empty`, and once before that for `terminal-goal-unverified-requirement`. */
export const SOFT_KINDS = [
  "empty-components", "empty-labels", "missing-parent",
  "terminal-goal-unverified-requirement", "schema-invalid",
  "deadline-unreachable", "dependency-cycle", "schedule-stale", "schedule-empty",
];

export const HARD_KINDS = new Set([
  "off-taxonomy-component", "off-taxonomy-label", "bad-link-key", "unknown-link-type",
  "dangling-target", "dangling-parent", "invalid-parent-type", "parse-error",
  // duplicate-status (BLZ-122/REQ-035) is raised by the RUNNER, not by auditCorpus — ticket
  // identity is a property of the walk, and this pure function is a function of frontmatter
  // alone. Its severity still belongs here: HARD_KINDS is the published contract that
  // `summarise` and every caller reads, so a kind raised elsewhere must still be classified
  // in one place.
  "duplicate-status",
  // config-unloadable (BLZ-402 review finding 1, tightened by round-2 finding 3) is raised
  // by the RUNNER, for the same reason as duplicate-status: whether `loadConfig` threw is a
  // property of the LOAD attempt, not of any ticket's frontmatter. HARD, deliberately —
  // `audit` is exempt from `cli.mjs`'s schema preflight on the ground that reporting this
  // class of problem IS its job, and a report that swallows a load failure into
  // `config = null` and still prints `ok=true` is the opposite of that job. It fires on
  // ANY `loadConfig` throw except the two BLZ-392 explicitly tolerates (unparseable JSON,
  // a `schemaVersion` stamp genuinely outside the supported window) — so a bad
  // `key`/`projects[]` entry, a malformed `schedule` block, AND a config that sets a
  // REMOVED key (`provider`, `terminal`, `codeRepo`; BLZ-298) all land here. The removed-
  // key case is semantically unrelated to the schemaVersion stamp — it says nothing about
  // whether the stamp is in-window — which is why `scripts/model/schema-version.mjs`
  // discriminates it from a version-window failure at the source (round 3), rather than
  // relying on this runner to re-derive the distinction from the exception's message.
  //
  // An earlier revision of this comment claimed it "cannot be a fill queue" because
  // "everything downstream ... depends on the config that failed to load, so there is
  // nothing safe to keep running against" — used to justify zeroing the audit-runner
  // project-set denominator to `[]` on this finding. That was FALSE, and
  // `scripts/audit-runner.mjs` disproves it: `tickets` comes from
  // `fsReadStorage.listTickets` and `schema-invalid` is read from each project's
  // `project.json` on disk, neither of which touches `config.projects`, so both remain
  // exactly as safe to compute as when `config` is null for any other reason. What makes
  // this HARD is not that nothing downstream is safe — it is that a config failing to load
  // for one of these reasons is itself real information the operator must see, the same way
  // `duplicate-status` is HARD despite the rest of the corpus still being auditable.
  "config-unloadable",
  // BLZ-407: a MALFORMED schema override — the class `assertSchemaValid` (the load path)
  // already refuses on. Before this, every problem `collectSchemaProblems` tags `hard` was
  // flattened into `schema-invalid` by `validateSchema` and filed SOFT, so `blaze audit`
  // reported `ok=true` on a board every non-exempt verb already refused with
  // `SchemaOverrideError` — the same message, the tag simply lost on the way to a finding.
  // See ADR-0024.
  "schema-malformed",
  // project-mismatch (BLZ-406 AC-3) is raised by the RUNNER, not by auditCorpus, for the
  // same reason duplicate-status and config-unloadable are: whether a ticket's DIRECTORY
  // agrees with its frontmatter `project` is a property of the WALK — which path the file
  // sits at — and this pure function is a function of frontmatter, which carries no path.
  //
  // HARD, deliberately: the corpus really is wrong. A ticket filed under one project's
  // directory while its frontmatter names another is exactly the shape this file's own
  // header sets as the test for HARD, and it is not a fill queue — there is nothing to
  // queue, only a file sitting in the wrong place. It also fails `reconcile --project
  // <KEY>` silently for BOTH keys (scripts/reconcile.mjs's `project-mismatch` finding is
  // the sibling of this one, on the write side): the signal map is keyed by frontmatter
  // `project`, the write lands by directory, and a run naming either key alone can never
  // reconcile such a ticket.
  //
  // Licensed by measurement, per the BLZ-353 lesson that shipping a plausible-sounding
  // hard finding on an unmeasured assumption fails the live board on day one: re-verified
  // at blaze-pm branch BLZ-305-v4-spine (1d172e1e6edfe481465609c9dfd05bd97f6b8930), across
  // 2,682 tickets in 11 projects, BOTH `frontmatter.project != directory` and
  // `id-prefix != directory` measure ZERO. Shipping this hard fails no existing board.
  "project-mismatch",
]);

// BLZ-353 / R48. Deliberately NOT in HARD_KINDS, and the reason is load-bearing.
//
// `terminal-goal-unverified-requirement` is raised by the RUNNER, not by auditCorpus, for
// the same reason as duplicate-status: it is a function of the walk (status is the
// directory), not of frontmatter.
//
// It is SOFT on evidence, against the ticket's own initial expectation. BLZ-353 predicted
// zero pre-existing violations and reasoned that hard was therefore affordable. That
// measurement was wrong — it walked a terminal set that omitted `achieved`, the goal
// workflow's actual terminal status. The real count on this board is 7, all under NCA-1,
// and one of them (NCA-24) is still `proposed` — never delivered — which means NCA-1
// reached `achieved` through a path that bypassed the gate entirely.
//
// Shipping this hard would fail `blaze audit` on day one for a pre-existing defect, and the
// comment at the top of this file explains why that is the wrong trade: a gate that fails on
// debt is a gate people learn to skip, which costs the hard findings too. It flips to hard
// once NCA-1 is resolved — see the tracking ticket named in BLZ-353.

// Types whose classification lives in typed fields rather than labels (BLZ-234).
const LABEL_EXEMPT = new Set(["requirement", "architecture", "risk"]);

const keyOf = (id) => String(id ?? "").split("-")[0];

/** BLZ-416: put the project into a per-project schema problem's own sentence.
 *
 *  A message that already names `project.json:` gets the DIRECTORY it is missing, so the
 *  result is a path an operator can open (`projects/OBA/project.json: …`). Anything else —
 *  a problem read off the merged type/workflow registry, which names no file at all — is
 *  prefixed with the project instead. One helper rather than two call sites, so the two
 *  shapes cannot drift apart. */
function attributeToProject(key, message) {
  return message.startsWith("project.json:")
    ? `projects/${key}/${message}`
    : `projects/${key}: ${message}`;
}

/**
 * @param tickets   [{ frontmatter, body }] — the whole corpus
 * @param projects  { KEY: projectJson } — taxonomy and optional per-project schema block
 * @param config    the board config, for the top-level schema override
 * @returns { findings: [{ ticket, kind, detail }], ok }
 */
export function auditCorpus({ tickets = [], projects = {}, config = null } = {}) {
  const findings = [];
  const add = (ticket, kind, detail = "") => findings.push({ ticket, kind, detail });

  const ids = new Set();
  const typeById = new Map();
  for (const t of tickets) {
    const fm = t?.frontmatter ?? {};
    if (fm.id) { ids.add(fm.id); typeById.set(fm.id, fm.type); }
  }

  // Each project is judged by its OWN resolved registry (BLZ-238), so one project's
  // customisation cannot make another project's corpus look wrong.
  const registryFor = new Map();
  const typesFor = (key) => {
    if (!registryFor.has(key)) {
      registryFor.set(key, resolveSchema({ config, project: projects[key] ?? null }).types);
    }
    return registryFor.get(key);
  };

  // BLZ-392: `validateSchema`'s FIRST production caller. It has existed since ADR-0002 with
  // nothing calling it, and ADR-0002 says in as many words that leaning on it buys "a
  // well-tested no-op: green in CI, absent in production" — which is exactly what happened when
  // this ticket first named it as the mitigation for a malformed link-type block.
  //
  // The top-level layer is judged ONCE — it is the same block for every project, and eleven
  // copies of one finding is noise that hides the signal. Each project's own layer is judged
  // separately and deduplicated per PROJECT, not by message: two projects with the same broken
  // block are two things to fix, and collapsing them to one attributed to whichever sorted
  // first would have an operator fix one, re-run, and discover the next — up to eleven rounds.
  // Computed ONCE: this ran twice, identically, back to back — two full merges and validations
  // for one result. Deduplicated within the layer too, which the restructure had dropped: a
  // repeated bad kind produced two byte-identical findings.
  const topResolved = resolveSchema({ config });
  // Every type that exists ANYWHERE, for the endpoint-kind check only. A top-level `Precedes`
  // list may legitimately name a type that only one project declares — judging it against the
  // top layer alone produced a finding its own report contradicted: "not a declared type, so it
  // stays unschedulable", printed beside a `deadline-unreachable` proving it HAD been scheduled.
  const endpointTypes = { ...topResolved.types };
  for (const key of Object.keys(projects)) {
    Object.assign(endpointTypes, resolveSchema({ config, project: projects[key] ?? null }).types);
  }
  // BLZ-407: the TAGGED list, not `validateSchema`'s flattened strings — `collectSchemaProblems`
  // already marks each problem `hard` (assertSchemaValid, the load path, refuses on exactly
  // these) or `soft` (legal-but-inert configuration, an advisory), and folding both into one
  // `schema-invalid` kind is the defect this ticket exists to close: `blaze audit` reported
  // `ok=true` on a board every non-exempt verb already refused. A hard problem is now filed
  // under the hard kind `schema-malformed`; a soft one keeps the existing soft `schema-invalid`
  // — `validateSchema`'s own public shape (an array of strings) is untouched, because
  // `auditCorpus` still needs it nowhere else and other callers still get strings.
  //
  // Deduped by MESSAGE, exactly as before (`new Set(validateSchema(top))` was the pre-BLZ-407
  // dedup, just untagged): a message's hard/soft classification cannot differ by layer — it is
  // decided once, at the `hard(...)`/`soft(...)` call site that produced it — so filing by
  // whichever layer reported it first carries the right tag regardless of which layer that was.
  //
  // Each branch calls `add(...)` with a LITERAL kind, never a computed one: BLZ-392's own
  // anti-drift scan (tests/model/link-type-overrides.test.mjs, "the finding registries are
  // complete, not just consistent") greps this file for `add\(...,\s*"kind"` to keep
  // `HARD_KINDS`/`SOFT_KINDS` from silently drifting from what actually gets emitted. A
  // `hard ? "schema-malformed" : "schema-invalid"` ternary here is invisible to that regex —
  // it would make `schema-invalid` look unemitted and `SOFT_KINDS` report a phantom.
  const topProblems = collectSchemaProblems({ ...topResolved, config, endpointTypes });
  const topByMessage = new Map();
  for (const p of topProblems) if (!topByMessage.has(p.message)) topByMessage.set(p.message, p.hard);
  for (const [message, hard] of topByMessage) {
    if (hard) add("-", "schema-malformed", message);
    else add("-", "schema-invalid", message);
  }
  for (const key of Object.keys(projects)) {
    const project = projects[key] ?? null;
    // Judged against the EFFECTIVE link types — the top layer's — not the project-merged ones.
    // A project block never reaches the scheduler, so reporting its endpoint kinds as "stays
    // unschedulable, fix the kind" alongside "does not reach the scheduler" gave the operator
    // two findings that contradict each other, one proposing a repair that cannot work.
    const resolved = { ...resolveSchema({ config, project }), linkTypes: topResolved.linkTypes };
    // No per-project dedup Map: `collectSchemaProblems` returns entries distinct by construction
    // for one layer (mirroring the pre-BLZ-407 comment about `validateSchema`), so a second one
    // here would be unreachable.
    for (const p of collectSchemaProblems({ ...resolved, config, project, endpointTypes })) {
      if (topByMessage.has(p.message)) continue;   // already reported against the top layer
      // BLZ-416: NAME THE PROJECT IN THE SENTENCE. This loop deliberately does not
      // deduplicate across projects — "two projects with the same broken block are two
      // things to fix" — and the consequence was two byte-identical `project.json:
      // schema.types must be an object …` findings, with the key travelling only in the
      // `ticket` field, which is named for ticket ids, and a plain report that prints
      // nothing but a per-kind count. An operator was told a project.json is broken and
      // not told whose.
      //
      // Decorated HERE, at the `add` site, and never in the message itself: the same
      // problem strings are also produced against the TOP layer, where they belong to no
      // one project and attributing them to one would be false. That also keeps the
      // `topByMessage` comparison above on the RAW message, which is what makes the
      // cross-layer skip still work.
      if (p.hard) add(key, "schema-malformed", attributeToProject(key, p.message));
      else add(key, "schema-invalid", attributeToProject(key, p.message));
    }
  }

  for (const t of tickets) {
    const fm = t?.frontmatter ?? {};
    const id = fm.id;
    if (!id) { add("?", "parse-error", "ticket has no id"); continue; }

    const key = keyOf(id);
    const project = projects[key] ?? {};
    const types = typesFor(key);
    const ttype = fm.type;

    // --- taxonomy -----------------------------------------------------------------
    const components = fm.components ?? [];
    const labels = fm.labels ?? [];
    if (components.length === 0) add(id, "empty-components", ttype);
    if (labels.length === 0 && !LABEL_EXEMPT.has(ttype)) add(id, "empty-labels", ttype);

    if (Array.isArray(project.components) && project.components.length) {
      for (const c of components) {
        if (!project.components.includes(c)) add(id, "off-taxonomy-component", c);
      }
    }
    if (Array.isArray(project.labels) && project.labels.length) {
      for (const l of labels) {
        if (!project.labels.includes(l)) add(id, "off-taxonomy-label", l);
      }
    }

    // --- links --------------------------------------------------------------------
    for (const link of fm.links ?? []) {
      if (link == null || typeof link !== "object") { add(id, "bad-link-key", "not an object"); continue; }
      if (link.target === undefined) {
        const bad = Object.keys(link).find((k) => k !== "type");
        add(id, "bad-link-key", bad ? `found '${bad}:' instead of 'target:'` : "missing 'target:'");
        continue;
      }
      if (!LINK_TYPES.has(link.type)) add(id, "unknown-link-type", String(link.type));
      if (!ids.has(link.target)) add(id, "dangling-target", link.target);
    }

    // --- hierarchy ----------------------------------------------------------------
    const parent = fm.parent;
    if (!parent) {
      if (ttype !== "goal") add(id, "missing-parent", ttype);   // soft: an orphan is reported
      continue;
    }
    if (!ids.has(parent)) { add(id, "dangling-parent", parent); continue; }
    const ptype = typeById.get(parent);
    const def = types[ttype];
    if (!def) { add(id, "invalid-parent-type", `unknown type '${ttype}'`); continue; }
    if (!def.parentTypes.includes(ptype)) {
      add(id, "invalid-parent-type", `${ttype} cannot be a child of ${ptype}`);
    }
  }

  return { findings, ok: !findings.some((f) => HARD_KINDS.has(f.kind)) };
}

/** Counts by kind, for a runner that prints a summary rather than every finding. */
export function summarise(findings) {
  const out = new Map();
  for (const f of findings) out.set(f.kind, (out.get(f.kind) ?? 0) + 1);
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({
    kind, count, severity: HARD_KINDS.has(kind) ? "hard" : "soft",
  }));
}

// ---------------------------------------------------------------------------------------
// scheduleFindings — BLZ-360 §7 / BLZ-382. ONE function, so `blaze audit` and the view layer
// cannot drift. A conflict that shows on the Gantt but not in CI is invisible to an agent;
// one that shows only in CI is invisible to the operator.
//
// It lives in this file rather than behind `scripts/audit-runner.mjs` deliberately:
// `.c8rc.json` excludes `scripts/*-runner.mjs`, so logic put in the runner escapes the
// coverage gate silently.
//
// ALL FOUR KINDS ARE SOFT, and none is in HARD_KINDS above. The header of this file sets
// the test: HARD means the CORPUS is wrong. A missed deadline means the PLAN is wrong, which
// is a true and useful statement about a correct corpus, and a `Precedes` cycle is two
// well-formed links whose combination is unschedulable — both rows are valid, both endpoints
// resolve, and the FK holds.
//
// `dependency-cycle`'s FLIP-TO-HARD TRIGGER is a coverage trigger, not a debt trigger,
// because the debt version was unfireable: BLZ-360 §7.1's original *"becomes HARD when the
// open-SCC count reaches zero"* was written against the wrong number and against the real one
// (zero, measured) it fires on day one, which is a condition rather than a trigger. The
// replacement:
//
//   dependency-cycle flips to HARD once `Precedes` is the sole declared input to the
//   scheduler — that is, once BLZ-360 §5.5's `import-deps` reconciliation is closed and no
//   scheduled ticket depends on a `Blocks` edge for its ordering.
//
// Until then a cycle can be an artefact of a half-migrated graph, which is not the
// operator's error to be gated on. BLZ-353 is the precedent for tracking a flip by its own
// ticket, and its lesson is why this zero is not being used to justify shipping hard.
// `schedule-empty` (BLZ-392) joins them. Adding a kind to `scheduleFindings` without adding it
// here made the grouper fall through its noun ternary and label it "tickets carrying a stale
// schedule" — a wrong sentence about a real finding, in the function whose own header says it
// exists so `blaze audit` and the view layer cannot drift.
export const SCHEDULE_KINDS = ["deadline-unreachable", "dependency-cycle", "schedule-stale", "schedule-empty"];
const scmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const projectOf = (id) => String(id ?? "").split("-")[0];

/**
 * The zero-float predecessor walk from a late ticket — §7.2's payload. "You are 11 days
 * late" is a complaint; "and here are the three tickets that decide it" is actionable.
 *
 * Only the BINDING predecessor is followed: the one whose EF + lag actually equals this
 * node's ES. A predecessor that finishes earlier decides nothing and does not belong in the
 * chain. Ties break on ticket id so the chain is byte-stable.
 */
function bindingChain(schedule, id) {
  const preds = new Map();
  for (const e of schedule.edges) {
    if (!preds.has(e.target)) preds.set(e.target, []);
    preds.get(e.target).push(e);
  }
  const chain = [id];
  const seen = new Set([id]);
  for (let cur = id; ;) {
    const row = schedule.by_id.get(cur);
    if (!row) break;
    const binding = (preds.get(cur) ?? [])
      .filter((e) => {
        const p = schedule.by_id.get(e.src);
        return p && p.ef + e.lag_minutes === row.es;
      })
      .map((e) => e.src).sort(scmp);
    // A cycle cannot appear here — SCC members are not scheduled — but the guard costs
    // nothing and a walk that could loop forever is not a walk anyone should ship.
    const next = binding.find((p) => !seen.has(p));
    if (next === undefined) break;
    chain.unshift(next); seen.add(next); cur = next;
  }
  return chain;
}

/**
 * @param schedule   the result of scheduleModel()
 * @param persisted  [{ id, schedule_run_id }] — the cached derived columns, for staleness
 * @returns [{ ticket, kind, detail, ... }] in auditCorpus's shape, so `blaze audit` can
 *          concatenate it and `summarise` needs no change
 */
export function scheduleFindings(schedule, { persisted = [] } = {}) {
  const findings = [];

  // --- schedule-empty: the endpoint kinds select nothing ----------------------------------
  // BLZ-392. The override that makes a custom type schedulable can equally make EVERYTHING
  // unschedulable, and every way of doing it is silent: `source_kinds: []`, a single typo'd
  // kind (`"taks"`), or a link-type list carrying no `Precedes` at all. The node set empties,
  // every schedule finding disappears with it, and the report is byte-identical to a healthy
  // board — a `deadline-unreachable` that was firing yesterday simply stops.
  //
  // This is deliberately an OUTCOME check, not a catalogue of the causes. Enumerating the
  // malformed shapes is what the first attempt did, and it missed the two most plausible
  // operator typos precisely because they are well-formed. Asking "did anything get scheduled,
  // and was there anything to schedule?" catches all of them, including the ones nobody has
  // thought of yet.
  // Keyed on the NODE count, not on `scheduled.length`. Those differ, and the difference is the
  // whole point: a board whose every ticket sits in a dependency cycle schedules nothing while
  // being perfectly schedulable, and `dependency-cycle` already says so. Conflating the two made
  // this fire there — caught by the existing SCC test, which is exactly what it is for.
  if ((schedule.node_count ?? 0) === 0 && (schedule.candidates ?? 0) > 0) {
    findings.push({
      ticket: "-", kind: "schedule-empty",
      detail: `nothing is schedulable: ${schedule.candidates} ticket(s) that ought to be `
        + "schedulable exist, but "
        + "the declared Precedes endpoint kinds match none of them "
        + `(source kinds: ${(schedule.source_kinds ?? []).join(", ") || "none"}). `
        + "Check schema.linkTypes — every schedule finding is suppressed while this holds",
    });
  }

  // --- deadline-unreachable: derived due_date > deadline ---------------------------------
  // STRICT. A deadline is a DATE, so finishing at 16:00 on the deadline day is on time, and
  // `>=` here is mutation 1.
  for (const row of schedule.scheduled) {
    if (!row.deadline || !(row.due_date > row.deadline)) continue;
    const chain = bindingChain(schedule, row.id);
    const crosses = new Set(chain.map(projectOf)).size > 1;
    const days = lateWorkingDays(schedule, row);
    // A chain of one used to say "no predecessors" unconditionally, which was a claim the
    // result object itself could contradict: a ticket whose ES is driven by its own
    // `not_before` has predecessors, they just do not bind. Saying so while never naming the
    // constraint that DOES decide the date is exactly the defect §7.2 forbids.
    const tail = chain.length > 1
      ? `binding chain ${chain.join(" → ")}, float ${schedule.by_id.get(chain[0]).float_minutes}`
        + (crosses ? " (crosses projects)" : "")
      : hasPredecessor(schedule, row.id)
        ? `no predecessor binds — the earliest start is set by ${boundBy(schedule, row)}`
        : "no predecessors — nothing else decides this date";
    findings.push({
      ticket: row.id, kind: "deadline-unreachable",
      detail: `deadline ${row.deadline}; earliest finish ${row.due_date} `
        + `(${days} working day${days === 1 ? "" : "s"} late); ${tail}`,
      chain, crosses_projects: crosses, late_working_days: days,
      deadline: row.deadline, due_date: row.due_date, epoch_date: schedule.epoch_date,
    });
  }

  // --- dependency-cycle: an SCC in the non-terminal delivery graph ------------------------
  for (const u of schedule.unscheduled) {
    if (u.reason !== "dependency-cycle") continue;
    const loop = [...u.scc, u.scc[0]].join(" → ");
    findings.push({
      ticket: u.id, kind: "dependency-cycle",
      detail: `Precedes cycle ${loop}; ${u.scc.length} tickets unscheduled`,
      chain: u.scc,
    });
  }

  // --- schedule-stale: a persisted row not stamped with the latest run --------------------
  // A stale date that looks live is worse than no date, so the finding exists to stop a view
  // rendering one (BLZ-360 §6.3).
  for (const row of [...persisted].sort((a, b) => scmp(a.id, b.id))) {
    if (row.schedule_run_id === schedule.run_id) continue;
    findings.push({
      ticket: row.id, kind: "schedule-stale",
      detail: row.schedule_run_id
        ? `schedule_run_id ${row.schedule_run_id} is not the latest run ${schedule.run_id} `
          + "— render as stale, never as a date"
        : `never stamped with a schedule run (latest is ${schedule.run_id}) `
          + "— render as stale, never as a date",
    });
  }

  return findings;
}

const hasPredecessor = (schedule, id) => schedule.edges.some((e) => e.target === id);

/**
 * What actually sets a ticket's ES when no predecessor binds. Naming it is the point: a
 * finding that reports lateness without naming its cause is the complaint §7.2 rejects.
 */
function boundBy(schedule, row) {
  const src = schedule.by_id.get(row.id);
  const nb = src && schedule.constraint_of ? schedule.constraint_of.get(row.id) : null;
  if (nb) return `not_before ${nb}`;
  return `project_epoch ${schedule.epoch_date}`;
}

/** Working days between a ticket's deadline and its derived finish. */
function lateWorkingDays(schedule, row) {
  let n = 0;
  const day = 24 * 60 * 60 * 1000;
  let ms = Date.parse(row.deadline + "T00:00:00Z");
  const end = Date.parse(row.due_date + "T00:00:00Z");
  const working = new Set(schedule.working_days);
  while (ms < end) { ms += day; if (working.has(new Date(ms).getUTCDay())) n++; }
  return n;
}

/**
 * Spec 3 §8's presentation rule: findings are GROUPED BY KIND WITH A COUNT, and a kind whose
 * every member is a migration artefact says so.
 *
 * It exists because of a measurement, not a preference. After BLZ-360 §4's migration, 11 of
 * the 12 non-terminal deadlines are already in the past, so `deadline-unreachable` fires 11
 * times on first open — and eleven separate red rows is how a view teaches an operator to
 * ignore a kind, which costs the hard findings too.
 *
 * `migratedDeadlines` is the 12-id NON-TERMINAL cohort, not §4's 40 ids: the 40 are 28
 * terminal + 12 non-terminal, so membership there identifies a DATED ticket rather than a
 * MIGRATED DEADLINE. With no set supplied the banner claims nothing rather than guessing.
 */
export function groupScheduleFindings(findings, { migratedDeadlines = null, epochDate = null } = {}) {
  const migrated = migratedDeadlines ? new Set(migratedDeadlines) : null;
  epochDate = epochDate ?? findings.find((f) => f.epoch_date)?.epoch_date ?? null;
  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  const order = (k) => { const i = SCHEDULE_KINDS.indexOf(k); return i < 0 ? SCHEDULE_KINDS.length : i; };
  return [...byKind.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || scmp(a[0], b[0]))
    .map(([kind, items]) => {
      const all = kind === "deadline-unreachable" && migrated !== null
        && items.length > 0 && items.every((f) => migrated.has(f.ticket));
      // "and already in the past" was conjoined to the banner WITHOUT being checked. It is a
      // separate claim from cohort membership and it is falsified by the twelfth member:
      // OMA-4 is in the 12-id cohort and its deadline is 2026-10-20.
      const past = all && items.every((f) => f.deadline && epochDate && f.deadline < epochDate);
      const noun = kind === "deadline-unreachable" ? "deadlines unreachable"
        : kind === "dependency-cycle" ? "tickets in a Precedes cycle"
        // Not a per-ticket count: one finding for the whole installation, so "1 tickets ..."
        // would be wrong twice over.
        : kind === "schedule-empty" ? "schedule with no schedulable tickets"
        : "tickets carrying a stale schedule";
      return {
        kind, count: items.length, severity: HARD_KINDS.has(kind) ? "hard" : "soft",
        all_migration_artefacts: all,
        all_already_past: past,
        summary: `${items.length} ${noun}`
          + (all ? ` — all ${items.length} are dates migrated from \`due\` by `
            + "`schedule migrate-dates`" + (past ? " and already in the past" : "") : ""),
        items,
      };
    });
}
