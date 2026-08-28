# blaze — successor kickoff (2026-08-28)

Successor to `2026-08-27-blaze-followup-lane-kickoff.md` (merged as `5167ae0`). That document
was the work order for BLZ-401..407. **This one is the work order for what that lane left
behind.** It is self-contained and authoritative: where it contradicts a chat instruction,
follow this.

`main` is at `245973d`. Suite **3,811 pass / 0 fail** (308 suites), hygiene clean, coverage
**98.49 / 87.73 / 97.24 / 98.49**, all 17 schedule mutations killed, smoke OK, board-gate
12/12. **Zero open PRs.**

## 0. What the previous lane actually shipped

All seven tickets are `done`; five PRs merged in the required order.

| PR | Tickets | Merge | Review rounds |
|---|---|---|---|
| #136 | BLZ-404, BLZ-405 | `778e336` | 4 |
| #135 | BLZ-402 | `e514575` | 4 |
| #137 | BLZ-407 | `0d8b217` | 1 (upheld first time) |
| #138 | BLZ-403 | `934c94a` | 3 |
| #139 | BLZ-401, BLZ-406 | `245973d` | 2 |

Decisions landed in the artifact that enforces them: **ADR-0024** (new — audit and the load
path agree on a malformed schema override) and **ADR-0023 §5, §6, §7** (terminal record,
change entry, project mismatch).

Three ground-truth oracles were built before their fixes and each was proven non-vacuous by
re-introducing the defect it exists to catch:

| Oracle | Cross-product | Ground truth |
|---|---|---|
| `tests/reconcile-feed-truth-oracle.test.mjs` | 336 tickets, 1,568 clauses | the filesystem |
| `tests/schema-audit-load-agreement-oracle.test.mjs` | 961 cases, 5,766 clauses | `assertSchemaValid`'s actual throw |
| `tests/reconcile-change-report-oracle.test.mjs` | 113 tickets, 1,494 assert-sites | filesystem + `git log`, driven through the real CLI |

**A caution for whoever runs the gate next.** A run of `node --test` on this tree reported
`3811 tests / 3739 pass / 72 fail` and the 72 were **not real**. `BLAZE_TEST_PG_URL` was
exported while no server was listening on the port, and by design (`2026-08-22-blaze-v4-spine.md`)
the Postgres blocks *fail* rather than skip when the variable is set. The container
`blzpg-55461` did not exist; `docker start` on a missing container fails silently when its
output is discarded. **Confirm `pg_isready` returns before trusting a red run**, and treat an
identical total-test count across a red and a green run as the signature of this artefact
rather than of missing coverage.

## 1. The goal

Close the **32 follow-up tickets** raised as recorded-not-blocking findings during the
BLZ-401..407 lane — **BLZ-408 … BLZ-439**. All are in `defined/`, all are `priority: medium`,
none is blocked. 25 tasks, 6 bugs, 1 story. Total estimate **655 minutes**. 23 sit under
BLZ-43, 9 under BLZ-51.

They were recorded rather than fixed **on purpose**: §3 of the previous work order requires
that wording, figures and test-machinery findings be ticketed instead of fix-and-re-reviewed,
because that scoping is what let the reviews find real defects. This lane is where that debt
is paid.

Two themes carry most of the product risk:

- **The board still overstates in three places** the last lane did not reach (Lane A below).
  This is the same defect class as BLZ-404 and BLZ-405 — a consumer rendering a refusal as a
  clean result, and a CLI claiming a commit that is not in `git log`.
- **Several oracles do not assert their own size.** An oracle that prints a clause count but
  never asserts it will silently shrink when a dimension is deleted — which is precisely the
  vacuity failure mode the oracles were built to prevent. Lane B closes that hole.

## 2. Lanes, in order. Do them in this order.

### Lane A — BLZ-426 + BLZ-422 + BLZ-427, ONE feature PR: "the board still overstates" (75 min)

The unfinished half of the last lane's Lane A. **Highest product value in this document.**

