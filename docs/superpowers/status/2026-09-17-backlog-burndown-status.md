# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-22 (later same day). Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**Phase 1 finished (seven PRs). Phase 2 (Lane R) fully merged. Phase 3's PR-1, PR-2, and a small follow-up fix (BLZ-654) all merged. PR-3 (the mapping layer — where ADR-0037's "a proposal, never an import" boundary becomes a tested property) is in flight.** `main` is `e981b8e`. The board has 19 unpushed commits on `BLZ-305-v4-spine` (blaze-pm is never pushed, per the standing constraint).

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
| #181 | docs: status update | `a93572f` | — (docs only) |
| #182 | BLZ-628, 629, 630, 631 (Lane C PR-2, the import engine + round-trip gate) | `e01b092` | 1 — no merge blockers; independently confirmed a genuinely valuable headline finding (design §5.1's stated SIGKILL invariant pair is structurally insufficient on its own; this PR's own third assertion correctly closes it) and a real gap in already-merged export code (a link with no target exports as literal `Relates:undefined`); four residuals ticketed as BLZ-654–657, none blocking |
| #183 | docs: status update | `de8cd0f` | — (docs only) |
| #184 | BLZ-654 (export-side link-refusal gap, already-merged PR-1 code) | `e981b8e` | 1 — upheld, discrimination independently confirmed by the reviewer; one finding (the refusal didn't name the ticket, contradicting the exact design row it cites as authority) fixed in-branch before merge |

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## In flight (this session, 2026-09-20/22)

- **Lane C PR-3** (`BLZ-634-mapping-layer`, worktree `blaze-worktrees/lane-csv3`) — BLZ-634/635/636: the mapping file format + deterministic apply + `blaze import repair` (the dominant cost, 240 of 240 min on BLZ-634 alone), the mapping proposer that spawns an external agent command (BLZ-635), and the boundary guard that makes "no model runs on the deterministic import path" a tested property via PATH-shadowed sentinel stubs (BLZ-636). Dispatched to opus given its complexity and the security-relevant boundary it has to prove. Not yet reviewed or merged.
- Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide).

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal — every callee shape its tests name, Node's own module resolution, the package root — and round 12 then planted eleven *more* shapes that still wrote green. At that point I invoked the plan's stop rule rather than start round 13.

**What shipped:** the guard as a ratchet, with its three open classes stated verbatim in the file's own banner instead of claimed closed, plus one genuine new fix (Node 24 type-strips, so `.ts`/`.mts`/`.cts` helpers were never scanned at all — now an unparseable typed file is an offence in itself, fail-closed). The predecessor it replaces sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain; it is not a proof.

**BLZ-642** is the successor ticket, est 240, quoting the three classes from the merged file and carrying ten planted shapes as acceptance criteria — each one measured as a real write with the guard green on the pre-merge tip.

## Board

- `BLZ-305-v4-spine`, 19 commits ahead of origin, unpushed, working tree clean.
- BLZ-639/638/637/641 (Lane G), BLZ-625/626/627 (Lane C PR-1), BLZ-512/519/514/513/511/510/520/567 (Lane R, including BLZ-567's split — delivered part `done`, deferred part spun off as **BLZ-653**, mirroring the BLZ-140/INF-749 precedent), BLZ-628/629/630/631 (Lane C PR-2), and BLZ-654 (the export-link-refusal fix) are all `done`. BLZ-587 stays open deliberately: its design merged, PR-1/PR-2/BLZ-654 of its build have landed, PR-3 is in flight.
- **Filed prior sessions:** BLZ-609–612, 614–616, 617–619 (PR-review residuals); BLZ-620–623 (#170); BLZ-624 (sign-in per-source ceiling, security/high); BLZ-625–641 (the whole Phase 3 build set + §8 gaps); BLZ-642 (seam successor); BLZ-643 (Lane-G review, hollow test); BLZ-644–649 (Lane-C-PR-1 review); BLZ-650–652 (Lane-R review); BLZ-653 (Lane-R, BLZ-567's deferred scope); BLZ-654–657 (Lane-C-PR-2 review — 654 is now `done`, see above; 655/656/657 still open, low-priority doc/test-machinery follow-ups, not blocking anything).
- A board-wide reconcile sweep ran in a prior session and applied 17 status moves + 39 branch/PR backfills, each verified against a real merged PR across five repos. One decline still outstanding, unchanged, blocked on the operator: **OBA-154** is marked SUPERSEDED in its own body and reconcile wanted to move it to plain `done` — it needs a deliberate `blaze resolve`, not a bare move.
- Also flagged (prior session, unchanged): `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing); two applied moves (INF-247, OBA-812) add to it, both evidenced against the parent's own scope.
- **Mechanism note for future board passes on this campaign — genuinely unresolved, do not trust any single prior claim:** three independent board-pass agents have given THREE DIFFERENT answers about whether `blaze reconcile` supports `--project`/`--ticket` scoping flags on this installed engine: the Lane-R pass said the flag doesn't exist; the Lane-C-PR-2 pass used `--project BLZ --ticket <ids> --apply` successfully; the BLZ-654 pass got "unknown flag" on both `--project` and `--ticket`. This has not been reconciled — it may be a stale/inconsistent local install, a difference in how each agent invoked it, or something else. **Do not assume either way.** Before relying on scoped reconcile, run a DRY RUN first (no `--apply`) and verify with your own eyes that it proposes exactly the intended tickets and nothing else — if the flags error, or the dry run's proposed set includes anything unexpected, fall back immediately to the direct `blaze move` verb sequence (defined → in-progress → in-review → done), which has worked reliably on every board pass in this campaign regardless of reconcile's behavior that day.

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 1.5 (kickoff Phase 3a). Lane G record corrections | **Done.** PR #177 merged as `44b797f`. BLZ-639/638/637/641. |
| 2. Test gap — BLZ-567 (infra E2E) + Lane R (BLZ-512, 519, 514, 513, 511, 520, 510) | **Done.** PR #180 merged as `1da8e5e`, board pass complete (see Board section — BLZ-567 split, BLZ-653 filed for the deferred remainder). Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide). |
| 3. CSV import | **PR-1 merged as `9680179` (#179). PR-2 merged as `e01b092` (#182) — the hardest ticket in this campaign, survived two rate-limit pauses and resumed cleanly both times. BLZ-654 (export-side link-refusal gap in PR-1 code, found by PR-2's review) fixed and merged as `e981b8e` (#184), including one in-branch fix from its own review (ticket attribution).** PR-3 (BLZ-634–636, the mapping layer) **in flight** in worktree `blaze-worktrees/lane-csv3`, dispatched to opus. PR-4 (BLZ-640/633, lock + markdown) blocked on PR-3. |
| 4. DB cutover — BLZ-254 | **Not started.** |
| 5. Retire blaze-pm | **Not started.** |

## Next

Once PR-3 is done, review it (separate worktree, agent that didn't write the branch, per the kickoff's constraint 3) — this PR proves (or doesn't) that "no model runs on the deterministic import path" is a real, tested property, so scrutinize BLZ-636's boundary guard especially hard. Then merge and proceed to PR-4 (BLZ-640/633). Lane T can start once PR-3 and PR-4 land and ~1/3 of context remains — check both conditions before starting it, since a half-done corpus-wide test sweep is worse than none. Update this file again after each merge, per the kickoff's continuity contract.
