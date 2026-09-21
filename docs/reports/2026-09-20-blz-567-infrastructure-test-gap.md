# BLZ-567 — what was closed, and what is deferred with the reason

- **Date:** 2026-09-20
- **Branch:** `BLZ-512-read-path-residue`
- **Ticket:** BLZ-567 (Phase 2, "close the infrastructure test gap")

BLZ-567 asks for three things. **One is done for real. Two are deferred, and the reason is
that the artefacts they test do not exist in this repository** — not that they were hard.
Nothing here is stubbed and presented as done.

## The environment, checked rather than assumed

The ticket was filed saying "no fixtures or dummy data exist for the k8s path". That is
still true of this repository, and the tooling situation is better than the ticket assumed:

| | |
|---|---|
| `helm` | installed (`/usr/local/bin/helm`) |
| `kubectl` | installed, and **a cluster is reachable** (`kubectl cluster-info` answers) |
| `k3d` | installed |
| `docker` | installed |
| a Helm chart in this repo | **none** — no `charts/`, no `helm/`, no `values.yaml`, nothing |
| `tests/flush-script/test_flush_exit_code.sh` | **does not exist**, and never has (`git log --all -S` finds no commit that added it) |

So the blocker is not infrastructure. **It is that the chart and the flush script are not in
this repository.** `flush-script` appears in this tree exactly twice, both inside
`docs/reports/2026-08-30-blz-500-ledger-capture.md`, describing a **ConfigMap** named
`blaze-flush-script` mounted into the running deployment. The chart, its values and that
ConfigMap live in a separate deployment repository. This lane owns a worktree of `blaze` and
may not reach into another repo to edit it.

## Done for real — the flush drives the real `blaze commit`

`tests/flush-real-blaze-commit.test.mjs`, four cases, no PATH stubs and no fixtures beyond a
throwaway `FIX` board in a temp dir.

The gap it closes is real and was not the one the ticket describes. Every drain test in the
suite spawns **`scripts/commit-runner.mjs` directly** — `runCommit` in
`tests/commit-settled-drain.test.mjs` is the canonical one — while the `blaze-flush` CronJob
runs **`blaze commit --all`**, i.e. `scripts/cli.mjs`. Nothing ran the entry point production
runs. Now something does, against a real git repository, asserting against **git objects**
rather than against what the command printed.

### Two corrections to the ticket, both measured

The ticket's stated purpose for this item is "so a config the engine rejects fails the test".
**That is false, twice, and neither is an accident.**

1. `commit` is one of three verbs deliberately exempt from `cli.mjs`'s schema preflight
   (`SCHEMA_PREFLIGHT_EXEMPT`, an explicitly recorded AC-4 decision). Refusing a flush would
   strand ticket files other verbs have already relocated but not committed.
2. **The exemption is not even what decides it.** Measured by deleting `"commit"` from that
   Set and re-running the file: all four cases stayed green. The refusal other verbs give on
   these boards is `config.mjs`'s `IncompatibleSchemaVersionError`, raised inside the
   **runner** — `node scripts/edit-runner.mjs` fails identically with no `cli.mjs` involved —
   and `commit-runner.mjs` never calls `loadConfig` at all.

So the test does **not** make the flush refuse; that would delete a decision this repo made
on purpose. It pins the property that decision exists to protect: **on a board every other
verb refuses, the queued work still reaches a commit.** That is what would actually break in
production, and nothing pinned it before.

**The test discriminates, proven rather than asserted.** Adding a `loadConfig` call to
`commit-runner.mjs` reddens exactly two of the four cases, each for the reason its name
gives — "other verbs REFUSE these boards" and "queued work STILL reaches a commit", the
second reporting the queued op stranded. Both mutations (`cli.mjs`'s Set, and
`commit-runner.mjs`) were reverted; neither file is modified by this branch.

## Deferred, with what is missing

### 1. E2E driving the real engine image against a rendered chart

**Missing:** the chart. There is nothing in this repository to render, so there is no
`values.yaml` to fill, no manifest to apply and no image tag to point at. Writing one here
would be inventing a deployment contract from the outside and then testing the invention —
which passes, proves nothing, and is exactly the "verified by a suite that stubs its own
verbs" failure the ticket's own Phase-2 note warns about.

**What would unblock it:** the chart source, or a rendered manifest, checked into this repo
or vendored into `tests/fixtures/`. With that present the cluster is already here, so the
test itself is straightforward: apply into a throwaway namespace, wait for the pod, assert
`/setup` 200 with everything else 503, then create an admin and assert 401 without a
credential and 200 with one.

### 2. The queue store is reachable *through the mount*

**Missing:** the same chart, plus the `hostPath` declarations. ADR-0033 fixed which store is
canonical; the assertion this ticket wants is that the **mount** actually reaches it, which
is a property of the chart's volumes, not of any code in this repository.

**What would unblock it:** the same as above. The assertion needs the rendered volume spec to
read the `hostPath` off, so that a chart that stops declaring it fails the test.

## What was deliberately not done

- **No invented chart.** See above.
- **No `tests/flush-script/` created to match the ticket's path.** The file the ticket names
  is a ConfigMap in another repo. Creating a same-named file here would make the ticket look
  closed while the thing it names stays untested.
- **No live board, no real credential, no queued op touched.** Every fixture is a throwaway
  `FIX` board under `mkdtemp`.
