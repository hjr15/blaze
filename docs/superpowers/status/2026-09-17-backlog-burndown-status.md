# Backlog burn-down — true status

Written for: the operator. Updated 2026-09-22. Every state below was re-read from git, GitHub and the board, not from memory.

## Headline

**The kickoff's Definition of Done (§1) is met.** Phases 1, 2, and 3 are all fully merged and board-verified. `main` is `59b2925`. Full suite: **5109 tests / 5107 pass / 0 fail / 453 suites / 2 skipped**, measured on `59b2925` via `npm test` after `npm ci`, without Postgres. `node scripts/ci/hygiene-check.mjs origin/main` → `hygiene: clean`. A campaign-wide board sanity check (this session) confirmed all 30 tickets across every lane are `done`. Only phases 4 and 5 (the DB cutover, retiring blaze-pm) remain, and both are explicitly out of scope for this session per the kickoff's own §3.

## Merged (in order)

| PR | Tickets | Merged as | Adversarial rounds |
|---|---|---|---|
| #168 | BLZ-590 | `a1f5fbd` | prior session |
| #172 | BLZ-531 | `13f661c` | 1 — UPHELD |
| #175 | BLZ-608, 597, 558, 602 | `67114bb` | 2 — UPHELD |
| #170 | BLZ-534, 601, 603 | `54a136d` | 4 — UPHELD, 4 residuals ticketed |
| #174 | BLZ-571, 570, 578, 613 | `af19a91` | 3 — UPHELD, 1 residual ticketed |
| #173 | BLZ-587 (design + ADR-0037) | `27ba2d0` | 9 — UPHELD, 8 wording residuals ticketed |
| #169 | BLZ-535, 521, 537 | `8d94fff` | 11 — merged with residuals (the write-seam guard, see below) |
| #176 | docs: successor kickoff + prior status doc | `a269abc` | — (docs only) |
| #177 | BLZ-639, 638, 637, 641 (Lane G, Phase 3a) | `44b797f` | 1 — UPHELD; one self-inflicted design-doc staleness finding fixed in-branch; one hollow-test finding ticketed as BLZ-643 |
| #178 | docs: status update | `f044984` | — (docs only) |
| #179 | BLZ-625, 626, 627 (Lane C PR-1, CSV format layer) | `9680179` | 1 — UPHELD; one test-discrimination gap fixed in-branch; six findings ticketed as BLZ-644–649 |
| #180 | BLZ-512, 519, 514, 513, 511, 510, 520, 567 (Lane R, read-path residue) | `1da8e5e` | 1 — UPHELD; both security-sensitive claims (setup-token pre-auth hang, commit-lock lock-theft) independently reproduced; three residuals ticketed as BLZ-650–652 |
| #181 | docs: status update | `a93572f` | — (docs only) |
| #182 | BLZ-628, 629, 630, 631 (Lane C PR-2, import engine + round-trip gate) | `e01b092` | 1 — UPHELD; a genuinely valuable headline finding confirmed (design §5.1's SIGKILL invariant pair is structurally insufficient alone) plus a real gap in already-merged export code; four residuals ticketed as BLZ-654–657 |
| #183 | docs: status update | `de8cd0f` | — (docs only) |
| #184 | BLZ-654 (export-side link-refusal gap, already-merged PR-1 code) | `e981b8e` | 1 — UPHELD; one finding (missing ticket attribution) fixed in-branch |
| #185 | docs: status update | `cdf83af` | — (docs only) |
| #186 | BLZ-634, 635, 636 (Lane C PR-3, mapping layer) | `7f8cada` | 1 — UPHELD; independently verified a conformance fix to already-merged PR-2 code and the boundary guard's actual coverage; one finding (guard didn't cover the verbs this PR adds) fixed in-branch; three residuals ticketed as BLZ-658–660 |
| #187 | docs: status update | `7a24960` | — (docs only) |
| #188 | BLZ-640, 633 (Lane C PR-4, import lock + markdown import — last of the CSV build) | `beac597` | 1 — UPHELD, cleanest of the four CSV PRs; confirmed a genuine latent-bug fix in already-merged `commit-lock.mjs` and a real (not timing-dependent) concurrency test; three residuals ticketed as BLZ-661–663 |
| #189 | docs: status update | `c355b9c` | — (docs only) |
| #190 | BLZ-503, 517, 516, 523, 504, 515 (Lane T, test machinery) | `59b2925` | 1 — UPHELD; eliminated a real 299-directory-per-run scratch leak, confirmed by independent re-measurement; the PR's own new mechanisms caught a real Postgres-only leak on their first CI run; three residuals ticketed as BLZ-664–666 |

Kickoff Lanes C and L (BLZ-505/506/507/508/509, BLZ-500/498/518/502/124) closed in the prior session.

## The one deliberate compromise: the write-seam guard (#169)

Eleven adversarial rounds, every one of which found a real defect by planting a module that wrote to disk while the guard reported all-pass. Round 11's fix closed a great deal; round 12 planted eleven more shapes that still wrote green. The stop rule was invoked rather than starting round 13.

**What shipped:** the guard as a ratchet, its three open classes stated verbatim in the file's own banner rather than claimed closed, plus one genuine new fix (Node 24 type-strips now fail closed). The predecessor sat at 3 pass / 0 fail with a live `appendFileSync` in a non-allowlisted module, so this is a large net gain — it is not a proof.

