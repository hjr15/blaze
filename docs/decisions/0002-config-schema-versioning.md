# ADR-0002: Config-schema versioning — an integer stamp with an explicit compat window

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-15 |
| **Deciders** | Ryan Howman |

## Context

The engine (`@hjr15/blaze-board`) and a board's data repo (`blaze.config.json`
+ `projects/`) ship and evolve independently — that is the point of the
engine ⟂ data split. Nothing told the engine which schema contract a given
board was written against, so a future breaking schema change (renamed status,
changed required-field rule, reshaped hierarchy) would make an older board on a
newer engine **silently misbehave**: it loads, it renders, and it is quietly
wrong. Silent wrongness on ticket history is the worst failure mode for a tool
whose pitch is "the board can't lie". The backward-compat contract test
(`tests/compat-legacy.test.mjs`) proves legacy boards still load today; this
decision adds the guard that makes a future incompatibility loud.

## Decision

A new optional top-level **`schemaVersion` integer** in `blaze.config.json`
stamps the data repo with the schema contract it was written against. The
engine declares an explicit closed compat window — `SCHEMA_VERSION = 1` (the
contract it writes/speaks) and `MIN_SCHEMA_VERSION = 1` (the oldest it still
reads) — and a board loads iff
`MIN_SCHEMA_VERSION <= schemaVersion <= SCHEMA_VERSION`.

- **Absent (or `null`) means legacy, and legacy means v1.** Every board in
  existence today is un-versioned; a guard that rejected them would fail every
  real board on day one.

- **The guard lives in a new, zero-import `scripts/model/schema-version.mjs`
  — not in `schema-config.mjs`.** This is the single most load-bearing choice
  here and looks like needless indirection unless the failure mode is spelled
  out. `schema-config.mjs` already imports `schema.mjs` and `workflows.mjs`,
  and both of those call `ambientSchemaOverride()` (from `config.mjs`) **at
  module scope** (`schema.mjs:31`, `workflows.mjs:46`). Defining the guard
  inside `schema-config.mjs` and having `config.mjs` import it from there would
  create the cycle:

  ```
  config.mjs → schema-config.mjs → schema.mjs    → config.mjs
                                 → workflows.mjs  → config.mjs
  ```

  Whenever `config.mjs` is the module graph's entry point, its body starts
  evaluating, reaches that import, and `ambientSchemaOverride()` runs *while
  `config.mjs`'s own `ROOT`/`DEFAULTS` bindings are still in the temporal dead
  zone*. The resulting `ReferenceError` is then swallowed by
  `ambientSchemaOverride`'s own `catch { return null }` — so `TYPES` and
  `WORKFLOWS` silently fall back to the built-in defaults and the board's real
  schema overrides vanish without a word. A guard against silent schema
  wrongness must not itself cause silent schema wrongness.
  `scripts/model/schema-version.mjs` has **no imports at all**, so it cannot
  participate in any cycle; `config.mjs` imports it directly, and
  `schema-config.mjs` re-exports the three symbols so the schema API stays in
  one place. `tests/schema-guard-cycle-regression.test.mjs` pins this — an
  adversarial review proved it fails on the rejected (cycle-creating) design
  and passes on this one.

- The pure guard `checkSchemaVersion(cfg, { current, min })` never throws
  itself; it is enforced in **`loadConfig`** (`scripts/config.mjs`), which
  throws house-style `` `blaze: …` `` — one call site covering the twelve
  entry points that load config.

- **In the six mutating runners (`move`/`edit`/`link`/`log`/`resolve`/`new`),
  the existing `loadConfig` call is hoisted above the mutation, not added
  anew.** Each of these already called `loadConfig` — but only afterward, to
  read `cfg.commitMode` for the commit step. `blaze move`, for example,
  relocated the ticket file via `applyMove` and only then reached
  `loadConfig`, so on a stamped-incompatible board it would move the file and
  *then* throw, leaving the board mutated. A guard whose entire purpose is "do
  not drive a board this engine may misread" must not half-drive it first.
  The fix reorders the existing call rather than adding a second one, so the
  "one call site" property above still holds — only the ordering changed.
  `loadConfig` is a pure read with no dependency on the mutation it now
  precedes.

