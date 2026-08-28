# ADR-0027 — a provably wrong delivery record is corrected by hand, not by a verb

- **Status:** Accepted
- **Date:** 2026-08-28
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-456

## Context

ADR-0023 makes a ticket's `branch`/`pr` record **write-once**: reconcile is its only
producer, `pr` is not in `EDITABLE_FIELDS`, and a terminal ticket may acquire a record it
never had but may never have one replaced. That rule exists because three earlier shapes
of wrong all came from *rewriting* a record — a done epic delivered by merged PR #80,
silently repointed at the later open #81; then at the latest merge to win a rank
tie-break; then at a follow-up docs PR.

BLZ-440 then narrowed the gate that writes those records, and BLZ-456 asked the obvious
follow-up: which records already on the board were written on evidence the new gate
rejects? Its read-only audit of `BLZ-305-v4-spine` on 2026-08-28 found **534** tickets
with a non-empty `pr:` record, **20** written on rejected evidence, split into 7 "true
downstream mentions" and 13 near-miss punctuation variants. (The board has since drifted:
**591** non-empty `pr:` records at `80dd9ccb`, the ref every figure below is taken at.)

The 13 near-misses are resolved by ADR-0026, not here: ten are `INF-nnn — desc` em-dash
titles, which that decision admits. What was left open is a route — if one is needed — to
correct a record that is *provably* wrong under a write-once rule.

## The seven, adjudicated individually

Each was checked against the PR's live title, body and head ref, against the ticket's own
body and worklog, and against the ticket the PR title actually claims. **BLZ-456's
premise is corrected by this adjudication: one of the seven is corrupt, not seven.** The
other six hold records that are *factually correct* and were merely written by a route the
gate has since closed — the same class as the 13, arriving through a different shape.

| Ticket | Record | PR title | What the PR actually delivered | Verdict |
|---|---|---|---|---|
| **OBA-159** | `#17`, branch `INF-126-backport-oba-159-investigation` | `INF-126: backport investigations template v2 into OBA-159 doc` | INF-126 — a docs-template backport *into* OBA-159's investigation document | **WRONG — correct it** |
| OBA-204 | `#78`, branch `OBA-204-repayments-calculator` | `OBA-91: Repayments calculator (runtime + UI + methodology) — OBA-204/205/206` | OBA-91 **and** its three sub-tasks, OBA-204 among them | Right record, closed route — **leave** |
| OBA-208 | `#80`, branch `OBA-208-fhog-calculator` | `OBA-94: FHOG eligibility calculator … — OBA-208/209/210` | OBA-94 and OBA-208/209/210 | Right record, closed route — **leave** |
| OBA-211 | `#82`, branch `OBA-211-lmi-calculator` | `OBA-93: LMI estimator … — OBA-211/212/213` | OBA-93 and OBA-211/212/213 | Right record, closed route — **leave** |
| OBA-214 | `#85`, branch `OBA-214-stamp-duty-calculator` | `OBA-92: state-aware Stamp Duty calculator … — OBA-214/215/216` | OBA-92 and OBA-214/215/216 | Right record, closed route — **leave** |
| OBA-42 | `#86`, branch `OBA-42-45-editorial-media-closure` | `OBA-6: close editorial-media IAM + CMS deploy ACs (OBA-42, OBA-45)` | OBA-6's two reopened children, OBA-42 and OBA-45 | Right record, closed route — **leave** |
| OBA-625 | `#284`, branch `OBA-625-lockdocs-rels-drift` | `S1 final unblock: OBA-625 rels drift migration + OBA-403 e2e spec sync + redeploy triggers` | OBA-625's rels-drift migration (and OBA-403's spec sync) | Right record, closed route — **leave** |

