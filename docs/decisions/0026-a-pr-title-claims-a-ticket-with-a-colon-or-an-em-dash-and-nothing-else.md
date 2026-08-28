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

### Round 1 measured the wrong repositories, and the excuse was a category error

The first version of this ADR measured `blaze` (237 → 237) and `blaze-pm` (99 → 99),
found no change, and excused it with *"the population it exists for lives in
`docs-central`, which is a codeRepo of neither."* **Both figures reproduce. The excusing
clause is false.** The relation is project→codeRepo, not repo→repo, and on the live board:

```
projects/INF/project.json → codeRepos: [service-platform, online-broker-agent, form-lab,
                                        claude-config, docs-central, blaze-pm, howman-cloud-site]
projects/CRP/project.json → codeRepos: [docs-central, howman-cloud-site]
```

`docs-central` is a configured codeRepo of **two live projects**. "Neither" was only ever
true of the two *repositories* that had been measured, and reading it as "no project is
affected" is what let two true figures carry a false conclusion. This is recorded rather
than quietly corrected because the failure was in the *scope* of the measurement, not in
its arithmetic — the same shape of error the engine's own comments keep warning about.

### The measurement, redone across every project and every codeRepo

Harvested exactly the way `gatherProject` unions them: for each project key, over each
codeRepo it configures, at each repo's default-branch ref. 14 repositories, board config
at blaze-pm `80dd9ccb`.

The board has **eleven** project keys and only **ten** of them are measurable here
(BLZ-488). `projects/STA/project.json` configures **no `codeRepos` key at all**, so
`gatherProject` unions nothing for it: it is 0 → 0 under both rules, and it could not have
moved whatever the decision had been. It carried no row at all in the version this ADR
shipped with, which left the reader to reconcile ten rows against the "all 11 keys" that
appears further down; it now carries an explicit **`no codeRepos`** row rather than a
0 → 0 one, because a zero would claim a repository was searched and nothing found. The
TOTAL is a sum over the ten keys that configure a repo, and STA changes it by nothing.

| Key | before | after | Δ | | Key | before | after | Δ |
|---|---|---|---|---|---|---|---|---|
| ACA | 6 | 6 | 0 | | NCA | 16 | 16 | 0 |
| BLZ | 237 | 239 | **+2** (manifest) | | OBA | 465 | 465 | 0 |
| CRP | 41 | 41 | 0 | | OMA | 23 | 23 | 0 |
| FL | 1 | 1 | 0 | | SN | 4 | 4 | 0 |
| INF | 453 | 475 | **+22** (em-dash) | | STA | — | — | no codeRepos |
| KPA | 24 | 24 | 0 | | **TOTAL** | **1270** | **1294** | **+24** |

- **The em-dash widening harvests +22 ids, all under INF**, every one of them from
  `docs-central` at `98f2fa8` (421 commits). CRP: **+0**, despite also configuring
  `docs-central` — none of those subjects carries a CRP key.
- Measured against `docs-central` in isolation the same delta reads **INF 210 → 232**;
  against INF's full seven-repo union it reads **453 → 475**. Same +22, two denominators,
  and the union is the one `gatherProject` actually computes.
- The manifest form's **+2** on `blaze` (BLZ-414, BLZ-458) is unchanged from round 1.

### It compounds — the widening is not subject-only

Only **10 subjects** newly qualify. They yield **22 ids**, because a qualifying subject
also unlocks `idsFromCommitMessage`'s body-manifest reader for that commit, and its
column-0 `* KEY-n:` bullets supply the other **12**. Round 1 described the widening as
though it stopped at the subject line. It does not, and the split is exactly:

| | count |
|---|---|
| subjects newly qualifying (`INF-231 — Tag taxonomy…`, `INF-326 — Diagram quick-wins…`, `INF-208 — Health subject…`, …) | 10 |
| id-slots those subjects name | 11 |
| **distinct** ids from those subjects (INF-231 is named twice) | 10 |
| **further ids unlocked from those commits' body bullets** | **12** |
| total | **22** |

