# blaze — next session handoff (2026-08-31)

**Start here.** Then read
[`2026-08-31-blaze-app-adoption-and-import-standard.md`](2026-08-31-blaze-app-adoption-and-import-standard.md),
which is the **phase order to completion**. This document is the state you inherit and the first
thing to do; that one is the plan.

**Do not read the older `*-kickoff.md` files as current, and do not write over them.** A kickoff has
been destroyed that way once. Descriptive filenames, never date-only.

---

## 0. Continuity contract

A usage, context or API limit is a **PAUSE, not completion.** Do not stop, do not mark anything done,
do not hand back early. Commit WIP freely on your lane branch; squash to one commit per ticket before
the PR. **Verify tree state, never trust a report — including this one.**

**Stop rule.** Finish the phase you are in, then stop and write a successor if ANY of: context is
running short, a lane has been refuted **twice on the same ticket**, or you have merged the phase you
are in.

## 1. The one thing blocking the operator right now

**BLZ-590** — `blaze commit` cannot drain a queue whose ops are all already filed.

```
blaze commit: git commit failed (status 1) — ledger kept, resolve manually
```

Nothing failed. All 210 ops are *orphaned* — each op's recorded file already matches HEAD, because
the work was filed by hand while the flush was broken. `git add` stages nothing, `git commit` exits 1
with "nothing to commit", and that is read as failure. **The ledger is kept, so the queue can never
empty.** A drain containing one genuinely-outstanding op succeeds normally; it fails only when
*every* op is settled — confirmed live.

**A fix was in flight when this session ended, on branch `BLZ-590-settled-drain` off `326233e`.**
Verify its state before doing anything: it may be unmerged, partly done, or refuted.

```
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin
git log --oneline origin/main..origin/BLZ-590-settled-drain   # empty means it never pushed
gh pr list --state all --limit 5
```

The design it was given: distinguish **settled** (nothing staged because every recorded file already
matches HEAD → clear the ledger, report plainly, exit 0) from a **genuine failure** (hook, signature,
lock → keep the ledger, exit non-zero), and detect it by asking the index whether anything is staged
— **not** by matching git's `"nothing to commit"` text. **Collapsing the two would be worse than the
bug**, because it would clear a ledger whose work never landed.

It was also asked to look at the `1 commit(s) behind origin/main (no fetch run)` warning, which fired
on a branch git reports as up to date with *its own* upstream.

## 2. State — re-verify, do not take as gospel

```
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git log --oneline -1 origin/main
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres   # your own port
npm ci && node --test 2>&1 | tail -9
```

| | |
|---|---|
| `blaze` main | **`326233e`** |
| Suite | **4,445 pass / 0 fail / 395 suites** — measured on `326233e` itself |
| Coverage | 98.48 / 88.28 / 97.35 (gates 91/77/93/91) |
| Board | **2,838 tickets**, 11 projects, **`ok=true` unscoped** |
| Non-terminal | **142** — 0 critical, **13 high**, 92 medium, 37 low |
| Deployed | image digest matches the git pin — both engine changes are **live** |

`--projects BLZ` reports `ok=false` with 5 hard `dangling-target` findings. That is **BLZ-586**, an
audit-scoping artifact: those tickets link to `INF-556`, which exists. **The corpus is correct.**

**The queue store is one per repository** (BLZ-556, ADR-0033). All **210** ops were migrated into
`blaze-pm/.blaze` on 2026-08-31 and verified **byte-identical** against a pre-migration snapshot —
zero lost, zero duplicated. `blaze commit --status`: **0 outstanding, 20 orphaned**. Re-derive that
before relying on it; an earlier note recorded 86, taken while the measuring session's own ops were
still queued, and the settled figure is 20.

- Snapshot: `/home/rnamwoh/Documents/Code/blaze-pm-queue-snapshot-20260831-190249` (16 MB)
- Held originals: `<worktree>/.blaze/migrated-<ts>/`
- **Delete neither until a drain is verified.**

> **On quoting these figures.** An earlier draft said 4,411 — that was the sign-in branch measured
> in isolation, before the queue lane merged, and it was wrong for `main`. The number above was
> measured on `326233e` directly. **Re-derive rather than quote**; that is the whole lesson of
> BLZ-505 and BLZ-509, and it has already caught two stale figures in this document's own lineage.

## 3. Two operator-owned conditions that are NOT bugs

**The nightly flush fails every night, by design.** `blaze-pm`'s main checkout is on
`BLZ-143-engineering-method-and-work-item-model`, **89 commits behind `main` with 10 dirty files**,
so the flush's `HEAD === "main"` gate skips — and BLZ-526 turned that silent skip into a loud
failure. ArgoCD reports the blaze app `Degraded` with *"CronJob has never completed successfully"*;
all three flush alerts are armed. **This is the fix working.** It resolves when that checkout moves
to `main` or BLZ-525's follow-up repoints the mount. **It is the operator's branch and their
uncommitted work — do not switch, clean or commit it.**

