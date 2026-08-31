# blaze — adopting the app, standardising import, and retiring blaze-pm (2026-08-31)

**If you are a session reading this, your task is §2 — close the gaps before anyone migrates
anything.** This is a *decision* brief, not an implementation work order: the honest state is that
the question "can we start using the app and delete `blaze-pm`?" **cannot be answered yes today**,
and §1 says exactly why.

**Do not read this as authorisation to import, migrate or delete anything.** Its output is a plan
and a set of answered questions.

---

## 0. The operator's ask, verbatim in substance

Asked 2026-08-31, at the end of the BLZ-556/BLZ-566 session:

1. *"Isn't the place to move away from these daily scheduled tasks and start using the blaze app?"*
2. *"Can I start importing my issues, or are you still building out the testing suite?"*
3. *"Can we move forward with migrating my current issues into the app so we can start using it,
   and then delete the `blaze-pm` repo?"*
4. *"For work items migration and import there should be a set standard way of bringing things in
   via CSV and/or markdown. Please establish this as part of the product. **The main import medium
   should be a standard CSV format.**"*

Point 1 is **correct in principle and premature in fact** — see §1.2. Point 4 is now filed as
**BLZ-587 / BLZ-588 / BLZ-589** and is the least blocked of the four.

---

## 1. The honest state — verify each of these before building on them

### 1.1 "The app" and "`blaze-pm`" are currently the same thing

`blaze-pm` is not a legacy store the app reads from. **It IS the app's storage.** The filesystem is
the write path; the markdown files under `projects/` are the records. Importing "into the app"
today means writing markdown into `blaze-pm`.

So **deleting `blaze-pm` today would delete the board** — 2,815 tickets across 11 projects.

### 1.2 The database cutover has not started

| Ticket | What | Status (verify) |
|---|---|---|
| **BLZ-305** | v4 spine epic | `in-progress` — **22 of 23 children done** |
| **BLZ-309** | v4 migration from v3 | `in-progress`, **BLOCKED** |
| **BLZ-254** | *"cut the live board over to the database and retire the git write path"* | **`defined`** — not started |

BLZ-309's own body: *"this feature cannot start until the db-primary Phase 2 cutover (BLZ-254) lands.
A `document`/`artifact_usage` model has no status directory, so the filesystem write port cannot
represent it at all — only the database write port can."*

BLZ-254's own body: *"**This is where the value lands** — everything before it is scaffolding."*

**So the dependency chain to the operator's goal is: BLZ-254 → BLZ-309 → retire `blaze-pm`.** The
first link has not been started. The Postgres driver exists (BLZ-282, done) and `blaze db` has a
dual-write soak, so the scaffolding is real — but nothing has cut over.

### 1.3 The nightly CronJob is load-bearing *because* the board is git-backed

The operator's instinct is right: the `blaze-flush` CronJob exists to be the single merger of a
git-file board. **Once the database is primary, the flush's reason to exist largely goes away.**
Today it is still load-bearing, and as of 2026-08-31 it **fails every night by design** — BLZ-526
turned a silent skip into a loud failure, and `blaze-pm`'s main checkout is on
`BLZ-143-engineering-method-and-work-item-model` (89 behind `main`, 10 dirty files), so the
`HEAD === "main"` gate skips. ArgoCD shows the app `Degraded`; all three flush alerts are armed.

**Do not "fix" that by disabling the guard.** Either the checkout moves to `main`, or BLZ-525's
follow-up repoints the mount.

### 1.4 Import today is Jira-shaped and has a blast radius

