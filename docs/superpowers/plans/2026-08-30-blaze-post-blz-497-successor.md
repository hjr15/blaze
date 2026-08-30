# blaze — successor kickoff (2026-08-30)

Successor to `2026-08-29-blaze-post-blz-497-kickoff.md`, whose four lanes are **discharged**.
**This document is the work order.** It is self-contained and authoritative: where it contradicts a
chat instruction, follow this.

**It supersedes nothing else.** `docs/superpowers/plans/` contains three other `*-next-session-kickoff.md`
files — dated 2026-08-29, 2026-08-30 and 2026-08-31 — that belong to a **different, older chain** and
are **not yours**. Two of them say "written 2026-08-26" in their own first line despite their
filenames, and the 08-30 file's "supersedes 2026-08-29" points at a document that no longer sits at
that path. **Do not read them as current, and do not write over them** — one kickoff has already been
destroyed that way once. This file carries a descriptive suffix (`post-blz-497-successor`) precisely
so no date-named file can collide with it. Follow that convention.

---

## 1. What happened

The BLZ-489..497 lane closed **10 of 10** tickets across four PRs, and generated **25 more by review**.

> **Three of the four PRs were REFUTED on the first adversarial review, and every refutation was a
> real, silent defect that would otherwise have shipped.**

That is the headline. Not one refutation was a wording quibble; each was a behaviour a user would
have hit:

| PR | Refutation |
|---|---|
| **#155** | `discardSandbox` deleted the tree behind a symlink when the path carried a **trailing separator**. `lstatSync(link)` reports `isSymbolicLink: true`; `lstatSync(link + "/")` reports **false**, because a trailing separator makes the OS resolve the link. The guard read the raw argument while its ancestor/descendant checks read the resolved one — and the test pinned only the bare spelling, so it stayed green over the hole. On a function whose failure mode is `rm -rf` on a working tree. |
| **#156** | A **silent corroboration regression**. `%(refname:short)` renders `refs/heads/origin/<x>` and `refs/remotes/origin/<x>` identically, and `for-each-ref` sorts on the FULL refname — so a stale local branch named `origin/task/…` captured the slot for `task/…` and the real branch stopped corroborating. Baseline `[["INF-1","in-progress"]]`, PR head `[]`, `ok: true`, `gitErrors: []`, nothing on stderr. |
| **#158** | On a board whose `projects/` is a **symlink**, `--status` reported already-filed ops as `outstanding` **permanently** — the over-fire twin of the under-fire that killed design 2, on design 2's own fixture. And its T4 masked it by hand-writing the ledger with the real path, pinning a fixture premise the product falsifies. |
| **#157** | **UPHELD.** The guard was attacked with symlink→FIFO, unix socket, block device, `/dev/zero`, directory, dangling symlink, and 200 consecutive refusals (fd delta 0). Nothing broke. |

**Two lanes caught their own tests as non-evidence before review saw them** — a Live-view test that
matched `/unreadable/` against the whole file and stayed green with the render branch deleted, and a
dead-string assertion that walked past its target because the fix left it line-wrapped. The revert
rule works on the people applying it, not just on the code.

## 2. State

`main` at **`d0f847b`**. Suite **4,261 pass / 0 fail** across **367 suites** (baseline was 4,174 / 347).
Coverage **98.60 / 88.11 / 97.23**. Hygiene clean. Board audit `ok=true` over **2,770** tickets.

**All four PRs merged; all ten tickets `done`. Zero open PRs.**

**`blaze-pm` is 46+ commits unpushed on `BLZ-305-v4-spine` and that is correct** — see §5.

### Merged
| PR | Tickets | Verdict |
|---|---|---|
| **#157** `fd8c31d` | BLZ-493 | UPHELD first round |
| **#156** `2951570` | BLZ-492, BLZ-495, BLZ-489, BLZ-494 | refuted → fixed → merged |
| **#155** `21ceb42` | BLZ-490, BLZ-491, BLZ-496, BLZ-497 | refuted → fixed → rebased → merged |
| **#158** `d0f847b` | BLZ-432, BLZ-499 | refuted → fixed → red on combined state → fixed → merged |

