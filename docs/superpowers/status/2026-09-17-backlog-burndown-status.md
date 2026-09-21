# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-21. Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**Phase 1 finished (seven PRs). The 2026-09-17 successor kickoff (`docs/superpowers/plans/2026-09-17-blaze-phases-2-to-5-kickoff.md`) is executing: Lane G (Phase 3a) merged, Lane C PR-1 (format layer) merged, Lane R (Phase 2, all 8 tickets) merged. Lane C PR-2 (the import engine + round-trip gate — the hardest ticket in this campaign) is in flight.** `main` is `1da8e5e`. The board has 15 unpushed commits on `BLZ-305-v4-spine` (blaze-pm is never pushed, per the standing constraint).

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
| #178 | docs: status update | `f044984` | — (docs only) |
| #179 | BLZ-625, 626, 627 (Lane C PR-1, the CSV format layer) | `9680179` | 1 — no merge-blocking defect; 31-column list and encodings independently re-derived from the design doc and matched exactly; one test-discrimination gap (`\r` quoting had no test that could fail) fixed in-branch; six minor findings ticketed as BLZ-644–649 |
| #180 | BLZ-512, 519, 514, 513, 511, 510, 520, 567 (Lane R, the read-path residue) | `1da8e5e` | 1 — merge recommended; both security-sensitive claims (setup-token pre-auth hang, commit-lock lock-theft) independently reproduced and upheld; three minor residuals ticketed as BLZ-650–652 |

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## In flight (this session, 2026-09-20/21)

- **Lane C PR-2** (`BLZ-628-csv-import`, worktree `blaze-worktrees/lane-csv2`) — BLZ-628/629/630/631: the import plan (pure classification), the apply (the seven-step write sequence, the receipt, exit codes 0–5), the round-trip gate (three sub-gates), and the blanking-revert test that proves gate 2 discriminates. This is the single most complex PR in the whole campaign — dispatched to opus, paused once already on a session rate limit and resumed in place (per the kickoff's §0 continuity contract: a rate limit is a pause, not completion). Not yet reviewed or merged.
- A board pass for Lane R's eight tickets (move to `done`, log time, reconcile; BLZ-567 needs special handling since it was only partially delivered — infra E2E deferred with a written reason at `docs/reports/2026-09-20-blz-567-infrastructure-test-gap.md`) was dispatched this session.
- Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide).

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal — every callee shape its tests name, Node's own module resolution, the package root — and round 12 then planted eleven *more* shapes that still wrote green. At that point I invoked the plan's stop rule rather than start round 13.

**What shipped:** the guard as a ratchet, with its three open classes stated verbatim in the file's own banner instead of claimed closed, plus one genuine new fix (Node 24 type-strips, so `.ts`/`.mts`/`.cts` helpers were never scanned at all — now an unparseable typed file is an offence in itself, fail-closed). The predecessor it replaces sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain; it is not a proof.

**BLZ-642** is the successor ticket, est 240, quoting the three classes from the merged file and carrying ten planted shapes as acceptance criteria — each one measured as a real write with the guard green on the pre-merge tip.

## Board

- `BLZ-305-v4-spine`, 15 commits ahead of origin, working tree clean, **not pushed**.
- BLZ-639/638/637/641 (Lane G) and BLZ-625/626/627 (Lane C PR-1) are `done`. A board pass for BLZ-512/519/514/513/511/510/520/567 (Lane R) was dispatched this session — check its outcome before trusting those seven as `done` and see its BLZ-567 disposition specifically (partial delivery, likely needs its own follow-up ticket or a documented-remainder note rather than a bare `done`). BLZ-587 stays open deliberately: its design merged, its build (Lane C) is now roughly half landed.
- **Filed prior session:** BLZ-609–612, 614–616, 617–619 (PR-review residuals); BLZ-620–623 (#170); BLZ-624 (sign-in per-source ceiling, security/high); BLZ-625–641 (the whole Phase 3 build set + §8 gaps); BLZ-642 (seam successor).
- **Filed this session:** BLZ-643 (Lane-G review, hollow test, parented BLZ-632, `Relates` BLZ-634); BLZ-644–649 (Lane-C-PR-1 review: unattributed crash on scalar frontmatter value, export doesn't self-validate against its own schema, a lone-quoted-empty-row parse bug, BOM/data-after-quote leniency, silent project-mismatch drop, sort-tie/collation gap); BLZ-650–652 (Lane-R review: `readOwner`'s EACCES-to-null lock-theft gap, edit/new's raw-stack-trace presentation gap, BLZ-520's prose-only reachability pin).
- A board-wide reconcile sweep ran in a prior session and applied 17 status moves + 39 branch/PR backfills, each verified against a real merged PR across five repos. One decline still outstanding, unchanged, blocked on the operator: **OBA-154** is marked SUPERSEDED in its own body and reconcile wanted to move it to plain `done` — it needs a deliberate `blaze resolve`, not a bare move.
- Also flagged (prior session, unchanged): `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing); two applied moves (INF-247, OBA-812) add to it, both evidenced against the parent's own scope.

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 1.5 (kickoff Phase 3a). Lane G record corrections | **Done.** PR #177 merged as `44b797f`. BLZ-639/638/637/641. |
| 2. Test gap — BLZ-567 (infra E2E) + Lane R (BLZ-512, 519, 514, 513, 511, 520, 510) | **Merged.** PR #180 merged as `1da8e5e`. Board pass for the ticket moves in flight (see above) — BLZ-567 needs special handling, it's a partial delivery. Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide). |
| 3. CSV import | **PR-1 (format layer, BLZ-625/626/627) merged as `9680179` (#179).** PR-2 (BLZ-628–631, the import engine + round-trip gate) **in flight** in worktree `blaze-worktrees/lane-csv2` — the hardest ticket in this campaign, dispatched to opus, already paused once on a rate limit and resumed. PR-3 (BLZ-634–636, the mapping layer), PR-4 (BLZ-640/633, lock + markdown) not started — each depends on the previous PR merging. |
| 4. DB cutover — BLZ-254 | **Not started.** |
| 5. Retire blaze-pm | **Not started.** |

## Next

Once Lane C PR-2 is done, review it (separate worktree, agent that didn't write the branch, per the kickoff's constraint 3) and merge. Then Lane C proceeds to PR-3 (BLZ-634–636, cut from the then-current main). Lane T can start once phases 2 and 3's lanes have landed and ~1/3 of context remains — check both conditions before starting it, since a half-done corpus-wide test sweep is worse than none. Update this file again after each merge, per the kickoff's continuity contract.