**BLZ-642** is the successor ticket (est 240), quoting the three open classes and carrying ten planted shapes as acceptance criteria. Still open, deliberately.

## Board — full campaign sanity check, 2026-09-22

All 30 tickets this campaign touched are confirmed `done`:

- **Lane G**: BLZ-639, 638, 637, 641.
- **Lane R**: BLZ-512, 519, 514, 513, 511, 510, 520 — plain `done`. BLZ-567 — `done`, but carries a Notes-section split (delivered part shipped; the in-cluster E2E and hostPath-mount test deferred with a written reason) rather than a plain terminal move — this is deliberate, matches the BLZ-140/INF-749 precedent, and the deferred remainder is tracked as **BLZ-653**.
- **Lane C** (the CSV import build, 13 tickets across 4 PRs + one standalone fix): BLZ-625, 626, 627, 628, 629, 630, 631, 634, 635, 636, 640, 633, 654.
- **Lane T**: BLZ-503, 517, 516, 523, 504, 515.

One correction made mid-session: BLZ-625/626/627 (Lane C PR-1) were found still sitting in `defined/` despite merging sessions ago — that PR's board pass had been accidentally skipped. Caught by this session's own sanity check and corrected before Lane T started.

**Still open, deliberately, not part of this campaign's scope:**
- BLZ-587 — the CSV design story; its design merged, its full build (4 PRs) has landed, but the story itself stays open as the umbrella (matches this project's convention of not auto-closing a parent story).
- BLZ-642 — the write-seam guard successor (see above).
- Review-residual follow-ups from every PR in this campaign, all low/medium priority, none blocking anything: BLZ-643 (Lane G); BLZ-644–649 (Lane C PR-1); BLZ-650–652 (Lane R); BLZ-653 (Lane R's deferred BLZ-567 remainder); BLZ-654–657 (Lane C PR-2 — 654 itself is `done`, 655/656/657 open); BLZ-658–660 (Lane C PR-3); BLZ-661–663 (Lane C PR-4); BLZ-664–666 (Lane T).
- BLZ-624 (sign-in per-source rate-limit ceiling, security/high, filed prior session) — not part of this campaign's scope, still open.
- **OBA-154** — marked SUPERSEDED in its own body; a prior reconcile sweep wanted to move it to plain `done`, but it needs a deliberate `blaze resolve`. Blocked on the operator, not on any lane.

`BLZ-305-v4-spine` (the board's working branch, in the `v4-spine` worktree) is committed but never pushed, per standing policy — roughly 30 local commits ahead of `origin/BLZ-305-v4-spine` as of this session's last board pass.

**Mechanism note for the next session's board passes**: `blaze reconcile`'s `--project`/`--ticket` scoping flags have behaved inconsistently across different board-pass agents in this campaign (sometimes erroring as unknown, sometimes appearing to work). A credible root-cause lead was found (INF-763: `codeRepos` resolves relative to the board root, and from the `v4-spine` worktree that path doesn't exist, so reconcile may silently scan zero repos) but was never fully reconciled against every prior report. **Every single board pass that used the direct `blaze move` verb sequence instead (defined → in-progress → in-review → done) worked reliably, every time, all session.** That's the recommended default; treat reconcile as something to dry-run and eyeball, never trust blind.

Also still flagged from prior sessions, unchanged: `terminal_parent_scan.py` shows 65 terminal parents with open children board-wide (pre-existing, not this campaign's doing).

## The five phases

| Phase | State |
|---|---|
| 1. Engine highs | **Done.** Seven PRs merged. |
| 1.5 (kickoff Phase 3a). Lane G record corrections | **Done.** PR #177, `44b797f`. |
| 2. Test gap — Lane R + BLZ-567 | **Done.** PR #180, `1da8e5e`. Board-verified. |
| 3. CSV import | **Done.** All four PRs plus BLZ-654: `9680179`, `e01b092`, `e981b8e`, `7f8cada`, `beac597`. Thirteen tickets, four adversarial reviews, each surfacing at least one real issue, each resolved in-branch or ticketed. Board-verified. |
| — Lane T (test machinery, folded into this campaign's scope alongside phases 2/3) | **Done.** PR #190, `59b2925`. Board-verified. |
| 4. DB cutover — BLZ-254 (est 3600 min) | **Not started. Deliberately out of scope for this session** — the kickoff's own §3 says this needs a brainstorming pass before planning, not a lane to just start. |
| 5. Retire blaze-pm | **Not started. Same reasoning as phase 4.** |

## Next

This campaign's stated scope (phases 2 and 3, plus the test-machinery lane) is complete, board-verified, and main is green on the full gate. This is a clean stopping point.

Phases 4 and 5 are real, sized work (BLZ-254 alone is a 3600-minute estimate — "a body of work, not a lane," per the kickoff's own words) and the kickoff explicitly calls for a brainstorming pass before any planning, not a continuation of this lane-based execution model. Starting either without that deliberate step would be exactly the kind of premature-planning the operator's own standing instructions warn against.

**If the operator wants to continue into phases 4/5 in this session or a successor, the next action is a brainstorming session, not a kickoff-style lane dispatch.** If not, this document is the closing record: every merged PR, every review finding and its disposition, every open follow-up ticket, and the one open mechanism question (reconcile's flag inconsistency) are all recorded above for whoever picks this up next.