### Nothing is open. Start at the backlog below.

### `strict: true` earned its keep — do not disable it

After #155 merged, #158 was brought up to date and **`test` went red on the combined state**:

```
✖ every mkdtempSync call under tests/ lands in a named bucket — nothing is dropped
  + [ 'tests/commit-status.test.mjs:43  const root = mkdtempSync(join(tmpdir(), prefix));' ]
```

#155 added a scan asserting every `mkdtempSync` under `tests/` has a **statically readable** prefix;
#158 added a new suite passing a **variable**. **Neither branch fails alone.** A clean textual merge
with a broken build — precisely the semantic conflict `strict: true` exists to catch, and the reason
the bundling skill says never to disable it to save minutes.

It also settled a question the review had only argued: BLZ-491's convention was claimed not to "rot
silently on a new suite", and it caught a genuinely new suite **within the hour, unprompted.** That
is better evidence than any review could have produced. The fix was to inline the literal — **not**
to except the new suite from the scan.

### The backlog: 24 tickets `defined`, 665 minutes

| Pri | Count | Minutes |
|---|---|---|
| **high** | 2 | 70 |
| medium | 8 | 360 |
| low | 14 | 235 |

**The two `high` ones are where to start, and they are related by a single idea: a figure nobody can
reproduce is not a figure.**

- **BLZ-505 (40)** — `tests/reconcile-finding-surfaces.test.mjs` points `origin` at
  `https://github.com/hjr15/service-platform.git` at **four** sites and runs with `--fetch`, pulling
  **26 live branches** into the fixture. Pre-existing on `main`, not introduced by this lane. But
  **BLZ-492's headline "52 occurrences" figure — quoted in the ticket, the PR body and the previous
  work order — is 26 live remote branches × 2 fixtures.** It is honest as a one-day diagnostic and
  **must not be quoted as a reproducible constant.** ADR-0024 says pin every figure to a SHA; a figure
  that also depends on another repository's mutable branch list is not pinned by a SHA at all.
  **Done 2026-08-30 (BLZ-505): the fixtures build their own origin, and the figure re-derives as
  21 and 20 at `be4b110` — 67 and 66 with the live remote still in place, so it had already moved.**
- **BLZ-500 (30)** — the `blaze-flush` CronJob appears not to be draining every queue: **185 ops
  across 8 of 14 queues, aged 2–5 days, five nightly runs passed over them.** Undiagnosed.
  **Do not drain the queues before diagnosing** — they are the only evidence, and 67 of the 185 are
  un-characterised, so a blind sweep commits content nobody has inspected. Capture the ledger state
  to a file first. This refusal is recorded on the ticket.

Then the `medium` band. **BLZ-512 (90)** is the largest and its scoping sentence has already been
corrected once: three of its sites (`commit-lock.mjs:14`, `pending-ledger.mjs:69/85`,
`setup-token.mjs`) are **on** the shared path, not off it, and `commit-lock.mjs:14` is an **eleventh
hang** the original inventory missed. `setup-token.mjs` is on the **pre-auth** surface — treat it as
the highest-priority member. **Re-derive the site list; the "~20" came from an inventory now shown to
miss one site and misclassify three.**

## 3. How to work — this is what produced the results above

**Every PR gets an adversarial review before merge, in a SEPARATE worktree with its own Postgres,
by an agent that did not write the branch.** Scope it to **PRODUCT BEHAVIOUR** — correctness, vacuous
tests, the board overstating, the pre-auth surface, blast radius. **Wording, figures and
test-machinery findings are recorded in the PR body and TICKETED — never fixed-and-re-reviewed.**

**The rule that keeps earning its keep:** *revert the production hunk the test claims to pin, and
watch THAT NAMED test go red for the reason its name gives.* Three refinements this lane proved:

1. **Pin the property, not the spelling.** Both #155 and #158 were refuted on tests that covered one
   spelling of a guard. After fixing #155, the informative revert row is the one where the **old**
   test stays green under a narrow revert while the new one goes red — that green row is the proof the
   hole existed.