- **BLZ-426** — `serve.mjs`'s dashboard still renders a refused reconcile preview as an
  in-sync board. #136 fixed `reconcilePreview()` to return `{ok:false,error,changes:[]}`, but
  the HTML consumer treats an empty `changes` array as "nothing to do". A refusal and a clean
  board are still indistinguishable to the person reading the dashboard.
- **BLZ-422** — `commitFile`'s benign empty-diff no-op is reported as `committed`, so the CLI
  can claim a commit that is not in `git log`. This is a false delivery record, one layer
  below BLZ-403's.
- **BLZ-427** — `blaze commit`'s summary counts ops rather than tickets and has no label entry
  for `reconcile`.

**Build the oracle first.** All three make the product assert something. Enumerate
`{reconcile outcome} × {commit outcome} × {consumer}` and compare every rendered sentence to
filesystem + `git log` ground truth. Prove it non-vacuous by re-introducing each of the three
defects and confirming the named test goes red for the reason its name claims.

### Lane B — BLZ-414, 415, 420, 421, 423, 431, 435, 437, 438, 439, ONE PR: oracle integrity (165 min)

Ten findings against the test machinery itself. Do them together — they share a fix shape.

- **Unasserted size**: BLZ-415 (schema-agreement oracle prints its clause count, never asserts
  it), BLZ-420 (feed-truth oracle's cross-product size unasserted — deleting a dimension
  silently shrinks it), BLZ-437 (change-report banner says "assertions executed" but counts
  assert-sites reached, understating by 8 — the honest figure is 1,502 against a printed 1,494).
- **Unreached cases**: BLZ-414 (claims one shape per hard/soft call site but never exercises
  two soft link-type sites), BLZ-421 (the preview half cannot detect an overstated `cleared`
  flag), BLZ-439 (queued commit mode exercised only on an unfiltered run, never a scoped one),
  BLZ-435 (the `project-mismatch` finding has no negative side, so a guard firing on a
  well-filed ticket goes uncaught in its own suite).
- **Weak assertions**: BLZ-423 (`reconcile-per-type`'s de-vacuity reads `reconcile`'s own
  return rather than `git log` — it trusts the thing under test), BLZ-431 (the blast-radius
  test voids the run result, so it kills an unscoped *write* but not an unscoped *report*),
  BLZ-438 (`assertSummaryLine` validates only the first match of an unanchored regex, so a
  doubled summary line goes unpinned).

BLZ-423 and BLZ-431 are the two that matter most: both are oracles trusting the subject
instead of an independent source.

### Lane C — BLZ-410 + BLZ-413 + BLZ-408, 409, 411, 412, 419, ONE PR + a decision (135 min)

Key-validation debt from #135. **BLZ-413 is a decision, not just a fix.**

- **BLZ-410** — `BLAZE_KEY=""` is discarded rather than refused, so the file key silently
  wins. An empty override is a caller error, not an absent override.
- **BLZ-413** — `blaze init` uppercases a project key while `blaze new` refuses it, and the
  asymmetry is undocumented. **Decide: converge or document.** Record the ruling in an ADR or
  in ADR-0023's successor — not only in chat. Do not pick the option that is less work.
- **BLZ-419** — eight of eleven per-runner key refusal guards are pinned by no test in the
  suite. Note plainly in the commit which of those guards **no current call path can reach**;
  a guard no mutation can kill must not be described as pinned.
- BLZ-408 (`assertValidKey` names a `project` argument for callers passing ticket frontmatter),
  BLZ-409 (a 90-word regex rationale for what is usually a typo), BLZ-411 (a key-validation
  test pins `idsFromSubject` rather than the guard), BLZ-412 (a test name claims a `blaze`
  refusal but asserts only the exception class).

### Lane D — BLZ-430, 436, 425, 428, 429, ONE PR: reconcile and config edges (85 min)

- **BLZ-430** — a submodule under a project directory makes `listTickets` throw
  "missing frontmatter" on its README. A whole board becomes unreadable because of a
  neighbouring directory.
