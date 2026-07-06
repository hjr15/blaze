# CI

Two workflows, split by trigger:

| Workflow | Trigger | Runner | Purpose |
|---|---|---|---|
| [`tests`](../.github/workflows/test.yml) | `pull_request` | `blaze-arc` | Run the suite under c8 + enforce the coverage floor. The merge gate. |
| [`build-image`](../.github/workflows/build-image.yml) | push to `main` | `blaze-arc` | Build + push the container image. |

Both run on the self-hosted **`blaze-arc`** scale-to-zero runner (INF-387), so CI
uses no billable GitHub-hosted minutes.

## The tests gate

`npm run test:coverage` runs `node --test` under [c8](https://github.com/bcoe/c8)
and fails if any test fails **or** coverage drops below the floor in
[`.c8rc.json`](../.c8rc.json). The gate runs **in-band**
(`--test-concurrency=1`) to keep peak memory bounded on the constrained runner —
the same class of mitigation projects reach for when a coverage-instrumented
test run OOMs on a memory-constrained CI runner (e.g. Jest's `--runInBand`).

Set `tests` as a required status check in branch protection so a red run blocks
merge (honour-system on free-private repos — see the repo's branch-protection
note).

## Triage: is a red gate real or transient?

The job is structured so the failing **step** tells you which:

| Symptom | Class | Action |
|---|---|---|
| **`Run tests + coverage gate`** step is red, log shows `# fail N` | **Real** — a test broke | Fix the test/code. Do not rerun. |
| **`Run tests + coverage gate`** step is red, log shows `ERROR: Coverage ... does not meet threshold` | **Real** — coverage regressed below the floor | Add tests (or, if intentional, justify and raise/adjust `.c8rc.json` in the same PR). Do not rerun. |
| **Checkout / Set up Node / Install dev dependencies** step is red | **Transient** — runner spin-up, network, or npm registry | Rerun the job (below). |
| Run shows **`cancelled`** | **Not a failure** — superseded by a newer push, or hit `timeout-minutes` | If superseded, ignore. If a lone run timed out with no newer push, the runner likely wedged — rerun. |
| No run appears at all / runner stays queued | **Infra** — `blaze-arc` is scaled to zero and the cluster is offline | Bring the cluster up; the queued job then picks up. |

The rule: **only the `Run tests + coverage gate` step failing is a real defect.**
Everything upstream of it is infra, and `cancelled` is never a test failure.

## Rerunning

- GitHub UI: **Re-run failed jobs** on the run.
- CLI: `gh run rerun <run-id> --failed`, or `gh run watch <run-id>`.

Never add an automatic retry to the gate step — it would mask a genuinely flaky
test. Reruns are a manual, deliberate act for infra transients only.
