# CI

One workflow, [`tests`](../.github/workflows/test.yml), runs on GitHub-hosted
`ubuntu-latest` runners:

| Trigger | Purpose |
|---|---|
| `pull_request` | Run the suite under c8 + enforce the coverage floor. The merge gate. |
| `push` to `main` | Same gate, run again after merge. |

Steps: `actions/checkout@v4` → `actions/setup-node@v4` (Node 20) → `npm ci` →
`npm run test:coverage`. This package ships as an npm package (`@hjr15/blaze-board`)
— there is no deploy/build-image workflow to gate here.

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
| **Checkout / Set up Node / Install dependencies** step is red | **Transient** — GitHub Actions infra or npm registry hiccup | Rerun the job (below). |
| Run shows **`cancelled`** | **Not a failure** — superseded by a newer push, or hit `timeout-minutes` | If superseded, ignore. If a lone run timed out with no newer push, rerun. |

The rule: **only the `Run tests + coverage gate` step failing is a real defect.**
Everything upstream of it is infra, and `cancelled` is never a test failure.

## Rerunning

- GitHub UI: **Re-run failed jobs** on the run.
- CLI: `gh run rerun <run-id> --failed`, or `gh run watch <run-id>`.

Never add an automatic retry to the gate step — it would mask a genuinely flaky
test. Reruns are a manual, deliberate act for infra transients only.