- **BLZ-436** — `reconcile --project`'s blanket `doesNotMatch` is now inconsistent with
  BLZ-406's deliberate narrowing. Reconcile the two or say which one is intended.
- **BLZ-425** — a direct `supervisor` run under `BLAZE_READONLY` would publish an undeduped
  error event every tick.
- **BLZ-429** — a null-valued removed config key is now a hard `config-unloadable`. **This is
  a severity flip the #135 PR body never enumerated.** Measure the live board before changing
  it again; BLZ-353's lesson applies.
- **BLZ-428** — `checkSchemaVersion`'s `kind` tag is unasserted on the two branches that are
  unreachable until `MIN_SCHEMA_VERSION` is raised. Say so rather than implying it is pinned.

### Lane E — BLZ-432, its own PR: the uncommitted-tree monitor (120 min, `type: story`)

The largest single item, and the one deliberately deferred. `reconcile` does not notice a
ticket tree left uncommitted by an earlier pass.

**This is a design question, not a fix.** Three prior designs were rejected during #136, and
the rejections are the most valuable input here:

1. A `dirtyTicketPaths` recovery sweep — **rejected.** It swept a human's `NOTES.md` and
   another project's files into a reconcile commit, violating BLZ-394's blast-radius rule,
   and it reintroduced a porcelain path parser that BLZ-347 deliberately deleted.
2. A detect-and-report boolean — **rejected.** It conflated a failed prior commit, a
   batch-queued-by-design state, and a human's own in-flight file, and it under-fired when
   `projects/` was a symlink.
3. A cross-pass detector — **deleted entirely**, and only the over-claiming "already in sync"
   wording was corrected, which is why BLZ-433 exists.

Do not re-propose 1 or 2. Whatever is chosen, **write the decision into an ADR**, and
distinguish the three states above rather than collapsing them into one boolean.

### Lane F — BLZ-417, 433, 434, 416, 418, 424, ONE PR: docs and wording (75 min)

- **BLZ-417** — ADR-0024 pins its board measurement to a moving branch rather than a SHA,
  against the repo's own rule. Fix to a SHA.
- **BLZ-433** — four comments quote reconcile's old "already in sync" wording that the product
  no longer emits.
- **BLZ-434** — the dirty-tree remediation offers `blaze commit` first without saying it only
  applies to a batch queue.
- BLZ-416 (a cross-project duplicate-schema finding carries no project name in its detail
  text), BLZ-418 (`AGENTS.md` says nothing called either schema path for years, but
  `assertSchemaValid` arrived with BLZ-56), BLZ-424 (reconcile's empty-string `hadRecord`
  comment overstates its symptom as a commit per tick).

## 3. How to work — unchanged, and it is still the part that matters

**Every PR gets an adversarial review before merge, and SCOPE EACH REVIEW TO PRODUCT
BEHAVIOUR** — correctness, vacuous tests, the board overstating, the pre-auth surface. Record
wording, figures and test-machinery findings in the PR body and ticket them; do not
fix-and-re-review them. *This document exists because that rule was followed.*

**When a change makes the product ASSERT something, test the assertion against ground truth
over a GENERATED CROSS-PRODUCT, not hand-picked examples**, and **prove the oracle non-vacuous
by re-introducing each historical defect and confirming it catches them.** Lane A makes the
product assert things. Build the oracle first.

**An oracle must not read the subject under test for its ground truth.** BLZ-423 and BLZ-431
are both instances of this; do not add a third.

**A guard no current call path can reach cannot be killed by any mutation.** Say so plainly in
the commit rather than implying it is pinned. Directly relevant to BLZ-419 and BLZ-428.

**TDD.** Tests red before implementation, and mutation-verify every guard: revert the
production hunk, watch the NAMED test go red for the reason its name claims.

**Measure before any severity change.** BLZ-429 is a severity flip that shipped unenumerated.
The live-board measurements taken last lane: 0 schema problems and 0 project mismatches across
2,655 tickets; 73 ambiguous terminal records, of which exactly 1 (OBA-773) falls outside its
candidate set.

