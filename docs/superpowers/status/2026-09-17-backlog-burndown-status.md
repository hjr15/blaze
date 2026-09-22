# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-22 (later same day). Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**Phases 1 and 2 fully done. Phase 3 (the entire CSV import build, all four PRs, thirteen tickets) is fully merged in code.** `main` is `beac597`. Both of the kickoff's named phases are complete; only Lane T (the test-machinery sweep) and phases 4/5 (out of scope for this session per the kickoff) remain. The board has 21+ unpushed commits on `BLZ-305-v4-spine` (blaze-pm is never pushed, per the standing constraint).

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
| #185 | docs: status update | `cdf83af` | — (docs only) |
| #186 | BLZ-634, 635, 636 (Lane C PR-3, the mapping layer) | `7f8cada` | 1 — no merge blocker; independently verified the two highest-risk items (a conformance fix to already-merged PR-2 code, and the boundary guard's actual proof coverage); one finding (the guard didn't cover the `--mapping`/`repair` verbs this PR itself adds, only the plain import) fixed in-branch before merge; three residuals ticketed as BLZ-658–660 |
| #187 | docs: status update | `7a24960` | — (docs only) |
| #188 | BLZ-640, 633 (Lane C PR-4, import lock + markdown import — the last PR of the CSV build) | `beac597` | 1 — upheld, no fix requested before merge, the cleanest of the four CSV PRs; independently confirmed a genuine latent-bug fix in already-merged `commit-lock.mjs` and that the lock-contention test is a real two-process race (8 consecutive clean runs, ~17x timing margin), not timing-dependent; three residuals ticketed as BLZ-661–663, none blocking |

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## In flight (this session, 2026-09-20/22)

- **The entire Lane C CSV import build is merged in code**: PR-1 (BLZ-625/626/627), PR-2 (BLZ-628/629/630/631), BLZ-654, PR-3 (BLZ-634/635/636), PR-4 (BLZ-640/633) — thirteen tickets (an earlier note in this doc miscounted "sixteen"; corrected), four PRs, four adversarial reviews, each finding at least one real issue and each resulting in either an in-branch fix before merge or ticketed follow-ups.
- **Board correction, this session**: BLZ-625/626/627 (Lane C PR-1's tickets) were found still sitting in `defined/` despite PR #179 having merged sessions ago — the board pass for that PR was accidentally never dispatched. A correction board pass was dispatched this session to close them and re-run the full 13-ticket sanity check; check its outcome before trusting the Board section below as current.
- Lane T (BLZ-503, 523, 516, 517, 504, 515) is next — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide). Both of its preconditions (phases 2 and 3 landed in code) are now met.

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal — every callee shape its tests name, Node's own module resolution, the package root — and round 12 then planted eleven *more* shapes that still wrote green. At that point I invoked the plan's stop rule rather than start round 13.

**What shipped:** the guard as a ratchet, with its three open classes stated verbatim in the file's own banner instead of claimed closed, plus one genuine new fix (Node 24 type-strips, so `.ts`/`.mts`/`.cts` helpers were never scanned at all — now an unparseable typed file is an offence in itself, fail-closed). The predecessor it replaces sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain; it is not a proof.

**BLZ-642** is the successor ticket, est 240, quoting the three classes from the merged file and carrying ten planted shapes as acceptance criteria — each one measured as a real write with the guard green on the pre-merge tip.

## Board

