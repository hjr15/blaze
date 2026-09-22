# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-22 (later same day). Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**Phase 1 finished (seven PRs). Phase 2 (Lane R) fully merged. Phase 3's PR-1, PR-2, PR-3, and BLZ-654 all merged — the deterministic CSV round trip and the mapping layer are DONE, matching the kickoff's §1 Definition of Done for that scope. PR-4 (the import lock + markdown import — the last PR in Lane C's build) is in flight.** `main` is `7f8cada`. The board has 20+ unpushed commits on `BLZ-305-v4-spine` (blaze-pm is never pushed, per the standing constraint).

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

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## In flight (this session, 2026-09-20/22)

- **Lane C PR-4** (`BLZ-640-import-lock`, worktree `blaze-worktrees/lane-csv4`) — BLZ-640 (an import-scoped lock reusing `commit-lock.mjs`'s atomic-`mkdirSync` primitive) and BLZ-633 (markdown import as a second reader onto PR-2's `planImport`, sharing one validation notion with CSV). Dispatched to opus. This is the last PR in Lane C's build — once it merges, Phase 3 is fully done per the kickoff's §3 lane structure (§1's Definition of Done itself only names PR-1/2/3's tickets, so Phase 3 was already "done" by that literal bar before PR-4; PR-4 completes Lane C's own stated four-PR scope). Not yet reviewed or merged.
- Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide).

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal — every callee shape its tests name, Node's own module resolution, the package root — and round 12 then planted eleven *more* shapes that still wrote green. At that point I invoked the plan's stop rule rather than start round 13.

**What shipped:** the guard as a ratchet, with its three open classes stated verbatim in the file's own banner instead of claimed closed, plus one genuine new fix (Node 24 type-strips, so `.ts`/`.mts`/`.cts` helpers were never scanned at all — now an unparseable typed file is an offence in itself, fail-closed). The predecessor it replaces sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain; it is not a proof.

**BLZ-642** is the successor ticket, est 240, quoting the three classes from the merged file and carrying ten planted shapes as acceptance criteria — each one measured as a real write with the guard green on the pre-merge tip.

## Board

- `BLZ-305-v4-spine`, 20+ commits ahead of origin, unpushed, working tree clean.
- BLZ-639/638/637/641 (Lane G), BLZ-625/626/627 (Lane C PR-1), BLZ-512/519/514/513/511/510/520/567 (Lane R, including BLZ-567's split — delivered part `done`, deferred part spun off as **BLZ-653**, mirroring the BLZ-140/INF-749 precedent), BLZ-628/629/630/631 (Lane C PR-2), BLZ-654 (the export-link-refusal fix), and BLZ-634/635/636 (Lane C PR-3) are all `done`. BLZ-587 stays open deliberately: its design merged, PR-1/PR-2/PR-3/BLZ-654 of its build have landed, PR-4 is in flight.
- **Filed prior sessions:** BLZ-609–612, 614–616, 617–619 (PR-review residuals); BLZ-620–623 (#170); BLZ-624 (sign-in per-source ceiling, security/high); BLZ-625–641 (the whole Phase 3 build set + §8 gaps); BLZ-642 (seam successor); BLZ-643 (Lane-G review, hollow test); BLZ-644–649 (Lane-C-PR-1 review); BLZ-650–652 (Lane-R review); BLZ-653 (Lane-R, BLZ-567's deferred scope); BLZ-654–657 (Lane-C-PR-2 review — 654 is `done`; 655/656/657 still open, low-priority, not blocking); BLZ-658–660 (Lane-C-PR-3 review — all open, low/medium-priority test-coverage/naming follow-ups, not blocking).
- A board-wide reconcile sweep ran in a prior session and applied 17 status moves + 39 branch/PR backfills, each verified against a real merged PR across five repos. One decline still outstanding, unchanged, blocked on the operator: **OBA-154** is marked SUPERSEDED in its own body and reconcile wanted to move it to plain `done` — it needs a deliberate `blaze resolve`, not a bare move.
- Also flagged (prior session, unchanged): `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing); two applied moves (INF-247, OBA-812) add to it, both evidenced against the parent's own scope.
- **Mechanism note for future board passes — likely resolved, but not fully reconciled with every prior report.** Multiple board-pass agents this campaign gave conflicting answers about `blaze reconcile`'s `--project`/`--ticket` flags (sometimes "doesn't exist", sometimes "worked"). The PR-3 board pass found a strong root-cause lead: `blaze`'s `project.json` sets `codeRepos: ["../blaze"]`, a path resolved relative to the board root — and from the `v4-spine` worktree, `../blaze` resolves to a nonexistent directory (the worktree isn't laid out like the main `blaze-pm` checkout). This matches a documented defect, INF-763 ("blaze reconcile is a silent no-op from a worktree", see `node_modules/@hjr15/blaze-board/AGENTS.md`) — reconcile from this worktree may scan zero repos and report "already in sync" regardless of real state, indistinguishable from a genuine no-op. This does NOT cleanly explain the one board pass (Lane C PR-2's) that reported reconcile actively moving tickets with backfilled `branch:`/`pr:` fields — that claim hasn't been re-examined against this root cause. **Still do not trust reconcile blindly**: dry-run first, inspect the proposed set with your own eyes, and fall back to direct `blaze move` (defined → in-progress → in-review → done) on any doubt — every board pass using that fallback has worked reliably regardless of reconcile's behavior that day. A ticket to fix INF-763 itself, or to re-verify the PR-2 pass's claim against this root cause, would be worth filing but is out of scope for this campaign (INF is a different project).

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 1.5 (kickoff Phase 3a). Lane G record corrections | **Done.** PR #177 merged as `44b797f`. BLZ-639/638/637/641. |
| 2. Test gap — BLZ-567 (infra E2E) + Lane R (BLZ-512, 519, 514, 513, 511, 520, 510) | **Done.** PR #180 merged as `1da8e5e`, board pass complete (see Board section — BLZ-567 split, BLZ-653 filed for the deferred remainder). Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide). |
| 3. CSV import | **PR-1 (`9680179`, #179), PR-2 (`e01b092`, #182), BLZ-654 (`e981b8e`, #184), and PR-3 (`7f8cada`, #186) all merged.** The deterministic CSV round trip and the mapping layer are done — the kickoff's §1 Definition of Done is met for this scope. PR-4 (BLZ-640/633, the import lock + markdown import) **in flight** in worktree `blaze-worktrees/lane-csv4`, dispatched to opus — the last PR in Lane C's own four-PR build. |
| 4. DB cutover — BLZ-254 | **Not started.** |
| 5. Retire blaze-pm | **Not started.** |

## Next

Once PR-4 is done, review it (separate worktree, agent that didn't write the branch, per the kickoff's constraint 3) and merge — this closes out Lane C entirely. Lane T can then start if ~1/3 of context remains — check that condition before starting it, since a half-done corpus-wide test sweep is worse than none; if context is short instead, this is a clean point to stop and write a successor kickoff for Lane T + phases 4/5, since §1's Definition of Done is otherwise met. Update this file again after each merge, per the kickoff's continuity contract.