**"10 subjects, 10 ids" is not an identity, and reading it as one is the mistake this row
now prevents** (BLZ-488). The subject→id relation is not 1:1 in either direction, and the
10 = 10 is an arithmetic coincidence of two offsetting facts:

- `93306cbf` — `INF-319 + INF-231 — diagram audit + tag taxonomy proposal (#116)` — is a
  **list** subject and claims **two** ids, so ten subjects name eleven id-slots.
- `69607d34` — `INF-231 — Tag taxonomy: ADR-0002 + full personal-notes tagging sweep
  (#118)` — claims **INF-231** independently, so one of those eleven slots is a repeat and
  the distinct count falls back to ten.

The `+22` is unaffected either way: `idsFromCommitMessage` already dedupes within a commit,
and the harvest is a set across commits. The point is that a future reader must not infer
"one subject, one ticket" from the row, because the em-dash rule inherits the whole `/ + , &`
list grammar and a bundle subject claiming several ids is the normal case, not the odd one.

The two halves map cleanly onto the board: **the 10 distinct subject ids are exactly the 10
that already hold a `pr:` record** (INF-193, 208, 226, 231, 232, 238, 241, 318, 319, 326 —
each has its own branch and merged PR; INF-231's record points at #118, the PR whose subject
claims it alone), and **the 12 body-bullet ids are exactly the 12 that hold none** (INF-194,
209–213, 320–325) — bundled children with no branch or PR of their own, which is the case
the shipped signal exists for.

**There IS a second dedup, and an earlier draft of this section denied it.** The raw
body-bullet harvest is **15** distinct ids, of which **3 — INF-193, INF-231, INF-241 — also
appear as subject ids**: `69607d34` names INF-231 in its subject *and* carries 33
`* INF-231:` bullets, and `a4511002` / `e15b854c` do the same for INF-241 and INF-193. So the
12 is the residue of deduplicating 15 against the 10, not two naturally disjoint sets. The
`+22`, the `12` and both id lists are unaffected; the reassurance was wrong. It is recorded
here rather than deleted because the sentence it replaces was the same defect this ADR exists
to remove — an unverifiable claim of tidiness attached to a correct figure — restated one
paragraph after the correction.

### Can the widening newly WRITE a record? Two paths answer differently, and a third is guarded

All 22 are terminal (`done`), so **no ticket moves**. But ADR-0023 permits a terminal
ticket to *acquire* a record it never had, and 12 hold none — so the question is real.
Two of them reach that write and they answer **differently**; a third is blocked by a guard
named below. The first two are settled by running
`reconcile` against a real board and reading the ticket back off disk
(`tests/reconcile-title-claim-oracle.test.mjs`), not by reasoning from the rules:

**A third path exists and is blocked only by a guard worth naming.** `buildBranchMap` carries
its own `shippedSet && shippedSet.has(id)` corroboration, so a wider set newly admits a
*branch*. On a terminal ticket that is blocked by terminal-sticky nulling both fields — which
is why the conclusion for the twelve holds — but on a NON-terminal ticket the same arm writes
`branch:` and moves the ticket to `in-progress`. The enumeration below is safe **because of**
that guard, not in spite of needing it.

- **Shipped alone — REFUTED.** `decide`'s `shipped` arm sets neither `branchVal` nor
  `prVal`, and on a terminal ticket it is not even reached: with no pr and no branch the
  chain falls through to the `skip` return. A bundled child recovered by a wider
  `shippedSet` moves nothing and records nothing. Pinned by *"PATH 1 REFUTED: a TERMINAL
  record-less ticket recovered by shipped alone acquires NO record"*, with a premise test
  proving the em-dash signal really did arrive (it moves the same ticket when it is
  non-terminal) so the assertion cannot pass vacuously.
- **Shipped as corroboration — REAL.** `claimCorroborated`'s *first* arm is
  `shippedSet.has(id)`. Enlarging that set promotes a weak-titled MERGED PR from
  uncorroborated — which may never write — to corroborated, which may fill an *absent*
  record on a terminal ticket. So the widening **can** newly write a delivery record, by
  a route round 1 never named. Pinned by *"PATH 2 REAL: a wider shippedSet CORROBORATES a
  weak-titled merged PR, which then fills the absent record"*, with a hyphen-instead-of-
  em-dash control that is identical in every other respect.
