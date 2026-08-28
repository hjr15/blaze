# ADR-0025 — a project key is refused, never normalised

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-413

## Context

The same string gets two different answers from the same engine, depending on which verb
sees it first.

- `blaze init --project acme` → exit 0. `planInit` does
  `String(answers.project ?? "").trim().toUpperCase()`, writes `projects: ["ACME"]` into
  `blaze.config.json` and creates `projects/ACME/`. Nothing is printed about the change.
- `blaze new --project acme` → exit 1. `loadProject` calls `assertValidKey`, which refuses
  anything outside `^[A-Z][A-Z0-9]*$`.

So the wizard accepts a value that every subsequent verb refuses, and the operator finds
out at their second command rather than their first. The rule is taught late, by a
refusal, on a board that already exists — and it is taught about a value the operator can
reasonably believe the product accepted, because it did.

Nothing documents the asymmetry. `AGENTS.md`'s configuration section, `docs/guide/commands.md`
and `blaze init --help` all state the shape rule; none of them says the wizard rewrites an
answer that breaks it.

The asymmetry is not a decision anyone made. `KEY_RE` was a private copy inside
`scripts/init.mjs` that guarded only the wizard's `--project` answer; nothing on the
config-load path ran it at all until BLZ-402 moved the definition into
`scripts/config.mjs`. The `.toUpperCase()` predates every load-path check in the engine.
It is a leftover from when the wizard was the only validator, not a convenience anyone
weighed against the refusal it now contradicts.

It is also the only one of its kind. No other surface in this CLI rewrites an operator's
input to make it valid: `--project` on every verb, `BLAZE_KEY`, `blaze.config.json`'s
`key`, and every `projects[]` entry are all refused as typed. `blaze init` is the single
place that answers a wrong value by silently substituting a different one.

## The three options

**Option A — converge on refusal.** `blaze init` stops upper-casing and refuses a key that
is not already in canonical shape, naming the upper-case form as the fix.

**Option B — converge on normalising.** `assertValidKey`, or each load path, upper-cases
before it checks, so `acme` is accepted everywhere.

**Option C — document the asymmetry and change no code.**

## Decision

**Option A.**

### Why not Option B

Normalising on the load path is the more dangerous direction, and it does not stay in one
place.

`cfg.key` is not only matched against — it is *written*. It is interpolated into
`idRegex`, `fileRegex` and `idLineRegex`; it is the prefix stamped into every id
`blaze new` allocates; and it is what `idsFromSubject` matches in a git subject line.
Upper-casing it at load makes the string in `blaze.config.json` and the string the engine
actually runs on two different values. That divergence between the configured key and the
effective key is the exact class of defect BLZ-402 exists to end, reintroduced one layer
up.

It is worse for `loadProject`, whose `key` argument is also a **path segment**
(`join(projectsDir, key)`). Normalising there means the engine looks in `projects/ACME/`
for a directory the operator created as `projects/acme/` — which resolves on a
case-insensitive filesystem and does not on ext4, so the same board would work on one
machine and not another. Option B buys symmetry by making several paths disagree with what
is on disk.

### Why not Option C, which is the cheaper option

Option C costs one paragraph and changes no behaviour, so it has to be argued down on
merits rather than on effort.

It fails twice. First, there is nothing here worth writing down as a contract: the
uppercasing is an accident of history (above), and documenting it would promote a leftover
to a promise the engine then has to keep. Second, and decisively, **a document does not
reach the person it is for.** The operator typing `acme` is running their first-ever
`blaze` command; they are not reading an ADR. The refusal is the only channel that reaches
them at the moment the key is being chosen, and Option A is the option that uses it.

### What Option A costs

Stated plainly, because it is a real cost and it is the whole cost.

- **`blaze init --project acme` now exits 1 where it exited 0.** Anyone scripting
  `blaze init` with a lower-case key gets a refusal instead of a board. This is a
  behaviour change on the first-run path.
- **The operator loses a convenience.** Typing `ENG` rather than `eng` is one keystroke
  more than before. What it buys is that the key the operator typed is the key in
  `blaze.config.json`, the directory under `projects/`, the prefix on every ticket id, and
  the value every later `--project` argument must match — one string, everywhere, chosen
  by them.

Three things keep the cost small, and none of them is a reason the cost is not real:

1. The refusal names the exact replacement — `--project "acme" is not a valid key … did
   you mean "ACME"?` — so the fix is a re-run, not an investigation.
2. `planInit` is pure and collects every error before anything is written (`{ ok, errors,
   plan }`), so a refused `blaze init` leaves no half-board behind. Re-running is safe.
3. It is paid once per board, ever.

### What is deliberately NOT changed

`.trim()` stays. Trimming surrounding whitespace does not change which characters the key
is made of — ` ENG ` and `ENG` are the same key, badly quoted — and `--admin-email`
already trims for that reason. Case is a change to the key itself, which is why it goes
and whitespace does not.

### Measured before shipping, per BLZ-353's lesson

- Live board `blaze-pm` on branch `BLZ-305-v4-spine`: **11** project keys
  (`ACA BLZ CRP FL INF KPA NCA OBA OMA SN STA`), across **2,707** tickets. All 11 conform
  to `KEY_RE`, and so do all 11 directory names under `projects/`.
- Every checked-in fixture board in this repo (`board-gate-good`,
  `board-gate-bad-schema-version`, `board-gate-removed-key`, `board-gate-real-shape`,
  `legacy-board`): **0** carry a key or a `projects[]` entry this refusal would reject.
- Exactly **one** test in the suite pinned the uppercasing
  (`tests/init.test.mjs`, "a project key is upper-cased, and a bad one is refused with an
  example"). It is rewritten by this decision rather than deleted, so the ruling stays
  pinned in the artifact that enforces it.

**0** boards that exist today are refused by this change.

## Consequences

- `planInit` refuses a non-canonical `--project` instead of rewriting it, and the refusal
  names the upper-case form when that is the only thing wrong. `blaze init` and every
  other verb now give the same answer for the same string.
- `KEY_RE` stays the single shared definition in `scripts/config.mjs`. `init.mjs` keeps
  using the predicate form (`KEY_RE.test`) rather than the throwing `assertValidKey`,
  because it collects every error in one pass — a wizard that reports one problem per run
  is a wizard people run four times.
- Every invalid-key refusal in the engine now points here for the reasoning (BLZ-409):
  the message states which value, where it came from, and what shape is expected, and
  links this file for why the shape is exact and why it is never auto-corrected.
- This says nothing about ADR-0002's version guard or ADR-0012's driver selection, and it
  reopens neither. It supersedes nothing.
