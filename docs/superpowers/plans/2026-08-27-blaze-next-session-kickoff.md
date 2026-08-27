# blaze — next session kickoff (2026-08-27)

Successor to `2026-08-30-blaze-next-session-kickoff.md`. That lane is **complete**: all four
lanes shipped, all seven tickets `done`. This document is self-contained.

## 1. What shipped

| Lane | Tickets | PR | Merged |
|---|---|---|---|
| 1 | BLZ-399, BLZ-395, BLZ-398 | #128 | yes |
| 2 | BLZ-394 | #129 | yes |
| 3 | BLZ-397, BLZ-400 | #131 | yes |
| 4 | BLZ-396 | #132 | `34ea712` |

`main` is at `34ea712`, suite **2,755 pass / 0 fail**, hygiene clean, coverage
98.45 / 87.57 / 97.22 / 98.45, all 17 schedule mutations killed.

## 2. The one thing worth carrying forward

**Lane 4 needed SIX adversarial review rounds. The same sentence was wrong in five
successive directions**, and each round's defect lived inside the previous round's fix:

1. hardcoded "the built-in defaults" — untrue at the project layer when config overrode;
2. hardcoded "the blaze.config.json layer is still in force" — untrue when that layer was
   absent or declared nothing, i.e. on the *more* common board;
3. `isRecord(configSchema)` as a proxy for "in force" — untrue for a well-formed record that
   contributes nothing, including one whose own block was reported IGNORED one line above;
4. the config layer's own clause, never threaded through, still hardcoded — round 1 mirrored;
5. an uncomputable comparison returning `false`, which renders as a *definite* claim.

Every round the code got fixed and **the tests did not pin the adjacent case**. Rounds 1–5
each found their defect in territory the previous round's tests had walked past — usually
because those tests fixed one layer to the single value that made the new claim true.

What finally settled it was not a better fix, it was a better **oracle**: enumerate the
cross-product of config × project shapes, and mechanically compare every emitted sentence
against `resolveSchema` ground truth for that exact board. 1,736 clauses, 0 mismatches — and
crucially, the oracle was **proven non-vacuous** by re-introducing each historical defect and
confirming it caught them (136 / 476 / 136 / 110 clauses respectively).

**The lesson for the next lane: when a change makes the product ASSERT something, test the
assertion against ground truth over a generated cross-product, not against hand-picked
examples.** Hand-picked examples are chosen by the same understanding that wrote the bug.

Secondary, and it recurred three times in this lane alone: **a guard that no current call
path can reach cannot be killed by any mutation.** Say so in the commit rather than implying
it is pinned (`DROPPED_KINDS`, the `?? null` lookup, the `try/catch` before it was pinned).

## 3. Ready to pick up — seven tickets, all in `defined/`

Ordered by my read of value. Nothing here is blocked.

| Ticket | What | Note |
|---|---|---|
| **BLZ-404** | `blaze start`'s reconcile loop is a permanent dry run | **HIGH** — the loop never applies, so the board silently never self-heals |
| **BLZ-407** | `blaze audit` says `ok=true` on a board every non-exempt verb refuses | Decide which side is right; do NOT presuppose. `schema-invalid` is SOFT and `audit` is in `SCHEMA_PREFLIGHT_EXEMPT` |
| **BLZ-405** | `serve`'s reconcile-preview renders a refused run as in-sync | Same family as 404 |
| **BLZ-403** | a hand-moved terminal ticket keeps a rank-chosen delivery record | Write-once interacts with this |
| **BLZ-406** | frontmatter/directory mismatch reconciled by no single-project run | Fallout of BLZ-394's `--project` |
| **BLZ-401** | resolution backfill reported as a change | Cosmetic but noisy in every reconcile |
| **BLZ-402** | project keys interpolated raw into `new RegExp` | Small, self-contained |

**BLZ-404 and BLZ-405 are one feature** (`the reconcile loop actually reconciles`) and should
bundle into a single PR per the `feature-pr-bundling` skill. The rest are independent.

## 4. Standing constraints — unchanged, still in force

- **Do NOT push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a **local commit**. 146 unpushed is correct.
- **Do NOT run `blaze schedule migrate-dates --write`** against the live board.
- **Do NOT touch the NCA project** (parked by the operator 2026-08-23).
- **Do NOT "fix" `provider`** in `blaze-pm/blaze.config.json` — it self-resolves at the flush.
- **Do NOT reopen** ADR-0001, ADR-0014's ruling, ADR-0021, ADR-0022's decision, or ADR-0023
  (including §1's options, §3's ruling against session-scoping, and its delete-direction
  paragraph).
- **Do NOT re-attack** the CLASSIFICATION table, the call-site source scanner, or
  `tests/cli.test.mjs`'s comment-arithmetic guard.
- The setup token's **PATH** may be logged; its **VALUE** never is, anywhere, ever.
- One agent per worktree. Never let a reviewer and a fix agent share one. Every concurrent
  agent gets its own Postgres container and port.

## 5. Working notes that cost time this lane

- Postgres test containers are named `blzpg-<port>`, and the password is **`x`**, not
  `postgres`. `postgres://postgres:x@127.0.0.1:55461/postgres`.
- Node 24 is not on the default PATH: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`.
  Omitting it makes every test file fail to load, which a naive mutation runner scores as
  "all mutations survived".
- **Commit before every mutation run.** A guarded runner that refuses a dirty tree, refuses a
  no-op patch, and refuses a run producing zero passes is in the scratchpad pattern; rebuild
  it rather than running `git checkout --` by hand.
- Squash bodies carry `* KEY-n:` bullets, so `idsFromCommitMessage` recovers the ticket.
  Verified again on #132 — all eight bullets present.
- `blaze log` wants a bare number (`90`), not `90m`.

## 6. Model routing

| Work | Model |
|---|---|
| Adversarial review, architecture, the oracle design | opus |
| Implementation, board operations, mechanical fixes | sonnet |
| Read-only lookups | haiku |

Set `model` explicitly on every dispatch. Never inherit.
