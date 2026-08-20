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

## Triage: is a red gate real or transient?

The job is structured so the failing **step** tells you which:

| Symptom | Class | Action |
|---|---|---|
| **`Run tests + coverage gate`** step is red, log shows `# fail N` | **Real** — a test broke | Fix the test/code. Do not rerun. |
| **`Run tests + coverage gate`** step is red, log shows `ERROR: Coverage ... does not meet threshold` | **Real** — coverage regressed below the floor | Add tests (or, if intentional, justify and raise/adjust `.c8rc.json` in the same PR). Do not rerun. |
| **Install dependencies** step is red, log shows `npm error code EUSAGE` / `Missing: <pkg> from lock file` | **Real** — `package.json` and `package-lock.json` disagree | Run `npm install --package-lock-only` and commit the lockfile. Rerunning will never fix it. |
| **Checkout / Set up Node / Install dependencies** step is red for any other reason | **Transient** — GitHub Actions infra or npm registry hiccup | Rerun the job (below). |
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
