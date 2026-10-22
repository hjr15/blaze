# BLZ-703 retire blaze-pm — Plan A (the code PRs: G0, E1, E2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the three code PRs that the Phase 5 cutover needs before it can run: G0 (a claude-config hook that refuses `blaze` writes from a blaze-pm checkout), E1 (schema v6, `blaze db migrate`, identity and sprints in Postgres, the fs-write guard, the ADR), and E2 (remote reads, the token file and TLS hint, the db-board reconcile refusal, the `/api/live` gate). Merging them changes nothing on the live v5 database. The cutover is a later step that the operator runs.

**Architecture:** G0 is a stand-alone PreToolUse hook. E1 adds a forward-only migration framework to `db-schema-version.mjs`'s world, with one step (v5→v6) that adds the six identity tables and the two sprint tables and writes `blaze_meta('authoritative','true')`. Optional `--identity-from` and `--sprints-from` copies run inside the same transaction, behind a row-level verify. Every v6 feature resolves its source from the write mode plus the stamp, at the entry point (ADR-0038): Postgres when `BLAZE_WRITE_PORT=db`, `database.driver` is `postgres` and the stamp is at least 6, and the existing file otherwise. Sync render paths get a prefetched registry. Async verbs read it through the reader they are already handed. E2 adds three read routes and two remote verbs on top of the BLZ-684 remote client, plus three small refusals and gates.

**Tech Stack:** Node 24 ESM, `node:test`, `node:sqlite`, `pg` 8 (Postgres tests gated by `PG_SKIP` / `BLAZE_TEST_PG_URL`), bash + jq + Python 3 stdlib `unittest` (claude-config).

**Spec:** `docs/superpowers/specs/2026-10-22-phase5-retire-blaze-pm-design.md` (main `2ecae26`). It is binding. Read D1, D2, D3, D5, D6, D7, D10, §3, §5, §7, §9 and §10 first. This plan argues from it. Where it departs from the spec, the departure is in **Findings**, with the ruling.

**Tickets:** feature **BLZ-703**. Plan A covers children #1 BLZ-704 (G0); #2 BLZ-705, #3 BLZ-706, #4 BLZ-707, #5 BLZ-708 and #8 BLZ-711 (E1); and #6 BLZ-709, #7 BLZ-710, #20 BLZ-723 and #21 BLZ-724 (E2).

**Baseline (recorded 2026-10-22 at `2ecae26`, Node 24.19.0, `npm test`):**
- `BLAZE_TEST_PG_URL` unset: `tests 5178 · suites 466 · pass 5139 · fail 0 · skipped 39 · 144 s`.
- With a throwaway `postgres:17-alpine`: `tests 5252 · suites 478 · pass 5251 · fail 0 · skipped 1 · 157 s`.

---

## PR split, branches and merge order

