# CI

One workflow, [`tests`](../.github/workflows/test.yml), runs on GitHub-hosted
`ubuntu-latest` runners:

| Trigger | Purpose |
|---|---|
| `pull_request` | Run the suite under c8 + enforce the coverage floor. The merge gate. |
| `push` to `main` | Same gate, run again after merge. |

Steps: `actions/checkout@v4` → `actions/setup-node@v4` (Node 24) → `npm ci` →
`npm run test:coverage`. This package ships as an npm package (`@hjr15/blaze-board`)
— there is no deploy/build-image workflow to gate here.

The job also provisions a **`postgres:17-alpine` service container** and exports
`BLAZE_TEST_PG_URL`. See [the Postgres service](#the-postgres-service) below.

## The tests gate

`npm run test:coverage` runs `node --test` under [c8](https://github.com/bcoe/c8)
and fails if any test fails **or** coverage drops below the floor in
[`.c8rc.json`](../.c8rc.json). The gate runs **in-band** (`--test-concurrency=1`);
this predates the move to GitHub-hosted runners (originally a memory mitigation
for a constrained self-hosted runner — the same class of fix projects reach for
when a coverage-instrumented test run OOMs, e.g. Jest's `--runInBand`) and is kept
for deterministic, easy-to-read test output.

Set `tests` as a required status check in branch protection so a red run blocks
merge (honour-system on free-private repos — see the repo's branch-protection
note; irrelevant once this repo is public, where required checks work normally).

## The engine is checked before the suite runs

`package.json` declares `"engines": { "node": ">=24" }` — the floor exists because
`node:sqlite` is built in from Node 24 and 34-odd suites import it. Nothing used to
enforce that. Running the suite on Node 20 makes every `node:sqlite` file fail to LOAD,
and the tally that produces says nothing about the engine: measured on 2026-09-07,
`/usr/bin/node` v20.20.2 gave **3,916 tests / 3,743 pass / 173 fail** where v24.19.0 gave
**4,408 / 4,406 / 0**. A real regression is invisible in the first of those (BLZ-601).

So `pretest` and `pretest:coverage` run
[`scripts/ci/require-engine.mjs`](../scripts/ci/require-engine.mjs), which refuses with
exit 78 and prints the required major, the detected version, whether `node:sqlite`
resolves, and how to get a conforming Node — including the exact `export PATH=…` line when
it finds one already installed under `~/.local/node*`, nvm, fnm, volta or n. Someone who
runs `node --test` directly bypasses npm and its pre-scripts; for them the same check is an
ordinary test, `tests/engine-precondition.test.mjs`.

`BLAZE_ENGINE_GUARD_FAKE_VERSION` substitutes the detected version. It is a test seam, so
the refusal path can be exercised on a machine (or a CI runner) where every Node available
is conforming.

## A hung test file is bounded and reported as a hang

The suite could hang **forever** on one file: observed once at 27+ minutes on
`tests/model/driver-conformance.test.mjs`, 0% CPU, blocked in `ep_poll`, holding a live
referenced TCP handle to the Postgres port (BLZ-534). Every test in the file had already
passed — the process simply could not exit. Note that `node --test` passes
`--test-timeout=0` to each per-file child by default, which is where that flag in the
ticket comes from: with no timeout set, nothing ends such a file.

Two bounds, for two different failures:

| Bound | Ends | Set by |
|---|---|---|
| `--test-timeout=120000` | a test whose BODY never returns | the `test` / `test:coverage` npm scripts |
| [`tests/setup/hang-watchdog.mjs`](../tests/setup/hang-watchdog.mjs) | a PROCESS that cannot exit after its tests finished | `--import=` in the same npm scripts |

The watchdog's timer is **unref'd**: it does not keep a healthy file alive, so it costs the
suite no wall-clock time, and it still fires when something else holds the loop open past
the deadline. When it fires it prints `BLAZE TEST HANG WATCHDOG`, names the file, the
deadline it exceeded, the still-open handle types and — for sockets — the peer address, then
exits 87 so the runner counts the file as **failed**. In a CI log a hang and a slow run are
otherwise the same thing.

The deadline defaults to 300s and is set with `BLAZE_TEST_WATCHDOG_MS` (`0` disables it).
`tests/hang-watchdog.test.mjs` pins both directions against a fixture that leaks a socket
on purpose, including that the fixture really does hang without the watchdog.

**The cause, for this one file, was found and fixed.** Each conformance test ended with
`await s.close?.()`, the one statement a failing assertion never reaches — so a red
Postgres assertion left the client open and the child could never exit. It reproduces on
demand: mutate one assertion with `BLAZE_TEST_PG_URL` set and the run never returns, where
the fixed file exits in about a second with four failures. Teardown now runs from
`t.after()`. That does not prove the original intermittent hang is gone — it survived ~10
runs across two reviewers before this — which is why the bound above exists regardless.

## Cleanup runs whether a test passes or fails

Related, and the same shape one level down: cleanup written as the last statement of a test
is skipped by a failing assertion (BLZ-603).
[`scripts/ci/temp-cleanup-guard.mjs`](../scripts/ci/temp-cleanup-guard.mjs) scans `tests/`
for that shape and `tests/temp-cleanup-guard.test.mjs` holds the corpus to the per-file
counts recorded in `scripts/ci/temp-cleanup-debt.json` — **454 sites across 64 files** at
the time of writing, pre-existing debt that is recorded rather than hidden. The check is an
equality, so a file cannot gain a site and a file that is cleaned up must drop its entry in
the same change (`node scripts/ci/temp-cleanup-guard.mjs --write` re-records).

The scanner is a line scanner, not a parser: cleanup done inside a helper a test calls is
invisible to it, so the number is a floor. That limit is asserted, not assumed.

## Mutation testing is scoped

`node scripts/ci/mutate-schedule.mjs` is **not** a whole-repo mutation gate, and reading
it as one has produced false evidence more than once (BLZ-441). It applies BLZ-360 §11's
17 mutations to two files — `scripts/model/schedule.mjs` and `scripts/model/audit.mjs` —
and judges them against `tests/model/schedule.test.mjs` and
`tests/model/schedule-findings.test.mjs`. It opens no other file, so on a change anywhere
else it is silent, and a silent gate is not a green one.

It is a *regression* check: run it to confirm the scheduler's own suite still kills what
it used to kill. **"All 17 mutations killed" is evidence about the scheduler and the audit
findings, and about nothing else** — quoting it beside a change to `reconcile.mjs`,
`serve.mjs`, `config.mjs` or a test file asserts coverage this harness never measured. Its
banner now prints its own scope on every run for that reason.

**A lane that touches other modules must mutation-verify those separately**, by hand and
per hunk: revert the production change a test claims to pin, run that named test, and
confirm it goes red *for the reason its name gives*. A test that stays green under that
revert is not evidence, whatever it is called — see
[the engineering method](method/engineering-method.md#when-the-evidence-is-an-oracle).

### It mutates a copy, so it cannot make another run go red

It used to rewrite `scripts/model/schedule.mjs` **in place, in the checkout, with no
lock**. A `node --test` run in the same worktree while it was mutating read a
half-mutated module and reported a failure that was not real. That happened during the
2026-08-28 wave: `npm run test:coverage` reported
`tests/model/link-type-overrides.test.mjs:422 ✖ a board that is all ONE DEPENDENCY CYCLE
does not raise it — expected the cycle finding, got: (empty)`; the same test passed in
isolation, a clean re-run with nothing else in the worktree was 4,017/0, and the control
on the parent commit was 4,016/0. It cost a full re-run, and the real cost is that it
teaches a reader to re-run instead of investigate.

Since BLZ-472 every run copies the **working tree** — `scripts/`, `tests/`,
`package.json`, uncommitted hunks included, since judging HEAD would judge code nobody is
about to ship — into a throwaway directory and mutates and tests there. Two things follow,
and the banner says the first of them on every run:

- **A suite failure you see in the checkout while this is running is REAL.** This process
  opens no file in the checkout for writing, so it cannot be the cause. Triage it as a
  real failure; do not re-run on the theory that the mutation harness caused it.
- A crash between mutating and restoring can no longer leave the checkout mutated. It
  leaves a temp directory, which the OS sweeps.

A lock was considered and rejected. The process that would have to respect it is
`node --test`, which knows nothing about this harness; a lock here would serialise
mutation runs against each other — never the failure — and nothing else.

`tests/ci-mutation-sandbox.test.mjs` pins it: writing to the sandbox's copy leaves the
checkout byte-identical, and every `writeFileSync` in the runner goes through the
sandbox-joined path.

The teardown is guarded too, in the runner rather than in the tests (BLZ-485).
`discardSandbox` is the only place in `mutate-schedule.mjs` allowed to remove anything, and
it refuses when the path it is given resolves to the checkout, or to any directory
containing it — an ancestor deleted recursively takes the checkout with it. The compare is
on **resolved real paths** (`realpathSync`), not on the strings, because a symlink or a
`..` segment names the same directory under a different spelling and a string compare lets
it through. Two things to be clear about:

- **No current call path can reach the refusal.** `createSandbox` is the sole producer of
  the argument and always returns a fresh `mkdtempSync` directory under the system temp
  dir. The guard is defence in depth against a future refactor, not a live check, and no
  mutation of it can be killed through the gate. It is pinned by direct call against a
  stand-in repository — never the real checkout, since a test whose failure mode is "the
  repository is gone" is not one you can run twice.
- The guard used to live in the test helper instead, where it protected the test run and
  not the thing that ships. A mutation runner that can delete the working tree on a bad
  refactor is worse than the race BLZ-472 removed.

## Triage: is a red gate real or transient?

The job is structured so the failing **step** tells you which:

| Symptom | Class | Action |
|---|---|---|
| **`Run tests + coverage gate`** step is red, log shows `# fail N` | **Real** — a test broke | Fix the test/code. Do not rerun. |
| **`Run tests + coverage gate`** step is red, log shows `ERROR: Coverage ... does not meet threshold` | **Real** — coverage regressed below the floor | Add tests (or, if intentional, justify and raise/adjust `.c8rc.json` in the same PR). Do not rerun. |
| **Install dependencies** step is red, log shows `npm error code EUSAGE` / `Missing: <pkg> from lock file` | **Real** — `package.json` and `package-lock.json` disagree | Run `npm install --package-lock-only` and commit the lockfile. Rerunning will never fix it. |
| **Checkout / Set up Node / Install dependencies** step is red for any other reason | **Transient** — GitHub Actions infra or npm registry hiccup | Rerun the job (below). |
| A test is red **only** while `mutate-schedule.mjs` is running in the same worktree | **Real** since BLZ-472 — the mutation runner works on a copy and cannot corrupt your checkout | Investigate the failure. Before BLZ-472 this was the one genuinely false failure this repo produced; it is not any more. |
| **Initialize containers** step is red | **Transient** — the Postgres service failed to start | Rerun the job (below). |
| Run shows **`cancelled`** | **Not a failure** — superseded by a newer push, or hit `timeout-minutes` | If superseded, ignore. If a lone run timed out with no newer push, rerun. |

The rule: **a red `Run tests + coverage gate` step is always a real defect**, and
everything upstream is *usually* infra — with one standing exception. A dependency
change that updates `package.json` without regenerating `package-lock.json` fails at
`npm ci`, before a single test runs. It looks like an infra failure and is not one;
the tests never executed, so the green-looking evidence for the change is absent
rather than positive. Read the npm error code before reaching for a rerun.

`cancelled` is never a test failure.

## Rerunning

- GitHub UI: **Re-run failed jobs** on the run.
- CLI: `gh run rerun <run-id> --failed`, or `gh run watch <run-id>`.

Never add an automatic retry to the gate step — it would mask a genuinely flaky
test. Reruns are a manual, deliberate act for infra transients only.

## The Postgres service

The driver conformance suite asserts one storage contract across four drivers — the
filesystem, in-memory, SQLite, and Postgres. The first three need nothing installed.
Postgres needs a server, so the workflow runs one:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    env: { POSTGRES_PASSWORD: postgres, POSTGRES_DB: blaze_test }
    options: >-
      --health-cmd pg_isready --health-interval 10s
      --health-timeout 5s --health-retries 5
    ports: [5432:5432]
env:
  BLAZE_TEST_PG_URL: postgres://postgres:postgres@localhost:5432/blaze_test
```

**Locally the Postgres quarter skips**, and that is deliberate — a suite that goes
red because a contributor has no database on their laptop is a suite people learn to
ignore. `node --test` passes with the Postgres tests skipped.

**In CI it must not skip.** If `BLAZE_TEST_PG_URL` is unset while `CI` is set, the
suite *fails* with an explicit message. Removing the service container or its
environment variable would otherwise drop coverage to three drivers silently, leaving
a check still named "one suite, every driver" while proving it for three of them.

To run the Postgres quarter locally:

```bash
docker run -d --name blaze-pg -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=blaze_test -p 5432:5432 postgres:17-alpine
BLAZE_TEST_PG_URL=postgres://postgres:postgres@localhost:5432/blaze_test node --test
```

`pg` itself is an optional peer dependency and is not installed for ordinary users —
see [ADR-0011](decisions/0011-database-clients-are-optional-peer-dependencies.md).
It is a devDependency here, so `npm ci` in this repo installs it.
