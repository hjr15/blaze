# BLZ-500 — pending-ledger capture and flush diagnosis

**Captured 2026-08-30**, before anything was drained, per the coordinator decision recorded on
[[BLZ-500]] ("Diagnose first, drain second"). **The queues were NOT drained.** This file is the
durable copy of the evidence, so the observation survives whatever happens to the live ledger.

- Engine tree: `blaze` @ `be4b110` (branch `BLZ-500-ledger-and-flush`, cut from `origin/main`).
- Board tree: `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`, branch `BLZ-305-v4-spine`,
  HEAD `12d143de`, **48 commits ahead of `origin/BLZ-305-v4-spine`** (the kickoff's figure of 47 was
  pinned before `12d143de` landed at 2026-08-30 01:12; measured against `origin/main` the number is a
  meaningless 204 — a different base).
- Ledger directory: `<board>/.blaze/pending/`. There is **no** `.blaze/pending-commit.jsonl` shared
  fallback in this tree, so `listQueues` returns 14 session queues and nothing else.

## 1. The ledger, as captured

**14 queues, 8 non-empty, 185 ops.** Every figure in BLZ-498 and BLZ-500 reproduces exactly.

| Queue (session) | Ops | By op | First op | Last op | Age of last | Distinct tickets |
|---|---|---|---|---|---|---|
| `auto-8c89bafb-929a-4ea2-bada-51b3584254f6` | 14 | 2 new, 8 move, 4 log | 2026-08-25T08:00:24.991Z | 2026-08-25T10:21:01.480Z | 4.6 d | 6 |
| `auto-ad647b1c-ce12-4598-b590-3d3f6872933a` | 60 | 16 new, 33 move, 11 log | 2026-08-24T01:06:44.348Z | 2026-08-24T11:56:55.106Z | 5.6 d | 18 |
| `auto-c055d5cd-92da-4667-a02d-640a32524a98` | 81 | 11 new, 48 move, 18 log, 4 edit | 2026-08-24T12:14:34.957Z | 2026-08-24T21:57:48.788Z | 5.2 d | 17 |
| `auto-ce4769de-0fd2-4db7-ab4e-b8114ca55834` | 18 | 13 move, 5 log | 2026-08-24T22:49:50.202Z | 2026-08-25T07:15:41.945Z | 4.8 d | 5 |
| `auto-e4fbe032-b457-471e-a0eb-105497dc76f2` | 9 | 5 new, 4 move | 2026-08-26T05:00:30.764Z | 2026-08-26T11:11:52.561Z | 3.6 d | 9 |
| `blaze-board-op-1787571261` | 1 | 1 new | 2026-08-24T11:34:24.117Z | 2026-08-24T11:34:24.117Z | 5.6 d | 1 |
| `blz396-close-1787809079` | 1 | 1 log | 2026-08-27T05:37:59.975Z | 2026-08-27T05:37:59.975Z | 2.8 d | 1 |
| `blz396-close-1787809083` | 1 | 1 move | 2026-08-27T05:38:04.327Z | 2026-08-27T05:38:04.327Z | 2.8 d | 1 |
| **8 non-empty** | **185** | 35 new, 107 move, 39 log, 4 edit | 2026-08-24T01:06 | 2026-08-26T11:11 | 2.8–5.6 d | |

Empty queues (present, zero ops): `auto-26768ce3-…`, `auto-518c1cf0-…`, `auto-6d3c1150-…`,
`auto-aee5790f-…`, `auto-e2eb4d4f-…`, `v4-spine-7944bc55`.

**Shape of the recorded entries** — the live ledger is *well formed*, which matters for BLZ-518:

- 186 distinct recorded paths, **all** under `projects/BLZ/`.
- **0** absolute paths, **0** paths escaping the board, **0** entries missing `files[]`,
  **0** unparseable lines.
- **All 185** carry `branch: BLZ-305-v4-spine`. None was queued on `main`.

So none of BLZ-518's three crash shapes is *currently* present on the live board. BLZ-518 is a
latent defect, not an active outage — but see §4.

## 2. The recorded paths, against git — has anything been lost?

Run read-only through `outstandingFiles` (`scripts/pending-ledger.mjs`) against the board tree:

| Bucket | Paths |
|---|---|
| `outstanding` — recorded write is still not in HEAD | **0** |
| `settled` — file already matches HEAD; filed by something else | 72 |
| `absent` — neither on disk nor tracked (created then relocated in-batch) | 128 |

**MIND THE DENOMINATOR.** 72 + 128 = **200**, and 200 is not 185. `outstandingFiles` dedups its
input with `new Set` **per queue**, so the buckets count *per-queue distinct path probes*. Four
different quantities live in this ledger and it is easy to quote one as another:

