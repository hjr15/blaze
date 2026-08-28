# ADR-0027 — preview surfaces and write-record surfaces use different vocabularies

- **Status:** Accepted
- **Date:** 2026-08-29
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-482 (ruling made under BLZ-447; BLZ-481 applied it to two more arms)

## Context

A reconcile pass produces two quantities: how many tickets **moved** status, and how many
were **written without moving** (a resolution backfilled, a delivery record filled or
cleared). Four surfaces state the second quantity, and they do not all use the same words:

| Surface | Kind | Words |
|---|---|---|
| the dashboard toast (`scripts/views/reconcile-summary.mjs`) | preview | `N other update(s)` |
| `reconcile.mjs`'s dry-run tail | preview | `N other update(s)` |
| `applySummary`'s post-apply line (`scripts/reconcile-commit-report.mjs`) | write record | `N ticket(s) updated without a status change` |
| the commit subject `reconcile.mjs` writes | write record | `N ticket(s) updated without a status change` |

BLZ-447 examined that split, found it was not an accident, and ruled it deliberate. But
the ruling was then recorded only in a comment in each of the two modules and in one guard
test. A rule governing four sites across three files, whose whole value is that a fifth
site cannot be added on the wrong side of it, is not adequately recorded in a comment
beside two of them — the next person adds a surface, reads whichever comment they happen
to be near, and has to reconstruct the rule from it. BLZ-482 is that gap.

## Decision

**The vocabulary is chosen by what the surface IS, not by which module prints it.**

- A **preview** surface says `N other update(s)`. A preview is a short parenthetical, read
  immediately beside its own move count, about what *would* happen. "Other" is
  unambiguous there because the thing it is other *than* is the number next to it, and
  brevity is what a parenthetical is for.
- A **write record** surface says `N ticket(s) updated without a status change`. A write
  record is durable and is read alone — in `git log`, or on a terminal scrolled back to
  hours later — with no move count beside it. "Other" names nothing in that setting.

A new surface joins whichever column it belongs to. It does not get a third wording, and
it does not get to pick the shorter one because it is shorter.

## Consequences

- Measured at the time of the ruling: **4 sites, 2 vocabularies**, and no site on the
  wrong side of the split.
- **BLZ-481 applied the rule to two arms that had been stating neither quantity.**
  `applySummary`'s `locked` and `failed` lines said "Ticket file(s) were already written to
  disk" with no number — on the one outcome where the files really are on disk and really
  are not in `git log`, i.e. the case a person has to go and clear by hand. Both now state
  the same two quantities as the other three arms, in the write-record vocabulary.
- All four sites are pinned by name. This ADR is what a fifth site is checked against.
- **BLZ-477 corrected the attribution** those comments carried. Every site was genuinely
  pinned, so the rule could not have lapsed; what was wrong was which test pinned which.
  `COMMITTED_LINE_RE` and `QUEUED_LINE_RE` in `tests/reconcile-change-report-oracle.test.mjs`
  match `res.stdout` — `applySummary`'s own line, driven through the CLI — not
  `reconcile.mjs`'s sites. `reconcile.mjs`'s dry-run tail is pinned by that file's
  `DRYRUN_TAIL_RE`; its commit subject was pinned by an inline unnamed regex, and now by
  `COMMIT_SUBJECT_MOVED_RE` / `COMMIT_SUBJECT_NONMOVED_RE`.
- The dashboard toast and `applySummary` are pinned by
  `tests/board-overstatement-guards.test.mjs`, which asserts each surface uses its own
  vocabulary **and refuses the other's** — a preview that borrows "updated without a status
  change", or a write record that borrows "other update(s)", fails by name.