- `BLZ-305-v4-spine`, 21+ commits ahead of origin, unpushed, working tree clean.
- BLZ-639/638/637/641 (Lane G), BLZ-512/519/514/513/511/510/520/567 (Lane R, including BLZ-567's split — delivered part `done`, deferred part spun off as **BLZ-653**, mirroring the BLZ-140/INF-749 precedent), BLZ-628/629/630/631 (Lane C PR-2), BLZ-654 (the export-link-refusal fix), BLZ-634/635/636 (Lane C PR-3), and BLZ-640/633 (Lane C PR-4) are all `done`. **BLZ-625/626/627 (Lane C PR-1) were found NOT done** despite merging sessions ago (the board pass for that PR was accidentally skipped) — a correction pass was dispatched this session; check its outcome before trusting these three as `done`. BLZ-587 stays open deliberately: its design merged, its build is now fully landed across four PRs.
- **Filed prior sessions:** BLZ-609–612, 614–616, 617–619 (PR-review residuals); BLZ-620–623 (#170); BLZ-624 (sign-in per-source ceiling, security/high); BLZ-625–641 (the whole Phase 3 build set + §8 gaps); BLZ-642 (seam successor); BLZ-643 (Lane-G review, hollow test); BLZ-644–649 (Lane-C-PR-1 review); BLZ-650–652 (Lane-R review); BLZ-653 (Lane-R, BLZ-567's deferred scope); BLZ-654–657 (Lane-C-PR-2 review — 654 is `done`; 655/656/657 still open, low-priority, not blocking); BLZ-658–660 (Lane-C-PR-3 review, all open, low/medium-priority, not blocking); BLZ-661–663 (Lane-C-PR-4 review, all open, low-priority, not blocking).
- A board-wide reconcile sweep ran in a prior session and applied 17 status moves + 39 branch/PR backfills, each verified against a real merged PR across five repos. One decline still outstanding, unchanged, blocked on the operator: **OBA-154** is marked SUPERSEDED in its own body and reconcile wanted to move it to plain `done` — it needs a deliberate `blaze resolve`, not a bare move.
- Also flagged (prior session, unchanged): `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing); two applied moves (INF-247, OBA-812) add to it, both evidenced against the parent's own scope.
- **Mechanism note for future board passes — likely resolved, but not fully reconciled with every prior report.** Multiple board-pass agents this campaign gave conflicting answers about `blaze reconcile`'s `--project`/`--ticket` flags (sometimes "doesn't exist", sometimes "worked"). The PR-3 board pass found a strong root-cause lead: `blaze`'s `project.json` sets `codeRepos: ["../blaze"]`, a path resolved relative to the board root — and from the `v4-spine` worktree, `../blaze` resolves to a nonexistent directory (the worktree isn't laid out like the main `blaze-pm` checkout). This matches a documented defect, INF-763 ("blaze reconcile is a silent no-op from a worktree", see `node_modules/@hjr15/blaze-board/AGENTS.md`) — reconcile from this worktree may scan zero repos and report "already in sync" regardless of real state, indistinguishable from a genuine no-op. This does NOT cleanly explain the one board pass (Lane C PR-2's) that reported reconcile actively moving tickets with backfilled `branch:`/`pr:` fields — that claim hasn't been re-examined against this root cause. **Still do not trust reconcile blindly**: dry-run first, inspect the proposed set with your own eyes, and fall back to direct `blaze move` (defined → in-progress → in-review → done) on any doubt — every board pass using that fallback has worked reliably regardless of reconcile's behavior that day. A ticket to fix INF-763 itself, or to re-verify the PR-2 pass's claim against this root cause, would be worth filing but is out of scope for this campaign (INF is a different project).

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 1.5 (kickoff Phase 3a). Lane G record corrections | **Done.** PR #177 merged as `44b797f`. BLZ-639/638/637/641. |
| 2. Test gap — BLZ-567 (infra E2E) + Lane R (BLZ-512, 519, 514, 513, 511, 520, 510) | **Done.** PR #180 merged as `1da8e5e`, board pass complete (see Board section — BLZ-567 split, BLZ-653 filed for the deferred remainder). Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide). |
| 3. CSV import | **DONE — all four PRs merged.** PR-1 (`9680179`, #179), PR-2 (`e01b092`, #182), BLZ-654 (`e981b8e`, #184), PR-3 (`7f8cada`, #186), PR-4 (`beac597`, #188). Sixteen tickets, four adversarial reviews, each surfacing at least one real issue (design-doc self-inconsistencies, a genuine gap in a merged file's own governing design section, a latent bug in a merged concurrency primitive, an under-covered security boundary guard) — each fixed in-branch or ticketed. |
| 4. DB cutover — BLZ-254 | **Not started.** |
| 5. Retire blaze-pm | **Not started.** |

## Next

Phases 2 and 3 are both done — Lane T's preconditions are met. Starting Lane T (BLZ-503, 523, 516, 517, 504, 515) next, in its own worktree, alone, since it edits test files corpus-wide and would collide with anything else running. Phases 4 and 5 (BLZ-254, the DB cutover; retiring blaze-pm) remain explicitly out of scope for this session per the kickoff's §3 ("brainstorm before planning" if reached with real context left) — do not start them without a fresh planning pass. Update this file again after Lane T merges, or write a successor kickoff if this session stops before then.
