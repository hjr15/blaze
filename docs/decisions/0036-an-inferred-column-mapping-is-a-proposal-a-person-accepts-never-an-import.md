# ADR-0036 — an inferred column mapping is a proposal a person accepts, never an import

- **Status:** Accepted
- **Date:** 2026-09-08
- **Deciders:** Ryan Howman
- **Tickets:** BLZ-587 (the CSV schema and the importer), BLZ-588 (the markdown front end),
  BLZ-589 (export and the zero-diff round trip)
- **Supersedes nothing.** It sits under ADR-0006 (the database is the sole source of truth),
  ADR-0009/ADR-0010 (the read and write seams) and ADR-0018 (typed columns plus a JSON tail).

## Context

The operator's requirement, recorded in
`docs/superpowers/plans/2026-08-31-blaze-app-adoption-and-import-standard.md` §5 Q2 and quoted
there verbatim: *"Design it first but ideally it should be able to read a CSV and import
accordingly. If that means leveraging an AI account to figure it out at the time based on the
format then so be it."* §5 Q1 answers the other half: **the import targets the model layer, not
the filesystem write port**, so it survives BLZ-254's cutover unchanged.

Those two answers pull in opposite directions if nothing separates them, and the shape of that
separation is what this ADR decides.

**What the engine already offers.** Every mutating verb takes an injectable write port and
defaults it to the filesystem one — `applyNew` (`scripts/new.mjs:19-22`), `applyEdit`
(`scripts/edit.mjs:23-25`), `applyMove` (`scripts/move.mjs:15-17`), `applyLink`
(`scripts/link.mjs:11-13`), `applyLog` (`scripts/log.mjs:11-13`), `applyResolve`
(`scripts/resolve.mjs:9-11`). `selectWritePort` (`scripts/model/write-port.mjs:458`) chooses
`fs`, `dual` or `db` from `BLAZE_WRITE_PORT`. A verb written against that seam is already
cutover-proof; a verb written against `node:fs` is not.

**What the one existing import surface does instead.** `blaze migrate` writes tickets with a
bare `writeFileSync` (`scripts/migrate/jira-import.mjs:95`) after `mkdirSync`, bypassing the
write port entirely, and its `--live` path then stages the result with
`git add -A -- <projectsDir>` (`scripts/migrate-runner.mjs:73`) — the blast radius its own
comment on the line above warns about. That is the anti-pattern BLZ-587's acceptance criteria
name by hand, and it is filesystem-shaped in both halves.

**Why a model in the loop is a new hazard class for this repo.** Nothing on a write path here
has ever consulted a language model. The groomer does (`scripts/loops/groomer.mjs:546,570`,
spawning `cfg.agentCommand`, default `"claude -p"` at `scripts/config.mjs:21`), and it is
wrapped in a tree snapshot, an out-of-bounds path check, a symlink refusal and a revert — about
250 lines of containment for one agent edit to one file. An importer that asked a model what a
column means, mid-run, would be that hazard multiplied by the row count, with no snapshot to
revert to, and it would make the import **irreproducible**: the same file imported twice could
land differently.

**The failure that motivates the split.** A model inferring `Summary → title` is a guess about
someone else's data. A guess that is right 95% of the time across 31 columns is wrong on at
least one column in most files, and an import that silently guesses wrong is worse than one that
refuses — the wrong rows look correct, and the cost is paid weeks later.

## Decision

### 1. The importer is a model-layer verb, and the write port is injected, never assumed

The importer's logic lives in `scripts/model/` behind the coverage gate (`.c8rc.json` excludes
`scripts/*-runner.mjs`, so a runner is the wrong home for anything decidable). It takes a write
port the same way every other verb does, defaulting to `fsWritePort` and accepting the database
one unchanged. Nothing in the import path calls `node:fs` to place a ticket, and nothing calls
`git add -A`; staging goes through `commitOrQueue` (`scripts/commit-or-queue.mjs:11`), which is
scoped to exactly the files it wrote.

**A row is written at its declared status directly through `writePort.write`, not by walking
transitions.** `applyNew` forces `initialStatus(type)` (`scripts/new.mjs:30`) and `applyMove`
enforces `validateTransition`, so landing an already-`done` story through those two verbs costs
three moves and three `updated` stamps that never happened. `writePort.write({ project, status,
frontmatter, body })` (`scripts/model/write-port.mjs:80-88`) accepts any status, which is
correct: a row arriving from outside has no prior status, so there is no transition to validate.
What is validated is membership — the status must be in `statusesFor(type)` — plus every rule
`validateTicket` (`scripts/model/rules.mjs:9`), `validateTaxonomy`
(`scripts/model/taxonomy.mjs:7`), `validateSprintFields` and `lintLinks`
(`scripts/model/links.mjs:18`) already enforce.

### 2. A model may produce a mapping. It may never produce a row

There is exactly one place a model is invoked: `proposeMapping(header, sampleRows)`, reached
only by `blaze import propose-mapping`. Its entire output is a **candidate mapping file**. It
never sees the board, never resolves an id, never touches a write port, and its output is not
input to anything until a person has accepted it.

`blaze import` — the verb that writes — **does not link the proposer at all.** They are separate
runners over separate module graphs. This is a reachability property, not a convention, and it
is pinned as one: a structural test walks the transitive import graph of the import runner and
asserts that the proposer module is absent from it, that no module in it imports
`node:child_process`, and that no module in it reads `agentCommand`. Following the repo's own
method (plan §9, *"pin the property, not the spelling"*), the same walk is run over the
propose runner as a **positive control** and must find the proposer — a graph walker that finds
nothing anywhere proves nothing anywhere.