- **`blaze reindex` and `blaze rollup` are both guarded explicitly**, because
  both resolve roots without loading config, and both are schema-sensitive.
  `reindex` re-validates every ticket against the schema. `rollup`
  (`scripts/rollup-runner.mjs:6`) imports `buildIndex`, which transitively
  pulls in `schema.mjs` and therefore `TYPES` — so it is **not**
  schema-agnostic, despite first appearances. Leaving it unguarded would have
  introduced a regression worse than doing nothing: once `loadConfig` throws
  on a stamped board elsewhere, `ambientSchemaOverride`'s catch-all converts
  that throw to `null`, silently degrading `TYPES` to the built-in defaults —
  a path that was previously silent-*correct* would become silent-*wrong*.
  `blaze commit` genuinely is schema-agnostic (it git-commits an explicit file
  list and never consults the schema) and stays unguarded by design.
  Note `reindex`'s guard validates the stamp at the resolved `dataRoot`, not
  the `projects/` directory it indexes — those normally coincide, but
  `reindex` also accepts an explicit `projects/`-dir argument, and if that
  argument points at a *different* board, the guard checks the wrong board's
  stamp (tracked separately; not addressed by this ADR).

- The error text **names no command** — it points at
  [`docs/schema-versioning.md`](../schema-versioning.md). `blaze migrate` is
  the external-tracker importer; sending a version-mismatched board there
  would be worse than saying nothing.

- **No migrator ships.** At v1 there is nothing to migrate; the PR that first
  ships a breaking schema change ships its migration.

## Alternatives considered

**(a) Semver stamp.** Rejected: the only question the guard asks is "is this
board's contract within the range this engine speaks?" — a total order over
discrete contract revisions. Semver's axes encode distinctions a schema
contract does not have and invite a range-matching dependency a zero-dep
engine should not carry.

**(b) A `blaze schema-migrate` verb (or `blaze migrate --schema`) named in the
error.** Rejected: `blaze migrate` is already taken by the Jira→blaze importer
(with its own disposition ledger and `--live` flag); a new or overloaded verb
would ship a command that exists but cannot act — at v1 there is nothing to
migrate — failing the "simple for an AI to drive" design gate.

**(c) Guard inside `resolveSchema()` (`scripts/model/schema-config.mjs`).**
Looks natural — pure, receives both config layers, and is where a version
*conceptually* belongs — but it is **not wired into runtime**; its only
callers are tests. A guard there would be a well-tested no-op: green in CI,
absent in production. Recorded so a future reader does not "fix" the guard by
moving it there.

**(d) Guard on the ambient import-time path (`schema.mjs`/`workflows.mjs`).**
Rejected: `ambientSchemaOverride()` swallows every error to `null` by design,
and those modules resolve at module import time — a throw there would fire
before any code runs and take out any test process whose ambient config
happened to be stamped. Every path a user actually invokes goes through
`loadConfig` or `reindex`/`rollup`.

**(e) Define the guard directly in `schema-config.mjs`.** This was the
original plan (see design doc D5, amended by D5a). Rejected once verified
against the real import graph: it creates the `config → schema-config →
schema/workflows → config` cycle described above, and the ambient-override
catch-all turns that cycle into exactly the silent-wrongness failure mode the
guard exists to prevent. This is the alternative most likely for a future
reader to "helpfully" reintroduce, since a guard living beside
`resolveSchema()`/`validateSchema()` in `schema-config.mjs` looks like the
obviously tidier home.

**(f) Leave the guard call in the six mutating runners where it already
was (after the mutation).** Rejected once the Task-3 adversarial review
demonstrated the relocate-then-throw behaviour on `blaze move` — a
stamped-incompatible board would end up with a ticket file moved to a new
status directory before the process exited non-zero. Hoisting the existing
call above the mutation fixes this without adding a second guard site.

## Consequences

- With `MIN = CURRENT = 1`, the too-old branch is **unreachable by
  construction** — expected and correct. The constants are injectable
  (`checkSchemaVersion(cfg, { current, min })`) so the branch stays
  unit-tested. The first genuinely breaking schema change bumps
  `SCHEMA_VERSION` to 2 and decides, in that PR with a real migration in hand,
  whether `MIN` follows.
- **Known, accepted gap:** the import-time `TYPES`/`WORKFLOWS` path still
  swallows the guard's throw inside `ambientSchemaOverride()` (pre-existing
  behaviour — it already swallowed the bad-JSON throw; not made worse here).
- An un-versioned legacy board keeps loading forever-until-`MIN`-moves;
  `tests/compat-legacy.test.mjs` pins that contract, and is not modified by
  this decision.
- A future reader should not move `checkSchemaVersion`'s definition into
  `schema-config.mjs` — that reopens the import cycle in alternative (e).
- A future reader should not treat the hoisted `loadConfig` call in
  `move`/`edit`/`link`/`log`/`resolve`/`new` as redundant with a later
  domain-logic call and remove it — the hoist itself *is* the guard for those
  six commands.
- A future reader should not assume `blaze rollup` is schema-agnostic like
  `blaze commit` and drop its guard — `rollup` transitively touches `TYPES`
  via `buildIndex` and would silently compute against the wrong type registry
  otherwise.
