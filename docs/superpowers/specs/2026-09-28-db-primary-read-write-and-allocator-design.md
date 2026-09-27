# Database-primary read path, Postgres wiring, and a database-native id allocator

**Specifies the subsystem BLZ-254's cutover actually needs, found missing by an
adversarial review of `docs/superpowers/plans/2026-09-23-blaze-phase2-cutover-and-retirement-kickoff.md`
on 2026-09-28.** That plan's premise — "flip one already-built default flag" — was
refuted: no database read path exists anywhere (`serve.mjs`, `audit-runner.mjs`,
`views/data.mjs` all hardcode the filesystem), no Postgres wiring exists (the write port
hardcodes a local SQLite shadow file, never a real shared Postgres instance), and no
database-native id allocator exists (`new.mjs` still hard-depends on `claims.mjs`). This
document specifies all three, plus the config plumbing they need. It supersedes nothing
in `docs/superpowers/specs/2026-09-23-blaze-v3-phase2-db-cutover-design.md` — that
document's schema and mechanism-fate decisions stand; this one fills the gap it was
built on top of without knowing the gap was there.

## 1. Goal

Give BLZ-254's cutover three things it doesn't have today: a way for the board/audit/
export code to read from a database instead of the filesystem, a way for the write port
to reach a real shared Postgres instance instead of a local SQLite file, and a way to
allocate ticket ids from the database with the same zero-collision guarantee `claims.mjs`
gives today — without the machinery that guarantee currently costs (a full-tree scan, a
committed claims ledger, `O_EXCL` reservations, a remote-ref sweep).

## 2. Current state, precisely