2. **Two guards sharing one helper look pinned when only one is exercised.** #158's diff-probe throw
   was unpinned because the test's failing-git stub was intercepted by the *first* probe. Revert each
   guard **separately**.
3. **Test the case that passes by accident.** #156's round 2 covered *both* sides of the ordering
   boundary — including the name round 1 got right for the wrong reason.

**A measurement can be structurally blind, and that is worth more than the number.** #156's original
corroboration delta was taken over a suite in which **zero of 259 `buildBranchMap` invocations involve
a branch named `origin/*`** — it could not have seen the regression. When a measurement clears a
change, ask what it was incapable of observing.

**Measure before any severity or behaviour change** (BLZ-353); **pin every figure to a SHA**
(ADR-0024) — and see BLZ-505 for why a SHA is not always enough.

**State reachability plainly.** A guard no current call path can reach cannot be killed by any
mutation and must be described that way. This lane did it three times correctly
(`panel-content.mjs:84`, `discardSandbox`'s guards, `inspect`'s `rev-parse` opt-in) and each was
independently verified.

**Two operational lessons, both mine to own:**

- **Do not let coverage gate a review report.** Two of three reviewers stalled by backgrounding a
  coverage run and waiting on it, having already established their verdict. Tell reviewers: report
  the verdict first, append coverage after. The full suite passing at the claimed count is the
  stronger half of the gate anyway.
- **A demo script with a hardcoded absolute import silently re-tests the same tree.** Running
  #156's counterexample from a different cwd "disproved" a real regression. Repoint the import per
  tree, and print which tree you actually loaded.

Standing rules: `blaze` skill for every tracked item (ticket at create **with parent and estimate**;
branch `KEY-n-slug`; commits and PR title `KEY-n: description`; `blaze log` before a terminal move —
bare number). One commit per body of work; the message names everything in the diff. Docs update in
the same effort.

**`KEY-n + N more:` is confirmed working.** `2951570` carried five `* BLZ-n:` bullets under a
`BLZ-492 + 3 more:` subject and BLZ-469 reads them as a manifest. A RANGE still claims nothing.

## 4. Constraints — non-negotiable

- **Do NOT push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole merger.
  Work there ends at a **local commit**. **43+ unpushed is correct.** Measure it against
  `origin/BLZ-305-v4-spine`, **not** `origin/main` — against `main` it reads ~190, which is a
  different base and has already been misreported once as "the kickoff is stale".
- **The board's working branch is `BLZ-305-v4-spine`**, in `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`.
- **One writer for the board.** With parallel lanes, the coordinator should own **all** `blaze`
  board operations and let lane agents report tickets to file instead. Four agents writing one
  board worktree is how index-sweep and branch-collision bugs happen.
- **Do NOT run `blaze schedule migrate-dates --write`** against the live board.
- **Never run bare `blaze`** — with no subcommand it defaults to `start` and runs the loops forever.
  Always name a subcommand, always `</dev/null`, always under `timeout`.
- **Do NOT touch the NCA project** (parked by the operator 2026-08-23).
- **Do NOT "fix" `provider`** in `blaze-pm/blaze.config.json` — it self-resolves at the flush.
- **Do NOT reopen** ADR-0001, ADR-0014's ruling, ADR-0021, ADR-0022's decision, ADR-0023, ADR-0024,
  ADR-0025, ADR-0026, ADR-0027, ADR-0028, ADR-0029, **ADR-0030**, **ADR-0031** (what a read that
  refused to open reports, per site) or **ADR-0032** (a queued write is a fact blaze recorded, not a
  shape git reports). Build ON them. **ADR-0033 is the next free number.**
  Note **BLZ-520**: ADR-0031's *reachability record* for the schema-config site is wrong (it is
  `blaze new`/`edit`, not the audit's schema layer). Correct the record; the decision stands.
- The setup token's **PATH** may be logged; its **VALUE** never is, anywhere, ever.
- Never accept a secret pasted into chat; never base64-decode a Kubernetes secret value.
- **One agent per worktree. Never let a reviewer and a fix agent share one.** Every concurrent agent
  gets its own Postgres container and port.
