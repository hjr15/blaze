# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-17. Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**Phase 1 is finished. Every PR in this body of work is merged; there are zero open PRs on `blaze`.** `main` is `8d94fff`. The board has 11 unpushed commits on `BLZ-305-v4-spine` (blaze-pm is never pushed, per the standing constraint).

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

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal — every callee shape its tests name, Node's own module resolution, the package root — and round 12 then planted eleven *more* shapes that still wrote green. At that point I invoked the plan's stop rule rather than start round 13.

**What shipped:** the guard as a ratchet, with its three open classes stated verbatim in the file's own banner instead of claimed closed, plus one genuine new fix (Node 24 type-strips, so `.ts`/`.mts`/`.cts` helpers were never scanned at all — now an unparseable typed file is an offence in itself, fail-closed). The predecessor it replaces sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain; it is not a proof.

**BLZ-642** is the successor ticket, est 240, quoting the three classes from the merged file and carrying ten planted shapes as acceptance criteria — each one measured as a real write with the guard green on the pre-merge tip.

## Board

- `BLZ-305-v4-spine`, 11 commits ahead of origin, working tree clean, **not pushed**.
- Everything merged is `done`. BLZ-587 stays open deliberately: its design merged, its build has not started.
- **Filed this session:** BLZ-609–612, 614–616, 617–619 (PR-review residuals); BLZ-620–623 (#170); BLZ-624 (sign-in per-source ceiling, security/high); BLZ-625–641 (the whole Phase 3 build set + §8 gaps); BLZ-642 (seam successor).
- A board-wide reconcile sweep ran and applied 17 status moves + 39 branch/PR backfills, each verified against a real merged PR across five repos. One decline worth your eye: **OBA-154** is marked SUPERSEDED in its own body and reconcile wanted to move it to plain `done` — it needs a deliberate `blaze resolve`, not a bare move. Your call.
- Also flagged: `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing); two applied moves (INF-247, OBA-812) add to it, both evidenced against the parent's own scope.

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 2. Test gap — BLZ-567 (infra E2E) + kickoff Lane R (BLZ-512, 519, 514, 513, 511, 520, 510) + Lane T (BLZ-503, 523, 516, 517, 504, 515) | **Not started.** 14 tickets, ~425 min. #170 landed its precondition. |
| 3. CSV import | **Design merged; build fully ticketed, no code.** BLZ-625–641: A1–A3, B1–B4, C1–C3 under the new mapping-layer story BLZ-632, D1, and five §8 gap tickets. |
| 4. DB cutover — BLZ-254 | **Not started.** |
| 5. Retire blaze-pm | **Not started.** |

## Next

Phases 2 and 3 are both shovel-ready and independent of each other. Phase 3 is the operator's stated priority (CSV as the primary import medium) and its dependency chain is explicit: A1 → A2 → {A3, B1} → B2 → B3 → B4, then C1 → C2 → C3, with D1 after B3.

Per the kickoff's stop rule, a successor kickoff should be written before starting either phase — the plan that governs this session was scoped to Phase 1 and is now spent.
