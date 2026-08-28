# ADR-0026 — a title claims a ticket with a colon or an em-dash, and nothing else

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-455 (the decision), BLZ-453 (the pin), BLZ-469 (the bundle form)

## Context

ADR-0023 makes reconcile's records write-once and biases its signals toward *not*
shipped. BLZ-440 narrowed one of those signals — PR-title corroboration — to the house
convention: a title claims a ticket only when it **opens** with `KEY-n` followed by `:`
(with the `/`, `+`, `,`, `&` list forms). Before that, the gate was
`new RegExp("\\b" + id + "\\b", "i").test(title)` — a bare *mention* anywhere in the
title — and `\bBLZ-408\b` matches inside `BLZ-408..439`, so PR #140 (`docs: successor
kickoff for the BLZ-408..439 follow-up lane`) corroborated its own range expression and
proposed `BLZ-408: defined → done` for a ticket that had never been worked.

The narrowing was right and is not being reopened. What it exposed is that real
deliveries on the live board do not all follow the convention. BLZ-455's audit found
**~64 merged PRs** carrying a shape the gate rejects, which makes it routine for those
authors rather than an aberration:

| Shape | Example | Count |
|---|---|---|
| `KEY-n — desc` (em-dash) | `INF-327 — Author the 3 Excalidraw-flagged diagrams` | 10, all in `docs-central` |
| `KEY-n <words>: desc` | `INF-889 to INF-892: corpus landing` | ~54 |
| `feat(KEY-n):`, `[KEY-n]`, `KEY-n desc`, `Revert "KEY-n: …"`, `WIP: KEY-n: …` | — | the remainder |

BLZ-456 separately found **20** of the board's **534** non-empty `pr:` records were
written on evidence this gate now rejects, of which **13** are near-miss punctuation
variants that are factually correct records.

There is a second, adjacent question the convention had never answered: how a title names
**many** tickets. PR #144 delivered sixteen and was titled `BLZ-414 + 15 more: the
oracles are non-vacuous`. After `+` the key must be repeated, so `15` is not `BLZ-15`,
the head match fails, and the subject claims **nothing** — not even BLZ-414. Reconcile
moved none of the sixteen and said nothing about it; all sixteen were hand-moved through
statuses the `blaze` skill otherwise forbids touching by hand.

This is a decision and not a bug fix, and it must not be made by quietly widening a
regex: `idsFromSubject` is the **same** predicate the shipped-commit signal uses, so
widening it for titles widens that too.

## Decision

**A title or commit subject claims a ticket when it opens with `KEY-n` immediately
followed by `:` or `—` (U+2014 EM DASH). Nothing else claims anything.**

An em-dash immediately after the id is an unambiguous **separator**, exactly like the
colon: there is no reading of `INF-327 — Author the three diagrams` on which the title is
about anything but INF-327. The existing list forms (`/`, `+`, `,`, `&`, with the key
repeated after all but `/`) are unchanged and end at either terminator.

**Words between the id and the colon stay rejected, and that is the load-bearing half of
this decision.** `INF-889 to INF-892: corpus landing` is a real merged PR title.
Admitting words-before-colon would make it claim INF-889 — which is a **range**, and
therefore precisely the defect BLZ-440 exists to stop, readmitted through the front door.
The same applies to `OBA-809 backfill + OBA-811: …` and `CRP-51 (bundle 3/3): …`.

Also rejected, explicitly: `feat(KEY-n):`, `[KEY-n]`, `KEY-n desc`, `Revert "KEY-n: …"`,
`WIP: KEY-n: …`, `KEY-n and KEY-m:`, and **every dash that is not U+2014** — en-dash
(U+2013), hyphen-minus, minus sign (U+2212), horizontal bar (U+2015), `--`. One code
point was decided; its neighbours are not it.

**And a bundle gets a manifest form:** `KEY-n + N more: desc` claims `KEY-n` from the
subject and nothing else; the squash body's `* KEY-m:` bullets at column 0 claim the
rest, through the manifest reader `idsFromCommitMessage` already has. `N` is a **count**
and is never read as an id — it sits exactly where a bare list element sits after `/`,
and reading it as one would claim a ticket that does not exist. A range still claims
nothing under this form: `BLZ-408..439 + 15 more:` fails the head match on the `..`
before the manifest tail is reached, and `BLZ-408 + 15 others:` — a bundle marker Blaze
does not know — claims nothing at all rather than silently falling back to its leading
id.

## Blast radius, stated

`idsFromSubject` is the same predicate the **shipped-commit** signal runs over a commit
subject, so this widens that signal by exactly the em-dash case too. That is accepted and
intended: an em-dash-separated commit subject claims its ticket as plainly as a
colon-separated one.

Measured before the flip (BLZ-353's rule), by running the old and new predicates over
every commit message on each default branch and diffing the harvested id sets:

| Repository | Ref | Commits | Keys | Shipped ids before | after the em-dash | after em-dash + manifest |
|---|---|---|---|---|---|---|
| `blaze` | 86619d4 | 337 | BLZ | 237 | **237** | **239** |
| `blaze-pm` | 80dd9ccb | 333 | all 11 configured | 99 | **99** | **99** |

- **The em-dash widening harvests 0 additional ids on either repository.** The population
  it exists for lives in `docs-central`, which is a codeRepo of neither.
- **The manifest form harvests 2**, both from the one commit in 337 whose subject carries
  it (b318d7b, PR #144): BLZ-414 and BLZ-458. A third, BLZ-427, is recovered too but was
  already named by PR #146's spelled-out title.
- That is **three of PR #144's sixteen tickets, not sixteen.** The body manifest is only
  ever as complete as the squash's commit list, and #144 squashed five commits naming
  three tickets. The go-forward contract is therefore a contract on the **author** as
  much as on the parser: a `+ N more` title is a promise that the bundle's commits each
  open with their own `KEY-n:` subject, which is already the house commit rule.

**On the ~64 existing merged PRs:** nothing is rewritten. Going forward, the 10 em-dash
titles supply a title claim where they previously supplied none; the other ~54 continue
to supply no title signal and fall back to `shippedSet`, which is the correct answer for
every one of them — each either names a range, or names a parent while delivering a
child. BLZ-456's 13 near-miss records become valid under this decision, and its 7 true
downstream mentions are adjudicated separately in ADR-0027.

## The silent half, and what now says it

The refusal is correct and is not weakened, but it was **silent**: PR #144 moved nothing
and nothing reported it, so the operator learned by noticing the board had not changed.
Reconcile now raises a `merged-pr-title-claims-nothing` finding — `NEEDS ATTENTION` on
stderr, on every run including dry runs — when a **merged** PR whose branch derives a
ticket's id fails to claim that id in its title, on a **non-terminal** ticket, and
**nothing else corroborated it**. All three conditions are volume control with a reason:
`gh pr list` reads `--state all --limit 1000`, so an unscoped version would emit a line
for every historically non-conventional title in a repository's whole history — the
failure mode reconcile's own comments already argue against ("73 NEEDS ATTENTION lines on
every run would bury the findings that matter"). An **open** uncorroborated PR is
BLZ-130's veto working as designed rather than a delivery that failed to land; a terminal
ticket missed nothing; and a ticket a `KEY-n:` commit corroborated *moved*, so its title
gap cost nothing.

## Alternatives considered

- **Enforce the colon and tell the authors.** Rejected: ten real `docs-central`
  deliveries are titled with an em-dash, and there is no ambiguity in that shape to
  protect against. Refusing it buys strictness with no defect prevented.
- **Admit words before the colon**, which would recover ~54 more PRs. Rejected — this is
  the load-bearing half above. It readmits BLZ-440's range defect directly.
- **Read the PR *body* as the bundle manifest.** Rejected, and it stays rejected: it
  widens trust to the forge for a claim that moves a ticket to `done`, and a PR body
  naming a ticket is weaker evidence than a commit demonstrably on the default branch.
  The squash **commit** body is read instead, which is git.
- **Drop `idsFromCommitMessage`'s early return** so a body manifest works under any
  subject. Rejected on measurement: at blaze-pm ff5f36c2 the subject gate is what takes
  the harvested id count from **63 to 3** — the board carries squashed PRs of ticket-*body*
  edits (`blaze: … board + ticket work`) whose bullets are real `KEY-n:` subjects
  describing an edit rather than a delivery. The manifest form unblocks the early return
  the way the return was designed to be unblocked: by making the bundle subject claim its
  leading id.

## Consequences

- `idsFromSubject`'s terminator set is `[:—]` and its head carries an optional, uncaptured
  `+ N more` tail. Ids are extracted from a **capture group** holding the id-list alone,
  so the manifest count can never become an id.
- The title-claim oracle (`tests/reconcile-title-claim-oracle.test.mjs`) carries the
  decided boundary as fixtures **and** as unit assertions: 28 title shapes in the
  cross-product (8 claiming, 17 mentioning-but-not-claiming), plus a named test per half
  of the decision. BLZ-453's finding was that mutating the lookahead from `(?=\s*:)` to
  `(?=\s*[:—])` left all 22 BLZ-440 tests green; the widening now has an exact edge, and
  every neighbour of that edge is pinned.
- Because the shipped signal shares the predicate, an em-dash commit subject now also
  moves a bundled child. Measured at 0 additional ids on both repositories today.
- This supersedes nothing. It refines the convention ADR-0023 depends on and leaves
  ADR-0023's write-once and not-shipped-bias rules exactly as they are.
