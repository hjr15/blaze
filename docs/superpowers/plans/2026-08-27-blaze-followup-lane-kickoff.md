# blaze — follow-up lane kickoff (2026-08-27)

Successor to `2026-08-27-blaze-next-session-kickoff.md` (merged as `7ffdb1e`). That document
records what shipped and why the last lane was hard. **This one is the work order.** It is
self-contained and authoritative: where it contradicts a chat instruction, follow this.

`main` is at `7ffdb1e`. Suite **2,755 pass / 0 fail**, hygiene clean, coverage
98.45 / 87.57 / 97.22 / 98.45, all 17 schedule mutations killed. **Zero open PRs.**

## 1. The goal

Close the seven follow-up tickets raised during the BLZ-394..400 lane. They are all in
`defined/` and none is blocked. Four of them are one theme: **`reconcile` and its consumers
assert things that are not true** — a feed that reports moves that never happened, a preview
that renders a refusal as a clean board, a change list that counts a non-move, and a ticket
that no single-project run touches and nothing mentions. Two are decisions with an ADR
attached. One is input validation on the config load path.

## 2. Lanes, in order. Do them in this order.

### Lane A — BLZ-404 + BLZ-405, ONE feature PR: "the reconcile loop tells the truth"
**BLZ-404 is `priority: high` and is the most direct case of the board overstating.**

`runReconcile` in `scripts/supervisor.mjs` calls
`reconcile({ fetch: true, commit: true, push: true, root, projectsDir })` and never passes
`dryRun` — and `reconcile()` defaults `dryRun = true`. So the supervisor's loop **never writes
a ticket and never commits**, while publishing a `reconcile` event per proposed change to the
activity feed on every tick. The feed shows `INF-645: defined → done (moved: true)` over and
over while the ticket never leaves `defined/`.

`serve.mjs`'s `/api/reconcile-preview` returns `{ changes: r.changes || [], ... }` without ever
checking `r.ok`. BLZ-394 gave `reconcile()` two `ok: false` paths; on both, `changes` is `[]`
and the reason is in `error`. A refused run therefore renders identically to a clean one.
It is **unreachable today** (that handler never passes `projects`) — fix it as a contract gap,
and say so; do not overstate it as a live bug.

These bundle because both are consumers of `reconcile()` that disagree with what it actually
did. `supervisor.mjs`'s `runReconcile` already checks `!r.ok` correctly — use it as the model.

**Also answer BLZ-404's fourth AC**: is `push: true` meaningful at all, given `reconcile()`
hardcodes `pushed: false` unconditionally in its return? Decide and record.

### Lane B — BLZ-402, its own PR: project keys reach `new RegExp` unvalidated
`KEY_RE = /^[A-Z][A-Z0-9]*$/` lives only in `scripts/init.mjs`, guards only the first-run
wizard, is not exported, and is called from nowhere on the config-load path. `loadConfig` and
`loadProject` interpolate the key raw into `new RegExp(...)`. Two measured consequences:

- `loadProject("A(", ...)` throws `SyntaxError: Invalid regular expression: /\bA(-(\d+)/i:
  Unterminated group` — a raw engine stack trace, not a `blaze: …` refusal.
- A key that is valid regex but not a valid key builds a silently over-broad matcher: with key
  `"A.*"`, `idsFromSubject("ZZZ-9: x", ".*")` returns `[".*-9"]` — claiming a ticket belonging
  to another project.

`BLAZE_KEY` overrides `cfg.key` before those regexes are built and is validated exactly as
much as the file key is: not at all. **Escaping alone is not the fix** — an over-broad-but-
valid key must be refused too, so validate the SHAPE.

### Lane C — BLZ-407, its own PR + an ADR: audit and load disagree on the same board
`blaze audit` reports a malformed `schema` override as a **SOFT** `schema-invalid` and
concludes `ok=true`. The load path treats it as **HARD** and refuses every non-exempt verb.
Reproduction: `{"schema": {"types": {"spike": 7}}}` → `blaze audit` exit 0 `ok=true`,
`blaze rollup` exit 1 `SchemaOverrideError`. Verified identical on `2047f30` — pre-existing.

