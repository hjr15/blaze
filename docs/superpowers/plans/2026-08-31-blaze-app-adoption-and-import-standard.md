# blaze — build out to the app, then retire blaze-pm (2026-08-31)

**If you are a session reading this, your task is §3 — run the phases in order.** You need no
further instruction to begin.

This replaces an earlier draft that was a decision brief. **The decision is made: we are still
building out.** Migration and repo retirement are the *last* phase, not the next one, and §1 is why.

**It supersedes nothing else.** `docs/superpowers/plans/` holds several older `*-kickoff.md` files
from unrelated chains. **Do not read them as current and do not write over them** — a kickoff has
been destroyed that way once. Descriptive filenames, never date-only.

---

## 0. Continuity contract

A usage, context or API limit is a **PAUSE, not completion.** Do not stop, do not mark anything
done, do not hand back early. **Commit WIP freely on your lane branch**; squash to one commit per
ticket before the PR. Resume from the branch plus the ticket's own acceptance-criteria checkboxes.
**Verify tree state, never trust a report** — including this document's.

**Stop rule.** Finish the phase you are in, then stop and write a successor if ANY of: context is
running short, a lane has been refuted **twice on the same ticket**, or you have merged the phase
you are in. Stopping cleanly with a written handoff is a success. Phase 4 must not begin with less
than roughly half your context left.

## 1. Where the product actually is

**`blaze-pm` is not a legacy store the app reads from — it IS the app's storage.** The filesystem is
the write path; the markdown under `projects/` *is* the records. So "import into the app" today
means writing markdown into `blaze-pm`, and deleting `blaze-pm` deletes **2,815 tickets**.

The chain to the operator's goal:

| Ticket | What | Status |
|---|---|---|
| **BLZ-254** | *"cut the live board over to the database and retire the git write path"* | **`defined`** — not started |
| **BLZ-309** | v4 migration from v3 | `in-progress`, **BLOCKED on BLZ-254** |
| **BLZ-324** | migrate requirement/architecture tickets, zero-diff oracle | `defined` |

BLZ-254's own body: *"**This is where the value lands** — everything before it is scaffolding."*
BLZ-309's: *"cannot start until the db-primary Phase 2 cutover lands. A `document`/`artifact_usage`
model has no status directory, so the filesystem write port cannot represent it at all."*

**Backlog shape:** 386 done. **144 non-terminal** — 0 critical, **13 high**, 94 medium, 37 low.
BLZ-305 (v4 spine) has **22 of 23 children done**; the one that is not is BLZ-309.

**Testing is uneven, and the gap is on the side that matters for a cutover.** The engine is
genuinely covered — 4,411 tests, 395 suites, coverage 98.48 / 88.28 / 97.35 against gates of
91/77/93/91, TDD with the revert rule. The infrastructure is not: **BLZ-567** records that the
flush harness *stubs the very verb it claims to test*, and no E2E proves the board serves
in-cluster. That is how `"provider": "github"` — a removed config key that killed the process
**after** it bound the port — reached production.

## 2. Definition of done for this whole effort

1. The database is the write path and the filesystem port is retired (**BLZ-254**).
2. v3 artefacts are migrated with a **zero-diff oracle** (**BLZ-309**, **BLZ-324**).
3. CSV import and matching export exist, with a **zero-diff round trip in CI** (**BLZ-587/588/589**).
4. The infrastructure test gap is closed (**BLZ-567**) — no harness stubs the verb it tests.
5. The retirement criterion in §6 **passes**, and only then is `blaze-pm` archived.

---

## 3. Phases, in order

**The order is a dependency order, not a preference.** Phase 4 cannot start before phase 1 merges.

### Phase 1 — make the engine safe to build on (the 13 highs, minus the blocked ones)

These are open defects in code the cutover will sit on. Landing the cutover on top of them means
debugging two things at once.

| Ticket | What |
|---|---|
| **BLZ-531** | `blaze commit` permanently destroys an unparseable ledger line when it drains the queue that held it. A WIP fix exists at `origin/BLZ-518-partial-ledger-quarantine-wip` (`f803747`) and was **refused merge twice** — it must land with the `try/finally`, the totals fix, a property-pinned `518f`, and the ADR-0031 guard on the sidecar. |
| **BLZ-534** | The full suite can hang **forever** on `tests/model/driver-conformance.test.mjs`; `--test-timeout=0` means nothing ends it. Intermittent — reproduced once, not reproduced in ~10 later runs. **In CI a hang is indistinguishable from a slow run.** |
| **BLZ-535** | The write-seam guard pins a **spelling** (`writeFileSync(`/`renameSync(`), so a live `appendFileSync` in a non-allowlisted file passes. This is why the FIFO defect shipped. Do with **BLZ-521** — same class, two seams. |
| **BLZ-537** | `appendRegularFileSync`'s `isFile()` comment makes a false shape claim. |
| **BLZ-558** | `queueops=` omits the legacy shared fallback ledger `--all` drains, so it can read `absent` while ops are queued. |
| **BLZ-570** | The pre-auth CSP test pins the directive string, not the origin the script calls. |
| **BLZ-571** | No rate limit or backoff on `POST /signin`. Needs a **decision** on shape first — per-source with a trusted-proxy config, or explicitly the edge's job. |