| PR | Repo | Branch / worktree | Tasks | Merge order and gate |
|---|---|---|---|---|
| **G0** | claude-config | `BLZ-704-blaze-pm-write-guard`, worktree `/home/rnamwoh/Documents/Code/claude-config-worktrees/BLZ-704-blaze-pm-write-guard` off `origin/main` | 0 | **First.** It closes today's split-brain window. Gate: the claude-kit CI is green. |
| **E1** | hjr15/blaze | `BLZ-703-e1-db-completeness`, worktree `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-703-e1-db-completeness` off `origin/main` | 1–7 | **Second.** It auto-deploys to the live board (service-platform's `bump` job), and it is inert on v5. Gate: CI green, including the Postgres job; Task 7's v5-compatibility rehearsal is recorded in the PR body; the opus whole-branch review is upheld. |
| **E2** | hjr15/blaze | `BLZ-703-e2-remote-agent-surface`, worktree `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-703-e2-remote-agent-surface`, **cut from `origin/main` after E1 merges** | 8–12 | **Third.** Gate: as for E1. |

**Writer's call: E2 is built after E1 merges, not beside it** (the spec allows parallel). Both PRs edit `scripts/serve.mjs`, `scripts/cli.mjs`, `tests/model/seam-closure.test.mjs`, `AGENTS.md` and `docs/guide/commands.md`. Building them in parallel buys a rebase across the seam-closure ledger and nothing else, because nothing in the cutover needs E2 before §5 step 8.

Each PR's title is `BLZ-703: <G0|E1|E2> — <summary>`. Each commit inside it is `<child key>: <description>`. The PR body lists every child ticket it carries and ends with the attribution line `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Global Constraints

- **Scope is Plan A only:** G0, E1 and E2 as the table above assigns them. Chart work (F1, F2), the cutover (§5 steps 1–10), the claude-config repoint (G), the doc moves (H1–H3) and the archive (D9) are **Plan B** and are not touched here.
- **Nothing here may change behaviour on a v5 database or on an fs board.** fs boards keep `sprints.json`, `identity.db` and `project.json` as they are today (spec §2 non-goal). The single exception is G-engine (Task 5), which refuses a write on a board whose config names `database.driver: "postgres"` while `BLAZE_WRITE_PORT` is unset.
- **`DB_SCHEMA_VERSION` becomes 6. `MIN_DB_SCHEMA_VERSION` stays 5** (D1(b)). Raising MIN is out of scope (spec §11).
- **`blaze db init --force` stays refused on Postgres.** It already is (`db-runner.mjs:74-77`), and that is not touched. The authoritative flag guards `load --replace` and the `older` message only.
- **v6 features turn on only when all three of these hold:** `BLAZE_WRITE_PORT=db`, `database.driver` is `postgres`, and the stamp is at least `6` (exported as `V6_FEATURES_FROM = 6` from `scripts/model/db-schema-version.mjs`). In every other case today's file source is used, unchanged.
- **Credentials never reach output** (A3). No message, log line, test failure text or error may contain:
  - a token, password, verifier or hash value;
  - the content of `BLAZE_TOKEN_FILE`.

  Messages name tables, columns, primary keys and paths only.
- **Seam-closure** (`tests/model/seam-closure.test.mjs`): only the rows listed in the "Seam-closure ledger" below change, each marked `// BLZ-<n>:`. No assertion is weakened. Where this plan predicts a classification (`writes` / `inert`) and the guard's reachability walk disagrees, the walk wins. The implementer moves the export to the bucket the walk reports and states why in the row's comment. Moving it is not a weakening: the walk is the truth the buckets are checked against.
- **TDD, red first.** Every task writes its failing tests, runs them and sees the stated failure, and only then implements.
- **New test files use `tests/helpers/scratch.mjs`:** `import { scratchRegistry } from "./helpers/scratch.mjs"; const scratch = scratchRegistry();` at module scope, and `scratch(mkdtempSync(join(tmpdir(), "<literal-prefix>-")))` for every scratch directory. The literal prefix stays inside `mkdtempSync`. There is no per-test `rmSync` after an assertion.
- **Postgres tests:**
  - They use `tests/helpers/pg-scratch.mjs`: `PG_SKIP` on the test, and one `scratchPgDb(tag)` per test, dropped in `finally`.
  - A spawned process gets `BLAZE_WRITE_PORT`, `BLAZE_READONLY`, `BLAZE_REMOTE_URL`, `BLAZE_TOKEN` and `BLAZE_TOKEN_FILE` **deleted** from its env, never set to `""`, except where a test sets one on purpose.
  - No step reaches the live cluster or runs `kubectl`, so the kube-stub rule is not needed.
- **THE DEBT STEP.** `scripts/ci/temp-cleanup-debt.json` is held to equality by `tests/temp-cleanup-guard.test.mjs`. Its size is quoted in `docs/ci.md` as "375 sites across 54 files" at baseline, and that quote is registered in `scripts/ci/quoted-sources.mjs`. Every task that edits an existing test file runs this block before its commit and stages all three files:
  ```bash
  node scripts/ci/temp-cleanup-guard.mjs --write \
    && OLD=$(grep -o '[0-9]* sites across [0-9]* files' scripts/ci/quoted-sources.mjs | head -1) \
    && NEW=$(node -e 'const f=JSON.parse(require("fs").readFileSync("scripts/ci/temp-cleanup-debt.json","utf8")).files;const v=Object.values(f);console.log(`${v.reduce((a,b)=>a+b,0)} sites across ${v.length} files`)') \
    && sed -i "s/$OLD/$NEW/" scripts/ci/quoted-sources.mjs docs/ci.md \
    && git diff scripts/ci/temp-cleanup-debt.json && echo "quote: $OLD -> $NEW"
  # stage: scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  ```
  The debt diff must show only removed lines or lowered counts. A raised count is a new leak: fix it in the test, and do not record it. An unchanged diff is the expected result for most tasks here, because new files use the registry.
- **Commits:**
  - One commit per task, or two where a task says so. The subject is `<child key>: …`.
  - Stage with an explicit pathspec (`git add <paths>`), never `git add -A`.
  - **No `Co-Authored-By` or `Signed-off-by` trailer** (the hjr15/blaze hygiene CI, `scripts/ci/hygiene-check.mjs`). No `/home/` path and no `*.howman.link` host in an added non-Markdown line.
  - Never run `git config`. No task pushes. Pushing and opening the PR are the orchestrator's job, at Task 7 and Task 12.
- **Ticket bookkeeping is the orchestrator's,** not a task step: `in-progress` at start, `in-review` at PR open, a worklog, and `done` at merge, through whatever live-board access the session has. No step runs a `blaze` write inside a blaze-pm checkout (after Task 0 merges, the hook refuses one).
- **Every task ends with all of these true:**
  - its named tests pass;
  - `npm test` is green (fail 0), and the Postgres-gated tests are green when `BLAZE_TEST_PG_URL` is set (Tasks 1–4 and 7 must run them);
  - `git status --short` prints nothing.
- **Environment for every engine command** (run `npm ci --ignore-scripts` once if `node_modules/` is absent):
  ```bash
  cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-703-e1-db-completeness   # E2: …/BLZ-703-e2-remote-agent-surface
  export PATH=/home/rnamwoh/.local/node24/bin:$PATH
  # Postgres-gated tests (Tasks 1–4, 7): a throwaway server, stopped when the task ends.
  docker run -d --rm --name blz703-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5544:5432 postgres:17-alpine
  until docker exec blz703-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
  docker exec blz703-pg psql -U postgres -c 'CREATE DATABASE blaze_test'
  export BLAZE_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5544/blaze_test
  # …and at the end of the task: docker stop blz703-pg
  ```
  If 5544 is taken, pick another free loopback port. The URL is never committed.

## Findings (decided here, from the code at `2ecae26`)

1. **`blaze board` is `serve.mjs`'s standalone block.** `cli.mjs:38` spawns `serve.mjs` for `board`, so the spec's two start-up wiring points ("the standalone block … and `blaze board`") are one point: `serve.mjs:957-971`. Task 3 wires it once.
2. **`blaze db migrate` refuses below `MIGRATE_FROM = 5`, not below MIN.** The spec says migrate "refuses an `older` database below `MIN`". It also says the `older` refusal on an authoritative database recommends `blaze db migrate`. Once MIN rises, those two contradict each other: an authoritative v6 database below a future MIN of 7 could not be migrated at all. **Ruling:** the floor is the oldest stamp that has a step chain (`MIGRATE_FROM`, 5 today, equal to MIN today). Today's behaviour is identical. A future MIN raise keeps the database migratable.
3. **The v6 tables are Postgres-only.** `DB_SCHEMA_VERSION` is shared by the SQLite shadow and Postgres. A fresh SQLite create stamps 6 and gains no tables: the shadow is derived, credentials must not live in a file that `db init --force` deletes (`identity-db.mjs` header), and a sprint written to a derived shadow is a sprint lost on rebuild. `blaze db migrate` refuses SQLite and names `blaze db init --force`. A v5 SQLite shadow stays readable (MIN 5). This matches D2 and D3, which speak only of `blaze-pg`.
4. **A database created by E1's `blaze db init` is already v6 and not authoritative.** So `blaze_rehearsal` (§5) has to be created with the **pre-E1 engine** (`2ecae26`, which is the image serving today) for the rehearsal to exercise the live v5→v6 path. A re-run of `blaze db migrate` on a v6 database still writes `authoritative` and still runs the copies the flags ask for. **For Plan B.** Task 7 runs exactly this flow against a throwaway Postgres.
5. **The pg identity store holds a `pg.Pool`, not one `pg.Client`.**
   - A server-lifetime store on one client sends concurrent requests' auth queries down one connection. That is BLZ-675's deprecated pattern, and pg 9 refuses it.
   - A single client also never recovers from a dropped connection, so every request would 503 until a restart.
   - So `openPostgresPool` (new, `init-pg.mjs`) creates a pool with `max: 4` and an `error` listener. An idle-client error on an unlistened pool ends the process.
   - Copies and migrations still use one client, because they need one transaction.
6. **The TLS hint covers four codes, not two.** Measured on 2026-10-22: `fetch` to a self-signed leaf fails with `cause.code === "DEPTH_ZERO_SELF_SIGNED_CERT"`, which is neither of the spec's two codes. A private CA whose chain the server does not send gives `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. The set is `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `DEPTH_ZERO_SELF_SIGNED_CERT` and `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
7. **"Value-shaped like `ticketValue`" means the same top-level keys, not `ticketValue` itself.** `ticketValue` (`write-port.mjs:50`) is a *comparison key*: it stringifies numbers, canonicalises arrays to strings and turns links into sorted strings. **Ruling:** the API returns `ticketJson(rec) = { id, project, status, frontmatter, body }`, where `frontmatter` is the record's own object (numbers stay numbers, `links` stays `[{type,target}]`). The record's `file` (a server path) is never included.
8. **`GET /api/matrix` has no handler.** It is classified `read` in `ROUTE_SCOPES` (`serve-auth.mjs:54`), and the handler exists in `model/artifact-api.mjs:610`, but `serve.mjs` never wires it, so the route 404s. Spec §8 relies on "The board serves `GET /api/matrix`". **Not fixed in Plan A.** It is recorded for Plan B: §8's matrices row uses `blaze matrices --out` in the pod, which does not need the route. Wiring the route is a separate ticket (open question 4).
9. **"Byte-equal" round-trip of a sprint registry means canonical equality.** JSON key order is not data, and the database cannot return the file's key order. `canonicalStrict` (`write-port.mjs:41`) sorts keys and compares strictly. The verify and the test use it.
10. **Where the sprint prefetch goes.** The four async consumers already receive the reader the entry point resolved. They are `applyNew`, `applyEdit`, groomer `validateGroomed` and import `loadBoard`. Each reads `await readStorage.sprintRegistry(root)`. Only the sync render paths (`pageHtml`, `viewEnvelope`, `renderView`, `boardModel` → `buildIndex`) take a prefetched `sprints` argument, which `serve.mjs` awaits per request. `loadSprints` and the other sync callers are unchanged (D3).
11. **`blaze start` (the supervisor) still loads identity from SQLite** (`supervisor.mjs:232`). The live board's pod runs `serve.mjs`, not the supervisor, so G1 holds without it. **Out of scope** (open question 3). Task 10 does make the supervisor's reconcile loop refuse on a db board, because D6 says "on any db board, `blaze reconcile` … refuse".
12. **The authoritative `older` message cannot be reached today.** An authoritative row is written only at v6, and MIN is 5. Task 1 pins it through `judgeDbSchema` with an injected `min`.
13. **`absent` for pg identity** (no `app_user` table) can occur at v6 only on a damaged schema. It keeps `loadIdentity`'s meaning (loopback serves unauthenticated, and any other host gets the setup flow) for parity with D2's four states.
14. **Remote `list --projects`.** Spec §6 regenerates `scripts/project_keys.txt` with `blaze-live list --projects`, and D7 names `GET /api/projects`. So remote `list` gains `--projects` (Task 8).
15. **`show` and `list` exist only in remote mode.** `cli.mjs` refuses an unknown command before the remote block (`cli.mjs:143`). Both are added to `SUBCOMMANDS` with `remoteOnly: true`, and run locally they print a one-line refusal instead of the usage dump.
16. **Version: 0.9.0 → 0.10.0 in E1 (Task 6). E2 adds no bump.** 0.9.0 is untagged, and the image already serving the live board reports it. E1 introduces DB schema v6, which a 0.9.0 engine refuses as `newer` (§5 step 4's rollback note), so an operator must be able to tell the two apart. E2 is additive on the same unreleased line. Tagging `v0.10.0` is a Plan B decision.

## Review Focus

1. **The live board restarts on the E1 image with its v5 database and no flags.** It serves exactly as before. Identity comes from SQLite, sprints come from `sprints.json` (none mounted, so the gantt is empty), sign-in works, and `blaze new --sprint` validates against the file. Pinned in Task 3 (`a v5 database: identity stays on SQLite`) and Task 4 (`a v5 database: sprints stay on the file`), both Postgres-gated, against a `makeV5` database.
2. **A migrate that cannot finish:**
   - the cause can be a missing `identity.db`, a FIFO or malformed `sprints.json`, a verify mismatch, or a crash mid-step;
   - the result is exit 1, a sentence naming the cause and "nothing was migrated", the stamp still `5`, no v6 table present, and no credential value anywhere in the output.

   Pinned in Task 1 (injected step failure), Task 2 (one-byte hash change; missing source) and Task 4 (malformed `sprints.json`).
3. **An agent in a blaze-pm checkout runs `blaze new`.**
   - Through any engine ≥ 0.10.0 on a postgres-driver config: refused, no file written (Task 5).
   - Through the old pinned engine: denied by G0's hook before it runs (Task 0).
   - `blaze-live …`, a remote-mode call, `grep "blaze new"` and every read verb are all allowed.
4. **Remote `show` and `list`:**
   - with a `viewer` token: 200 and the ticket;
   - with no token: 401;
   - the JSON never contains a server filesystem path (the board's `projectsDir` and `codeRepoPaths`).

   Pinned in Task 8.
5. **A token file that is missing, unreadable, empty or whitespace-bearing, or a TLS trust failure:**
   - the result is one line naming `BLAZE_TOKEN_FILE`'s path or `NODE_EXTRA_CA_CERTS`, exit 1;
   - the token's text never appears.

   Pinned in Task 9.

---

## File Structure

| File | Task | Change |
|---|---|---|
| claude-config `hooks/blaze-pm-write-guard.sh` | 0 | **new.** PreToolUse Bash deny hook |
| claude-config `scripts/test_blaze_pm_write_guard.py` | 0 | **new.** stdlib `unittest` |
| claude-config `global/settings.json`, `.github/workflows/claude-kit-ci.yml`, `docs/changelog.md`, `docs/architecture.md` | 0 | register the hook, run its test in CI, and document it |
| `scripts/model/db-schema-version.mjs` | 1, 4 | `DB_SCHEMA_VERSION = 6`, `V6_FEATURES_FROM`, `MIGRATE_FROM`; facts gain `authoritative`; the `older` message branches on it; a pg create adds the v6 DDL |
| `scripts/model/db-migrate.mjs` | 1, 2, 4 | **new.** `MIGRATIONS`, `migrateDb` |
| `scripts/model/sprint-store.mjs` | 1, 4 | **new.** `sprintDdl` (Task 1); the registry ↔ tables mapping and `openSprintSource` (Task 4) |
| `scripts/db-runner.mjs` | 1, 2, 4 | the `migrate` verb; `load --replace` refused on an authoritative database; `--identity-from`, `--sprints-from` |
| `scripts/model/identity-copy.mjs` | 2 | **new.** read `identity.db` read-only, copy, verify row-for-row |
| `scripts/model/identity-pg.mjs` | 3 | **new.** `loadIdentityPg`, `poolExec` |
| `scripts/model/identity-db.mjs` | 3 | `resolveIdentity` |
| `scripts/init-pg.mjs` | 3 | `openPostgresPool` |
| `scripts/model/user-admin.mjs`, `scripts/user-runner.mjs` | 3, 5 | the Postgres target at v6; no `.gitignore` or `.blaze/` write in that case; G-engine |
| `scripts/serve.mjs` | 3, 4, 8, 10, 11 | the standalone entry awaits `resolveIdentity`; adoption reloads through it; sprints prefetched; read routes; reconcile-preview refusal; live gate |
| `scripts/model/sprints.mjs` | 4 | `normaliseRegistry`, `stampedRegistry` extracted (loader and saver unchanged in behaviour) |
| `scripts/model/read-storage.mjs`, `scripts/model/sqlite-storage.mjs`, `scripts/model/pg-storage.mjs` | 4 | `sprintRegistry(dataRoot)` on every reader |
| `scripts/new.mjs`, `scripts/edit.mjs`, `scripts/loops/groomer.mjs`, `scripts/model/import-apply.mjs` | 4 | read sprints through `readStorage.sprintRegistry` |
| `scripts/views/page.mjs`, `scripts/views/data.mjs` | 4, 10 | a `sprints` argument; the reconcile button hidden on a db board |
| `scripts/sprint-runner.mjs` | 4, 5 | through `openSprintSource`; G-engine |
| `scripts/model/fs-write-guard.mjs` | 5 | **new.** `fsWriteRefusal`, `assertFsWriteAllowed` |
| `scripts/cli.mjs` | 5, 8, 9 | the G-engine gate; `show` and `list` remote-only; `BLAZE_TOKEN_FILE` opens remote mode |
| `scripts/model/write-port-resolve.mjs` | 5 | the G-engine check in `resolveWritePort`'s fs branch |
| `scripts/model/ticket-json.mjs` | 8 | **new.** `ticketJson` |
| `scripts/model/serve-auth.mjs` | 8 | three `read` routes in `ROUTE_SCOPES` |
| `scripts/remote-client.mjs` | 8, 9 | `show`, `list`; `BLAZE_TOKEN_FILE`; the TLS hint |
| `tests/setup/no-remote.mjs` | 9 | also deletes `BLAZE_TOKEN_FILE` |
| `scripts/reconcile.mjs`, `scripts/supervisor.mjs` | 10 | the db-board refusal |
| `tests/model/seam-closure.test.mjs` | 3, 4, 10 | the rows in the ledger below |
| `tests/helpers/pg-scratch.mjs` | 1 | `makeV5(url)`, `pgEnvFor(url)` |
| `package.json`, `package-lock.json`, `tests/package.test.mjs` | 6 | 0.10.0 |
| `docs/decisions/0039-board-data-lives-in-postgres-board-config-in-the-platform-chart.md` | 6 | **new ADR** |
| `docs/decisions/0006-*.md` | 6 | addendum |
| `docs/schema-versioning.md` | 1 | the version sentence, v6, and "Authoritative databases migrate, derived ones rebuild" |
| `docs/guide/commands.md`, `AGENTS.md` | 1, 3, 4, 5, 8, 9, 10, 11 | in the task that changes the behaviour |
| `docs/operations/live-board.md` | 9 | **new** page |

## Seam-closure ledger (every line of `tests/model/seam-closure.test.mjs` Plan A touches, at `2ecae26`)

The only new **write** seam is `model/sprint-store.mjs`, whose `openSprintSource` falls back to `saveSprints`. The pg identity and sprint writes themselves go through `pg`, which is not the `node:fs` surface this guard covers (see its banner on `node:sqlite` at `:467-473`). Even so, every allowlisted module whose exports change is re-pinned, and the new module is classified.

| Line(s) | Today | After | Task |
|---|---|---|---|
| 868-871 (`SEAM_WRITE_PROVIDERS`, `model/sprints.mjs`) | `inert: ["SPRINT_REGISTRY_VERSION", "loadSprints", …, "formatSprintList"]` | the same list plus `"normaliseRegistry", "stampedRegistry"`, with `// BLZ-707: the loader's and saver's pure halves, extracted so the Postgres registry normalises and stamps by the same rule.` | 4 |
| new row after 871 (`SEAM_WRITE_PROVIDERS`) | — | `// BLZ-707: the sprint registry's Postgres mapping. Only openSprintSource reaches node:fs, through saveSprints, when the source is the file.` then `["model/sprint-store.mjs", { writes: ["openSprintSource"], sanctioned: [], inert: ["sprintDdl", "parseSprintRegistry", "readSprintRegistry", "writeSprintRegistry"] }],` | 4 (the row is born in Task 1 as `{ writes: [], sanctioned: [], inert: ["sprintDdl"] }` **only if** Task 1's run of the guard demands it. A module that imports nothing allowlisted needs no row, so Task 1 normally adds none.) |
| 921-922 (`model/identity-db.mjs`) | `writes: ["openIdentityDb", "loadIdentity"]` | `writes: ["openIdentityDb", "loadIdentity", "resolveIdentity"]` with `// BLZ-706: resolveIdentity falls back to loadIdentity below v6, so it is a write like the loader it wraps.` | 3 |
| 1038-1042 (`reconcile.mjs`) | `inert: ["PR_RANK", …, "recordablePr"]` | the same list plus `"DB_BOARD_RECONCILE_REFUSAL"`, with `// BLZ-723: a sentence.` | 10 |
| new row in `WRITE_ALLOWED`, after the `model/user-admin.mjs` row (1995) | — | `// BLZ-707: the sprint registry's source picker saves through saveSprints when the source is the file (fs, dual, SQLite db, or a Postgres board below v6).` then `["model/sprint-store.mjs", ["saveSprints"]],` | 4 |
| 2042-2047 (`WRITE_ALLOWED`, `serve.mjs`) | `["serve.mjs", ["issueSetupToken", …, "ensureIdentityIgnored", "addUser", "loadIdentity", "reconcile", "resolvePorts", "pageHtml", "viewEnvelope", "applyNew"]]` | `"resolveIdentity"` added after `"loadIdentity"`, with `// BLZ-706: the standalone entry resolves identity (Postgres at v6) before bind.` | 3 |
| 2052 (`sprint-runner.mjs`) | `["sprint-runner.mjs", ["saveSprints"]],   // BLZ-254: …` | `["sprint-runner.mjs", ["openSprintSource"]],   // BLZ-707: the runner saves through the source picker, never saveSprints directly` | 4 |

`FS_READER_ALLOWED` (`:3164`) is unchanged: no new module names `fsReadStorage`. `model/user-admin.mjs`'s rows are unchanged. Its exports and the primitives it takes stay the same, because the Postgres target is reached through `openCheckedPg` (inert) and `identityStore`.

## Task order and routing

| # | Task | Ticket | PR | Implementer | Reviewer |
|---|---|---|---|---|---|
| 0 | Interim hook: refuse `blaze` writes from a blaze-pm checkout | BLZ-704 | G0 | sonnet | opus |
| 1 | Schema v6, `blaze db migrate`, the authoritative refusals | BLZ-705 | E1 | **opus** (a migration on an authoritative database) | opus |
| 2 | Identity copy: `--identity-from`, verified row-for-row | BLZ-706 | E1 | **opus** (credentials, A1/A3) | opus |
| 3 | Identity at runtime: `loadIdentityPg`, `resolveIdentity`, serve and user-admin over pg | BLZ-706 | E1 | **opus** (bind safety, setup flow, seam) | opus |
| 4 | Sprints in Postgres: tables, readers, prefetch, runner, `--sprints-from` | BLZ-707 | E1 | **opus** (seam rows, many call sites) | opus |
| 5 | G-engine: refuse fs writes on a postgres-driver board | BLZ-708 | E1 | sonnet | opus |
| 6 | ADR-0039, ADR-0006 addendum, docs sweep, 0.10.0 | BLZ-711 | E1 | sonnet (the text is given here) | opus |
| 7 | E1 whole-branch verification, the v5-compatibility rehearsal, push, PR | — | E1 | haiku runs the read-only checks; **opus** does the whole-branch review | — |
| 8 | Remote reads: `GET /api/ticket(s)`, `/api/projects`, remote `show` and `list` | BLZ-709 | E2 | **opus** (auth scopes) | opus |
| 9 | `BLAZE_TOKEN_FILE`, the TLS hint, `docs/operations/live-board.md` | BLZ-710 | E2 | sonnet | opus |
| 10 | Refuse `blaze reconcile` and `/api/reconcile-preview` on a db board | BLZ-723 | E2 | sonnet | opus |
| 11 | Gate `GET /api/live` on `views.live` | BLZ-724 | E2 | sonnet | opus |
| 12 | E2 whole-branch verification, push, PR | — | E2 | haiku checks; **opus** review | — |

Order: Task 0 is independent and runs first. Tasks 1→2→3→4→5→6→7 run sequentially: 2, 3 and 4 build on Task 1's `migrateDb`, 3 and 4 both edit `serve.mjs` and seam-closure, and 5 edits `user-admin.mjs` after 3 and `sprint-runner.mjs` after 4. Tasks 8→9→10→11→12 run sequentially on E2's branch: 8 and 9 both edit `remote-client.mjs` and `cli.mjs`, and 10 and 11 both edit `serve.mjs`.

---

## G0 — claude-config

### Task 0: Interim hook — refuse `blaze` writes from a blaze-pm checkout (BLZ-704)

**Setup (once):**
```bash
git -C /home/rnamwoh/Documents/Code/claude-config fetch origin
git -C /home/rnamwoh/Documents/Code/claude-config worktree add /home/rnamwoh/Documents/Code/claude-config-worktrees/BLZ-704-blaze-pm-write-guard -b BLZ-704-blaze-pm-write-guard origin/main
cd /home/rnamwoh/Documents/Code/claude-config-worktrees/BLZ-704-blaze-pm-write-guard
```

**Files:**
- Create: `hooks/blaze-pm-write-guard.sh` (mode 0755)
- Create: `scripts/test_blaze_pm_write_guard.py`
- Modify: `global/settings.json`, adding a third entry to the `PreToolUse` → `matcher: "Bash"` → `hooks` list (`:84-97`, after `show-cwd-branch-on-drift.sh`): `{ "type": "command", "command": "$HOME/.claude/hooks/blaze-pm-write-guard.sh" }`
- Modify: `.github/workflows/claude-kit-ci.yml`, adding `python3 scripts/test_blaze_pm_write_guard.py` to the "Unit suites" step after `test_blaze_activity_hook.py`
- Modify: `docs/changelog.md` (a `### BLZ-704: …` entry under `## Unreleased`) and `docs/architecture.md` (one sentence under **`hooks/`**: the guard, why it exists, and that the archive PR removes it)

**Interfaces:**
- Input: the PreToolUse JSON on stdin (`.tool_input.command`, `.cwd`).
- Output:
  - **deny:** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<REASON>}}` on stdout, exit 0;
  - **allow:** nothing on stdout, exit 0.
  - It never exits non-zero. If `jq` is missing it fails open. That is stated in the header comment as the hook's one known gap.

**The decision, in order.** Each step can only return *allow*. Only reaching the end denies.

1. **A write verb in command position.** Allow unless the command matches (bash ERE):
   `(^|[;&|(]|\$\()[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*((npx[[:space:]]+)?blaze|node[[:space:]]+[^[:space:]]*cli\.mjs)[[:space:]]+(new|move|edit|link|resolve|log|sprint|reindex|reconcile|groom|import|schedule|matrices|migrate|user|start|init|db)([[:space:]]|$)`
   That is the mutating set of `cli.mjs`'s `SUBCOMMANDS` at engine 0.8.0 and 0.9.0, plus `db`. A bare `blaze` (which runs `start`) is matched too: `(^|[;&|(])[[:space:]]*blaze[[:space:]]*($|[;&|)])`.
2. **Remote mode.** Allow if `BLAZE_REMOTE_URL` is non-empty in the hook's own environment, or if the command carries `BLAZE_REMOTE_URL=[^[:space:]]` (a per-command prefix).
3. **The target directory.** The candidates are:
   - the payload `cwd`;
   - every `cd <target>` in the command, where `~` expands to `$HOME` and a relative target is resolved against `cwd`;
   - the parent of every `BLAZE_PROJECTS_DIR=<path>`.

   A candidate is a blaze-pm checkout when either of these holds:
   - `git -C <cand> rev-parse --show-toplevel` succeeds, and that toplevel's `git remote get-url origin` matches `[/:]hjr15/blaze-pm(\.git)?$`. This covers every worktree, because worktrees share the origin.
   - The candidate's absolute path has a component that is exactly `blaze-pm` or `blaze-pm-worktrees`, or that starts with `blaze-pm-`.

   If no candidate is a blaze-pm checkout, allow.
4. **Deny** with `<REASON>`, exactly:
   `blaze-pm is retired as a writable board (BLZ-703). A \`blaze <verb>\` run here writes ticket files that never reach the live board — INF-928, INF-930 and INF-931 had to be replayed by hand. Write to the live board in remote mode instead (BLAZE_REMOTE_URL with BLAZE_TOKEN), or read it there. This guard is removed when blaze-pm is archived.`

- [ ] **Step 1: Write the failing test** `scripts/test_blaze_pm_write_guard.py`.
  - Shape: stdlib `unittest`, subprocess-driven, `tempfile.TemporaryDirectory()`, on the same contract as `scripts/test_blaze_activity_hook.py` (`run(payload, env_extra)` → `subprocess.run(["bash", HOOK], input=json.dumps(payload), …, timeout=10)`).
  - Fixtures:
    - `make_bp(tmp)`: `git init -q`, then `git remote add origin https://github.com/hjr15/blaze-pm.git`, in `<tmp>/work/board`. The directory is deliberately *not* named blaze-pm, so the origin rule is what is tested.
    - `make_other(tmp)`: origin `https://github.com/hjr15/blaze.git`.
  - Every run passes an env with `BLAZE_REMOTE_URL` removed.
  - A helper `decision(proc)` returns `"deny"` when stdout parses to `permissionDecision == "deny"`, and `"allow"` when stdout is empty. It asserts `returncode == 0` in both cases.
  - Tests. Each has one assertion on `decision(...)` and, for denies, `"BLZ-703" in reason and "remote mode" in reason`:
    - `test_denies_new_in_blaze_pm_by_origin`: cwd=`make_bp`, `blaze new --project INF --type task "x" --estimate 30` → deny
    - `test_denies_each_mutating_verb`: a loop over the 18 verbs in rule 1, `blaze <verb>` → deny for each (`subTest(verb=…)`)
    - `test_denies_bare_blaze`: `blaze` → deny
    - `test_denies_npx_and_node_cli`: `npx blaze move INF-1 done` and `node node_modules/@hjr15/blaze-board/scripts/cli.mjs edit INF-1 title x` → deny
    - `test_denies_cd_into_blaze_pm`: cwd=`make_other`, `cd <bp> && blaze log INF-1 30` → deny
    - `test_denies_relative_cd`: cwd=`<tmp>/work`, `cd board && blaze new …` → deny
    - `test_denies_projects_dir_prefix`: cwd=`make_other`, `BLAZE_PROJECTS_DIR=<bp>/projects blaze new …` → deny
    - `test_denies_in_a_worktree`: `git -C <bp> commit --allow-empty -qm init` (with `-c user.email=t@t -c user.name=t`), then `git -C <bp> worktree add -q <tmp>/wt`, cwd=`<tmp>/wt` → deny
    - `test_denies_by_directory_name_without_origin`: `<tmp>/blaze-pm` with no git → deny
    - `test_allows_read_verbs`: `blaze board`, `blaze audit`, `blaze rollup`, `blaze export --format csv` in `make_bp` → allow
    - `test_allows_blaze_live`: `blaze-live new --project INF …` in `make_bp` → allow
    - `test_allows_remote_env`: env `BLAZE_REMOTE_URL=https://board.example` → allow
    - `test_allows_remote_prefix`: `BLAZE_REMOTE_URL=https://board.example BLAZE_TOKEN=t blaze new …` → allow
    - `test_allows_other_repos`: cwd=`make_other`, `blaze new …` → allow
    - `test_allows_mentions_that_are_not_commands`: `grep -rn "blaze new" .`, `echo blaze move`, `git log --grep "blaze edit"` in `make_bp` → allow
    - `test_allows_non_blaze_commands`: `git status` in `make_bp` → allow
- [ ] **Step 2: Run it and watch it fail.** Run `python3 scripts/test_blaze_pm_write_guard.py`. Expected: ERROR or FAIL on every test, because the hook file does not exist.
- [ ] **Step 3: Implement `hooks/blaze-pm-write-guard.sh`.**
  - `set -uo pipefail`.
  - Read stdin once. Then apply rules 1–4 in order, each one an early `exit 0`.
  - Emit the deny JSON with `jq -n --arg r "$REASON" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'`.
  - The header comment states:
    - the purpose (spec D5 "Interim");
    - that it is removed in the PR that archives blaze-pm;
    - that it fails open without `jq`.
  - `chmod +x`.
- [ ] **Step 4: Run it and watch it pass.** Run `python3 scripts/test_blaze_pm_write_guard.py`. Expected: `OK`, 16 tests.
- [ ] **Step 5: Register the hook and gate it in CI.**
  - Apply the `global/settings.json` and `claude-kit-ci.yml` edits from Files.
  - Check: `jq -e '.hooks.PreToolUse[] | select(.matcher=="Bash") | .hooks[] | select(.command|endswith("blaze-pm-write-guard.sh"))' global/settings.json` prints the entry.
  - Run every unit suite the workflow lists. Each must end `OK`.
  - Run `bash scripts/export-public.sh --dry-run`. It must exit 0.
- [ ] **Step 6: Write the docs** (the changelog entry and the architecture sentence). The changelog entry names spec D5 and BLZ-703, and says the hook is deleted in the blaze-pm archive PR.
- [ ] **Step 7: Commit.**
  ```bash
  git add hooks/blaze-pm-write-guard.sh scripts/test_blaze_pm_write_guard.py global/settings.json .github/workflows/claude-kit-ci.yml docs/changelog.md docs/architecture.md
  git commit -m "BLZ-704: interim hook refuses blaze writes from a blaze-pm checkout without remote mode"
  ```
  The PR (`BLZ-703: G0 — interim blaze-pm write guard`) is opened by the orchestrator. After it merges, the operator's machine picks up the hook on the next `install.sh` run (the PostToolUse auto-deploy).

---

## E1 — hjr15/blaze, db completeness

**Setup (once):** `git -C /home/rnamwoh/Documents/Code/blaze fetch origin && git -C /home/rnamwoh/Documents/Code/blaze worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-703-e1-db-completeness -b BLZ-703-e1-db-completeness origin/main`, then the Global Constraints environment. Re-run the baseline there and record it in the Task 7 report.

### Task 1: Schema v6, `blaze db migrate`, and the authoritative-database refusals (BLZ-705)

**Files:**
- Modify: `scripts/model/db-schema-version.mjs`
- Create: `scripts/model/db-migrate.mjs`, `scripts/model/sprint-store.mjs` (`sprintDdl` only in this task)
- Modify: `scripts/db-runner.mjs` (`USAGE`, `migrate`, the `load --replace` refusal)
- Modify: `tests/helpers/pg-scratch.mjs` (`makeV5`, `pgEnvFor`)
- Modify tests: `tests/model/db-schema-version.test.mjs:175-185` and `:238-250`, `tests/model/config-install.test.mjs:50-60`, `tests/schema-versioning-docs.test.mjs:62-73`
- Create test: `tests/db-migrate.test.mjs`
- Docs: `docs/schema-versioning.md` (the DATABASE section), and `docs/guide/commands.md` `## db` (`migrate` and the `--replace` refusal)

**Interfaces:**
- Produces, from `db-schema-version.mjs`:
  - `DB_SCHEMA_VERSION = 6`; `MIN_DB_SCHEMA_VERSION = 5` (unchanged); `V6_FEATURES_FROM = 6`; `MIGRATE_FROM = 5`.
  - `judgeDbSchema({ hasTicket, hasMeta, version, authoritative = false, current, min })`.
  - `readSchemaFactsSync(exec)` and `checkDbSchema(exec, opts)`'s facts carry `authoritative: boolean` (row `('authoritative','true')`).
- Produces, from `sprint-store.mjs`: `sprintDdl() → string`. This is Postgres DDL for `sprint` and `sprint_registry`, exactly D3's columns, each `CREATE TABLE IF NOT EXISTS`.
- Produces, from `db-migrate.mjs`:
  - `MIGRATIONS: Map<number, (exec) => Promise<void>>`, holding `5 → v5ToV6`. `v5ToV6` runs `identityDdl("postgres")`, then `sprintDdl()`.
  - `migrateDb(exec, { identityRows = null, sprintRegistry = null, migrations = MIGRATIONS, beforeVerify = null } = {}) → Promise<{ from, to, steps: number[], authoritative: "written"|"already", identity: object|null, sprints: object|null }>`.
  - `exec` is `pgExec(client)` over **one** client. `migrateDb` owns `BEGIN` / `COMMIT` / `ROLLBACK`.
  - `identityRows` and `sprintRegistry` are accepted and ignored in this task. Tasks 2 and 4 give them meaning. `beforeVerify(exec)` is a test seam, documented as such.
- Produces, from `tests/helpers/pg-scratch.mjs`:
  - `makeV5(url) → Promise<void>`: `createDbSchema` (v6), then `DROP TABLE` the six identity tables and the two sprint tables, then `UPDATE blaze_meta SET value='5' WHERE key='schema_version'`. That is exactly the shape of a database a 0.9.0 engine created.
  - `pgEnvFor(url) → { BLAZE_DB_HOST, BLAZE_DB_PORT, BLAZE_DB_NAME, BLAZE_DB_USER, BLAZE_DB_PASSWORD_ENV: "BLAZE_TEST_PG_PASSWORD", BLAZE_TEST_PG_PASSWORD }`, parsed from the URL.

**`migrateDb`'s algorithm**, which the tests determine except for the order:
1. `BEGIN`, then `LOCK TABLE blaze_meta IN EXCLUSIVE MODE`, so two migrates serialise while plain reads continue.
2. Read the facts in the transaction. The outcome depends on the state:
   - `newer`: throw `database schema version N is newer than this engine (DB_SCHEMA_VERSION); upgrade the engine`.
   - `empty` or `unstamped`: throw, quoting `judgeDbSchema`'s error, and naming `blaze db init` for `empty`.
   - `version < MIGRATE_FROM`: throw `no migration path from version N — the oldest this engine migrates from is 5`.
3. For `v` from `version` to `DB_SCHEMA_VERSION - 1`, run `migrations.get(v)(exec)`, then `UPDATE blaze_meta SET value = $1 WHERE key = 'schema_version'` with `v+1`.
4. `INSERT INTO blaze_meta (key, value) VALUES ('authoritative', 'true') ON CONFLICT (key) DO NOTHING`. Report `"written"` or `"already"` from whether a row existed before.
5. (Tasks 2 and 4 insert their copies here.)
6. `await beforeVerify?.(exec)`.
7. (Tasks 2 and 4 insert their verifies here.)
8. `COMMIT`. On any throw: `ROLLBACK` (swallowing a rollback error), then rethrow the original.

**`db-runner.mjs`:**
- `USAGE` gains:
  - `  migrate       Postgres only: bring the schema forward to v6 in one transaction and mark the database authoritative. With --identity-from <identity.db> and --sprints-from <sprints.json>, copy those in the same transaction, verified row for row`
  - `  --replace` gains `(refused on an authoritative database — restore a pg_dump instead)`.
- `runDb` dispatches `migrate` to `migrateCmd(ctx)`. It reads `--identity-from` and `--sprints-from` as `argv[argv.indexOf(flag) + 1]`. A flag with no value, or a value starting with `-`, prints `blaze db migrate: <flag> needs a path` and exits 1.
- `migrateCmd`:
  1. `dbConfigOr` and `writableOr(ctx, "migrate")`.
  2. SQLite → `blaze db migrate: migrates a Postgres database. The SQLite shadow is derived — rebuild it with 'blaze db init --force'.` → 1.
  3. Connect with `ctx.openPgClient` directly. Not `openCheckedPg`, which refuses states migrate must name itself.
  4. `migrateDb`.
  5. On success, print:
     ```
     blaze db migrate — <where>
       schema         v<from> → v<to>        (or: v6, already current)
       authoritative  yes (written now)      (or: yes (already))
     migrate: DONE — one transaction, committed.
     ```
     Exit 0.
  6. On a throw, print `blaze db migrate: <where> — <message>` and then `Nothing was migrated: the migration runs in one transaction.` Exit 1.
  7. Always `client.end()`.
- `loadCmd`: before `buildTransitions`, if `replace`, read `SELECT value FROM blaze_meta WHERE key = 'authoritative'`. If it is `'true'`, print, and exit 1 without opening a transaction:
  ```
  blaze db load: <where> is authoritative — it IS the board, not a copy loaded from files.
  --replace would erase its tickets and their history, and there is no file corpus to reload them from.
  Nothing was loaded. To roll the database back, restore a pg_dump with pg_restore.
  ```

**`judgeDbSchema`'s `older` branch** keeps today's text when `!authoritative`. When `authoritative`, it is:
`database schema version ${version} is older than this engine supports (supported: ${min}..${current}). This database is AUTHORITATIVE — it is the board itself, not a copy derived from files — so it is migrated, never rebuilt: take a pg_dump, then run 'blaze db migrate'. Never 'blaze db init --force' or 'blaze db load --replace', which would erase it — see ${DOCS}`

**`applyCreate`** adds two steps after `viewDdl`, for `dialect === "postgres"` only: `() => exec.run(identityDdl("postgres"), [])` and `() => exec.run(sprintDdl(), [])`. The `DB_SCHEMA_VERSION` comment block gains:
`// 6 under BLZ-705 (Phase 5, spec D1(b)): the six identity tables and sprint/sprint_registry, Postgres only — the SQLite shadow is derived and holds neither credentials nor sprints. MIN stays 5: a v5 database serves exactly as before, its v6 features falling back to their files, until 'blaze db migrate' runs.`

- [ ] **Step 1: Write the failing tests.**
  - In `tests/model/db-schema-version.test.mjs`:
    - `"the stamp is 5"` becomes `"the stamp is 6"`. It asserts `DB_SCHEMA_VERSION === 6` and a fresh SQLite create's `blaze_meta` value `"6"`, and the comment chain gains `// 5 -> 6 under BLZ-705: identity and sprint tables, Postgres only.`
    - `"the floor rises to 5 …"` is retitled `"the floor stays 5 — v6 is additive and a v5 database still serves (BLZ-705, D1(b))"`. Its assertions are unchanged.
    - Add `test("BLZ-705: the older refusal on an AUTHORITATIVE database says migrate, never rebuild", …)`: `judgeDbSchema({ hasTicket: true, hasMeta: true, version: 5, authoritative: true, min: 6, current: 6 })` → `ok: false`, `state: "older"`, `error` matches `/blaze db migrate/` and `/pg_dump/`, and `doesNotMatch(/run 'blaze db init --force'/)`. The same call with `authoritative: false` still matches `/'blaze db init --force'/`.
    - Add `test("BLZ-705: facts carry the authoritative row", …)`: a SQLite exec with `blaze_meta` holding `('authoritative','true')` → `readSchemaFactsSync(exec).authoritative === true`. Without the row → `false`.
  - In `tests/model/config-install.test.mjs:57-58`: `assert.equal(DB_SCHEMA_VERSION, 6); assert.equal(MIN_DB_SCHEMA_VERSION, 5);`, retitled `"the version is 6 and the floor stays 5 (BLZ-705)"`.
  - In `tests/schema-versioning-docs.test.mjs:62-73`: the test is retitled `"BLZ-705: the doc's DB schema version and floor match the constants"`. The regex becomes `/\*\*The version is (\d+) and the floor is (\d+), as of ([A-Z]+-\d+)\.\*\*/`. It asserts `Number(m[1]) === DB_SCHEMA_VERSION` and `Number(m[2]) === MIN_DB_SCHEMA_VERSION`, and the old equality assertion is deleted.
  - Create `tests/db-migrate.test.mjs`. Every test in it is `PG_SKIP` and gets its own `scratchPgDb`. Name and assertions:
    - `"BLZ-705: a v5 database migrates to v6 in one transaction"`: `makeV5`, then `migrateDb(pgExec(c))` → `{ from: 5, to: 6, steps: [5], authoritative: "written" }`. After it, `schema_version = '6'`, `authoritative = 'true'`, and `to_regclass` is non-null for each of `app_user, user_identity, membership, api_token, local_password, user_session, sprint, sprint_registry`.
    - `"BLZ-705: a second run is a no-op"`: run it twice → the second returns `{ from: 6, to: 6, steps: [], authoritative: "already" }`.
    - `"BLZ-705: a failure mid-step leaves v5 intact"`: `migrations: new Map([[5, async (e) => { await e.run(identityDdl("postgres")); throw new Error("injected"); }]])` → rejects `/injected/`. Afterwards `schema_version = '5'`, `to_regclass('app_user') IS NULL`, and there is no `authoritative` row.
    - `"BLZ-705: newer, unstamped and empty databases are refused by name"`: three databases, three `/newer/`, `/no Blaze schema stamp/`, `/blaze db init/` rejections.
    - `"BLZ-705: a fresh v6 create holds the v6 tables and is not authoritative"`: `createDbSchema(…, { dialect: "postgres" })` → the 8 tables exist, and there is no `authoritative` row.
    - `"BLZ-705: blaze db migrate prints the transition and exits 0"`: `runDb(["migrate"], { …QUIET-with-capture, roots: dbBoard(), resolveDbConfig: () => ({ driver: "postgres", connection: url }), openPostgresClient: pgClient })` → returns 0, and the captured log includes `"schema         v5 → v6"` and `"migrate: DONE"`.
    - `"BLZ-705: blaze db migrate refuses the SQLite shadow"`: a `dbBoard()` with the default SQLite driver → returns 1, and err matches `/blaze db init --force/`.
    - `"BLZ-705: load --replace refuses an authoritative database and erases nothing"`:
      - setup: `createDbSchema`, then `blaze db load` a `dbBoard()` (ENG-1), then `migrateDb`;
      - `runDb(["load", "--replace"], …)` → 1, err matches `/is authoritative/` and `/pg_restore/`;
      - `SELECT count(*) FROM ticket` is still `1`.
    - `"BLZ-705: load --replace on a NON-authoritative database still works, and leaves identity and sprint tables untouched"`:
      - setup: `createDbSchema`, then insert one `app_user` row and one `sprint` row by hand, then `load`, then `load --replace`;
      - both loads return 0;
      - `app_user` and `sprint` each still hold 1 row. That proves `LOAD_TABLES` does not reach them (D2, §9).
  - The existing `init --force` Postgres refusal test stays as it is (grep `refused on Postgres` in `tests/`). It must still pass.
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/model/db-schema-version.test.mjs tests/model/config-install.test.mjs tests/schema-versioning-docs.test.mjs tests/db-migrate.test.mjs`. Expected:
  - the version assertions fail (`5 !== 6`);
  - `tests/db-migrate.test.mjs` fails to import `../scripts/model/db-migrate.mjs` (ERR_MODULE_NOT_FOUND);
  - the docs test fails on the regex.
- [ ] **Step 3: Implement.** Change `db-schema-version.mjs`, create `sprint-store.mjs` (`sprintDdl`) and `db-migrate.mjs` with the signatures above, then make the `db-runner.mjs` changes and the helper additions.
- [ ] **Step 4: Write the docs.**
  - `docs/schema-versioning.md`'s DATABASE section:
    - Replace `**Both are 5 as of BLZ-667.**` with `**The version is 6 and the floor is 5, as of BLZ-705.**`.
    - Append a "Version 6 (BLZ-705)" sentence: identity and sprint tables, Postgres only.
    - Add a subsection `### Authoritative databases migrate, derived ones rebuild`. It says:
      - the SQLite shadow and a freshly loaded Postgres database are derived, and `init --force` or `load --replace` rebuilds them from the corpus;
      - a Postgres database marked by `blaze db migrate` with `blaze_meta('authoritative','true')` is the board itself, and has no corpus;
      - `load --replace` refuses it, and the `older` refusal names `blaze db migrate`;
      - `MIGRATE_FROM` is the oldest stamp `migrate` has a step chain from;
      - take a `pg_dump` before any migrate.
  - `docs/guide/commands.md` `## db`: a `migrate` row and paragraph (flags in Tasks 2 and 4), and the `--replace` refusal.
- [ ] **Step 5: Run them and watch them pass.** Run the Step 2 command, then `npm test` with `BLAZE_TEST_PG_URL` set. Expected: all green. The seam-closure guard must stay green without a new row, because `db-migrate.mjs` and `sprint-store.mjs` import nothing allowlisted yet. If it reddens, the ledger's Task-1 conditional row applies.
- [ ] **Step 6: Run THE DEBT STEP, then commit.**
  ```bash
  git add scripts/model/db-schema-version.mjs scripts/model/db-migrate.mjs scripts/model/sprint-store.mjs scripts/db-runner.mjs tests/helpers/pg-scratch.mjs tests/model/db-schema-version.test.mjs tests/model/config-install.test.mjs tests/schema-versioning-docs.test.mjs tests/db-migrate.test.mjs docs/schema-versioning.md docs/guide/commands.md scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-705: schema v6 and a forward-only blaze db migrate; an authoritative database refuses load --replace"
  ```

### Task 2: Identity copy — `blaze db migrate --identity-from`, verified row for row (BLZ-706, part 1)

**Files:**
- Create: `scripts/model/identity-copy.mjs`
- Modify: `scripts/model/db-migrate.mjs` (the copy and verify slots), `scripts/db-runner.mjs` (`--identity-from`)
- Create test: `tests/identity-copy.test.mjs`
- Docs: `docs/guide/commands.md` `## db` (the `--identity-from` paragraph)

**Interfaces:**
- Produces, from `identity-copy.mjs`:
  - `IDENTITY_TABLES`: an ordered array, in FK order, of `{ name, pk: string[], ts: string[] }`:
    - `app_user` (`id`; `created_at`)
    - `user_identity` (`provider, subject`; `created_at`)
    - `membership` (`user_id, scope_key`; `created_at`)
    - `api_token` (`id`; `created_at, last_used_at, expires_at, revoked_at`)
    - `local_password` (`user_id`; `created_at, updated_at`)
    - `user_session` (`id`; `created_at, last_used_at, expires_at, revoked_at`)
  - `readIdentityRows(path) → Promise<{ [table]: { rows: object[], absent: boolean } }>`:
    - It opens with `new (await import("node:sqlite")).DatabaseSync(path, { readOnly: true })`.
    - A missing file throws `blaze: no identity database at ${path}` (checked with `existsSync` first).
    - A table missing from the source is `{ rows: [], absent: true }`, because a pre-BLZ-566 roster has no `local_password` or `user_session`.
    - Rows are `SELECT * FROM t ORDER BY <pk>`.
  - `copyIdentity(exec, source) → Promise<{ [table]: number }>`:
    - It first refuses if `SELECT count(*) FROM app_user` is non-zero: `identity copy refused: app_user already holds N row(s) in Postgres — the copy must land in empty tables for its verify to be exact`.
    - Then, per table in order, it inserts each row with its own column list (`$n` placeholders).
  - `verifyIdentity(exec, source) → Promise<void>`:
    - It re-reads every table from Postgres (`ORDER BY <pk>`) and compares with `canonicalIdentityRow`.
    - It throws on the first difference, naming table, primary key and column, **never a value**:
      - a count: `identity verify: <table> has <a> row(s) in Postgres, <b> in the source`;
      - columns: `identity verify: <table> columns differ (source: a,b,…; Postgres: a,b,…)`;
      - a value: `identity verify: <table> row <pk joined "/"> differs in <column>`.
  - `canonicalIdentityRow(row, ts) → object`: keys sorted. Each `ts` column becomes `null` (null/undefined/`""`) or epoch milliseconds (a `Date` gives `getTime()`, a string gives `Date.parse`). An unparseable timestamp throws `identity verify: unreadable timestamp in <column>`. Every other column is kept as is.
- Consumes: Task 1's `migrateDb`. Its `identityRows` option is now the `readIdentityRows` result. The copy runs at slot 5 and the verify at slot 7. The return carries `identity: { app_user: n, … }`.
- `db-runner.mjs migrateCmd`:
  - It reads the source with `readIdentityRows` **before connecting**. A read failure prints `blaze db migrate: <message>` and `Nothing was migrated.`, then exits 1.
  - On success it prints `  identity       app_user N · user_identity N · membership N · api_token N · local_password N · user_session N  (row-for-row verified)`, adding ` (absent in source)` after a table's count where `absent`.

- [ ] **Step 1: Write the failing tests** in `tests/identity-copy.test.mjs`. Every test is `PG_SKIP` except the pure ones.
  - Fixture `seedIdentityDb(dir)`:
    - `openIdentityDb(dir, { create: true })`, then through its `store`:
      - an admin with a password (`setPassword`, 12+ characters);
      - a member with two tokens, one of them revoked (`revokeToken`);
      - a viewer;
      - a live session for the admin (`createSession`);
      - an expired session (`createSession({ ttlMs: -1000 })`).
    - Close the database. Return `{ path, adminToken, sessionToken }`, the plaintexts being those `issueToken` and `createSession` returned. They are used only to authenticate, never printed.
  - `"BLZ-706: canonicalIdentityRow normalises timestamps to UTC ms and sorts keys"` (pure):
    - `{ b: 1, created_at: "2026-10-22T01:02:03.456Z" }` and `{ created_at: new Date("2026-10-22T01:02:03.456Z"), b: 1 }` canonicalise `deepStrictEqual`;
    - `"not a date"` throws `/unreadable timestamp in created_at/`.
  - `"BLZ-706: every table copies with zero row diffs"`:
    - `makeV5`, `migrateDb(exec, { identityRows: await readIdentityRows(path) })` → `identity` equals the SQLite per-table `count(*)`;
    - an independent re-read of both sides through `canonicalIdentityRow` is `deepStrictEqual` per table;
    - all six tables hold at least one row.
  - `"BLZ-706: after the copy, the old bearer token and the old session authenticate"`:
    - `identityStore(pgExec(c), { dialect: "postgres" })`;
    - `authenticate({ presented: adminToken, operation: "write" })` → `ok: true`;
    - `authenticateSession({ presented: sessionToken, operation: "read" })` → `ok: true`;
    - the revoked token → `ok: false`;
    - the expired session → `ok: false`.
  - `"BLZ-706: a one-byte hash change aborts the whole migration"` (prove-test-discriminates):
    - `beforeVerify: (e) => e.run("UPDATE api_token SET token_hash = overlay(token_hash placing 'x' from 1 for 1) WHERE revoked_at IS NULL")`;
    - it rejects `/api_token row .* differs in token_hash/`, and the message does not include any `token_hash` value read from the source;
    - afterwards the stamp is `'5'` and `to_regclass('app_user')` is null.
  - `"BLZ-706: the copy refuses tables that already hold users"`: `createDbSchema` (v6), then insert one `app_user`, then `migrateDb` with `identityRows` → rejects `/already holds 1 row/`.
  - `"BLZ-706: a missing source is refused before anything connects"`: `runDb(["migrate", "--identity-from", "/nonexistent/identity.db"], { …, openPostgresClient: () => { throw new Error("must not connect"); } })` → 1, err matches `/no identity database at/` and `/Nothing was migrated/`.
  - `"BLZ-706: the CLI prints per-table counts and never a credential"`:
    - `runDb(["migrate", "--identity-from", path], …)` → 0;
    - the captured log matches `/app_user 3 · user_identity 3 · membership 3 · api_token 3 · local_password 1 · user_session 2/`;
    - and `doesNotMatch(new RegExp(\`${adminToken}|blz_\`))`.
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/identity-copy.test.mjs`. Expected: ERR_MODULE_NOT_FOUND for `identity-copy.mjs`.
- [ ] **Step 3: Implement `identity-copy.mjs`, the two `migrateDb` slots, and the CLI flag.** Use the lazy `import("node:sqlite")` so `blaze db` without the flag never loads it. No `node:fs` write anywhere: `existsSync` is the only fs call.
- [ ] **Step 4: Run them and watch them pass.** Run `node --test tests/identity-copy.test.mjs tests/db-migrate.test.mjs`, then `npm test` with PG. Expected: green, and seam-closure unchanged.
- [ ] **Step 5: Write the docs.** In `commands.md` `## db`:
  - `--identity-from <path>` copies all six identity tables verbatim (hashes, verifiers and live sessions), so no token is reissued;
  - the copy runs in the migrate transaction with a row-for-row verify;
  - it refuses non-empty tables;
  - the source is opened read-only.
- [ ] **Step 6: Commit** (no existing test file was edited, so there is no debt step).
  ```bash
  git add scripts/model/identity-copy.mjs scripts/model/db-migrate.mjs scripts/db-runner.mjs tests/identity-copy.test.mjs docs/guide/commands.md
  git commit -m "BLZ-706: blaze db migrate --identity-from copies identity.db into Postgres, verified row for row"
  ```

### Task 3: Identity at runtime — `loadIdentityPg` before bind, adoption, user-admin over Postgres (BLZ-706, part 2; absorbs BLZ-701)

**Files:**
- Create: `scripts/model/identity-pg.mjs`
- Modify: `scripts/model/identity-db.mjs` (`resolveIdentity`), `scripts/init-pg.mjs` (`openPostgresPool`), `scripts/serve.mjs` (`:277` param, `:348`, `:558`, `:957-971`), `scripts/model/user-admin.mjs`, `scripts/user-runner.mjs`
- Modify: `tests/model/seam-closure.test.mjs` (ledger rows 921-922 and 2042-2047)
- Create test: `tests/identity-pg.test.mjs`
- Docs: `docs/guide/commands.md` `## user` (where identities live in db mode); `docs/architecture.md`'s identity-states table (a "Postgres, v6" row); `AGENTS.md` nothing

**Interfaces:**
- Produces, from `identity-pg.mjs`:
  - `poolExec(pool) → { run, all }`, the `pgExec` shape over `pool.query`.
  - `loadIdentityPg(exec) → Promise<{ state: "absent"|"broken"|"empty"|"healthy", store, hasIdentity, error, close }>`:
    - `absent`: `SELECT to_regclass('app_user') AS r` gives null;
    - `broken`: any query throws. `error` is `blaze: refusing to serve — the identity tables in Postgres exist but cannot be read.\n\n    <cause message>\n\nThis is a refusal, not "no users": a damaged roster must never disarm authentication. Restore the database from a pg_dump.\n`;
    - `empty`: `Number(count) === 0`;
    - `healthy`: otherwise, with `store: identityStore(exec, { dialect: "postgres" })`.

    `close` is a no-op: the caller owns the pool.
- Produces, from `init-pg.mjs`: `openPostgresPool({ host, port, database, user, password }, { Pool } = {}) → pg.Pool`. It sets `max: 4`, attaches a `pool.on("error", (e) => console.error("blaze: identity connection pool:", e.message))`, and gives the same missing-`pg` message as `openPostgresClient`.
- Produces, from `identity-db.mjs`: `resolveIdentity({ dataRoot, env = process.env, resolveDbConfig = resolveDatabaseConfig, openPgPool = openPostgresPool } = {}) → Promise<loadIdentity-shaped result & { source: "sqlite"|"postgres", reload: () => Promise<result>|result }>`:
  - `resolveWriteMode(env) !== "db"`, or the driver is `sqlite`, gives `{ ...loadIdentity(dataRoot), source: "sqlite", reload: () => loadIdentity(dataRoot) }`.
  - Postgres:
    1. `pool = await openPgPool(connection)`, then `state = await checkDbSchema(poolExec(pool), { dialect: "postgres" })`.
    2. `!state.ok` or `empty`: `await pool.end()`, then throw `blaze: ${state.error ?? "the Postgres database has no Blaze schema — run 'blaze db init'"}`.
    3. `state.version < V6_FEATURES_FROM`: `await pool.end()`, then the SQLite result above.
    4. Otherwise `{ ...(await loadIdentityPg(poolExec(pool))), source: "postgres", reload: () => loadIdentityPg(poolExec(pool)), close: () => pool.end() }`.
- `serve.mjs`:
  - `startServer` keeps `identity = loadIdentity(root)` as its default.
  - At `:348`, `ensureIdentityIgnored(root)` runs only when `identity?.source !== "postgres"`.
  - At `:558`, `const adopted = await (identity?.reload ?? (() => loadIdentity(root)))();`.
  - The standalone block (`:957-971`) becomes `server = startServer({ root, identity: await resolveIdentity({ dataRoot: root }) })`, inside the existing try. A throw prints its message and exits 1, as today.
- `user-admin.mjs`:
  - The signatures are `addUser(dataRoot, opts, deps = {})` and `setUserPassword(dataRoot, opts, deps = {})`, with `deps = { env = process.env, resolveDbConfig = resolveDatabaseConfig, openPgClient = openPostgresClient }`.
  - A private `identityTarget(dataRoot, { create }, deps)`:
    - In db mode with a Postgres driver and a stamp ≥ 6, it returns `{ store: identityStore(pgExec(client), { dialect: "postgres" }), source: "postgres", where: describePgTarget(connection), close: () => client.end() }`, where `client` comes from `openCheckedPg`.
    - Otherwise it returns today's SQLite target. `setUserPassword` keeps its "no users are configured" refusal for the SQLite target only.
  - Both functions return `source` and `where` beside today's fields.
- `user-runner.mjs`, in the `postgres` case:
  - it prints `identities: Postgres ${where}`;
  - it does **not** call `ensureIdentityIgnored`, and creates no `.blaze/` (BLZ-701);
  - `passwd` output is unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/identity-pg.test.mjs`.
  - Helpers, one per file:
    - `pgBoard(url)`: a `dbBoard()` whose `blaze.config.json` gains `"database": { "driver": "postgres" }`, and on which `createDbSchema` has run (v6).
    - `deps(url)`: `{ env: { BLAZE_WRITE_PORT: "db" }, resolveDbConfig: () => ({ driver: "postgres", connection: url }), openPgClient: pgClient }`.
    - `poolFor(url)`: `(_c) => new (pg.Pool)({ connectionString: url })`.
    - `postSetup`: copied from `tests/setup-flow.test.mjs:48-60`.
  - `"BLZ-706: loadIdentityPg reports absent, broken, empty and healthy — and broken is not absent"`:
    - absent: a fresh `scratchPgDb` with no tables;
    - broken: an exec whose `all` throws `new Error("boom")`. The result has `state: "broken"`, `hasIdentity: false`, and `error` matching `/cannot be read/` and `/boom/`;
    - empty: a v6 database;
    - healthy: after one `createUser`.
  - `"BLZ-706: resolveIdentity reads Postgres at v6 and SQLite below it"`:
    - v6 → `source: "postgres"`;
    - `makeV5` plus an `identity.db` holding one user under `dataRoot` → `source: "sqlite", state: "healthy"`;
    - `BLAZE_WRITE_PORT` unset → `source: "sqlite"` whatever the stamp.
  - `"BLZ-706: a v5 database: identity stays on SQLite"` (Review Focus 1): `makeV5`, then `addUser(dataRoot, { email: "a@b.c", role: "admin" }, deps(url))` → `source: "sqlite"` and `existsSync(identityDbPath(dataRoot))`.
  - `"BLZ-706 / BLZ-701: user add on a v6 Postgres board writes Postgres and creates no .blaze or .gitignore"`:
    - `addUser(…, deps(url))` → `source: "postgres"`;
    - `SELECT count(*) FROM app_user` = 1;
    - `existsSync(join(dataRoot, ".blaze"))` is false;
    - the board's `.gitignore` is absent or unchanged (it was never created).
  - `"BLZ-706: user passwd sets the verifier in Postgres"`: `setUserPassword(…, { email, password: "correct horse battery" }, deps(url))`, then `identityStore(...).signIn(...)` → `ok: true`.
  - `"BLZ-706: the standalone serve.mjs entry reads Postgres before bind, not SQLite"`:
    - setup: a v6 Postgres board with one admin and a token, made through `identityStore` over pg. **Also a 0-byte `<dataRoot>/.blaze/identity.db`**, which SQLite's `loadIdentity` reads as `broken` and refuses to start on.
    - Spawn `node scripts/serve.mjs` with this env:
      - `{ ...process.env minus the five, BLAZE_PROJECTS_DIR: projectsDir, BLAZE_WRITE_PORT: "db", PORT: "0", HOST: "127.0.0.1", ...pgEnvFor(url) }`.
    - Read the port from the stdout line `board → http://localhost:(\d+)`.
    - Assert:
      - `GET /api/hash` with no token → 401;
      - with `authorization: Bearer <token>` → 200;
      - the 0-byte file is still 0 bytes.
    - Kill the child in `finally`.
    - A server that had opened SQLite would have exited 1 with `/identity database .* cannot be read/`. That is the discriminator §9 asks for.
  - `"BLZ-706: post-setup adoption reloads from Postgres"`:
    - setup: an empty v6 board, and a 0-byte `.blaze/identity.db`;
    - `identity = await resolveIdentity({ dataRoot, env: { BLAZE_WRITE_PORT: "db" }, resolveDbConfig: …, openPgPool: poolFor(url) })` → `state: "empty"`;
    - `startServer({ root: dataRoot, projectsDir, port: 0, host: "0.0.0.0", identity, addUser: (r, o) => addUser(r, o, deps(url)) })`;
    - `postSetup(base, { token: readSetupToken(dataRoot), email: "admin@example.com", password: "correct horse battery" })` → 200, and its body's token authenticates `GET /api/hash` → 200.
    - Adopting through SQLite would have met the 0-byte file and answered 500.
  - `"BLZ-706: two concurrent setup completions against Postgres create exactly one admin"`:
    - setup: as above, without the 0-byte file;
    - `Promise.all` of two `postSetup` calls with the right token → the statuses sorted are `[200, 409]`;
    - `SELECT count(*) FROM app_user` = 1.
    - This makes `setupInFlight` (`serve.mjs:327`) proven against a store that really yields. Update its comment at `:316-326`: replace the "no store that ships today yields there" paragraph with `// BLZ-706: the Postgres store yields here, and tests/identity-pg.test.mjs proves the guard against it.`
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/identity-pg.test.mjs` with PG. Expected: ERR_MODULE_NOT_FOUND for `identity-pg.mjs`, or `resolveIdentity is not a function`.
- [ ] **Step 3: Implement** `identity-pg.mjs`, `openPostgresPool`, `resolveIdentity`, the four `serve.mjs` edits, and the `user-admin.mjs` / `user-runner.mjs` changes, as in Interfaces.
- [ ] **Step 4: Apply the ledger rows 921-922 and 2042-2047.** Run `node --test tests/model/seam-closure.test.mjs`. Expected: green. If the walk classifies `resolveIdentity` differently, see Global Constraints.
- [ ] **Step 5: Run the tests and watch them pass.** Run `node --test tests/identity-pg.test.mjs tests/setup-flow.test.mjs tests/serve-identity.test.mjs tests/identity-resilience.test.mjs`, then `npm test` with and without PG. Expected: green.
- [ ] **Step 6: Write the docs.**
  - `commands.md` `## user`: on a db-mode Postgres board at schema v6, users live in the database. Nothing is written under the board directory, and the output names the database.
  - `docs/architecture.md`'s identity-states table: one row, "Postgres (db mode, schema ≥ 6): `app_user` etc.; the same four states; read at start through a small connection pool; a v5 database keeps `identity.db`".
- [ ] **Step 7: Run THE DEBT STEP, then commit.**
  ```bash
  git add scripts/model/identity-pg.mjs scripts/model/identity-db.mjs scripts/init-pg.mjs scripts/serve.mjs scripts/model/user-admin.mjs scripts/user-runner.mjs tests/model/seam-closure.test.mjs tests/identity-pg.test.mjs docs/guide/commands.md docs/architecture.md scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-706: a db-mode Postgres board at v6 loads identity from Postgres before bind; user add and passwd write it there (absorbs BLZ-701)"
  ```

### Task 4: Sprints in Postgres — tables, readers, prefetch, `blaze sprint`, `--sprints-from` (BLZ-707)

**Files:**
- Modify: `scripts/model/sprint-store.mjs`, `scripts/model/sprints.mjs`, `scripts/model/read-storage.mjs` (`fsReadStorage`, `memReadStorage`), `scripts/model/sqlite-storage.mjs` (its reader), `scripts/model/pg-storage.mjs` (`postgresReader`)
- Modify consumers: `scripts/new.mjs:107`, `scripts/edit.mjs:83`, `scripts/loops/groomer.mjs:824`, `scripts/model/import-apply.mjs:343`, `scripts/views/page.mjs` (`renderView` gantt `:82`, `pageHtml`, `viewEnvelope`), `scripts/views/data.mjs:37` (`boardModel` → `buildIndex`), `scripts/serve.mjs` (`/` and `/view/<name>`)
- Modify: `scripts/sprint-runner.mjs`, `scripts/model/db-migrate.mjs`, `scripts/db-runner.mjs` (`--sprints-from`)
- Modify: `tests/model/seam-closure.test.mjs` (ledger rows 868-871, the new `sprint-store` rows, and 2052)
- Create test: `tests/sprints-pg.test.mjs`
- Docs: `AGENTS.md` `## Sprints` (one paragraph on db mode at v6), `docs/guide/commands.md` `## sprint` and `## db` (`--sprints-from`)

**Interfaces:**
- `sprints.mjs`, with behaviour unchanged for every existing caller:
  - `normaliseRegistry(parsed) → { ...parsed, active: parsed.active ?? null, sprints: parsed.sprints }`. `loadSprints` calls it.
  - `stampedRegistry(registry) → { ...registry, registryVersion }`, holding today's never-downgrade rule. `saveSprints` calls it.
- `sprint-store.mjs`:
  - `parseSprintRegistry(text, source) → registry`. It is strict, and the error is `blaze: <source>: <reason>` for each of these:
    - the text is not JSON;
    - it is not an object;
    - `sprints` is not an array;
    - a sprint is not an object;
    - `id` is missing or empty, or duplicates another;
    - `name` is not a string;
    - `start`/`end` is present and not `isIsoDate`;
    - `registryVersion` is present and not an integer ≥ 1.

    A sprint is named by `sprints[i]` and its id. It returns `normaliseRegistry(parsed)`.
  - `writeSprintRegistry(exec, registry) → Promise<void>`. It re-validates with the same rules (it throws on the first invalid sprint), then runs `DELETE FROM sprint` and `DELETE FROM sprint_registry`. It inserts one `sprint_registry` row (`id 1, active, registry_version, extra_json = JSON of every top-level key except active, sprints, registryVersion`), and one `sprint` row per sprint (`ord` = index, `start_date`/`end_date` from `start`/`end` or null, `extra_json` = every key except `id, name, start, end`). The caller owns the transaction.
  - `readSprintRegistry(exec) → Promise<registry>`:
    - no registry row and no sprints → `{ active: null, sprints: [] }`;
    - otherwise `{ ...JSON.parse(extra_json), active, sprints, ...(registry_version !== null ? { registryVersion } : {}) }`. Each sprint is `{ id, name, ...(start_date ? { start } : {}), ...(end_date ? { end } : {}), ...JSON.parse(extra_json) }`, ordered by `ord`. Dates are read as `start_date::text`.
  - `openSprintSource({ dataRoot, env = process.env, resolveDbConfig = resolveDatabaseConfig, openPgClient = openPostgresClient }) → Promise<{ kind: "postgres"|"file", where, load(), save(registry), close() }>`:
    - **postgres** (db mode, `postgres` driver, stamp ≥ `V6_FEATURES_FROM`): `save` runs `BEGIN; writeSprintRegistry(exec, stampedRegistry(r)); COMMIT`, and `ROLLBACK` on a throw.
    - **file**: `{ kind: "file", where: join(dataRoot, "sprints.json"), load: () => loadSprints({ root: dataRoot }), save: (r) => saveSprints({ root: dataRoot }, r), close() {} }`.
- Every reader gains `sprintRegistry(dataRoot)`, async-capable:
  - `fsReadStorage` and the SQLite reader → `loadSprints({ root: dataRoot })`;
  - `memReadStorage` → `{ active: null, sprints: [] }`;
  - `postgresReader(client)` → reads `SELECT value FROM blaze_meta WHERE key = 'schema_version'` once per reader (memoised in its closure). At ≥ `V6_FEATURES_FROM` it returns `readSprintRegistry(pgExec(client))`, and otherwise `loadSprints({ root: dataRoot })`.
- Consumers:
  - `applyNew`, `applyEdit`, groomer `validateGroomed` and import `loadBoard` replace `loadSprints({ root: … })` with `await readStorage.sprintRegistry(<same root>)`.
  - `pageHtml({ …, sprints })` and `viewEnvelope({ …, sprints })` pass `sprints` (a registry object) to `renderView` and to `boardModel(pDir, { …, sprints })`, which passes `sprints: sprints?.sprints` to `buildIndex`.
  - `renderView`'s gantt uses `sprints ?? loadSprints({ root: dirname(pDir) })`.
  - `serve.mjs`'s `/` and `/view/<name>` pass `sprints: await rs.sprintRegistry(root)` inside `reading(...)`.
- `migrateDb`'s `sprintRegistry` option:
  - At slot 5 it refuses if `SELECT count(*) FROM sprint` > 0 or a `sprint_registry` row exists (`sprint copy refused: the sprint tables already hold a registry`), then `writeSprintRegistry`.
  - At slot 7 it compares `canonicalStrict(await readSprintRegistry(exec))` with `canonicalStrict(source)`. On a mismatch it throws `sprint verify: the registry read back from Postgres differs from <source>`, and names the first differing sprint id when one differs.
  - It returns `sprints: { count, active }`.
- `db-runner.mjs`:
  - `--sprints-from <path>` is read through `readRegularFileSync` and `parseSprintRegistry(text, path)` before connecting. A failure prints `blaze db migrate: <message>` and `Nothing was migrated.`, then exits 1.
  - Output: `  sprints        N sprint(s), active <id|none>  (verified)`.
- `sprint-runner.mjs`:
  - `const source = await openSprintSource({ dataRoot })` after the config guard. Every `loadSprints`/`saveSprints` becomes `await source.load()`/`await source.save(registry)`. `source.close()` runs in a `finally`.
  - In `postgres` mode the `new`/`active` lines gain ` (database: ${where})`. File-mode output is byte-identical.

- [ ] **Step 1: Write the failing tests** in `tests/sprints-pg.test.mjs`. The pure ones run always, and the pg ones are `PG_SKIP`.
  - `"BLZ-707: parseSprintRegistry refuses what the tables cannot hold, by name"`: seven cases, one per rule, each `assert.throws(…, /<rule>/)`. A valid registry returns `normaliseRegistry` of it.
  - `"BLZ-707: a registry with unknown keys at both levels round-trips through Postgres"`:
    - `REG = { active: "S2", registryVersion: 1, activeByProject: { BLZ: "S2" }, sprints: [{ id: "S1", name: "One", start: "2026-07-13", end: "2026-07-26", goal: "x" }, { id: "S2", name: "Two", start: "2026-07-27", end: "2026-08-09" }] }`;
    - `writeSprintRegistry`, then `readSprintRegistry` → `canonicalStrict(read) === canonicalStrict(REG)`.
  - `"BLZ-707: an empty database reads as no sprints"` → `{ active: null, sprints: [] }`.
  - `"BLZ-707: migrate --sprints-from imports and verifies; a tampered row aborts"`:
    - `makeV5`, `migrateDb(exec, { sprintRegistry: REG })` → `sprints: { count: 2, active: "S2" }`;
    - on a second `makeV5` database, `beforeVerify: (e) => e.run("UPDATE sprint SET name = 'tampered' WHERE id = 'S1'")` → rejects `/sprint verify: .*S1/`, and the stamp is still `'5'`.
  - `"BLZ-707: a malformed sprints.json is refused before anything connects"`: `runDb(["migrate", "--sprints-from", <file holding "{\"sprints\": 3}">], { …, openPostgresClient: () => { throw new Error("must not connect"); } })` → 1, and err matches `/sprints is not an array/` and `/Nothing was migrated/`.
  - `"BLZ-707: a v5 database: sprints stay on the file"` (Review Focus 1): `makeV5`, then a `sprints.json` with S1 in `dataRoot` → `postgresReader(c).sprintRegistry(dataRoot)` names S1.
  - `"BLZ-707: at v6 the gantt renders the database's sprints"`:
    - a v6 Postgres board, `writeSprintRegistry(REG)`, and **no** `sprints.json`;
    - a ticket ENG-1 with `sprint: S2`, `start`/`due` inside S2, loaded with `blaze db load`;
    - `startServer({ root, projectsDir, port: 0 })` with `process.env` holding `BLAZE_WRITE_PORT=db` and every key of `pgEnvFor(url)` for the run, set and restored in `finally` as `serve-db-mode.test.mjs:17-31` does. The server resolves the database through `resolveDatabaseConfig`'s env layer, so nothing is injected.
    - `GET /view/gantt?sprint=S2` → 200, and `JSON.parse(body).html` includes `ENG-1` and `Two`.
  - `"BLZ-707: --sprint validates against the database registry at v6"`: `applyNew(projectsDir, { project: "ENG", type: "task", title: "t", extra: { estimate: 30, sprint: "S2" }, readStorage: postgresReader(c), writePort: dbWritePort(pgExec(c), { dialect: "postgres" }) })` → `ok: true`. With `sprint: "S9"` → `ok: false`, and errors match `/sprint 'S9' is not in the registry/`.
  - `"BLZ-707: blaze sprint new and active write the database at v6, and write no sprints.json"`:
    - spawn `node scripts/sprint-runner.mjs new "Three" --start 2026-08-10 --end 2026-08-23` with `BLAZE_WRITE_PORT=db` and `pgEnvFor(url)` → exit 0, and stdout matches `/^created S3 \(database: /`;
    - then `active S3` → exit 0;
    - `readSprintRegistry` has `active: "S3"` and three sprints, and `existsSync(join(dataRoot, "sprints.json"))` is false.
  - `"BLZ-707: blaze sprint on an fs board is byte-identical"`: an fs board and `sprint new "A" --start 2026-07-13 --end 2026-07-26` → stdout is exactly `created S1\n`, and `sprints.json`'s `registryVersion` is `1`.
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/sprints-pg.test.mjs` with PG. Expected: `parseSprintRegistry is not a function` (or ERR_MODULE_NOT_FOUND on its import), and `sprintRegistry is not a function`.
- [ ] **Step 3: Implement** the Interfaces block. Then grep the five test files that pass hand-built readers into these verbs: `tests/db-runner-pg.test.mjs`, `tests/db-mode-reads-pg.test.mjs`, `tests/verbs-read-through-seam.test.mjs`, `tests/reserve-window.test.mjs` and `tests/import-db-mode.test.mjs`. Grep the groomer tests too (`rg -n "listTickets\s*[:(]" tests | rg -v "memReadStorage|fsReadStorage|postgresReader"`). Add `sprintRegistry() { return { active: null, sprints: [] }; }` to every literal reader the run reports missing it, with `// BLZ-707: every reader answers sprintRegistry`. There is **no** fallback in production code (ADR-0009: the names are the contract).
- [ ] **Step 4: Apply the ledger rows 868-871, the two `sprint-store` rows and 2052.** Run `node --test tests/model/seam-closure.test.mjs`. Expected: green.
- [ ] **Step 5: Run the tests and watch them pass.** Run `node --test tests/sprints-pg.test.mjs tests/model/sprints*.test.mjs tests/views/*.test.mjs tests/serve-db-mode.test.mjs`, then `npm test` with and without PG. Expected: green, and the page golden (`tests/views/page-golden.html`) unchanged.
- [ ] **Step 6: Write the docs.**
  - `AGENTS.md` `## Sprints`: "On a db-mode Postgres board at schema v6, the registry lives in the database (`sprint`, `sprint_registry`); `blaze sprint` writes there and `sprints.json` is not read. `blaze db migrate --sprints-from` imports an existing file once."
  - `commands.md` `## sprint` and `## db`: the same, plus the `--sprints-from` flag.
- [ ] **Step 7: Run THE DEBT STEP, then commit.**
  ```bash
  git add scripts/model/sprint-store.mjs scripts/model/sprints.mjs scripts/model/read-storage.mjs scripts/model/sqlite-storage.mjs scripts/model/pg-storage.mjs scripts/new.mjs scripts/edit.mjs scripts/loops/groomer.mjs scripts/model/import-apply.mjs scripts/views/page.mjs scripts/views/data.mjs scripts/serve.mjs scripts/sprint-runner.mjs scripts/model/db-migrate.mjs scripts/db-runner.mjs tests/model/seam-closure.test.mjs tests/sprints-pg.test.mjs <each test file Step 3 touched> AGENTS.md docs/guide/commands.md scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-707: sprints live in Postgres at v6 — readers, prefetch, blaze sprint and migrate --sprints-from"
  ```

### Task 5: G-engine — refuse fs writes on a board whose config names the postgres driver (BLZ-708)

**Files:**
- Create: `scripts/model/fs-write-guard.mjs`
- Modify: `scripts/cli.mjs` (after the remote-mode block, before the schema preflight), `scripts/model/write-port-resolve.mjs` (`resolveWritePort`'s fs branch), `scripts/sprint-runner.mjs`, `scripts/model/user-admin.mjs` (`identityTarget`'s non-db branch)
- Create test: `tests/fs-write-guard.test.mjs`
- Docs: `AGENTS.md` (a new section `## A Postgres board refuses file writes`, after `## Read-only mode`), `docs/guide/commands.md` `## Environment variables` (the `BLAZE_WRITE_PORT` row: unset vs `fs`)

**Interfaces:**
- `fsWriteRefusal({ env = process.env, config, what }) → string | null`. It is pure. It returns the refusal when `config?.database?.driver === "postgres"` **and** `env[WRITE_PORT_ENV] === undefined`, and `null` otherwise. That makes an explicit `fs`, `dual` or `db` allowed, along with any other driver, or no `database` block at all. The text is exactly:
  `blaze: refusing to ${what} — this board's blaze.config.json names database.driver "postgres", but BLAZE_WRITE_PORT is unset, so the write would land in this checkout's files and never reach the database the board serves. Write to the live board in remote mode (BLAZE_REMOTE_URL and BLAZE_TOKEN), or set BLAZE_WRITE_PORT=db. During a migration, BLAZE_WRITE_PORT=fs states that a file write is deliberate.`
- `assertFsWriteAllowed(what, { dataRoot = null, env = process.env } = {}) → Promise<void>`:
  - It resolves `dataRoot ?? resolveRoots().dataRoot` and runs `loadConfig({ root })`. Both are imported dynamically from `../config.mjs`, as `dbConfigFor` does.
  - **If resolving or loading throws, it returns.** The verb's own load reports that, and a config that fails to load is itself a refusal (D8's tombstone note).
  - It throws `new Error(fsWriteRefusal(...))` when that is non-null.
- `cli.mjs`: `if (sub.mutates && !readOnlyInvocation && key !== "db") { try { await assertFsWriteAllowed(\`run blaze ${key}\`); } catch (e) { console.error(e.message); process.exit(1); } }`. It sits after the remote block (so remote mode never reaches it) and before the preflight. `blaze db *` is exempt (D5).
- `resolveWritePort`: in the `mode === "fs"` branch, before building the port, `if (dataRoot) await assertFsWriteAllowed("write to this board", { dataRoot, env })`. This also covers `resolvePorts` (the six runners, import, reconcile `--apply`) and `serve.mjs`'s mutating block, which already turns a resolver throw into a 503.
- `sprint-runner.mjs`: for `new` and `active`, `await assertFsWriteAllowed("create/activate a sprint", { dataRoot })` before `source.save`, when `source.kind === "file"`.
- `user-admin.mjs`: in `identityTarget`'s non-db branch, `await assertFsWriteAllowed("run blaze user", { dataRoot, env: deps.env })` before any open.

- [ ] **Step 1: Write the failing tests** in `tests/fs-write-guard.test.mjs`.
  - Fixture `pgDriverBoard()`: the `dbBoard()` shape plus `"database": { "driver": "postgres" }` in `blaze.config.json`. No database is needed.
  - `run(args, env)` spawns `scripts/cli.mjs` with `BLAZE_PROJECTS_DIR`, and with the five env variables deleted unless `env` sets them.
  - `snapshot(projectsDir)` is a sorted recursive file listing with sizes.
  - `"BLZ-708: fsWriteRefusal — only the implicit default is refused"` (pure): `{}` → string; `{ BLAZE_WRITE_PORT: "fs" }`, `"dual"`, `"db"` → null; a config with driver `sqlite`, and one without `database` → null.
  - `"BLZ-708: every mutating verb refuses on a postgres-driver board when BLAZE_WRITE_PORT is unset"`:
    - parse `run(["--help"])`'s stdout for command names;
    - for each name not in `READ_ONLY = ["board", "audit", "export", "rollup"]` and not `db`, under `subTest`: `run([name])` → status 1, stderr includes `BLAZE_WRITE_PORT is unset`, and `snapshot` is unchanged;
    - also assert the derived list includes `new, move, edit, link, resolve, log, sprint, user, reindex, import, matrices`, so a parsing failure cannot pass vacuously.
  - `"BLZ-708: an explicit fs is allowed and writes the file"`: `run(["new", "--project", "ENG", "--type", "task", "t", "--estimate", "30"], { BLAZE_WRITE_PORT: "fs" })` → 0, and a new `ENG-2-*.md` exists.
  - `"BLZ-708: dual, db and remote mode never meet the guard"`:
    - `BLAZE_WRITE_PORT: "dual"` and `"db"` with `move ENG-1 in-progress`, and `BLAZE_REMOTE_URL: "http://127.0.0.1:9", BLAZE_TOKEN: "blz_x"` with `new …`;
    - each stderr `doesNotMatch(/BLAZE_WRITE_PORT is unset/)`. They fail later, on the missing connection, and that is expected.
  - `"BLZ-708: blaze db is exempt"`: `run(["db", "status"])` → stderr `doesNotMatch(/BLAZE_WRITE_PORT is unset/)`.
  - `"BLZ-708: direct runners refuse too"`:
    - `node scripts/move-runner.mjs ENG-1 in-progress` → 1, the guard sentence, and the file still under `defined/`;
    - `node scripts/sprint-runner.mjs new "S" --start 2026-07-13 --end 2026-07-26` → 1, and no `sprints.json`;
    - `node scripts/user-runner.mjs add --email a@b.c` → 1, and no `.blaze/identity.db`.
  - `"BLZ-708: the board server's write API refuses"`:
    - `startServer({ root, projectsDir, port: 0 })` with `process.env.BLAZE_WRITE_PORT` deleted (restored in `finally`);
    - `POST /api/move {id:"ENG-1", to:"in-progress"}` with the CSRF header → 503, and the body's `errors[0]` includes `BLAZE_WRITE_PORT is unset`;
    - the file has not moved;
    - `GET /api/hash` still answers 200, because reads are not refused.
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/fs-write-guard.test.mjs`. Expected: ERR_MODULE_NOT_FOUND for `fs-write-guard.mjs`, and once that exists, exit 0 instead of 1 on the verbs.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run them and watch them pass.** Run `node --test tests/fs-write-guard.test.mjs`, then `npm test` with and without PG. **Any other test that now fails** writes files on a postgres-driver board with the port unset, which is exactly what G-engine refuses. Give its spawn env or `resolveWritePort` call `BLAZE_WRITE_PORT: "fs"`, with `// BLZ-708: an explicit fs — this test writes files on a postgres-driver board on purpose`. Never weaken the guard to pass it. List each such file in the commit body.
- [ ] **Step 5: Prove the test discriminates.** Temporarily make `fsWriteRefusal` return `null`, then run `node --test tests/fs-write-guard.test.mjs`. Expected: the verb, runner and server tests fail. Restore it, and note the result in the commit body (`regression-injected: N tests red`).
- [ ] **Step 6: Write the docs.**
  - `AGENTS.md`'s new section: the rule, the three allowed spellings, the `db` exemption, why it refuses rather than warns (A2), and that it cannot protect an engine older than 0.10.0 (D5's table).
  - The `commands.md` env row.
- [ ] **Step 7: Run THE DEBT STEP (if Step 4 edited tests), then commit.**
  ```bash
  git add scripts/model/fs-write-guard.mjs scripts/cli.mjs scripts/model/write-port-resolve.mjs scripts/sprint-runner.mjs scripts/model/user-admin.mjs tests/fs-write-guard.test.mjs <Step 4's files> AGENTS.md docs/guide/commands.md scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-708: a board whose config names the postgres driver refuses file writes unless BLAZE_WRITE_PORT says otherwise"
  ```

### Task 6: ADR-0039, the ADR-0006 addendum, the docs sweep, and 0.10.0 (BLZ-711)

**Files:**
- Create: `docs/decisions/0039-board-data-lives-in-postgres-board-config-in-the-platform-chart.md`
- Modify: `docs/decisions/0006-*.md` (an addendum after the BLZ-254 addendum at `:94`), `docs/decisions/` index or README if one lists ADRs (`rg -l "0038-reads-resolve" docs README.md` finds the lists)
- Modify: `package.json`, `package-lock.json` (both `version` fields), `tests/package.test.mjs:24-36`
- Sweep: `rg -n "identity\.db|sprints\.json|init --force|Both are 5" README.md AGENTS.md docs --glob '!docs/superpowers/**'`. Every hit that is now false for a db-mode Postgres board at v6 gets a qualifying clause. fs-mode statements stay.

**Interfaces:** none. This task is text and the version.

- [ ] **Step 1: Write the failing test.** In `tests/package.test.mjs`, retitle the BLZ-687 test to `"BLZ-711: this tree is 0.10.0 — DB schema v6 (BLZ-705) — and 0.8.0 stays the frozen release"`. Its three version assertions become `"0.10.0"`. The other assertions in it stay, and the comment gains `// BLZ-711: 0.9.0 → 0.10.0 because a 0.9.0 engine refuses a v6 database as newer, so the two must be distinguishable (plan Finding 16).`
- [ ] **Step 2: Run it and watch it fail.** Run `node --test tests/package.test.mjs`. Expected: `'0.9.0' !== '0.10.0'`.
- [ ] **Step 3: Bump the version.** Run `npm version 0.10.0 --no-git-tag-version --ignore-scripts`, then check `git diff package.json package-lock.json` shows exactly the three version lines.
- [ ] **Step 4: Write ADR-0039** in the house format (`# 39. Board data lives in Postgres; board configuration lives in the platform chart`, `Date: 2026-10-22`, `## Status` Accepted (BLZ-711, feature BLZ-703), `## Context`, `## Decision`, `## Consequences`, `## Alternatives rejected`). Content, generic and public-safe (no hostnames, no operator paths):
  - **Context:** a deployed db-mode board still read identities, sprints and project taxonomy from a writable checkout, and a second checkout could be written in fs mode and silently diverge (spec §1).
  - **Decision:**
    1. Board *data* (tickets, events, users, tokens, sessions, sprints) lives in the board's Postgres database, and nowhere else, once `blaze db migrate` has marked it authoritative.
    2. Board *configuration* (`blaze.config.json`, `projects/<KEY>/project.json`) is mounted read-only from the deployment's own versioned configuration (for example a Helm chart). It is reviewed, versioned and revertible there, and the engine reads it unchanged through `loadConfig`/`loadProject`.
    3. The schema moves forward only, in one transaction (D1).
    4. A postgres-driver config refuses implicit fs writes (D5).
    5. Remote mode is the agent surface, and admin verbs run inside the deployment (D7).
  - **Consequences:**
    - `init --force` and `load --replace` are refused on an authoritative database;
    - a `pg_dump` is the backup, and now holds credential hashes;
    - fs mode is unchanged;
    - an engine older than 0.10.0 is not protected by the guard;
    - the Live view is local-file-only.
  - **Alternatives rejected:**
    - identity on a PVC (D2(a));
    - project config in `blaze_config.project` (D4(a));
    - raising MIN to 6 (D1(a));
    - adding tables without a bump (D1(c)).
  - **Link** the spec by its repository path.
- [ ] **Step 5: Write the ADR-0006 addendum.** Title it `## Addendum (2026-10-22, BLZ-711) — a deployed db board is the only writable store`. Two short paragraphs:
  - the single-machine fs rule from the BLZ-254 addendum still holds;
  - a deployed board's data is now Postgres-only (ADR-0039), and a checkout of a migrated board must not be written, which G-engine enforces for engines ≥ 0.10.0.
- [ ] **Step 6: Run the sweep** (Files). Then run `node --test tests/package.test.mjs tests/schema-versioning-docs.test.mjs tests/quoted-sources.test.mjs`, then `npm test`. Expected: green.
- [ ] **Step 7: Commit.**
  ```bash
  git add docs/decisions/0039-board-data-lives-in-postgres-board-config-in-the-platform-chart.md docs/decisions/0006-*.md package.json package-lock.json tests/package.test.mjs <swept files>
  git commit -m "BLZ-711: ADR-0039 (board data in Postgres, config in the platform chart), ADR-0006 addendum, 0.10.0"
  ```

### Task 7: E1 whole-branch verification, the v5-compatibility rehearsal, push and PR

**Routing:** haiku runs Steps 1–3 and reports output verbatim. Opus does Step 4.

- [ ] **Step 1: Run the full suite twice.** Run `npm test` without PG, then with PG. Record both summaries next to the baseline. Expected: fail 0 both times. Tests and suites are up by the new files, and pass + skipped = tests.
- [ ] **Step 2: Rehearse v5 → v6 against a throwaway Postgres** (Finding 4, and Review Focus 1 and 2). In the scratchpad, never in the repo:
  ```bash
  OLD=/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-703-plan-a-v5engine
  git -C /home/rnamwoh/Documents/Code/blaze worktree add --detach "$OLD" 2ecae26 && (cd "$OLD" && npm ci --ignore-scripts)
  ```
  1. Make a scratch board with `blaze.config.json` `{ "projects": ["ENG"], "schemaVersion": 2, "database": { "driver": "postgres" } }`, one ENG ticket, a `sprints.json` with S1–S2 (`active: "S2"`), and the env from `pgEnvFor` pointing at a fresh `blaze_rehearsal` database.
  2. With the **old** engine (`node $OLD/scripts/cli.mjs`): `db init`, `db load`, and `BLAZE_WRITE_PORT=db … user add --email r@example.com --role admin`. That writes `.blaze/identity.db`, because v5 has no pg identity. Record the stamp (`5`).
  3. With the **new** engine, `BLAZE_WRITE_PORT=db`:
     - `blaze db migrate` alone with a deliberately malformed `--sprints-from` → exit 1, stamp still `5`;
     - then `blaze db migrate --identity-from <board>/.blaze/identity.db --sprints-from <board>/sprints.json` → exit 0, printing the per-table counts. Those counts must equal `sqlite3 <identity.db> 'select count(*) from <t>'` for each table (use `node -e` with `node:sqlite` if `sqlite3` is absent);
     - then start `node scripts/serve.mjs` with `PORT=0` and the printed token → `GET /api/hash` 200, no token 401, and `GET /view/gantt?sprint=S2` contains S2.
  4. With the **old** engine against the now-v6 database: `blaze db status`/any read → refused as `newer` (the §5 rollback note, observed).
  5. Remove the old worktree with `git -C /home/rnamwoh/Documents/Code/blaze worktree remove "$OLD"`, and `docker stop blz703-pg`.

  Paste the commands and outputs into the PR body under "v5-compatibility rehearsal".
- [ ] **Step 3: Run the hygiene checks.** Run `node scripts/ci/hygiene-check.mjs origin/main` → exit 0. Run `git log origin/main..HEAD --format='%s%n%b' | rg -n 'Co-Authored-By|Signed-off-by'` → nothing. Run `git diff origin/main --stat`, and check that every file is in this plan's File Structure.
- [ ] **Step 4: Opus whole-branch review**, against the spec's D1–D5 and §9, this plan's Review Focus 1–3, and the Seam-closure ledger. Any finding is fixed in a new commit under the owning child key and re-verified (Step 1).
- [ ] **Step 5: Push and open the PR** (the orchestrator does this): `git push -u origin BLZ-703-e1-db-completeness`, then `gh pr create --title "BLZ-703: E1 — db completeness (schema v6, migrate, identity and sprints in Postgres, fs-write guard)" --body <children BLZ-705/706/707/708/711; what is inert on v5; the rehearsal; test summaries; the attribution line>`. Merge when CI is green (the Postgres job included), per the operator's standing merge authority. E1's deploy is §5 step 0.

---

## E2 — hjr15/blaze, remote agent surface

**Setup, after E1 has merged:** `git -C /home/rnamwoh/Documents/Code/blaze fetch origin && git -C /home/rnamwoh/Documents/Code/blaze worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-703-e2-remote-agent-surface -b BLZ-703-e2-remote-agent-surface origin/main`, then the environment. Record a fresh baseline.

### Task 8: Remote reads — `GET /api/ticket(s)`, `/api/projects`, remote `show` and `list` (BLZ-709)

**Files:**
- Create: `scripts/model/ticket-json.mjs`
- Modify: `scripts/model/serve-auth.mjs` (`ROUTE_SCOPES`), `scripts/serve.mjs` (three GET routes beside `/api/panel`), `scripts/remote-client.mjs`, `scripts/cli.mjs` (`SUBCOMMANDS` `show` and `list`, and the remote-only refusal)
- Modify: `tests/fs-write-guard.test.mjs` (`READ_ONLY` gains `"show", "list"`)
- Create test: `tests/remote-reads.test.mjs`
- Docs: `docs/guide/commands.md` `## Remote mode` (show, list, `--projects`, `--json`), and `AGENTS.md` `## Remote mode`. Replace "read the board over `GET /api/live` or the page" with "read it with `blaze show <id>` and `blaze list` (remote mode), or the page".

**Interfaces:**
- `ticketJson(rec, { body = true } = {}) → { id, project, status, frontmatter, body? }`. `id = rec.frontmatter?.id ?? null`, `project = rec.project ?? rec.frontmatter?.project ?? null`, `status = rec.status ?? null`, and `frontmatter = { ...rec.frontmatter }`. `rec.file` and every other key are dropped.
- `ROUTE_SCOPES` gains `"GET /api/ticket": "read"`, `"GET /api/tickets": "read"` and `"GET /api/projects": "read"`, under `// BLZ-709: remote reads (spec D7)`.
- `serve.mjs` routes, each inside `reading(...)` with a `catch` that logs `boardFailureReason(e)` and answers `500 { errors: ["the board could not be read"] }`:
  - `GET /api/ticket?id=`:
    - no id → `400 { ok: false, errors: ["id is required"] }`;
    - otherwise `rs.getTicket(projectsDir, id)`:
      - `duplicates` → `409 { ok: false, errors: [\`${id} is ambiguous: ${n} records carry it\`] }`;
      - not found → `404 { ok: false, errors: ["not found"] }`;
      - found → `200 { ok: true, ticket: ticketJson(found) }`.
  - `GET /api/tickets?project=&status=&type=`: `allTickets(rs)`, filtered by each given parameter (exact match on `frontmatter.project`, `status` and `frontmatter.type`), sorted by project and then by the numeric part of the id. The answer is `200 { ok: true, tickets: [...].map((r) => ticketJson(r, { body: false })) }`.
  - `GET /api/projects`: `200 { ok: true, projects: listProjects(cfgFor(root)).map((key) => { const p = loadProject(key, { root, projectsDir, allowMissing: true }); return { key, labels: p.labels ?? [], components: p.components ?? [], requireLabels: Boolean(p.requireLabels), requireComponents: Boolean(p.requireComponents), requireWorklogBeforeTerminal: Boolean(p.requireWorklogBeforeTerminal) }; }) }`. It never includes `codeRepos` or `codeRepoPaths`.
- `remote-client.mjs`:
  - `REMOTE_VERBS` gains `show: "/api/ticket"` and `list: "/api/tickets"`.
  - `requestFor` returns `{ method, path, body, read, json }`. Writes have `method: "POST"`, `read: false`, and their body unchanged.
    - `show <id> [--json]` → `{ method: "GET", path: \`/api/ticket?id=${encodeURIComponent(id)}\`, read: "ticket", json }`. Usage: `usage: blaze show <id> [--json]`.
    - `list [--project K] [--status S] [--type T] [--json]` → a GET to `/api/tickets` with a `URLSearchParams` query, `read: "tickets"`.
    - `list --projects [--json]` → a GET to `/api/projects`, `read: "projects"`.
    - An unknown flag gives `unknown flag: <flag>`.
  - `runRemote` passes `req.method` to `requestRemote`. On a read it prints `renderRead(req, answer, cfg.origin)` instead of `successLine`.
  - `renderRead(req, answer, origin) → string`:
    - with `json`: `JSON.stringify(answer.ticket ?? answer.tickets ?? answer.projects, null, 2)`;
    - `ticket`: line 1 is `${id}  ${status}  ${type}  ${title}`. Then each frontmatter key except `id, title, type, project` as `  ${k}: ${v}`, where an array is joined with `", "`, an object is JSON, and empty/null is skipped. Then a blank line and the body;
    - `tickets`: one `${id}  ${status}  ${type}  ${title}` line per ticket;
    - `projects`: one `${key}  labels: ${labels.join(", ") || "-"}  components: ${components.join(", ") || "-"}` line per project.

    The count line, `${n} ticket(s) (remote: ${origin})` or `${n} project(s) …`, is written to **stderr** by `runRemote`, so `--json` stdout stays parseable.
- `cli.mjs`:
  - `SUBCOMMANDS` gains `show: { file: null, desc: "show one ticket (remote mode — BLAZE_REMOTE_URL)", mutates: false, remoteOnly: true }` and `list: { file: null, desc: "list tickets, or --projects (remote mode — BLAZE_REMOTE_URL)", mutates: false, remoteOnly: true }`.
  - After the remote block: `if (sub.remoteOnly) { console.error(\`blaze: ${key} reads the live board over HTTP and runs in remote mode only — set BLAZE_REMOTE_URL and BLAZE_TOKEN. Locally, read projects/ or run \\\`blaze board\\\`.\`); process.exit(1); }`.

- [ ] **Step 1: Write the failing tests** in `tests/remote-reads.test.mjs`.
  - Fixture:
    - a `dbBoard()` (SQLite db mode), `runDb(["init"], …)`, and a second ticket ENG-2 of type `bug` in `in-progress`, loaded with `db init --force`, or written before init;
    - `project.json` with `labels: ["ux"]` and `codeRepos: ["../somewhere"]`;
    - users made with `addUser(dataRoot, …)`: a viewer, `v@example.com`, and a member, `m@example.com`;
    - `process.env.BLAZE_WRITE_PORT = "db"` while the server runs (restored in `finally`);
    - `startServer({ root, projectsDir, port: 0 })`.
  - `"BLZ-709: the three read routes are classified read"` (pure): `ROUTE_SCOPES["GET /api/ticket"] === "read"`, and the same for `/api/tickets` and `/api/projects`.
  - `"BLZ-709: a viewer reads a ticket; no token is 401"`:
    - viewer → `GET /api/ticket?id=ENG-1` → 200 and `ticket.id === "ENG-1"`, `ticket.status === "defined"`, `ticket.frontmatter.estimate === 30` (a number), and `ticket.body` includes `one`;
    - no header → 401.
  - `"BLZ-709: unknown id 404, missing id 400"`.
  - `"BLZ-709: list filters by project, status and type"`: `?status=in-progress` → only ENG-2; `?type=task` → only ENG-1; no params → `["ENG-1", "ENG-2"]` in order; each item has no `body` key.
  - `"BLZ-709: /api/projects carries taxonomy and no server path"`: `projects[0]` is `{ key: "ENG", labels: ["ux"], components: [], requireLabels: false, requireComponents: false, requireWorklogBeforeTerminal: false }`.
  - `"BLZ-709: no read answer contains a server filesystem path"`: for each of the three routes, `assert.ok(!text.includes(projectsDir) && !text.includes(dataRoot))`.
  - `"BLZ-709: an fs board's duplicate id is 409 without paths"`: an fs board with two `ENG-1` files and no identity (loopback) → 409, and the body does not include `projectsDir`.
  - `"BLZ-709: remote show and list round-trip end to end"`: spawn `scripts/cli.mjs` with `BLAZE_REMOTE_URL=http://127.0.0.1:<port>` and `BLAZE_TOKEN=<viewer token>`:
    - `show ENG-1 --json` → 0, and `JSON.parse(stdout).id === "ENG-1"`;
    - `show ENG-1` → stdout's first line is `ENG-1  defined  task  A task`;
    - `list --project ENG --json` → two ids;
    - `list --projects --json` → `[{ key: "ENG", … }]`;
    - `list --status in-progress` → stdout is exactly `ENG-2  in-progress  bug  <title>\n`, and stderr matches `/1 ticket\(s\) \(remote: /`.
  - `"BLZ-709: show and list refuse outside remote mode"`: `scripts/cli.mjs show ENG-1` with no remote env → 1, and stderr matches `/runs in remote mode only/`.
  - `"BLZ-709: requestFor builds GETs and refuses unknown flags"` (pure):
    - `requestFor("show", ["A B"])` → path `/api/ticket?id=A%20B`;
    - `requestFor("list", ["--status", "done", "--type", "bug"])` → path `/api/tickets?status=done&type=bug`;
    - `requestFor("list", ["--bogus"])` → `{ error: "unknown flag: --bogus" }`.
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/remote-reads.test.mjs`. Expected: ERR_MODULE_NOT_FOUND for `ticket-json.mjs`, then 404s, then usage-dump exits.
- [ ] **Step 3: Implement** the Interfaces block. Add `"show", "list"` to `tests/fs-write-guard.test.mjs`'s `READ_ONLY` with `// BLZ-709: remote-only reads`.
- [ ] **Step 4: Run them and watch them pass.** Run `node --test tests/remote-reads.test.mjs tests/remote-mode.test.mjs tests/model/serve-auth.test.mjs tests/fs-write-guard.test.mjs`, then `npm test`. Expected: green. If `tests/model/serve-auth.test.mjs` pins `ROUTE_SCOPES` exactly, extend it to the three new routes in the same commit.
- [ ] **Step 5: Write the docs** (Files).
- [ ] **Step 6: Run THE DEBT STEP, then commit.**
  ```bash
  git add scripts/model/ticket-json.mjs scripts/model/serve-auth.mjs scripts/serve.mjs scripts/remote-client.mjs scripts/cli.mjs tests/remote-reads.test.mjs tests/fs-write-guard.test.mjs <serve-auth test if touched> docs/guide/commands.md AGENTS.md scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-709: remote reads — GET /api/ticket, /api/tickets, /api/projects and remote blaze show / list"
  ```

### Task 9: `BLAZE_TOKEN_FILE`, a TLS-failure hint, and `docs/operations/live-board.md` (BLZ-710)

**Files:**
- Modify: `scripts/remote-client.mjs` (`remoteFrom`, `failureLine`), `scripts/cli.mjs` (the remote gate condition, `:172`), `tests/setup/no-remote.mjs`
- Create test: `tests/remote-token-file.test.mjs`
- Create: `docs/operations/live-board.md`
- Docs: `docs/guide/commands.md` `## Remote mode` and `## Environment variables`; `AGENTS.md` `## Remote mode`

**Interfaces:**
- `REMOTE_TOKEN_FILE_ENV = "BLAZE_TOKEN_FILE"` (exported).
- `remoteFrom(env = process.env, { readFile = (p) => readRegularFileSync(p, "utf8") } = {})`:
  - The token is `env.BLAZE_TOKEN` when non-empty after trim. Otherwise, if `BLAZE_TOKEN_FILE` is non-empty, the token is `readFile(path).trim()`.
  - The half-set rule counts either source as "the credential". The messages name `BLAZE_TOKEN (or BLAZE_TOKEN_FILE)`.
  - Errors, which never interpolate the file's content:
    - unreadable: `blaze: BLAZE_TOKEN_FILE (${path}) could not be read (${e.code ?? "error"})`;
    - empty: `blaze: BLAZE_TOKEN_FILE (${path}) is empty`;
    - internal whitespace: today's `contains whitespace` message, naming `BLAZE_TOKEN_FILE` when that was the source.
- `failureLine(prefix, origin, e)`: when `e?.cause?.code` is in `TLS_TRUST_CODES = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"])` (Finding 6), it returns:
  `${prefix}: ${origin}'s TLS certificate is not trusted on this machine (${code}). Point NODE_EXTRA_CA_CERTS at the CA certificate that signed it — e.g. NODE_EXTRA_CA_CERTS=/path/to/ca.crt — and run again.`
  Every other cause keeps today's line.
- `cli.mjs:172`: `if (process.env.BLAZE_REMOTE_URL || process.env.BLAZE_TOKEN || process.env.BLAZE_TOKEN_FILE)`.
- `tests/setup/no-remote.mjs`: add `delete process.env.BLAZE_TOKEN_FILE;`.

- [ ] **Step 1: Write the failing tests** in `tests/remote-token-file.test.mjs`. `SECRET = "blz_" + "S3CRETVALUE"` is built at run time, so no literal token sits in the source.
  - `"BLZ-710: the token is read from BLAZE_TOKEN_FILE when BLAZE_TOKEN is unset"`: `remoteFrom({ BLAZE_REMOTE_URL: "https://b.example", BLAZE_TOKEN_FILE: f })` with `f` holding `SECRET + "\n"` → `{ remote: true, token: SECRET }`.
  - `"BLZ-710: BLAZE_TOKEN wins over the file"`.
  - `"BLZ-710: URL plus file alone is complete; file alone is half-set"`: the second gives `error` matching `/needs both BLAZE_REMOTE_URL and BLAZE_TOKEN \(or BLAZE_TOKEN_FILE\)/`.
  - `"BLZ-710: a missing, empty or whitespace token file is one line naming the path, never the content"`, for each of:
    - a missing file;
    - an empty file;
    - a file holding `SECRET.slice(0, 6) + " " + SECRET.slice(6)`.

    Each gives `error` matching the path, and `assert.ok(!error.includes(SECRET.slice(4)))`.
  - `"BLZ-710: the token from the file never appears on a failed run"`:
    - `runRemote("move", ["ENG-1", "done"], { env: { BLAZE_REMOTE_URL: "https://b.example", BLAZE_TOKEN_FILE: f }, fetch: async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }); }, out, err })` → 1;
    - the joined `err` lines do not include `SECRET`;
    - and the same with a stub answering `401 { errors: ["bad token"] }`.
  - `"BLZ-710: each TLS trust failure names NODE_EXTRA_CA_CERTS"`: for each of the four codes, `failureLine("blaze new", "https://b.example", new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code }) }))` matches `/NODE_EXTRA_CA_CERTS/` and includes the code. `ECONNREFUSED` does not match `/NODE_EXTRA_CA_CERTS/`.
  - `"BLZ-710: blaze enters remote mode on BLAZE_TOKEN_FILE alone with the URL"`: spawn `cli.mjs move ENG-1 done` with `BLAZE_REMOTE_URL=http://127.0.0.1:9` and `BLAZE_TOKEN_FILE=f` → 1, stderr matches `/no answer from http:\/\/127\.0\.0\.1:9/` (remote, not local), and stderr does not include `SECRET`.
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/remote-token-file.test.mjs`. Expected: the token-file tests get `remote: false` or the half-set error, and the TLS tests do not match.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run them and watch them pass.** Run `node --test tests/remote-token-file.test.mjs tests/remote-mode.test.mjs`, then `npm test`. Expected: green.
- [ ] **Step 5: Write `docs/operations/live-board.md`.** It is public-safe: no hostnames, no operator paths. Sections:
  1. **Where the board runs.** A deployment runs `node scripts/serve.mjs` with `BLAZE_WRITE_PORT=db` and a Postgres `database` block. The data is in Postgres (ADR-0039).
  2. **Configuration.** `blaze.config.json` and `projects/<KEY>/project.json` are mounted read-only from the deployment's versioned config. A change is a reviewed config change, not an edit on the box.
  3. **Agents and people write remotely.** `BLAZE_REMOTE_URL` plus `BLAZE_TOKEN_FILE` (mode 0600). Set `NODE_EXTRA_CA_CERTS` for a private CA. `show`/`list` read, and `new`/`move`/`edit`/`resolve`/`log`/`link` write.
  4. **Admin verbs run inside the deployment:** `kubectl exec -n <namespace> deploy/<name> -- node scripts/cli.mjs <verb>` for `user`, `sprint`, `db`, `audit`, `matrices` and `import`. `user add` prints a token once, so the operator runs it and writes the token straight to the token file.
  5. **One token per machine:** a `member` user per machine, so revoking one never touches another.
  6. **Moves are explicit** on a db board (Task 10's refusal; spec D6).
  7. **There is no Live view** on a db-hosted board (Task 11).
  8. **Backups:** a `pg_dump` now holds password and token hashes, so its directory must be mode 0700. Restore with `pg_restore`, and never `db init --force` or `load --replace` (ADR-0039).

  Link it from `docs/guide/commands.md` `## Remote mode`.
- [ ] **Step 6: Commit** (no existing test edited other than `no-remote.mjs`, which is setup, not a scanned test. Run the debt step anyway and stage it if it changed).
  ```bash
  git add scripts/remote-client.mjs scripts/cli.mjs tests/setup/no-remote.mjs tests/remote-token-file.test.mjs docs/operations/live-board.md docs/guide/commands.md AGENTS.md
  git commit -m "BLZ-710: BLAZE_TOKEN_FILE, a NODE_EXTRA_CA_CERTS hint on TLS trust failures, and docs/operations/live-board.md"
  ```

### Task 10: Refuse `blaze reconcile` and `/api/reconcile-preview` on a db board (BLZ-723)

**Files:**
- Modify: `scripts/reconcile.mjs` (the export, and the CLI block at `:2476`), `scripts/serve.mjs` (`/api/reconcile-preview` at `:742`), `scripts/views/page.mjs` (the `reconcileBtn` at `:334`, which `pageHtml({ …, reconcile = true })` omits when `false`), `scripts/supervisor.mjs` (`runReconcile` at `:288`)
- Modify: `tests/model/seam-closure.test.mjs` (ledger row 1038-1042)
- Create test: `tests/reconcile-db-board-refusal.test.mjs`
- Docs: `docs/guide/commands.md` `## reconcile` (a db-board paragraph), and `AGENTS.md` "The loop" step 3 (one sentence: "On a db-mode board, `blaze reconcile` refuses — tickets move only by explicit `blaze move`.")

**Interfaces:**
- `export const DB_BOARD_RECONCILE_REFUSAL = "this board moves tickets explicitly — it runs on the database write port (BLAZE_WRITE_PORT=db), where status changes only by `blaze move` (remote mode, on a deployed board). Reconcile derives moves from branches and PRs on file boards only."`
- `reconcile.mjs` CLI: first thing after argument parsing, `if (resolveWriteMode() === "db") { console.error(\`reconcile: ${DB_BOARD_RECONCILE_REFUSAL}\`); process.exit(1); }`. This covers dry runs too: the preview of a board that never reconciles is noise.
- `serve.mjs`: `if (resolveWriteMode() === "db") return json(409, { ok: false, error: DB_BOARD_RECONCILE_REFUSAL, changes: [] });`, before `reconcilePreview`. The page route passes `reconcile: mode !== "db"` into `pageHtml`.
- `supervisor.mjs runReconcile`: `if (resolveWriteMode() === "db") return { ok: false, error: DB_BOARD_RECONCILE_REFUSAL };` before any work, with no feed event.

- [ ] **Step 1: Write the failing tests** in `tests/reconcile-db-board-refusal.test.mjs`:
  - `"BLZ-723: blaze reconcile refuses on a db board, dry run included"`: a `dbBoard()` plus `runDb(["init"])`, then spawn `scripts/reconcile.mjs` with `BLAZE_WRITE_PORT=db`, with and without `--apply` → 1, and stderr includes `moves tickets explicitly`.
  - `"BLZ-723: GET /api/reconcile-preview refuses on a db board"`: `withDbServer` (the `serve-db-mode.test.mjs` shape) → 409, and `body.error` includes `moves tickets explicitly`.
  - `"BLZ-723: the page hides the reconcile button on a db board, and keeps it on fs"`: in db mode, `GET /` body `doesNotMatch(/id="reconcileBtn"/)`; `pageHtml({ projectsDir: <fs board>, … })` with the default still matches it.
  - `"BLZ-723: the supervisor's reconcile loop refuses on a db board"`: `createApp(cfg, { root, identity: { state: "absent", hasIdentity: false, store: null, close() {} } })` with `process.env.BLAZE_WRITE_PORT = "db"` (restored) → `(await app.runReconcile()).ok === false`, and its `error` includes `moves tickets explicitly`.
  - The fs-board reconcile suites stay green, unchanged. Step 4 runs them by name.
- [ ] **Step 2: Run them and watch them fail.** Run `node --test tests/reconcile-db-board-refusal.test.mjs`. Expected: exit 0 / 200 / the button present / `ok: true`.
- [ ] **Step 3: Implement** the Interfaces block, and apply ledger row 1038-1042.
- [ ] **Step 4: Run them and watch them pass.** Run `node --test tests/reconcile-db-board-refusal.test.mjs tests/reconcile*.test.mjs tests/serve-db-mode.test.mjs tests/views/*.test.mjs tests/model/seam-closure.test.mjs`, then `npm test`. Expected: green, and the page golden unchanged (the default is `reconcile = true`).
- [ ] **Step 5: Write the docs** (Files).
- [ ] **Step 6: Run THE DEBT STEP, then commit.**
  ```bash
  git add scripts/reconcile.mjs scripts/serve.mjs scripts/views/page.mjs scripts/supervisor.mjs tests/model/seam-closure.test.mjs tests/reconcile-db-board-refusal.test.mjs docs/guide/commands.md AGENTS.md scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-723: reconcile and its preview refuse on a db board — tickets move explicitly there"
  ```

### Task 11: Gate `GET /api/live` on `views.live` (BLZ-724)

**Files:**
- Modify: `scripts/serve.mjs` (`/api/live` at `:707`)
- Create test: `tests/live-view-gate.test.mjs`
- Docs: `AGENTS.md` `## Live activity feed` (a closing note)

**Interfaces:** before the `try` at `:717`, `if (!viewEnabled("live", views, projectsDir)) return json(404, { errors: ["the Live view is disabled on this board (views.live: false)"] });`.

- [ ] **Step 1: Write the failing test** `tests/live-view-gate.test.mjs`. An fs board, loopback, `startServer({ …, port: 0 })`:
  - `"BLZ-724: /api/live is 404 when views.live is false"`: config `views: { live: false }` → `GET /api/live` 404, and `GET /view/live` 404 (already true, pinned beside it).
  - `"BLZ-724: /api/live is 200 when views.live is true or absent"`: two boards → 200 and a `groups` array.
- [ ] **Step 2: Run it and watch it fail.** Run `node --test tests/live-view-gate.test.mjs`. Expected: 200 where 404 is asserted.
- [ ] **Step 3: Implement** the one guard.
- [ ] **Step 4: Run it and watch it pass.** Run `node --test tests/live-view-gate.test.mjs tests/serve-endpoints.test.mjs tests/read-path-fifo.test.mjs tests/serve-survives-unreadable-board.test.mjs`, then `npm test`. Expected: green.
- [ ] **Step 5: Write the docs.** The `AGENTS.md` note: "The feed is a local file written by a local hook, so a board served from another machine or from a database (a deployed db-mode board) has no Live view. Set `views.live: false` there, and `/api/live` answers 404 like `/view/live`."
- [ ] **Step 6: Commit.**
  ```bash
  git add scripts/serve.mjs tests/live-view-gate.test.mjs AGENTS.md
  git commit -m "BLZ-724: GET /api/live honours views.live; the Live feed is documented as local-only"
  ```

### Task 12: E2 whole-branch verification, push and PR

- [ ] **Step 1: Run the full suite twice.** Run `npm test` without and with PG. Record both. Expected: fail 0.
- [ ] **Step 2: Run an end-to-end smoke on an ephemeral port** (scratchpad, not the repo). A SQLite db board with one member user and its token in a 0600 file.
  - `BLAZE_REMOTE_URL=http://127.0.0.1:<port> BLAZE_TOKEN_FILE=<f> node scripts/cli.mjs new --project ENG --type task "smoke" --estimate 15`, then `show <id> --json`, then `move <id> in-progress`, then `list --status in-progress`. Each exits 0, and nothing on stdout or stderr contains the token.
  - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/api/live` on a `views.live: false` board → `404`.
  - `node scripts/reconcile.mjs` with `BLAZE_WRITE_PORT=db` → exit 1.

  Paste the outputs into the PR body.
- [ ] **Step 3: Run the hygiene checks** (as in Task 7 Step 3).
- [ ] **Step 4: Opus whole-branch review** against the spec's D6, D7 and D10, §9's "Remote reads", "Reconcile refusal" and "Live gate", and Review Focus 4–5.
- [ ] **Step 5: Push and open the PR** (orchestrator): `BLZ-703: E2 — remote agent surface (reads, token file, TLS hint, db-board reconcile refusal, /api/live gate)`. The body lists BLZ-709/710/723/724, the smoke and the summaries, and ends with the attribution line. Merge when green.

---

## Self-review (run 2026-10-22 against the spec)

1. **Spec coverage.** Each Plan A item, and the task that owns it:

   | Spec item | Task |
   |---|---|
   | D1 (v6, MIN 5, migrate, authoritative, the two refusals, docs section) | 1 |
   | D2: copy | 2 |
   | D2: load at both points, user admin, BLZ-701, `setupInFlight` proof | 3 |
   | D3 (tables, no FK, reads, writes, copy) | 4 |
   | D5 G-engine (dispatch, `resolvePorts` via `resolveWritePort`, `sprint-runner`, `user-admin`, `db` exempt, explicit `fs`/`dual`, regression injection) | 5 |
   | D5 interim hook | 0 |
   | D6 engine half | 10 |
   | D7 engine half: reads, `show`/`list`, `/api/projects` | 8 |
   | D7 engine half: token file, CA hint | 9 |
   | D10 engine half | 11 |
   | Child 8: ADR, ADR-0006 addendum, schema-versioning | 6 (and 1) |
   | Child 7: `live-board.md` | 9 |

   §9's migrate, identity-copy, identity-wiring, sprints, G-engine, remote-reads, reconcile-refusal and live-gate bullets each map to a named test above. G-data and the service-platform bullets are Plan B. "A v5 database still serves" is split across Tasks 3 and 4 and rehearsed in Task 7.
2. **Placeholders.** No step says "handle errors" or "add tests". Every message the spec or a test pins is given verbatim.
3. **Type consistency.** These names match across their producing and consuming tasks:
   - `migrateDb`'s options (`identityRows`, `sprintRegistry`, `beforeVerify`, `migrations`): Tasks 1, 2 and 4;
   - `V6_FEATURES_FROM`: Tasks 1, 3 and 4;
   - `resolveIdentity`'s `reload`/`source`: Task 3 and `serve.mjs`;
   - `sprintRegistry(dataRoot)`: every reader and consumer in Task 4;
   - `openSprintSource().kind`: Tasks 4 and 5;
   - `assertFsWriteAllowed(what, { dataRoot, env })`: Task 5;
   - `ticketJson`, `requestFor`'s `{ method, path, read, json }` and `renderRead`: Task 8.
4. **Review Focus.** Each of the five lines names its pinning test and its owning task.
5. **Proportion.** Bodies are given only for messages and algorithms the tests do not determine: `migrateDb`'s order, the hook's decision chain, and the registry ↔ table mapping. Everything else is a signature plus a test.

## Out of scope / Plan B

- **F1:** the chart holds `blaze.config.json` and 11 `project.json`, without `codeRepos` or `loops.reconcile` (INF-932).
- **F2:** no hostPaths, an `emptyDir` `/data`, read-only config (INF-933), the `blaze-audit` CronJob, `k8s-up.sh`, docs, and basic-auth removal (BLZ-697).
- §5 steps 1–10: the three-way config diff, the governance verifies against `blaze_rehearsal`, the freeze, the `pg_dump`, the migrate, the restart, the watch, and the day-14 delete. Finding 4 is an input to this.
- **G:** the `blaze-live` wrapper, the `blaze-live-board` skill, and the agent/skill/hook/script/settings repoint, including deleting `blaze-activity.sh` (BLZ-725) and **removing Task 0's hook** in the archive PR.
- H1–H3, the blaze-pm archive (D9), and the board operations on BLZ-206/210 and BLZ-202…218.
- Wiring `GET /api/matrix` (Finding 8), and the supervisor's identity source (Finding 11).

## Open questions for the operator

1. **E2 after E1, not in parallel?** This plan builds E2 off `main` once E1 has merged, to avoid a seam-closure and `serve.mjs` rebase. Say if you want them in parallel.
2. **0.10.0 now, tag later?** E1 moves the tree to 0.10.0 untagged (Finding 16). Tagging `v0.10.0` is left to the cutover.
3. **Supervisor identity** (Finding 11). `blaze start` keeps SQLite identity, because the live pod does not run it. Is that acceptable, or should a follow-up ticket move it too?
4. **`GET /api/matrix`** (Finding 8). It is classified but not served. Should a ticket be filed so that §8's "the board serves `/api/matrix`" becomes true, or should §8's wording be changed to `blaze matrices --out`?