**This is a decision, and the ticket deliberately does not presuppose it.** Either the audit
finding becomes HARD so `ok=false` matches the refusal, or the load path stops refusing on this
class. Weigh both; do not pick the one that is less work. Confirmed facts to build on:
`schema-invalid` is in `SOFT_KINDS` (`scripts/model/audit.mjs`), and
`SCHEMA_PREFLIGHT_EXEMPT = new Set(["audit", "init", "commit"])` (`scripts/cli.mjs`), so
`blaze audit` cannot be made to refuse by the load path at all. **BLZ-56 established the
malformation-vs-inert split — build on it, do not reopen it. ADR-0023 stays closed.**

### Lane D — BLZ-403, its own PR: a hand-moved terminal ticket freezes a wrong record
`PR_RANK` puts OPEN above MERGED, so while any PR carrying the key is open the record is chosen
by RANK and `prTitleClaim` never runs. PR #128 clears that rank-chosen record when the merged
set is unresolvable, but both the clear and the `ambiguous-deliverer` finding are gated on
`d.recordAmbiguous && !keep()`, where `keep = () => d.recordIfAbsentOnly && hadRecord`.

A ticket **hand-moved** to `done` while the follow-up PR is still open reaches
terminal-with-a-record by a route `reconcile()` never sees. `keep()` then reads true, neither
the clear nor the report fires, and the record is frozen permanently — `pr` is not in
`EDITABLE_FIELDS`, so `blaze edit` cannot repair it.

**This is the largest blast radius of the seven.** Closing it means either overriding write-once
on a terminal ticket (a deliberate rule) or reporting on the ~54 terminal tickets at blaze-pm
`ff5f36c2` that already hold a record drawn from an ambiguous set — most of which are probably
correct. **Decide the reporting question before writing code, and prefer report-over-mutate**
unless you can show the mutation is safe. ADR-0023 already records this residual; extend that
record rather than contradicting it.

### Lane E — BLZ-401 + BLZ-406, ONE feature PR: "the change list counts what actually moved"
`reconcile()`'s resolution backfill sets `dirty = true` when `d.target === t.status`, and the
`changes.push(...)` is gated only on `dirty` — so a resolution-only backfill pushes an entry
with `from === to` and the CLI prints `would move X: done → done`. It also inflates the
`--apply` commit message's change count, which cuts directly against BLZ-394's acceptance
criterion that the message "counts only those" tickets in scope.

BLZ-406: the `--project` filter scopes on the ticket's DIRECTORY (`keys.includes(t.project)`)
while the signal map is keyed by `t.frontmatter.project`. A ticket at
`projects/OBA/defined/INF-2-t.md` carrying `project: INF` is reconciled by **neither**
single-key run, exit 0, no finding, no warning. **The directory is status (ADR-0001) and
BLZ-394 scoped on it deliberately — do not reverse that.** The fix is that the skip is
REPORTED, and a decision recorded on which key wins.

These bundle: both are `reconcile` failing to report accurately on what it did and did not do.

## 3. How to work — this is the part that cost ten review rounds last lane

**Every PR gets an adversarial review before merge, and SCOPE EACH REVIEW TO PRODUCT
BEHAVIOUR** — correctness, vacuous tests, the board overstating, the pre-auth surface. Record
wording, figures and test-machinery findings in the PR body and ticket them; do not
fix-and-re-review them. That scoping is what found the real defects last lane after eight
broader rounds walked past them.

**When a change makes the product ASSERT something, test the assertion against ground truth
over a GENERATED CROSS-PRODUCT, not hand-picked examples.** Lane 4 last time needed six review
rounds because the same sentence was wrong in five successive directions, and every round's
tests pinned only the case that made the new claim true. What settled it was an oracle:
enumerate config × project shapes, compare every emitted sentence to `resolveSchema` ground
truth. 1,736 clauses, 0 mismatches — **and prove the oracle non-vacuous by re-introducing each
historical defect and confirming it catches them.** Lanes A, C and E all make the product
assert things. Build the oracle first.

