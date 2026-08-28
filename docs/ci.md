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
