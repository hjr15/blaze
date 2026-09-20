# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-20. Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**Phase 1 is finished (seven PRs, see below). The 2026-09-17 successor kickoff (this file's companion, `docs/superpowers/plans/2026-09-17-blaze-phases-2-to-5-kickoff.md`) is now executing: Lane G (Phase 3a) merged; Lane C PR-1 and Lane R (Phase 2/3b) are in flight in parallel worktrees.** `main` is `44b797f`. The board has 12 unpushed commits on `BLZ-305-v4-spine` (blaze-pm is never pushed, per the standing constraint).

## Merged (in order)

| PR | Tickets | Merged as | Adversarial rounds |
|---|---|---|---|
| #168 | BLZ-590 | `a1f5fbd` | prior session |
| #172 | BLZ-531 | `13f661c` | 1 — UPHELD |
| #175 | BLZ-608, 597, 558, 602 | `67114bb` | 2 — UPHELD |
| #170 | BLZ-534, 601, 603 | `54a136d` | 4 — UPHELD, 4 residuals ticketed |
| #174 | BLZ-571, 570, 578, 613 | `af19a91` | 3 — UPHELD, 1 residual ticketed |
| #173 | BLZ-587 (design + ADR-0037) | `27ba2d0` | 9 — UPHELD, 8 wording residuals ticketed |
| #169 | BLZ-535, 521, 537 | `8d94fff` | 11 — **merged with residuals**, see below |
| #176 | docs: successor kickoff + prior status doc | `a269abc` | — (docs only) |
| #177 | BLZ-639, 638, 637, 641 (Lane G, Phase 3a) | `44b797f` | 1 — code UPHELD; one self-inflicted design-doc staleness finding fixed in-branch before merge; one hollow-test finding (`torn-line-parked-recovery.test.mjs`) ticketed as BLZ-643 rather than fixed-and-re-reviewed |

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## In flight (this session, 2026-09-20)

- **Lane C PR-1** (`BLZ-625-csv-format`, worktree `blaze-worktrees/lane-csv`) — BLZ-625/626/627, the CSV format/schema/export layer. Implementation dispatched, not yet reviewed or merged.
- **Lane R** (`BLZ-512-read-path-residue`, worktree `blaze-worktrees/lane-r`) — BLZ-512/519/514/513/511/510/520/567, the read-path residue. Implementation dispatched, not yet reviewed or merged. BLZ-512's site list is being re-derived live per its own ticket instruction ("do not trust the ~20 count"); BLZ-567's k8s-E2E scope may be partially deferred with a written reason if cluster/helm infra isn't available in this environment.
- Both run in parallel per the kickoff's §3 (disjoint file ownership: Lane C owns `scripts/model/csv*.mjs`/`export-rows.mjs`/the design doc; Lane R owns `setup-token.mjs`/`audit-runner.mjs`/`config.mjs`/`serve.mjs`/`views/**`/`commit-lock.mjs`).
- Lane G's board pass (moving BLZ-639/638/637/641 to done, logging time, reconcile) was also dispatched this session; BLZ-643 (the Lane-G review follow-up ticket) is already filed and confirmed on the board.

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal — every callee shape its tests name, Node's own module resolution, the package root — and round 12 then planted eleven *more* shapes that still wrote green. At that point I invoked the plan's stop rule rather than start round 13.

**What shipped:** the guard as a ratchet, with its three open classes stated verbatim in the file's own banner instead of claimed closed, plus one genuine new fix (Node 24 type-strips, so `.ts`/`.mts`/`.cts` helpers were never scanned at all — now an unparseable typed file is an offence in itself, fail-closed). The predecessor it replaces sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain; it is not a proof.

**BLZ-642** is the successor ticket, est 240, quoting the three classes from the merged file and carrying ten planted shapes as acceptance criteria — each one measured as a real write with the guard green on the pre-merge tip.

## Board

- `BLZ-305-v4-spine`, 12 commits ahead of origin, working tree clean, **not pushed**.
- Everything merged is `done` (a board pass to move BLZ-639/638/637/641 to `done` was dispatched this session — see "In flight" above; check its outcome before trusting this line literally). BLZ-587 stays open deliberately: its design merged, its build is now in flight (Lane C).
- **Filed prior session:** BLZ-609–612, 614–616, 617–619 (PR-review residuals); BLZ-620–623 (#170); BLZ-624 (sign-in per-source ceiling, security/high); BLZ-625–641 (the whole Phase 3 build set + §8 gaps); BLZ-642 (seam successor).
- **Filed this session:** BLZ-643 — the Lane-G review's hollow-test finding (`tests/model/torn-line-parked-recovery.test.mjs` guards test-local code only), parented under BLZ-632, `Relates` BLZ-634, to be resolved for real once BLZ-634 (C1) ships.
- A board-wide reconcile sweep ran in the prior session and applied 17 status moves + 39 branch/PR backfills, each verified against a real merged PR across five repos. One decline still outstanding, unchanged, blocked on the operator: **OBA-154** is marked SUPERSEDED in its own body and reconcile wanted to move it to plain `done` — it needs a deliberate `blaze resolve`, not a bare move.
- Also flagged (prior session, unchanged): `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing); two applied moves (INF-247, OBA-812) add to it, both evidenced against the parent's own scope.

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 1.5 (kickoff Phase 3a). Lane G record corrections | **Done.** PR #177 merged as `44b797f`. BLZ-639/638/637/641. |
| 2. Test gap — BLZ-567 (infra E2E) + Lane R (BLZ-512, 519, 514, 513, 511, 520, 510) | **In flight.** Implementation dispatched to worktree `blaze-worktrees/lane-r`, not yet reviewed/merged. Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting). |
| 3. CSV import | **Design merged; PR-1 (format layer, BLZ-625/626/627) in flight** in worktree `blaze-worktrees/lane-csv`, not yet reviewed/merged. PR-2 (BLZ-628–631, the import + gate), PR-3 (BLZ-634–636, the mapping layer), PR-4 (BLZ-640/633, lock + markdown) not started — each depends on the previous PR merging. |
| 4. DB cutover — BLZ-254 | **Not started.** |
| 5. Retire blaze-pm | **Not started.** |

## Next

Once Lane C PR-1 and Lane R are each reviewed (separate worktree, agent that didn't write the branch, per the kickoff's constraint 3) and merged: Lane C proceeds to PR-2 (BLZ-628–631, cut from the then-current main), Lane R proceeds to review-and-merge, then Lane T can start if ~1/3 of context remains. Update this file again after each merge, per the kickoff's continuity contract.