The only import surface is `blaze migrate` — a Jira export through a reviewed disposition ledger.
Its own docs carry the warning: *"`--live` is the one Blaze command whose staging is not
file-scoped: it runs `git add -A` over the data repo."* **There is no CSV import.** `grep -rli csv
scripts/` finds nothing relevant.

### 1.5 Testing: strong on the engine, weak on the infrastructure

Answering *"are you still building out the testing suite?"* honestly, because the two halves differ:

- **Engine — genuinely covered.** 4,411 tests, 395 suites, coverage 98.48 / 88.28 / 97.35 against
  gates of 91/77/93/91. TDD with the revert rule on every guard.
- **Infrastructure — not.** **BLZ-567** records it: the flush harness *stubs the very verb it
  claims to test*, and no E2E proves the board serves in-cluster. That is how `"provider":
  "github"` — a removed config key that killed the process **after** it bound the port — survived
  until a live container run found it.

**The relevant gap for import is neither of those: it is that no round-trip export exists**
(BLZ-589). Until it does, "the corpus moved intact" is an assertion, not a measurement.

---

## 2. Your task — answer these before anyone migrates

Each is a real gap, not a rhetorical question. Where a decision is the operator's, bring them the
options and the trade-offs; do not choose for them.

### Q1. Does CSV import land before or after the database cutover?

BLZ-587 can be built against the filesystem write path today and would work unchanged after the
cutover **if** it goes through the model layer rather than writing files. Building it against the
filesystem write port directly makes it disposable.
**Establish which port BLZ-587 must target, and record it.**

### Q2. What is actually being imported, and from where?

The brief says *"my current issues"*. Nobody has established: which tracker, how many, which fields,
whether links/parents/attachments/history come too, and whether ids must be preserved. **An import
schema designed without a sample of the real data is a guess.** Get an export first — even 20 rows.

### Q3. What is the retirement criterion for `blaze-pm`?

Not a date — a **test**. The candidate, per BLZ-589's discipline: export the whole corpus from the
database, export it from `blaze-pm`, and diff. Non-empty diff means not ready.
**Write the criterion down before starting, so it cannot be relaxed to fit the schedule.**

### Q4. What happens to the git history?

`blaze-pm` carries 371+ commits of board history — who changed what, when, and why. A database
cutover that keeps only current state **discards the audit trail**. Is that acceptable, is history
migrated, or is the repo kept read-only in perpetuity as an archive? **This is the question most
likely to be discovered late and regretted.**

### Q5. Does the flush survive the cutover, and in what form?

If the database is primary, what merges concurrent writers — and what does BLZ-525's mount fix
become? Six flush tickets (BLZ-525–530) are open against a mechanism that may be retired. **Decide
whether to finish them or supersede them**, and say so on each rather than letting them rot.

### Q6. What is the rollback?

If the cutover is wrong, what returns the board to a working state, and how long is the window in
which both stores must agree? The dual-write soak exists for this — **establish what "soak passed"
means numerically** before relying on it.

---

## 3. What is already decided — do not relitigate

- **CSV is the primary import medium.** Operator's explicit preference, 2026-08-31. Markdown is
  secondary (BLZ-588) and must share CSV's validator, not reimplement it.
- **Export is not optional** (BLZ-589). An importer you cannot export from is unverifiable, and it
  is the only honest basis for Q3.
- **Dry-run is the default** for any import (BLZ-587), and staging is file-scoped — `blaze
  migrate`'s `git add -A` is the anti-pattern, named in its own docs.
- **`blaze-pm` is not deleted until Q3's criterion passes.** It holds 2,815 tickets.

---

## 4. State to re-verify before you start — do not take these as gospel

```
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git log --oneline -1 origin/main
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres
npm ci && node --test 2>&1 | tail -9
```

At the time of writing: `blaze` main **`168c5f9`**, suite **4,411 pass / 0 fail / 395 suites**,
coverage 98.48 / 88.28 / 97.35. Board **`ok=true`** unscoped — note `--projects BLZ` reports 5 false
`dangling-target` hard findings, which is **BLZ-586**, not corpus damage.

**The queue store is now one per repository** (BLZ-556, ADR-0033). All **210** ops were migrated
into `blaze-pm/.blaze` on 2026-08-31 and verified byte-identical against a pre-migration snapshot —
zero lost, zero duplicated. `blaze commit --status` reports **0 outstanding, 20 orphaned**: every one
of those ops references a file already at HEAD, which is the direct measurement confirming BLZ-500's
finding that **nothing was ever lost** while the flush was silently doing nothing.

Snapshot: `/home/rnamwoh/Documents/Code/blaze-pm-queue-snapshot-20260831-190249` (16 MB).
Originals in `<worktree>/.blaze/migrated-<ts>/`. **Neither has been deleted; do not delete either
until the ops are drained and the drain is verified.**

---

## 5. Constraints carried forward

- **Do not delete `blaze-pm`**, and do not treat any plan as authorisation to.
- **Do not drain the 210 queued ops without checking they are still 0-outstanding first.** They are
  stale today; that is a measured fact with a date on it, not a permanent property.
- **`blaze-pm`'s main checkout is on a feature branch with uncommitted work** — it is the operator's,
  do not switch or clean it.
- **Never run bare `blaze`** — it defaults to `start` and loops forever. Name a subcommand,
  `</dev/null`, under `timeout`.
- **Never `git stash`** — repo-wide, shared across worktrees.
- **The setup token's PATH may be logged; its VALUE never is.** Same for any API token: `blaze user
  add` prints it once and stores only a SHA-256.
- Do not reopen ADR-0001, 0006, 0013, 0021–**0034**. **ADR-0035 is the next free number.**
- Every PR gets an adversarial review in a separate worktree by an agent that did not write it.

## 6. Method, earned the hard way

The BLZ-556/BLZ-566 session ran **nineteen adversarial review rounds and produced nineteen
refutations, every one a real defect. Eight were defects introduced by the fix for an earlier
refutation.** What repeatedly worked:

- **Pin the property, not the spelling.** Three separate fixes closed the enumerated cases and left
  the property open — argv spellings, a partially-swept `readdirSync`, a FIFO sweep that covered
  reads but not writes.
- **Ask what the measurement cannot observe.** It found a data-loss path, an infinite hang, and a
  migration whose verification counted an unreadable file as zero and reported success twice over.
- **Assert the observation happened.** **Six times** a green result turned out to be measuring
  nothing — a relative CLI path, an unread env var, an uncommitted revert baseline, a memoised
  cache, a mismatched test name, TAP parsed against a spec reporter.
- **A hardening that disables the feature it protects is a defect.** A CSP with no `connect-src`
  blocked the sign-in it was added to secure, and passed a test asserting the header was present.