- Write-once still holds: a wider `shippedSet` may fill an absent record, never repoint a
  held one. Pinned separately.

**Live exposure of path 2 today: none.** Of `docs-central`'s **204** pull requests, **0**
have a head ref deriving any of the 12 record-less ids, so there is no PR for the enlarged
`shippedSet` to promote. The path is live but untriggered, and that is a fact about
today's forge state rather than a property of the design — a future PR on a branch named
for one of those 12 would trigger it.

**On the ~64 existing merged PRs:** nothing is rewritten. Going forward, the 10 em-dash
titles supply a title claim where they previously supplied none; the other ~54 continue to
supply no title signal and fall back to `shippedSet`, which is the correct answer for
every one of them — each either names a range, or names a parent while delivering a child.
BLZ-456's 13 near-miss records become valid under this decision, and its 7 true downstream
mentions are adjudicated separately in ADR-0027.

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
  subject. Rejected on measurement — and the measurement was cited wrongly in round 1,
  which said the subject gate "takes the harvested id count from **63 to 3**". It does
  not. `reconcile.mjs`'s own comment reads *1,323 ids ungated, 63 with the subject gate
  alone, 3 with both*, so **63 → 3 is the column-0 marker's contribution with the gate
  already on**; the gate's own contribution is **1,323 → 63**.

  Re-derived here as a full 2×2 at blaze-pm `ff5f36c2` (156 commits, all 11 keys), on the
  basis that makes those three figures self-consistent — they are **marginal** counts, ids
  the *body* contributes beyond what the subjects already named, which is why the original
  names exactly three ids for the "both" cell:

  | | marker OFF | marker ON |
  |---|---|---|
  | **gate OFF** | 1,323 | 110 |
  | **gate ON** | 63 | **3** (BLZ-259, INF-672, INF-701) |

  The three named ids reproduce exactly, and the gate-ON/marker-OFF cell is **63** — the
  figure `reconcile.mjs`'s own comment has carried all along. An earlier draft of this ADR
  put 65 there and explained the gap as landing "within 2" of the comment. That was wrong,
  and wrong in the way this whole record is about: it presented a **definitional
  divergence as measurement noise.** 65 is reachable only under a marker-OFF rule that
  drops the bullet requirement entirely (`^(?:[*+-]\s+)?KEY-n:`), which admits two
  *wrapped prose lines* that are not bullets at all — `INF-707: CronJobLastRunFailed pages
  for a suspended CronJob (pre-existing to the` and `INF-708: guard the
  annotation-vs-expr invariant in CI. I2 (a widened selector whose`, both under subject
  `INF-693: deploy-path observability epic (board) (#24)`. **Every bullet-based definition
  gives 63.** The marker-OFF rule is therefore stated here explicitly: a body line counts
  only as a column-0 bullet.

  So: the **subject gate** is worth **1,323 → 63** and the **column-0 marker** a further
  **63 → 3**. Dropping the gate would readmit **1,260** ids — the board carries
  squashed PRs of ticket-*body* edits (`blaze: … board + ticket work`) whose bullets are
  real `KEY-n:` subjects describing an edit rather than a delivery. The conclusion is
  therefore *better* supported than the misattributed figure suggested, and it is robust
  across every basis computed (totals rather than marginals, and "any mention" rather than
  `KEY-n:` for the loose body rule, all give the same ordering). The manifest form unblocks
  the early return the way the return was designed to be unblocked: by making the bundle
  subject claim its leading id.

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
  moves a bundled child, and unlocks the body manifest for its own commit. Measured at
  **+22 ids under INF** (10 subjects, 12 compounded body bullets) and +0 everywhere else;
  all 22 already terminal, so nothing moves today.
- A wider `shippedSet` is also a wider *corroboration* set, which is the one way this
  decision can newly write a write-once record. Tested, not assumed — see the two paths
  above.
- This supersedes nothing. It refines the convention ADR-0023 depends on and leaves
  ADR-0023's write-once and not-shipped-bias rules exactly as they are.