Verified against `blaze` main, 2026-09-28, by independent grep and read of each cited
file (not carried over from an earlier document's claims):

**Already built, reusable as-is:**

- `scripts/model/pg-storage.mjs:108` — `openPostgresRead(connection, { create })`, the
  real async Postgres read driver (BLZ-282, ADR-0010), already exercised by the driver
  conformance suite.
- `scripts/init-pg.mjs` — `openPostgres({ host, port, database, user, password })`, a
  tested connection-opener built from parsed credential parts (never a composed URL, so
  an error handler cannot print a password it never held). Built for `blaze init`'s
  connection test; reusable here as-is.
- `scripts/model/write-port.mjs:154` — `dbWritePort(exec, { dialect })` already accepts
  `dialect: "postgres"` generically and already branches its SQL between the two
  dialects internally. It needs a Postgres-shaped `exec` object, not new dialect logic.
- `scripts/model/write-port.mjs:386` — `dualWritePort(primary, shadow, opts)`. Its own
  comment states the governing principle this design reuses for allocation: "the primary
  decides every outcome. A shadow that disagreed here would change what the verb DOES."
- `scripts/new.mjs:19-20` — `applyNew(projectsDir, { ..., writePort = fsWritePort(...) })`
  already takes an injectable `writePort`. The dependency-injection seam this design
  needs for id allocation already exists at the call site; it's simply not used for
  allocation today (see §2's gap list).
- ADR-0012's decision (§2, "The driver NAME is repo config. The CONNECTION is not.") —
  the exact config shape §5 implements: `blaze.config.json`'s `database.driver` (tracked,
  name only), `.blaze/database.json` mode `0600` (untracked: host/port/database/user/
  `passwordEnv`), `BLAZE_DB_*` env vars, precedence `CLI flag > env > .blaze/database.json
  > blaze.config.json > default`. **Decided, never implemented** — confirmed by grep:
  zero references to `database.driver`, `.blaze/database.json`, or `passwordEnv` in
  `scripts/config.mjs` or `scripts/model/config.mjs`.

**Genuinely missing, confirmed by grep and read, not assumed:**

1. No `pgExec()`-shaped adapter exists wrapping a `pg.Client`/`Pool` into the `{run, all}`
   shape `dbWritePort` expects (the shape `sqliteExec()` in
   `write-port-resolve.mjs` already provides for SQLite). Zero grep hits for `pgExec` or
   equivalent anywhere in `scripts/`.
2. `scripts/model/write-port-resolve.mjs`'s `resolveWritePort()` — the function every
   real runner (`new`, `move`, `edit`, `log`, `link`, `resolve`, `import`, `serve`)
   actually calls — hardcodes `dbWritePort(shadow.exec, { dialect: "sqlite" })` against
   `openShadow()`'s local, gitignored `.blaze/blaze.db`. It never consults ADR-0012's
   config shape and has no path to a real Postgres connection at all.
3. No injectable reader exists in `scripts/model/index.mjs`, `scripts/views/data.mjs`, or
   `scripts/audit-runner.mjs` — each hardcodes `fsReadStorage` internally. Confirmed:
   zero grep hits for `readStorage` as a parameter in any of the three (contrast with
   `new.mjs`, which already has exactly this shape for a different concern).
4. No database-native id allocator exists. `scripts/new.mjs:111` calls `allocateId()`
   (`scripts/model/ids.mjs:66`), which imports `maxClaim`/`claimedNumbers`/`ensureCutover`
   from `scripts/model/claims.mjs` unconditionally — regardless of which `writePort` was
   injected. Deleting `claims.mjs` today breaks `blaze new` in every mode, not only the
   git-write mode BLZ-254 means to retire.
5. `scripts/model/index.mjs:137-162`'s `missingClaimErrors()` citation, used by
   BLZ-254's own acceptance criteria and the prior plan, is stale: that function was
   already relocated to `index.mjs:373` by BLZ-274, and it is called only from
   `scripts/reindex.mjs:77` — not from `buildIndex`'s render path. This AC item is very
   likely already moot; §6 states the concrete check that settles it either way.

## 3. Scope boundary — what this document does not cover

This is the read/write/allocation subsystem only. It does not re-litigate
`docs/superpowers/specs/2026-09-23-blaze-v3-phase2-db-cutover-design.md`'s schema
decisions, does not re-scope the six governance scripts (confirmed to live in
`blaze-pm`, not `blaze` — a different repo and a different acting role, out of place
here), and does not redesign BLZ-309/324's v4 artifact migration. Those documents need
revision once this one is approved and its own plan clears review — that revision is
this session's likely next step, not this document's job.

## 4. Approaches considered for the id allocator

**A — a per-project counter table, single atomic statement (recommended, per the
operator's own choice made during this brainstorm).**

```sql
CREATE TABLE IF NOT EXISTS project_counter (
  project_key text PRIMARY KEY,
  n           integer NOT NULL DEFAULT 0
);
```

Allocation is one statement, portable across both certified dialects:

```sql
INSERT INTO project_counter (project_key, n) VALUES ($1, 1)
ON CONFLICT (project_key) DO UPDATE SET n = project_counter.n + 1
RETURNING n;
```

SQLite has supported `RETURNING` since 3.35.0 and upsert (`ON CONFLICT DO UPDATE`) since
3.24.0; `node:sqlite` on Node 24 ships 3.53.3 (measured directly during BLZ-253's own
groundwork), well past both. One statement means one round trip and no separate
lock-then-read-then-write race window — concurrent callers serialize on the row's own
lock, which is the database doing exactly the job `claims.mjs`'s machinery approximates
today (ADR-0006's own framing).

**B — native per-engine sequences.** Rejected: SQLite's `AUTOINCREMENT` is one counter
per *table*, not per project key, and would need N tables or a workaround to produce
independent `BLZ-n`/`OBA-n` numbering — solving the same problem Approach A solves in one
portable statement, with two engine-specific paths instead of one shared one.

**C — UUIDs, dropping the sequential-number requirement.** Rejected: every doc, branch
name (`KEY-n-slug`), and commit-message convention (`KEY-n: description`) in this repo's
own house style cites the sequential form. Changing the id shape has a larger blast
radius than the allocator problem itself.

## 5. Config plumbing

Implements ADR-0012 §2–4 exactly — nothing in this section is a new decision, only new
code, since the decision already stands and only lacked an implementation:

- `blaze.config.json`: `{ "database": { "driver": "sqlite" | "postgres" } }` — name only,
  git-tracked, same for every clone.
- `<dataRoot>/.blaze/database.json`, mode `0600`, gitignored (`.blaze/` already is):
  `{ "host", "port", "database", "user", "passwordEnv" }`. `passwordEnv` names an
  environment variable; the file never holds a password or a composed URL. `loadConfig`
  throws if `blaze.config.json` carries `database.url`, `database.password`, or a
  `user:pass@` host — a committed credential is refused, not warned about.
- Precedence: CLI flag (`blaze init`/`blaze db *` only) > environment (`BLAZE_DB_HOST`,
  `BLAZE_DB_PORT`, `BLAZE_DB_NAME`, `BLAZE_DB_USER`, `BLAZE_DB_PASSWORD_ENV`) >
  `.blaze/database.json` > `blaze.config.json` > default (`sqlite`, local shadow — today's
  behavior, unchanged when nothing else is configured).
- New: `resolveDatabaseConfig({ dataRoot, config, env })` in `scripts/config.mjs`,
  returning `{ driver, connection }` where `connection` is `null` for `sqlite` or
  `{ host, port, database, user, password }` (the password read from `process.env[passwordEnv]`
  at the moment of connecting, never stored) for `postgres`. This is the single function
  §6 and §7 both call — one place decides the driver, not two that could disagree.

## 6. Write-side Postgres wiring

- New: `pgExec(client)` in `scripts/model/write-port-resolve.mjs` (beside the existing
  `sqliteExec(db)` it mirrors), wrapping a `pg.Client` into the `{run, all}` shape
  `dbWritePort` already expects: `run` executes and returns nothing structured, `all`
  returns `(await client.query(sql, params)).rows`.
- `resolveWritePort()` changes from unconditionally opening the local shadow to: call
  `resolveDatabaseConfig()`; if `driver === "sqlite"`, keep today's `openShadow()` path
  unchanged (this is the soak-mode behavior BLZ-254's dual-write plan already depends on,
  and it must not regress); if `driver === "postgres"`, call `init-pg.mjs`'s
  `openPostgres(connection)`, wrap it in `pgExec()`, and pass that to `dbWritePort(exec,
  { dialect: "postgres" })`.
- This is additive, not a replacement of the soak path — a board that never configures
  `database.driver` behaves exactly as it does today.

## 7. Read-side injection seam

- `scripts/model/index.mjs`, `scripts/views/data.mjs`, and `scripts/audit-runner.mjs`
  each gain an injectable `readStorage` parameter defaulting to `fsReadStorage`,
  mirroring the DI shape `new.mjs` already uses for its own `readStorage` parameter — an
  existing house pattern, not a new one invented for this document.
- One place wires the real choice: wherever `serve.mjs`/`cli.mjs` currently construct
  these three (found and named precisely when this design is planned into tasks — this
  document specifies the seam's shape, not its exact call-site line numbers, since those
  weren't opened during this brainstorm and guessing them here would repeat the citation
  error the prior plan's review caught). That construction site calls
  `resolveDatabaseConfig()` once and passes `openPostgresRead(connection)` or the
  existing SQLite equivalent (locate its name — the shadow-read counterpart to
  `openShadow`, likely already present given `openPostgresRead` exists as a Postgres
  counterpart) as `readStorage` when `driver === "postgres"`, `fsReadStorage` otherwise.
- Mirrors the write port's own mode by construction — both derive from the same
  `resolveDatabaseConfig()` call, so read and write can't independently disagree about
  which backend is live (per the operator's own choice earlier in this brainstorm).

## 8. ID allocator wiring

- `dbWritePort(exec, { dialect })` gains an `allocate(project)` method executing §4
  Approach A's statement (SQLite/Postgres placeholder syntax already branches inside this
  function per its existing dialect handling) and returning `{ id: `${project}-${n}`, n }`
  — the same shape `allocateId()` returns today, so callers don't need to branch on shape.
- `fsWritePort(projectsDir, storage)` gains an `allocate(project)` method wrapping the
  existing `allocateId()` + `remoteMaxClaim()` + `writeClaim()` sequence from
  `new.mjs:105-118` unchanged — moved, not rewritten. `new.mjs` no longer imports
  `claims.mjs`/`ids.mjs` directly; it calls `writePort.allocate(project)` and gets back
  `{ id, n }` plus (for the fs port specifically) whatever claim-file bookkeeping that
  port's own `write()` needs — the claim file's staging-with-the-ticket requirement
  (`new.mjs`'s own comment: "The claim has to land WITH the ticket") stays satisfied
  because it now happens inside `fsWritePort`'s own `write()`, not split across two call
  sites in `new.mjs`.
- `dualWritePort(primary, shadow, opts)` gains `allocate(project) { return
  primary.allocate(project); }` — one line, following the exact principle the module's
  own existing comment states for every other verb ("the primary decides every outcome").
  The shadow never allocates independently during the soak; there is exactly one id
  authority at any moment, matching how `write`/`move`/`read`/`exists` already work in
  this function.
- `new.mjs` changes from calling `allocateId(projectsDir, project, opts)` directly to
  calling `writePort.allocate(project)`. This is the one call-site change; every other
  consumer of `claims.mjs` (BLZ-254's plan found 21 production files, 39 test files) is
  either a caller of `new.mjs`'s `applyNew()` (unaffected, since the interface it calls
  doesn't change) or a direct importer that needs enumerating and migrating in the
  implementation plan — this document names the mechanism, the plan enumerates the
  call sites exhaustively against live `main` at plan-writing time, not against a list
  carried over from an earlier, already-shown-stale count.

## 9. What retires `claims.mjs`, and when

**Not immediately, and not as part of this document's own scope.** `claims.mjs` stays
live and in use by `fsWritePort.allocate()` for as long as `BLAZE_WRITE_PORT` can resolve
to `fs` or `dual` — which per the original cutover design's own soak plan is true for the
entire soak week and any time before the default flips. `claims.mjs` is deleted only once
`resolveWritePort()`'s default is `db` **and** dual-write has ended, exactly as
`docs/superpowers/specs/2026-09-23-blaze-v3-phase2-db-cutover-design.md`'s §5 already
states for the git-era mechanisms generally. This document changes what fills that slot
(`fsWritePort.allocate()` wrapping the same functions, callable identically before and
after this design lands) without changing when it's safe to delete it.

## 10. Testing

Per this repo's own established rules (already proven across the phases 2/3 campaign):

- **Conformance runs against both engines, real Postgres in CI** — extend the existing
  driver-conformance suite (`tests/model/driver-conformance.test.mjs`) with the new
  `allocate()` method on both `dbWritePort` dialects, asserting the exact same behavior
  each dialect gives under concurrent allocation (see next bullet).
- **The concurrent-write property is a test, not an argument** — two simulated
  concurrent callers each requesting N allocations against one `project_counter` row,
  against real Postgres (not a mock, per this repo's own testing rule), asserting the
  returned set of `n` values is exactly `{1..2N}` with no duplicates and no gaps. This is
  the same property BLZ-254's own AC names for the whole cutover, narrowed to the one
  new piece of code that has to prove it.
- **Every guard is proven to discriminate** — for the config precedence rule (§5), a test
  per precedence level asserting a lower-precedence value is ignored when a higher one is
  present, not merely that the highest-precedence value "works" in isolation.
- **`fsWritePort.allocate()`'s behavior is pinned unchanged** — the existing tests for
  `allocateId`/`remoteMaxClaim`/`writeClaim`'s combined behavior move to exercise
  `fsWritePort.allocate()` instead of the three functions directly, proving the move
  didn't change behavior, only where it lives.

## 11. Risks

| Risk | Mitigation | Honest residual |
|---|---|---|
| A `pg` connection failure mid-allocation leaves a burned counter value | Wrap allocation + ticket insert in one transaction (§4); a rolled-back insert rolls back the increment too | A crash between commit and the caller receiving the result can still burn a number — tolerable, since gaps are already tolerated by design (ADR-0018's own language) |
| §7's exact call-site names are unverified (not opened during this brainstorm) | Named explicitly as a plan-time task, not guessed here | The implementation plan must locate these before writing tasks against them, or repeat this document's own predecessor's citation error |
| Postgres wiring is additive and easy to leave untested if the soak never actually exercises `driver: "postgres"` | §10's conformance suite runs against real Postgres regardless of what any deployed board configures | A config-plumbing bug that only manifests with a real multi-host Postgres deployment (vs. CI's single-host container) is not fully ruled out by this design alone |

## 12. Verification this document meets its own brief

- Names a concrete mechanism for all three missing pieces (read seam, Postgres wiring,
  allocator) with file:line citations verified today, not carried over from an earlier
  document.
- States explicitly what it does NOT redesign (§3), so it doesn't silently expand scope
  into the governance-script or v4-migration work that belongs in other documents.
- States explicitly when `claims.mjs` retires and why this document doesn't change that
  timing (§9) — no ambiguity about whether this design deletes it.
- Every approach considered names why the alternatives were rejected (§4), not just the
  chosen one.