**Files:** `scripts/pending-ledger.mjs`, `scripts/commit-runner.mjs`, `scripts/model/regular-file.mjs`,
`scripts/model/signin.mjs`, `tests/model/seam-closure.test.mjs`, `tests/model/driver-conformance.test.mjs`.

### Phase 2 — close the infrastructure test gap (BLZ-567)

Do this **before** the cutover, not after. A cutover verified by a suite that stubs its own verbs
is not verified.

- An **E2E that drives the real engine image** against the rendered chart and asserts the board
  *serves* — setup mode (`/setup` 200, everything else 503) and authenticated (401 without a
  credential, 200 with one).
- The flush test exercises the **real** `blaze commit`, not a PATH stub, so a config the engine
  rejects fails the test.
- A test that the queue store is reachable **through the mount**, failing if the hostPath is absent.
- Fixtures use dummy data. **Never the live board, never a real credential**, and the queued ops are
  never touched.

### Phase 3 — CSV import and export (BLZ-587, BLZ-588, BLZ-589)

Buildable now and largely independent of the cutover — **but see Q1 in §5 first**: target the
**model layer**, not the filesystem write port, or this becomes disposable at cutover.

**BLZ-589 is not optional and not last.** An importer you cannot export from is unverifiable, and
its zero-diff round trip is the only honest basis for §6's retirement criterion. Sequence it
**alongside** BLZ-587, not after.

**Get a real sample first** — see Q2. A schema designed without one is a guess.

### Phase 4 — the cutover (BLZ-254 → BLZ-309 → BLZ-324)

**Do not start with less than roughly half your context left.** This is the phase where the value
lands and the phase with the least margin for a half-finished state.

Answer §5's questions **before** writing code. BLZ-254 first, alone; BLZ-309 and BLZ-324 follow it.

### Phase 5 — retirement, only after §6 passes

Migrate the operator's real issues, then archive `blaze-pm`. **Not before §6's criterion passes.**

---

## 4. Also outstanding, sequence where they fit

**The flush cluster** — BLZ-525 (mount, deployed but *necessary not sufficient*), BLZ-527, BLZ-528.
As of 2026-08-31 the CronJob **fails every night by design**: `blaze-pm`'s main checkout is on
`BLZ-143-…`, 89 behind `main` with 10 dirty files, so the `HEAD === "main"` gate skips and BLZ-526
made that loud. ArgoCD shows `Degraded`. **That is the fix working.** It resolves when the checkout
moves to `main` or the mount is repointed — and **phase 4 may retire the flush entirely**, so
decide whether to finish these or supersede them rather than letting them rot (Q5).

**Migration residuals** — BLZ-572 (resume double-appends across a shared destination; latent, no
two non-store copies share a filename today), BLZ-573 (`assert_engine_agrees` discards the exit code
BLZ-556 *created*), BLZ-574 (the **60-second stale lease** steals the store lock from a live owner —
benign with separate queues, corrupting with one store).