**The board requires a credential.** An admin exists (created 2026-08-31 via a direct POST, because
`/setup`'s page could not complete at the time). BLZ-566 has since made browser sign-in work end to
end, verified in Chromium. The edge answers 401 from Traefik basic-auth.

## 4. What to do, in order

**Phase 0 — unblock the operator.** Land BLZ-590, then drain. The drain command the operator runs is:

```
blaze commit --all
```

**An auto-mode classifier has blocked this twice for an agent.** Do not reword or split it to get
past — ask the operator to run it, or to add a permission rule.

Then phases 1–5 of the adoption work order: engine highs → the infrastructure test gap → CSV import
and export → the database cutover → retirement.

**The sequencing worth defending:** the infrastructure test gap (**BLZ-567**) comes *before* the
cutover. A cutover verified by a suite that **stubs its own verbs** is not verified — that is exactly
how a removed config key which killed the process *after* it bound the port reached production.

## 5. The open highs

BLZ-531 (drain destroys an unparseable ledger line — WIP at `origin/BLZ-518-partial-ledger-quarantine-wip`
`f803747`, **refused merge twice**; needs the `try/finally`, the totals fix, a property-pinned `518f`,
the ADR-0031 guard) · BLZ-534 (the suite can hang **forever**; intermittent) · BLZ-535 (write-seam
guard pins a spelling — do with BLZ-521) · BLZ-537 · BLZ-558 · BLZ-570 · BLZ-571 (needs a **decision**
on rate-limit shape first) · BLZ-587 / BLZ-589 (CSV import + round-trip export) · BLZ-590 (§1).

BLZ-235, BLZ-568, BLZ-569 are `accepted` decision records, not work.

## 6. Constraints — non-negotiable

- **Do not delete `blaze-pm`.** It holds 2,838 tickets and **is** the app's storage today.
- **Do not drain without re-checking the ops are still 0-outstanding.** That is a measured fact with
  a date on it, not a permanent property.
- **Never run bare `blaze`** — it defaults to `start` and loops forever. Name a subcommand,
  `</dev/null`, under `timeout`. **Never `git stash`** — repo-wide, shared across worktrees.
- **The setup token's PATH may be logged; its VALUE never is.** Same for any API token — `blaze user
  add` prints it once and stores only a SHA-256. **An error message is an output channel.**
- **One writer for the board.** With parallel lanes the coordinator owns all `blaze` board ops; lane
  agents return findings as `title | type | priority | estimate | context` and the coordinator files
  them.
- No `test-gap` type — use `task`. `labels` is `[]`; `components` is `blaze`/`engine`.
- **Do not reopen** ADR-0001, 0006, 0013, 0021–0034. **ADR-0035 is the next free number.**
- **Every PR gets an adversarial review in a separate worktree**, by an agent that did not write it,
  scoped to product behaviour. Wording and test-machinery findings are **ticketed, not
  fixed-and-re-reviewed**.
- One Postgres container per concurrent agent, distinct port (55481, 55482, …). Each worktree needs
  its own `npm ci`.

## 7. Method — earned across nineteen refutations

The BLZ-556/BLZ-566 session ran **nineteen adversarial review rounds and produced nineteen
refutations, every one a real defect. Eight were defects introduced by the fix for an earlier
refutation.** The habits that found them:

- **Pin the property, not the spelling.** Three separate fixes closed the enumerated cases and left
  the property open — argv spellings, a partially-swept `readdirSync`, a FIFO sweep covering reads
  but not writes. BLZ-590 is the same shape again: *"nothing to commit"* is a message; *"is anything
  staged"* is the fact.
- **Ask what the measurement cannot observe.** It found a data-loss path, an infinite hang, and a
  migration whose verification counted an unreadable file as **zero** and reported success twice.
- **Assert the observation happened.** **Six times** a green result was measuring nothing — a
  relative CLI path, an unread env var, an uncommitted revert baseline, a memoised cache, a
  mismatched test name, TAP parsed against a spec reporter. **Check a positive control before
  trusting a negative.**
- **A hardening that disables the feature it protects is a defect.** A CSP with no `connect-src`
  blocked the sign-in it secured, and passed a test asserting the header was present.
- **State reachability plainly**, and check that "unpinnable" is not merely "unpinned".
- **The revert rule**: revert the production hunk the test claims to pin and watch **that named
  test** go red **for the reason its name gives**.
