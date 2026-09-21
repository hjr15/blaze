# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-22. Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**Phase 1 finished (seven PRs). Phase 2 (Lane R) fully merged. Phase 3's PR-1 and PR-2 (format layer, then the import engine + round-trip gate — the hardest ticket in this campaign) both merged.** `main` is `e01b092`. The board has 17+ unpushed commits on `BLZ-305-v4-spine` (blaze-pm is never pushed, per the standing constraint; exact count pending the latest board pass).

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

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## In flight (this session, 2026-09-20/22)

- A board pass for BLZ-628/629/630/631 (Lane C PR-2's tickets: move to `done`, log time) was dispatched this session.
- Lane C now proceeds to **PR-3** (BLZ-634–636, the mapping layer — the deliberate-inference-boundary story, ADR-0037) once cut from `e01b092`.
- Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide).

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal — every callee shape its tests name, Node's own module resolution, the package root — and round 12 then planted eleven *more* shapes that still wrote green. At that point I invoked the plan's stop rule rather than start round 13.

**What shipped:** the guard as a ratchet, with its three open classes stated verbatim in the file's own banner instead of claimed closed, plus one genuine new fix (Node 24 type-strips, so `.ts`/`.mts`/`.cts` helpers were never scanned at all — now an unparseable typed file is an offence in itself, fail-closed). The predecessor it replaces sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain; it is not a proof.

**BLZ-642** is the successor ticket, est 240, quoting the three classes from the merged file and carrying ten planted shapes as acceptance criteria — each one measured as a real write with the guard green on the pre-merge tip.

## Board

- `BLZ-305-v4-spine`, unpushed (exact commit-ahead count pending the latest board pass), working tree clean.
- BLZ-639/638/637/641 (Lane G), BLZ-625/626/627 (Lane C PR-1), and BLZ-512/519/514/513/511/510/520/567 (Lane R, including BLZ-567's split — delivered part `done`, deferred part spun off as **BLZ-653**, mirroring the BLZ-140/INF-749 precedent) are all `done`. A board pass for BLZ-628/629/630/631 (Lane C PR-2) was dispatched this session — check its outcome before trusting those four as `done`. BLZ-587 stays open deliberately: its design merged, PR-1 and PR-2 of its build have landed.
- **Filed prior sessions:** BLZ-609–612, 614–616, 617–619 (PR-review residuals); BLZ-620–623 (#170); BLZ-624 (sign-in per-source ceiling, security/high); BLZ-625–641 (the whole Phase 3 build set + §8 gaps); BLZ-642 (seam successor); BLZ-643 (Lane-G review, hollow test); BLZ-644–649 (Lane-C-PR-1 review); BLZ-650–652 (Lane-R review); BLZ-653 (Lane-R, BLZ-567's deferred in-cluster E2E/hostPath-mount scope, blocked on a Helm chart landing in the deployment repo).
- **Filed this session:** BLZ-654 (HIGH PRIORITY — `export-rows.mjs`/`encodePairList` doesn't refuse a link with no target, exports the literal string `Relates:undefined`; already-merged code, blocks writing design §3.3's required refusal fixture); BLZ-655 (fold the SIGKILL test's third invariant back into design §5.1, which as written is insufficient on its own); BLZ-656 (`--allocate-ids`' partial-failure report misreports successfully-written rows as not-written); BLZ-657 (the SIGKILL test's kill trigger is coupled to the receipt file whose durability it's testing, can pass vacuously).
- A board-wide reconcile sweep ran in a prior session and applied 17 status moves + 39 branch/PR backfills, each verified against a real merged PR across five repos. One decline still outstanding, unchanged, blocked on the operator: **OBA-154** is marked SUPERSEDED in its own body and reconcile wanted to move it to plain `done` — it needs a deliberate `blaze resolve`, not a bare move.
- Also flagged (prior session, unchanged): `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing); two applied moves (INF-247, OBA-812) add to it, both evidenced against the parent's own scope.
- **Mechanism note for future board passes on this campaign:** `blaze reconcile --apply` (globally scoped) picks up unrelated tickets and must not be used broadly; a `--ticket <ids>` scoping flag does not exist on this board's installed engine; and reconcile's git-evidence matching does not reliably recognize tickets from a squash-merge commit whose subject combines multiple ticket ids in one line. Every board pass on this campaign since Lane R has used the direct `blaze move` verb sequence (defined → in-progress → in-review → done) instead — expect to keep doing this.

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 1.5 (kickoff Phase 3a). Lane G record corrections | **Done.** PR #177 merged as `44b797f`. BLZ-639/638/637/641. |
| 2. Test gap — BLZ-567 (infra E2E) + Lane R (BLZ-512, 519, 514, 513, 511, 520, 510) | **Done.** PR #180 merged as `1da8e5e`, board pass complete (see Board section — BLZ-567 split, BLZ-653 filed for the deferred remainder). Lane T (BLZ-503, 523, 516, 517, 504, 515) not yet started — runs alone, last, per the kickoff's stop rule (needs ~1/3 of context remaining before starting, since it edits test files corpus-wide). |
| 3. CSV import | **PR-1 (format layer, BLZ-625/626/627) merged as `9680179` (#179). PR-2 (the import engine + round-trip gate, BLZ-628–631) merged as `e01b092` (#182)** — the hardest ticket in this campaign, survived two rate-limit pauses and resumed cleanly both times. PR-3 (BLZ-634–636, the mapping layer) not started — cut a fresh worktree from `e01b092` (or later). PR-4 (BLZ-640/633, lock + markdown) blocked on PR-3. **Note:** BLZ-654 (the export-side link-refusal gap in already-merged PR-1 code) should probably land before or alongside PR-3, since it blocks a required design §3.3 test fixture — worth a small standalone fix rather than waiting for PR-4. |
| 4. DB cutover — BLZ-254 | **Not started.** |
| 5. Retire blaze-pm | **Not started.** |

## Next

Once the board pass for BLZ-628–631 confirms, decide whether to land BLZ-654 (the export-side gap, small, high-priority, blocks a design-required test fixture) as its own quick lane before or alongside PR-3, then start PR-3 (BLZ-634–636, the mapping layer — read ADR-0037 closely, this is where the "a proposal a person accepts, never an import" boundary is load-bearing) in a fresh worktree cut from the current main. Lane T can start once PR-3 and PR-4 land and ~1/3 of context remains — check both conditions before starting it, since a half-done corpus-wide test sweep is worse than none. Update this file again after each merge, per the kickoff's continuity contract.