**Sign-in follow-ups** — BLZ-575 (no way to list or revoke another user's sessions), BLZ-576
(`identity.db` has no schema-version marker), BLZ-577 (the generic `unknown flag` echo survives in
~14 other runners), BLZ-578 (the board page carries no CSP at all).

**BLZ-586** — `blaze audit --projects X` reports cross-project links as **hard** `dangling-target`
findings. Unscoped the same corpus is `ok=true`. It would permanently fail a per-project CI gate.

---

## 5. Questions to answer before the phase they gate

**Q1 (gates phase 3).** Which write port does CSV import target? Through the model layer it survives
the cutover unchanged; against the filesystem port it is disposable. **Record the answer.**

**Q2 (gates phase 3).** What is actually being imported? Which tracker, how many, which fields,
whether links/parents/attachments/history come too, whether ids must be preserved. **Nobody has seen
a sample. Get one — even 20 rows — before designing the schema.**

**Q3 (gates phase 5).** See §6.

**Q4 (gates phase 5).** **What happens to 371+ commits of board history?** A cutover keeping only
current state discards the audit trail. Migrate it, keep the repo read-only in perpetuity, or accept
the loss — deliberately. **This is the question most likely to be discovered late and regretted.**

**Q5 (gates phase 4).** Does the flush survive the cutover, and in what form? If the database is
primary, what merges concurrent writers?

**Q6 (gates phase 4).** What is the rollback, and what does "the dual-write soak passed" mean
**numerically**? Establish it before relying on it.

## 6. The retirement criterion — write it before you need it

**Not a date. A test.** `blaze-pm` is archived only when:

1. Export the whole corpus from the database and from `blaze-pm` in the same schema (BLZ-589);
   **`diff` is empty.**
2. The ticket count matches exactly — **2,815** at the time of writing; re-derive it.
3. Every link resolves in the database corpus; `blaze audit` is `ok=true` **unscoped and scoped**
   (needs BLZ-586).
4. Q4 is answered and its answer is executed, not merely decided.
5. The queued-ops store is empty or explicitly accounted for.

**A non-empty diff means not ready.** Do not relax the criterion to fit a schedule — write it down
first precisely so it cannot be.

## 7. State to re-verify — do not take as gospel

```
cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git log --oneline -1 origin/main
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
export BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55481/postgres   # your own port
npm ci && node --test 2>&1 | tail -9
```

`blaze` main **`168c5f9`**; suite **4,411 pass / 0 fail / 395 suites**; coverage 98.48 / 88.28 /
97.35. Board **`ok=true`** unscoped. Deployed image digest matches the git pin, so both engine
changes are live.

**The queue store is one per repository** (ADR-0033). All **210** ops were migrated into
`blaze-pm/.blaze` on 2026-08-31 and verified **byte-identical** against a pre-migration snapshot —
zero lost, zero duplicated. `blaze commit --status`: **0 outstanding, 20 orphaned** — the direct
measurement confirming BLZ-500's finding that **nothing was ever lost** while the flush was silently
doing nothing. **The ops are consolidated but NOT drained.** Snapshot at
`blaze-pm-queue-snapshot-20260831-190249`; originals in `<worktree>/.blaze/migrated-<ts>/`.
**Delete neither until a drain is verified.**

## 8. Constraints — non-negotiable

- **Do not delete `blaze-pm`**, and treat no plan as authorisation to.
- **Do not drain the 210 ops without re-checking they are still 0-outstanding.** That is a measured
  fact with a date on it, not a permanent property.
- **`blaze-pm`'s main checkout is on a feature branch with uncommitted work.** It is the operator's —
  do not switch, clean or commit it.
- **Never run bare `blaze`** — it defaults to `start` and loops forever. Name a subcommand,
  `</dev/null`, under `timeout`. **Never `git stash`** — repo-wide, shared across worktrees.
- **The setup token's PATH may be logged; its VALUE never is.** Same for any API token — `blaze user
  add` prints it once and stores only a SHA-256. **An error message is an output channel.**
- Do not reopen ADR-0001, 0006, 0013, 0021–**0034**. **ADR-0035 is the next free number.**
- **One writer for the board.** With parallel lanes the coordinator owns all `blaze` board ops.
- **Every PR gets an adversarial review in a separate worktree**, by an agent that did not write it,
  scoped to product behaviour. Wording and test-machinery findings are **ticketed, not
  fixed-and-re-reviewed**.

## 9. Method — earned across nineteen refutations

The BLZ-556/BLZ-566 session ran **nineteen adversarial review rounds and produced nineteen
refutations, every one a real defect. Eight were defects introduced by the fix for an earlier
refutation.**

- **Pin the property, not the spelling.** Three separate fixes closed the enumerated cases and left
  the property open — argv spellings, a partially-swept `readdirSync`, a FIFO sweep covering reads
  but not writes.
- **Ask what the measurement cannot observe.** It found a data-loss path, an infinite hang, and a
  migration whose verification counted an unreadable file as zero and reported success **twice**.
- **Assert the observation happened.** **Six times** a green result was measuring nothing — a
  relative CLI path, an unread env var, an uncommitted revert baseline, a memoised cache, a
  mismatched test name, TAP parsed against a spec reporter. **Check a positive control before
  trusting a negative.**
- **A hardening that disables the feature it protects is a defect.** A CSP with no `connect-src`
  blocked the sign-in it secured — and passed a test asserting the header was present.
- **State reachability plainly**, and check that "unpinnable" is not merely "unpinned".
- **The revert rule**: revert the production hunk the test claims to pin and watch **that named
  test** go red **for the reason its name gives**.