| Quantity | Value |
|---|---|
| queued ops | **185** |
| total `files[]` occurrences across all ops | **327** |
| board-wide distinct recorded paths | **186** |
| sum of per-queue distinct paths (what the buckets above total) | **200** |

The defensible statement is therefore: **no queue reported a single `outstanding` path** — 0 of 200
probes, across all 8 queues. Not "0 of 185 ops", which mixes two denominators.

On that basis BLZ-498's characterisation ("stale, not outstanding — the writes did land, by hand")
holds for every queue, not only the 118 ops it could trace. **The 67 that BLZ-500 called
un-characterised sit in queues that reported nothing outstanding**, so they are stale too.

## 3. The `blaze-flush` CronJob — its invocation, verbatim

Live in k3d cluster `service-platform`, namespace `blaze`, name `blaze-flush`;
`schedule: 50 23 * * *`, `timeZone: Australia/Sydney`, `suspend: false`. Chart source:
`/home/rnamwoh/Documents/Code/service-platform/deploy/apps/blaze/chart/templates/cronjob.yaml` and
`.../flush-configmap.yaml`.

Container command:

```
command: ["node", "/flush/flush.mjs"]
```

`flush.mjs` step 1, verbatim from the ConfigMap:

```js
const headBranch = git("rev-parse", "--abbrev-ref", "HEAD");
if (headBranch === "main") {
  execFileSync("node", [`${ENGINE}/scripts/cli.mjs`, "commit", "--all"],
    { cwd: DATA, stdio: "inherit", env: { ...process.env, BLAZE_PROJECTS_DIR: `${DATA}/projects` } });
} else {
  console.log(`SKIP step 1 (blaze commit): /data is checked out on '${headBranch}', not 'main'. Queued batch ops are NOT flushed this run and remain queued; publishing refs/heads/main's existing commits only.`);
}
```

**It DOES pass `--all`.** BLZ-500's stated hypothesis — "it does not pass `--all`, so it drains one
queue per run" — is **refuted**. The invocation is `blaze commit --all`, which
`scripts/commit-runner.mjs:97` expands to `listQueues(dataRoot)`, i.e. *every* queue.

## 4. Why 185 ops survived five nightly runs anyway — three independent reasons

The CronJob is not under-draining. It is draining **a different ledger from the one the agents write
to** — and, separately, is skipping the drain step entirely. Each of the three below is on its own
sufficient to explain the whole observation.

### 4a. `/data` is never on `main`, so step 1 is skipped every run

`/data/.git` is a `hostPath` bind of `/home/rnamwoh/Documents/Code/blaze-pm/.git` (verified on the
k3d node container's mount table). That checkout's HEAD is
`BLZ-143-engineering-method-and-work-item-model`, not `main`. `git rev-parse --abbrev-ref HEAD`
therefore returns a feature branch on every run, the `else` arm fires, and **`blaze commit --all` is
never executed at all.** The guard is deliberate and correct (its comment explains it prevents board
ops landing on a feature branch and then being silently published without them) — but its skip has
been the steady state, not the exception.

### 4b. `/data/.blaze` is not mounted, so the container's ledger is always empty

The pod mounts exactly four things:

```
/data/blaze.config.json  (configMap blaze-config, subPath)
/data/projects           (hostPath /host-blaze-projects  -> /home/rnamwoh/Documents/Code/blaze-pm/projects)
/data/.git               (hostPath /host-blaze-git       -> /home/rnamwoh/Documents/Code/blaze-pm/.git)
/flush                   (configMap blaze-flush-script, read-only)
```

**`.blaze/` is absent from that list.** The pending ledger lives at `<dataRoot>/.blaze/pending/`
(`scripts/pending-ledger.mjs:24-28`). Inside the container that path is ephemeral container-local
storage, recreated empty on every run. So even with `/data` checked out on `main`, `blaze commit
--all` would call `listQueues("/data")`, find nothing, and print `blaze commit: nothing to flush`.
**The CronJob has never been able to see a queued op, on any branch, since the mount was written.**

### 4c. The 185 ops are in a third tree the CronJob does not mount

They are in `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine/.blaze/pending/` — a git
worktree of `blaze-pm`, not the main checkout. `.blaze/` is gitignored and per-working-tree, so it is
neither shared with `blaze-pm/.blaze/` nor reachable through the `/host-blaze-git` mount (which binds
`.git`, not the worktree's working directory).

For contrast, the tree the CronJob *does* bind — `/home/rnamwoh/Documents/Code/blaze-pm/` — holds its
own **28 queues (27 session files plus a zero-byte shared fallback), 3 of them non-empty, carrying 19
ops** last touched between 2026-08-11 and 2026-08-17. Those have sat undrained for **19 days**,
through roughly nineteen nightly runs, on the very checkout whose `.git` is mounted at `/data/.git`.
A second, older instance of the same condition, and independent corroboration that the CronJob is not
draining anything anywhere.

### What is actually merging the board

Not the CronJob's step 1. **128 of the 361 commits on `BLZ-305-v4-spine` carry the flush-path subject
`blaze: <date> board update (...)`** — and their commit times are spread across 20 of the 24 hours,
in interactive clusters (14 at 14:00, 14 at 21:00, 11 at 15:00, 11 at 22:00, 11 at 23:00, 8 at
00:00…). Committer identity: 102 `rnamwoh <ryan@howman.me>`, 26 `GitHub <noreply@github.com>` (the
squash-merges). These are **agent sessions running `blaze commit` by hand during the day**, not a
23:50 job. The board is merged by the operator's sessions; the CronJob publishes whatever
`refs/heads/main` already has.

## 5. Has any op ever been permanently dropped by the flush?

**Not by the CronJob — but the flush as written DID have a path that destroys a record, and it is
now closed.** The two halves of that answer rest on different kinds of evidence and must not be
blurred together.

**The load-bearing evidence is the code path, not the measurement.**

1. **The CronJob cannot drop one.** `clearLedger` runs *after* both `git add` and `git commit` have
   returned 0; a failure at either bails with "ledger kept". And per §4b the CronJob's `listQueues`
   has never returned a non-empty queue, so it has never called `clearLedger` on real work at all.
2. **The drain is byte-exact.** `readForDrain` records the consumed byte count and `clearLedger`
   keeps `buf.subarray(consumedBytes)`, so an op appended during a flush survives it. The one
   acknowledged hole is a microsecond read-rewrite window, documented in place.

**The 185/0 measurement is NOT corroboration, and was wrong to offer as such.** It is structurally
incapable of observing a drop, twice over: `outstanding` is computed over ledger records that *still
exist*, so a destroyed record never enters the denominator at all; and `parseLines` strips
unparseable lines *before* the count is taken, so the denominator is "parseable lines", not
"recorded writes". A measurement that clears a change must be asked what it was incapable of
observing, and this one was incapable of observing the very thing it was cited for.

**Asking that question found a real path.** `readForDrain` measures `bytes` over the whole file, so
`clearLedger(bytes)` erased any line that failed to parse *along with* the ops that were
successfully committed. Verified by construction at `be4b110`: a queue of three recorded ops with a
truncated middle line drains to a commit carrying two, and the third is then present nowhere on
disk. That is `blaze commit`'s one way to lose a record for good. It has **never fired on this
board** — the 185 orphaned ops contain **0** unparseable lines (185 raw non-blank lines, 185
parseable) — which is why it was worth closing before it bit rather than after. It is closed on this
branch: the flush now quarantines dropped raw lines to `<queue>.corrupt` before clearing, and
`--status` reports such a queue as `PARTIALLY READ` and exits 2 instead of reporting a short list as
a complete one (BLZ-518).

The correct reading of the condition is therefore **not** "the sole merger is silently skipping ops"
but "**the sole merger has never been merging, and nobody noticed because the operator's own
sessions were doing it**". That is a different, quieter problem: the failure mode is a *publishing*
outage waiting on a day when no session runs `blaze commit`, not data loss.

## 6. Why the alerting did not catch it

`service-platform/obs-ingress/blaze-flush-health-rule.yaml` defines `BlazeFlushNotSucceeding` and
`BlazeFlushStale`; **both** are expressed purely over
`kube_cronjob_status_last_successful_time`. A run that takes the `SKIP step 1` branch and then hits
`NOOP: local main not ahead of origin/main` exits **0** and is recorded as a success. The alerts
measure *that the job finished*, never *that it flushed anything* — the exact "assert the observation
happened, not just the value" gap. `kubectl get cronjob blaze-flush -n blaze` currently reports
`lastSuccessfulTime: 2026-08-29T13:50:05Z`: green, five nights running, over five nights of no flush.

The job pods are also no longer retained (`kubectl logs` on all six recent jobs returns
`timed out waiting for the condition`), so the `SKIP` line the script prints is not recoverable after
the fact. There is no durable record of what the flush did on any given night.

## 7. What was deliberately NOT done

- **The 185 ops were not drained.** No `blaze commit`, no `blaze commit --all`, no board write of any
  kind was run against the live board by this lane. The capture above is entirely read-only:
  `readFileSync` on the ledger, `git log`/`git ls-files`/`git diff` on the board.
- **`blaze-pm` was not pushed** and nothing was committed in either `blaze-pm` tree.
- The CronJob, its chart, and the alert rules were **not modified** — they live in
  `service-platform`, another repo, outside this lane. Fixes are reported for the coordinator to
  file, not applied here.