**OBA-159 is the only genuine corruption, and it is a double-write.** PR #17 adopted the
"investigations template v2" into the *existing* OBA-159 investigation document; it did
not fix the Payload `/admin` hydration crash that OBA-159 is about, which OBA-159's own
two worklog entries (2026-05-24, 60 min + 90 min) describe being debugged separately.
INF-126 — the ticket the title claims — carries the **byte-identical** `branch:` and `pr:`
values, so the same PR is recorded as the deliverer of two different tickets, and its own
worklog note says plainly: *"Backport into OBA-159 investigation doc shipped
(online-broker-agent PR #17)."*

The six others share one shape: the title leads with a **parent or sibling** while the
head ref names the child the record was written on, and the PR body names that child as
delivered. The record went to the right ticket; only the *evidence path* is one the gate
no longer accepts.

**Precisely why each supplies no claim on the record's ticket** — and round 1 got this
wrong, calling all of them "words-before-colon or leading-non-id". Five of the six are
nothing of the kind:

- `OBA-91:`, `OBA-94:`, `OBA-93:`, `OBA-92:` and `OBA-6:` are **valid
  leading-id-with-colon titles that DO claim a ticket** under ADR-0026 — in fact the
  canonical house shape. They simply claim the *parent*, not the child the record sits on.
  The sub-task ids appear only after an em-dash (`— OBA-204/205/206`) or in parentheses
  (`(OBA-42, OBA-45)`), and a downstream mention is never a claim — which is the rule
  ADR-0026 preserves, not one it bends.
- Only **#284** (`S1 final unblock: OBA-625 rels drift migration + …`) is leading-non-id.
- **None** of the six is a words-before-colon shape. That population exists on the board
  (`INF-889 to INF-892: corpus landing`) and is why ADR-0026 rejects the form, but it is
  not what these six are.

The operative conclusion is unchanged: reconcile would not write these records today,
because on each the *branch*-derived id is corroborated by neither the title (which claims
a different ticket) nor a `KEY-n:` commit. It would also not *re*-write them: they are
terminal and the record is write-once.

## Decision

**A provably wrong delivery record is corrected by an operator, by hand, with the evidence
recorded on the ticket. No engine verb is added for it.**

Concretely, for OBA-159: clear `branch:` and `pr:` on the ticket (blank, not repointed —
there is no PR that delivered OBA-159), leave its `done` status and `resolution: done`
alone, leave INF-126's identical record intact because for INF-126 it is correct, and note
the correction and its evidence in OBA-159's body.

**And no route is added for the other six, because they are not wrong.** ADR-0023's
measure-before-changing rule (BLZ-353) applies to corrections as much as to code: six of
seven records here are accurate, and a bulk "fix the 20" pass would have destroyed six
true records to correct one false one.

### Why by hand, and not a verb

- The population is **1 in 591**. A verb is a permanent, always-available route to
  overwrite a write-once record, bought to serve a single case.
- Every previous defect in this field came from an *automated* rewrite winning some
  ranking. Adding `pr` to `EDITABLE_FIELDS`, or a `reconcile --clear-record`, restores
  exactly the capability ADR-0023 removed, and the guard rail that stopped three separate
  bugs would then be one flag away on every run.
- "Provably wrong" is a judgement made from the PR's body and the ticket's own worklog —
  evidence the engine does not read and cannot weigh. A verb would have to take the
  operator's word for it, which is not a route to correctness, only a route to a write.
- The correction is **verifiable after the fact**, which is what makes the manual route
  safe rather than merely permitted. Once OBA-159's record is cleared, reconcile will not
  re-assert it: `idFromRef` does derive `OBA-159` from
  `INF-126-backport-oba-159-investigation`, but PR #17's title claims only INF-126 and no
  `OBA-159:` commit exists on the default branch, so the claim is **uncorroborated** and
  BLZ-440's rule lets an uncorroborated claim hold a ticket back and never advance it —
  no record, no move. `blaze reconcile --ticket OBA-159` (BLZ-451) is the one-ticket way to
  confirm that before trusting it.

## The six unresolvable `form-lab` records

BLZ-456's audit set aside six records it could neither confirm nor refute because the
`hjr15/form-lab` repository's history was reset and the PRs no longer exist. They are
**marked unresolvable here rather than counted as clean**, with their ids named so the
count is not a floating number:

| Ticket | Record |
|---|---|
| INF-316 | `#9 — https://github.com/hjr15/form-lab/pull/9` |
| INF-371 | `#10 — .../pull/10` |
| FL-5 | `#12 — .../pull/12` |
| FL-21 | `#14 — .../pull/14` |
| FL-3 | `#15 — .../pull/15` |
| FL-2 | `#16 — .../pull/16` |

Re-checked at `80dd9ccb` on 2026-08-28: all six tickets still hold those records, and all
six PRs return *"Could not resolve to a PullRequest"* from the forge. Note that four sit
under `FL` and **two under `INF`** — "form-lab" names the repository, not the project key,
and reading it as a project key would miss a third of them. They are left exactly as they
are: unverifiable is not the same as wrong, and clearing a record on the strength of a
deleted history would destroy the only trace of the delivery that remains.

## Consequences

- Nothing in this repository changes. This ADR records an adjudication and a route; the
  board write it authorises is an operator action, applied deliberately and separately,
  against a board this lane treats as read-only.
- The corrected count for BLZ-456 is **1 provably wrong record, not 7** — the ticket's
  own framing is superseded by the adjudication above.
- Reconcile will not reproduce any of these seven records today, for two independent
  reasons: the titles supply no claim under ADR-0026, and every one of the tickets is
  terminal, where the record is write-once regardless.
- Three residuals are noted and deliberately **not** acted on, each ticketable on its own:
  OBA-45 and OBA-403 were each delivered by a PR (#86, #284) that also delivered a ticket
  which *did* get a record, and hold none themselves — an under-record, which is the
  direction ADR-0023 biases toward and which no branch name would let reconcile fill;
  and OBA-625 carries `resolution: done` with unchecked acceptance criteria in its body,
  which is a hygiene finding about the ticket rather than about its delivery record.