Other standing rules: `blaze` skill for every tracked item (ticket at create with parent and
estimate; branch `KEY-n-slug`; commits and PR title `KEY-n: description`; `blaze log` before a
terminal move — it wants a bare number, not `90m`). One commit per body of work. Docs update in
the same effort, never as a follow-up.

## 4. Constraints — non-negotiable, unchanged

- **Do NOT push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a **local commit**. Unpushed commits are correct — do not "fix" it.
- **The board's working branch is `BLZ-305-v4-spine`, not `main` and not the checked-out
  branch.** A `blaze-pm` working tree left on `BLZ-143-engineering-method-and-work-item-model`
  will show every BLZ-4xx ticket as missing. Confirm the branch before concluding a ticket
  does not exist.
- **Do NOT run `blaze schedule migrate-dates --write`** against the live board.
- **Do NOT touch the NCA project** (parked by the operator 2026-08-23).
- **Do NOT "fix" `provider`** in `blaze-pm/blaze.config.json` — it self-resolves at the flush.
- **Do NOT reopen** ADR-0001, ADR-0014's ruling, ADR-0021, ADR-0022's decision, ADR-0023
  (including §1's options, §3's ruling against session-scoping, and its delete-direction
  paragraph), or **ADR-0024**. This lane builds ON these.
- **Do NOT re-attack** the CLASSIFICATION table, the call-site source scanner, or
  `tests/cli.test.mjs`'s comment-arithmetic guard.
- The setup token's **PATH** may be logged; its **VALUE** never is, anywhere, ever.
- Never accept a secret pasted into chat; never base64-decode a Kubernetes secret value.
- One agent per worktree. **Never let a reviewer and a fix agent share one.** Every concurrent
  agent gets its own Postgres container and port.
- **Never `git stash`.** It is repo-wide and shared across worktrees; a sibling agent will see
  it. Use `git restore --source=HEAD -- <file>` on a committed tree.

## 5. Environment — verified this session

- Node 24 is **not** on the default PATH: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`.
  Omitting it makes every test file fail to load, which a naive mutation runner scores as
  "all mutations survived". Guard against zero-pass runs.
- Postgres test containers are named `blzpg-<port>` and the password is **`x`**, not
  `postgres`. Currently running: `blzpg-55461`.
  Start one with:
  `docker run --rm -d -e POSTGRES_PASSWORD=x -p 55461:5432 --name blzpg-55461 postgres:17-alpine`
  then **block until `docker exec blzpg-55461 pg_isready -U postgres` succeeds** before
  exporting `BLAZE_TEST_PG_URL`. Do not use `docker start` on a container that may not exist,
  and never discard its stderr inside an `until` loop — that hangs forever.
- **Commit before every mutation run**, and use a runner that refuses a dirty tree, refuses a
  no-op patch, and refuses a run producing zero passes.
- Run `node --check` on every edited file.
- Gate before every push: full suite, `node scripts/ci/hygiene-check.mjs origin/main`,
  `node scripts/ci/mutate-schedule.mjs`, `npm run test:coverage`.
  `hygiene-check.mjs` **fails on `Co-Authored-By:` trailers** and on absolute `/home/...`
  paths in added non-Markdown lines.
- Squash bodies carry `* KEY-n:` bullets, so `idsFromCommitMessage` recovers the ticket.

## 6. Model routing — set `model` explicitly on every dispatch, never inherit

| Work | Model |
|---|---|
| Adversarial review, architecture, decisions, oracle design | opus |
| Implementation, board operations, mechanical fixes | sonnet |
| Read-only lookups | haiku |

## 7. Definition of done for this lane

All 32 tickets `done`; six PRs merged; `main` green on the full gate (suite, hygiene, mutation,
coverage, smoke, board-gate); the decisions in Lanes C and E recorded in the artifact that
enforces them — an ADR — not only in chat; and a successor kickoff written if anything is left.

**Do not narrow the lane on your own.** If you run out of room, leave the next lane untouched
and say which one it is.