**A guard no current call path can reach cannot be killed by any mutation.** Say so plainly in
the commit rather than implying it is pinned. This came up three times in one PR last lane.

**TDD.** Tests red before implementation, and mutation-verify every guard: revert the
production hunk, watch the NAMED test go red for the reason its name claims.

Other standing rules: `blaze` skill for every tracked item (ticket at create with parent and
estimate; branch `KEY-n-slug`; commits and PR title `KEY-n: description`; `blaze log` before a
terminal move — it wants a bare number, not `90m`). One commit per body of work. Docs update in
the same effort, never as a follow-up.

## 4. Constraints — non-negotiable, unchanged

- **Do NOT push `blaze-pm`.** The `blaze-flush` CronJob (23:50 Australia/Sydney) is the sole
  merger. Work there ends at a **local commit**. ~147 unpushed is correct — do not "fix" it.
- **Do NOT run `blaze schedule migrate-dates --write`** against the live board.
- **Do NOT touch the NCA project** (parked by the operator 2026-08-23).
- **Do NOT "fix" `provider`** in `blaze-pm/blaze.config.json` — it self-resolves at the flush.
- **Do NOT reopen** ADR-0001, ADR-0014's ruling, ADR-0021, ADR-0022's decision, or ADR-0023
  (including §1's options, §3's ruling against session-scoping, and its delete-direction
  paragraph). Lanes C and D build ON these.
- **Do NOT re-attack** the CLASSIFICATION table, the call-site source scanner, or
  `tests/cli.test.mjs`'s comment-arithmetic guard.
- The setup token's **PATH** may be logged; its **VALUE** never is, anywhere, ever.
- Never accept a secret pasted into chat; never base64-decode a Kubernetes secret value.
- One agent per worktree. **Never let a reviewer and a fix agent share one.** Every concurrent
  agent gets its own Postgres container and port.

## 5. Environment — verified this session

- Node 24 is **not** on the default PATH: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`.
  Omitting it makes every test file fail to load, which a naive mutation runner scores as
  "all mutations survived". Guard against zero-pass runs.
- Postgres test containers are named `blzpg-<port>` and the password is **`x`**, not
  `postgres`: `BLAZE_TEST_PG_URL=postgres://postgres:x@127.0.0.1:55461/postgres`.
  Currently running: `blzpg-55461`, `blzpg-55455`, `blzpg-55462`.
- **Commit before every mutation run**, and use a runner that refuses a dirty tree, refuses a
  no-op patch, and refuses a run producing zero passes. Running `git checkout --` by hand in a
  mutation loop destroyed uncommitted work three times last lane.
- Run `node --check` on every edited file — a backtick inside a template literal broke
  `supervisor.mjs` and `page.mjs` last lane.
- Gate before every push: full suite, `node scripts/ci/hygiene-check.mjs origin/main`,
  `node scripts/ci/mutate-schedule.mjs`, `npm run test:coverage`.
- Squash bodies carry `* KEY-n:` bullets, so `idsFromCommitMessage` recovers the ticket.
  Verified on #132 and #133.

## 6. Model routing — set `model` explicitly on every dispatch, never inherit

| Work | Model |
|---|---|
| Adversarial review, architecture, decisions, oracle design | opus |
| Implementation, board operations, mechanical fixes | sonnet |
| Read-only lookups | haiku |

## 7. Definition of done for this lane

All seven tickets `done`; five PRs merged; `main` green on the full gate; every decision in
Lanes C, D and E recorded in the artifact that enforces it (an ADR or the ticket), not only in
chat; and a successor kickoff written if anything is left.

**Do not narrow the lane on your own.** If you run out of room, leave the next lane untouched
and say which one it is.