### 3. Acceptance is a separate invocation that writes a file and nothing else

`blaze import propose-mapping <file.csv>` renders the proposal — every source column with the
canonical column it would become, every value translation, every source column left unmapped,
and every required canonical column nothing maps to — and, on confirmation, writes
`import-mappings/<name>.json`. It creates no ticket, allocates no id, stages nothing.

`blaze import --mapping import-mappings/<name>.json <file.csv>` is a different command run later.
Given the mapping file it is **deterministic**: the same file and the same mapping produce the
same plan on every machine, forever, with no network and no model. Re-running it is a no-op
rather than a duplicate.

The mapping file is **source, not cache**, so it lives at the data root beside `sprints.json`
and is committed — not under `.blaze/`, which holds regenerable derived state
(`scripts/reindex.mjs:1-5`). This is the same distinction BLZ-110 drew when it put `sprints.json`
at the top level for the same reason.

### 4. The dry run is the default, and the write is the flag

`blaze import` reports what it would create, update and skip, and exits without writing. Writing
requires `--apply`. This follows `reconcile`, whose CLI entry already reads *"dry run unless
--apply"* (`scripts/cli.mjs:36`).

### 5. Export is part of this decision, not a follow-up

An importer that cannot be exported from is unverifiable, and this repo has spent nineteen
adversarial rounds establishing that a measurement which cannot observe the failure is not
evidence. `blaze export --format csv` emits the same versioned schema, and the gate is a
**byte-identical export-to-export** comparison: export a fixture corpus, import it into an empty
board, export again, `diff` is empty.

The gate is deliberately not a byte comparison of the *markdown*. `scripts/migrate/zero-diff.mjs`
measured that one before any migration existed: 137 of 2,534 tickets (5.4%) do not re-emit
byte-identically today, with zero value mismatches, purely because `serializeTicket` normalises
to `FIELD_ORDER` while on-disk files keep whatever order they were authored in. An acceptance
criterion that fails for an unrelated reason gets waived, and then it is not watching when
something real breaks.

## Consequences

- **The import survives the cutover.** With `BLAZE_WRITE_PORT=db` the same importer writes rows
  instead of files, and gains real per-run atomicity from the transaction it did not have on a
  filesystem.
- **An import is reproducible and auditable.** The mapping file is committed, so the decision
  "`Summary` means `title` on this tracker's exports" is reviewable in a diff rather than
  re-inferred per run.
- **Cost, accepted: two commands where an operator wanted one.** Proposing and applying cannot be
  collapsed into a single invocation without putting a model on the write path, which is the one
  thing this ADR forbids. The second run is cheap and, for a tracker seen before, the first is
  never run again.
- **Cost, accepted: a model can still propose a wrong mapping the operator accepts.** Nothing
  here makes the proposal correct — it makes it *visible and durable*. The dry run against the
  real file is the second check, and the round trip is the third.
- **Cost, accepted: filesystem atomicity is not real and is not claimed.** Validation is
  all-or-nothing; the write is not. A write that fails part way through stops at the first
  failure, names every id written and every id not, and exits 4. It does not roll back — a
  rollback is a second write path with its own failure mode, which is the shape ADR-0032
  rejected in a neighbouring problem. What it does instead is keep the evidence: the run records
  each row's outcome **before** performing that row's write, and refuses to start at all if that
  record cannot be written. That is BLZ-531's rule (`13f661c`) in a second place — park before you
  clear, and fail closed on a unit whose record could not be kept.
- **Scheduled expiry, partial.** BLZ-254 retires `fsWritePort`; §1's injection is what makes that
  a configuration change rather than a rewrite. §2's boundary has no expiry — it is a property of
  the verb, not of the store.

## Alternatives rejected

- **Infer the mapping per row, inside the import.** This is the literal reading of the operator's
  sentence and it is rejected because it makes the import irreproducible, unreviewable and
  unbounded in cost, and because a mid-file inference has nowhere to report a low-confidence
  guess except an error stream nobody is reading. The operator's requirement — that blaze read an
  unfamiliar CSV and import it — is met in full by §2 and §3; only the *timing* moves.
- **Cache the model's mapping and reuse it silently.** Rejected: an unconfirmed cache is the
  silent guess with a longer lifetime. What makes the mapping file safe is the acceptance step,
  not the persistence.
- **Hardcode a mapping table per tracker, as `blaze migrate` does for Jira**
  (`scripts/migrate/map.mjs:16-23`). Rejected: it works and it is what exists, but it requires
  blaze to know the source system, which is precisely the property the operator chose CSV to
  avoid. The Jira tables stay where they are; nothing here removes them.
- **A `--yes` flag that accepts the proposal and imports in one run.** Rejected: it puts the
  model back on the write path through a flag, and a flag that exists is a flag that ends up in
  a script.
- **Write rows through `applyNew` + `applyMove` to reuse the transition validator.** Rejected on
  measurement of the consequence rather than on taste: it fabricates transitions that never
  happened, stamps `updated` up to three times per imported row, and — under `BLAZE_WRITE_PORT=db`
  — appends up to three `ticket_event` rows per import (`scripts/model/write-port.mjs`'s
  `recordEvent`), corrupting the event log the migration oracle later reads.
- **Ship an untyped, dynamic column set that accepts whatever the CSV has.** Rejected: it makes
  the round trip unfalsifiable. A schema you cannot fail is not a schema.