- **Never `git stash`** — repo-wide and shared across worktrees.
- **Scan for file overlap before declaring lanes disjoint.** The previous work order called Lanes C
  and D disjoint; they both touched `tests/reconcile-project-filter.test.mjs` and
  `tests/walk-unreadable-dirs.test.mjs`, and `git merge-tree` showed a real conflict. Run
  `git merge-tree --write-tree --name-only <a> <b>` before dispatching, and sequence the merges so
  one branch absorbs the rebase.
- **Do NOT disable branch protection's `strict: true` to save CI minutes.** A textual-overlap scan
  would NOT have predicted the #155/#158 conflict — the two branches shared no file. Only running
  the suite against the combined state catches that class. Every concurrent PR after the first pays
  one update-and-re-run; that cost is the feature.
- **When a new cross-cutting guard lands, the next branch to touch that area will trip it — and the
  fix is to satisfy the guard, not to except the tripping suite.** Excepting is how a guard that
  works becomes a guard that reads as working.

## 5. Environment

- Node 24 is **not** on the default PATH: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`.
  Omitting it makes every test file fail to load, which a naive runner scores as success.
- **A fresh worktree has no `node_modules`.** Run `npm ci` in each one. All four lanes hit this.
- **Three distinct red-suite signatures — do not confuse them:**
  | Signature | Cause |
  |---|---|
  | total **unchanged** from baseline | unreachable Postgres |
  | total **lower** than baseline, load errors | missing `node_modules` |
  | total **higher**, with failures | a real regression |
- Postgres containers are `blzpg-<port>`, password **`x`**:
  `docker run --rm -d -e POSTGRES_PASSWORD=x -p <port>:5432 --name blzpg-<port> postgres:17-alpine`
  then **block until `docker exec blzpg-<port> pg_isready -U postgres` succeeds** before exporting
  `BLAZE_TEST_PG_URL`. `pg_isready` is **not** on the host PATH.
- **Any test for a blocking-read shape must run in a CHILD PROCESS with a hard wall-clock limit.**
  `node:test`'s `timeout` is an event-loop timer and a synchronous `readFileSync` never yields to it.
  `tests/read-path-fifo.test.mjs` and `tests/walk-unreadable-dirs.test.mjs` have working harnesses.
  Note **BLZ-522**: the 15 s cap SIGTERMs a healthy child under multi-agent load.
- **CI checkouts are shallow, single-branch and detached.** A guard that resolves a git ref locally
  passes on every developer machine and fails in CI. Key on `--is-shallow-repository`.
- Gate before every push: full suite, `node scripts/ci/hygiene-check.mjs origin/main`,
  `npm run test:coverage`. `hygiene-check.mjs` fails on `Co-Authored-By:` trailers and on absolute
  `/home/...` paths in added non-Markdown lines.
- **When merging, assert on the check RESULT, not the absence of `pending`** — and assert the checks
  ran on the **head SHA you are merging**, not an earlier push.
- `blaze audit --json` truncates at 64 KB when piped. Redirect to a file.
- **`gh pr merge --delete-branch` fails if a worktree holds the branch.** Harmless; the merge still
  lands. Verify with `gh pr view <n> --json state,mergedAt` — never treat a silent merge as confirmed.

## 6. Definition of done

The `high` pair (**BLZ-505**, **BLZ-500**) closed or consciously deferred with a reason; `main` green
on the full gate; and a successor kickoff written if anything is left.

**Do not narrow the lane on your own.** If you run out of room, leave the next lane untouched and say
which one it is.

**Expect the count to grow.** This lane closed 10 and opened 25. That is the process working, not
failing — but it means "finished" is a judgement about the remaining tickets' severity, not about
reaching zero. On that judgement: **nothing in the current backlog is a live data-loss or
correctness risk to a user's board.** The two `high` items are about the trustworthiness of
measurements and of the flush; the `medium` band is hangs on paths no current call reaches, plus
robustness. It is a good place to stop, if you need one.
