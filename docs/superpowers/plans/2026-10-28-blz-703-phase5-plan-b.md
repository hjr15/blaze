# BLZ-703 retire blaze-pm — Plan B (E3, the chart, the cutover, the repoint, the archive) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish retiring blaze-pm. Ship E3 (remote body and acceptance-criteria authoring, plus the audit and matrices observation checks), F1 and F2 (board config once in the chart, then no hostPath), verify the governance replacements, run the identity and sprint cutover, repoint claude-config, obs-maturity-audit, k8s-posture-audit and docs-central, and archive hjr15/blaze-pm behind a verified bundle.

**Architecture:** Work runs in §5's order, adjusted by `decisions.md`. Code PRs come first where nothing live depends on them: E3 is additive on the engine, and F1 is a pure config move that keeps the hostPaths. The cutover (§5 steps 3–6) is a runbook the operator gates, rehearsed first on a throwaway CNPG database loaded from the `v4-spine` tree. F2 removes the hostPaths only after the migrated board has soaked for a day. G, then H1–H3, repoint every consumer. The archive is last, gated on E3 (OD-B1), and G-final removes the interim hook after it.

**Tech Stack:** Node 24 ESM and `node:test` (engine); Helm 3, pytest and PyYAML (service-platform chart tests); bash and stdlib `unittest` (claude-config); Python with ruff, mypy and pytest via `uv` (obs-maturity-audit, k8s-posture-audit); stdlib Python and pytest (docs-central); `kubectl` against context `k3d-service-platform`; git bundles.

**Spec:** `docs/superpowers/specs/2026-10-22-phase5-retire-blaze-pm-design.md` at `d3223c4` (as amended by #205). It is binding, except where `.superpowers/sdd/2026-10-27-blz-703-phase5-plan-b/decisions.md` (OD-B1..B5, R1..R14) rules otherwise. Read §5, §6, §7, §8, D4–D10 and §10 rows 9–19, 22 and 23 first. The recon files beside `decisions.md` are ground truth over the spec's assumptions. Where this plan departs from either, the departure is in **Findings**, with the ruling.

**Tickets** (all under BLZ-703 on the live board): BLZ-712 F1 (child 9), BLZ-713 F2 (child 10), BLZ-714 CronJob (child 11), BLZ-715 governance verify (child 12), BLZ-716 cutover (child 13), BLZ-717 wrapper and skill (child 14), BLZ-718 repoint claude-config (child 15), BLZ-719 H1/H2 (child 16), BLZ-720 H3 (child 17), BLZ-721 archive (child 18, blocked by BLZ-729), BLZ-722 board ops (child 19), BLZ-725 remove `blaze-activity` (child 22), BLZ-729 E3 (child 23). Carried: BLZ-697 (basic-auth, in F2) and BLZ-702 (smoke users, step 10), both under BLZ-254; INF-932 (absorbed by F1) and INF-933 (absorbed by F2).

**State at writing (2026-10-28):** E1 (#203) and E2 (#204) are merged. The live board runs engine 0.10.0 at source commit `1475d6e`, with its database still at schema v5 (§5 step 0 done). G0 (claude-config #144) is merged and live.

---

## PR split, repos, branches and merge order

| # | PR | Repo | Branch / worktree (always off the remote default branch) | Tasks | Merge gate |
|---|---|---|---|---|---|
| 1 | **E3** | hjr15/blaze (public) | `BLZ-729-e3-remote-body-authoring`, `/home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-729-e3-remote-body-authoring` off `origin/main` | 1–5 | CI green including Postgres; opus whole-branch review upheld. Auto-deploys; additive. |
| 2 | **F1** | hjr15/service-platform | `BLZ-712-f1-config-once`, `/home/rnamwoh/Documents/Code/service-platform-worktrees/BLZ-712-f1-config-once` off `origin/main` | 6–7 | `validate` green; three-way diff in the PR body; §5 step 1 gate after ArgoCD syncs. |
| — | governance verify | cluster + blaze-pm oracle (read-only) | none | 8–9 | every §8 row passes (R2's delta listed) |
| — | rehearsal and cutover | cluster (operator-gated) | none | 10–12 | each §5 step's gate |
| 3 | **F2** | hjr15/service-platform | `BLZ-713-f2-drop-hostpaths`, `/home/rnamwoh/Documents/Code/service-platform-worktrees/BLZ-713-f2-drop-hostpaths` off `origin/main` **after Task 12 passes** | 13–17 | `validate` green; the live audit probe is clean; §5 step 7 gate. |
| 4 | **G** | hjr15/claude-config | `BLZ-717-g-blaze-live`, `/home/rnamwoh/Documents/Code/claude-config-worktrees/BLZ-717-g-blaze-live` off `origin/main` | 18–22 | claude-kit CI green; deployed with `install.sh`; the live probe passes. |
| 5 | **H1** | hjr15/obs-maturity-audit | `BLZ-719-h1-legal-and-oma-spec`, `/home/rnamwoh/Documents/Code/obs-maturity-audit-worktrees/BLZ-719-h1-legal-and-oma-spec` off `origin/main` | 23 | CI green. Merges before H2. |
| 6 | **H2** | hjr15/k8s-posture-audit | `BLZ-719-h2-repoint-legal`, `/home/rnamwoh/Documents/Code/k8s-posture-audit-worktrees/BLZ-719-h2-repoint-legal` off `origin/main` | 24 | CI green, after H1 merged. |
| 7 | **H3** | hjr15/docs-central | `BLZ-720-h3-launchpad-live-board`, `/home/rnamwoh/Documents/Code/docs-central-worktrees/BLZ-720-h3-launchpad-live-board` off `origin/master` | 25 | `tests` green, after G deployed. |
| — | board ops, §5 step 8 gate | live board | none | 26 | — |
| — | archive | blaze-pm (local only; the operator pushes) | v4-spine worktree, in place | 27–29 | §5 step 9 gate |
| 8 | **G-final** | hjr15/claude-config | `BLZ-721-g-final-remove-write-guard`, `/home/rnamwoh/Documents/Code/claude-config-worktrees/BLZ-721-g-final-remove-write-guard` off `origin/main` | 30 | claude-kit CI green, after Task 29 |
| — | step 10 | cluster + laptop | none | 31 | day 14 |

**PR titles** are `BLZ-703: <PR> — <summary>`, as Plan A's were. **Commit subjects** are `<child key>: <description>`. PR bodies list every child they carry and end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

**Trailers, per repo** (a commit in the wrong style fails a gate or misattributes):

| Repo | Commit trailer |
|---|---|
| hjr15/blaze | **none.** No `Co-Authored-By`, no `Signed-off-by` (`scripts/ci/hygiene-check.mjs`). |
| service-platform, claude-config, docs-central, obs-maturity-audit, k8s-posture-audit, blaze-pm (local `final-wip/*` and tombstone commits) | the `Co-Authored-By:` line from the executing session's attribution reminder (at writing, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`) |

## Global Constraints

- **`pod-blaze`** (R4) is shorthand, not a script. Every use in this plan expands to:
  ```bash
  kubectl --context k3d-service-platform -n blaze exec deploy/blaze -- node scripts/cli.mjs <verb>
  ```
  Two more shorthands, used the same way:
  - `pg-psql <args>` ≡ `kubectl --context k3d-service-platform -n blaze exec blaze-pg-1 -c postgres -- psql -U postgres <args>`. Confirm `blaze-pg-1` is the primary first: `kubectl --context k3d-service-platform -n blaze get cluster blaze-pg -o jsonpath='{.status.currentPrimary}'`.
  - `RH` ≡ `env BLAZE_DB_NAME=blaze_rehearsal BLAZE_PROJECTS_DIR=/tmp/rehearsal/projects`, placed after `exec deploy/blaze --` and before `node`. It points one in-pod command at the rehearsal database and tree. The pod's own env supplies host, user and password, so no credential leaves the pod.
- **Credentials never materialise where an agent can see them** (A3; skill `agent-side-credential-materialization-stop-and-report`). An agent never:
  - runs `user add` or `user passwd` (they print or read a credential: operator-only);
  - opens, `cat`s, copies or prints `identity.db` rows, `admin-api-token.txt`, `~/.config/blaze/token`, or any Secret (`kubectl get secret -o yaml`, `base64 -d`);
  - runs `env` or `printenv` in the pod, or prints `BLAZE_DB_PASSWORD`;
  - reads a credential-bearing table's values. Row **counts** and table names are fine.

  Every evidence file is checked with `rg -n 'blz_|token_hash|password|verifier'` before it is saved. Any hit is redacted and reported.
- **Operator gates.** A step marked **GATE (operator go-ahead)** waits for the operator's explicit "go" in chat. That covers every live-board write outside ticket bookkeeping, every irreversible step, every live cluster mutation, and every blaze-pm ref change. Ticket bookkeeping is the exception. A gated step names what **the operator does** and what **Claude does**.
- **Ticket bookkeeping is the orchestrator's, and it is explicit** (OD2): `in-progress` at start, `in-review` at PR open, `log` and then `done` at merge, `resolve` for a non-Done outcome. There is no reconcile. Until Task 22 deploys `blaze-live`, use `pod-blaze move|log|resolve|link`. After it, use `blaze-live`. A ticket that spans two PRs (BLZ-714: E3 and F2) is moved to `done` after the second.
- **No `blaze` write inside a blaze-pm checkout.** The G0 hook denies one. `kubectl … node scripts/cli.mjs …` is not a blaze-pm write and is allowed.
- **The oracle is read-only** (R5): `/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine` at `a65adb7b`. Anything that writes (a matrices regeneration, a config patch) runs in a scratch clone. The main checkout `/home/rnamwoh/Documents/Code/blaze-pm` sits on the old BLZ-143 tree and is never an oracle.
- **Worktrees, never the local checkouts.**
  - claude-config's checkout has an uncommitted `skills/workflow/feature-pr-bundling/SKILL.md` edit that is not touched (R10).
  - docs-central's checkout is on a rescue branch (R12).
  - service-platform's local `main` is behind and has dirty submodules.

  Paths are absolute. Every git or gh call in a multi-repo session is `cd <abs-path> && …` (user rule).
- **TDD, red first,** for every code change. Docs, ADRs and changelog entries land in the same PR as the behaviour they describe.
- **Repo `CLAUDE.md` files are user-only.** A task that finds a stale line in one writes the proposed wording into its PR body under "Proposed CLAUDE.md wording (operator to apply)". It never edits the file.
- **Evidence.** Runbook and verification tasks write their outputs to `<sdd-workspace>/evidence/task-<N>.md`, where `<sdd-workspace>` is what `scripts/sdd-workspace` prints for this plan. When the task ends, the same file becomes the owning ticket's body section `## Evidence (Plan B Task N)`. Copy it into the pod with `kubectl … exec -i deploy/blaze -- sh -c 'cat > /tmp/ev.md' < <file>`, then run `pod-blaze edit <KEY-n> --body-file /tmp/ev.md` (E3). `--body-file` replaces the whole body, so the file starts with the ticket's current body. Read that body with `pg-psql -d blaze -tAc "SELECT body FROM ticket WHERE id='<KEY-n>'"` before Task 22, or `blaze-live show <KEY-n> --json | jq -r .body` after it. A body is not a credential. The ticket is the durable record (user rule: no deliverable only in scratch).
- **Engine (hjr15/blaze, Tasks 1–5)**, copied from Plan A's Global Constraints, which remain binding:
  - Environment: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH`, `npm ci --ignore-scripts` once, and the throwaway `postgres:17-alpine` on `127.0.0.1:5544` with `BLAZE_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5544/blaze_test`, stopped at task end.
  - New test files use `scratchRegistry()` and `scratch(mkdtempSync(join(tmpdir(), "<literal>-")))`. PG tests use `PG_SKIP` and one `scratchPgDb(tag)` each, dropped in `finally`. Spawned processes get `BLAZE_WRITE_PORT`, `BLAZE_READONLY`, `BLAZE_REMOTE_URL`, `BLAZE_TOKEN` and `BLAZE_TOKEN_FILE` **deleted** from their env unless a test sets one on purpose.
  - **THE DEBT STEP** (Plan A, verbatim) runs before every commit that edits an existing test file, staging `scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md`. The debt may only shrink.
  - **Seam-closure** (`tests/model/seam-closure.test.mjs`): only the rows in this plan's ledger change, each marked `// BLZ-<n>:`. The guard's reachability walk wins over a predicted bucket.
  - No `/home/` path and no `*.howman.link` host in an added non-Markdown line (`hygiene-check.mjs`). Stage with explicit pathspecs. Never run `git config`. Workers never push.
  - Every task ends with its tests green, `npm test` green with and without PG, and `git status --short` empty.
- **service-platform (Tasks 6–7, 13–17):**
  - Tests: `python3 -m pytest tests/blaze-chart -q` (needs `helm` and PyYAML), `helm lint deploy/apps/blaze/chart`, and `helm template blaze deploy/apps/blaze/chart -n blaze -f deploy/apps/blaze/values-dev.yaml | kubeconform -strict -ignore-missing-schemas`.
  - Process delta (repo CLAUDE.md): the PR body summarises a `code-review` skill report, and `context7` is consulted before any change to an external chart or operator API.
  - `image.digest` and `image.sourceCommit` in `values-dev.yaml` are CI-owned. Never hand-edit them. Rebase before merge, because the `bump` job moves the file.
  - Merging to `main` is the deploy (ArgoCD automated, `prune: true`).
- **claude-config (Tasks 18–22, 30):** tests are stdlib `unittest` files `scripts/test_*.py`, each added by hand to the "Unit suites" step of `.github/workflows/claude-kit-ci.yml`. Before every commit, run `bash scripts/context-budget.sh` and `bash scripts/export-public.sh --dry-run` (both exit 0). A GitHub merge deploys nothing: `scripts/install.sh` runs from the main checkout afterwards.
- **blaze-pm is never pushed by Claude** (OD-B2). Claude makes local commits and the bundle. The operator runs every push and every GitHub setting.

## Findings (decided here, from recon and `decisions.md`)

1. **`blaze matrices --check` has nothing to check against on a db board** (R1, R3). It compares the render with files under `--out`, which defaults to `<dataRoot>/docs/matrices`. In the pod after F2, that is an empty `emptyDir`, so `--check` would report all 22 files as drift every night. D8 says the same: "No committed copy remains". **Ruling:**
   - E3 (Task 4) makes `--check` exit **2**, "could not run", when its directory does not exist, so a misconfigured gate cannot read as drift or as sync.
   - The CronJob's second step (R3) is a **render proof**: `matrices --out /data/matrices` must exit 0 for every configured project.
   - R3's NCA exception existed because NCA's committed copy drifted (BLZ-555). A render has no committed copy to drift from, so NCA is rendered like the rest. **Operator question 1.**
2. **The audit's observation check** (R1) is `ticketCount` in every `--json` report. Under `--fail-on`, a run that observed 0 tickets while ≥ 1 project resolved is `failOnVerdict: "could-not-observe"` with exit 2, the BLIND path that already exists. The plain report, without `--fail-on`, is unchanged, so `blaze audit` on a new empty board still exits 0.
3. **`~/.local/bin/blaze` runs through the blaze-pm checkout.** It resolves as `~/.local/bin/blaze → /home/rnamwoh/Documents/Code/blaze-pm/node_modules/.bin/blaze → /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs`, and the engine checkout's `main` is at `2ecae26`, before E1. So `blaze-live` would exec a pre-E2 engine, and D9 step 5 would break it. **Ruling:** Task 22 pulls the engine checkout and relinks `~/.local/bin/blaze` straight to `/home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs`. Task 27 refuses to start while `readlink ~/.local/bin/blaze` still names blaze-pm.
4. **`git bundle create --all` carries only `stash@{0}`.** `refs/stash` names the newest stash. `stash@{1}` lives in the reflog, which a bundle does not carry. **Ruling** (R13): each stash gets a branch `final-wip/stash-<n>` and a `git stash show -p --include-untracked` patch file before the bundle. Upstream tracking (the ~31 `[gone]` branches) is config, not a ref, so it is recorded in a manifest.
5. **The bundle is made after the tombstone commit** (D9 lists bundle, then commit). The tombstone is the only ref the operator's push changes, so bundling after it means the bundle holds every ref the archive ends with. The pre-tombstone tree is in history either way.
6. **OD-B2 narrows D9 step 3's "push every branch".** The operator pushes `BLZ-305-v4-spine` and the three branches with no upstream. `final-wip/*` and `[gone]` branches live in the verified bundle only.
7. **The architecture workflow has no `superseded` status** (`proposed → accepted / rejected`; superseded is designed but not shipped, per the engine's `AGENTS.md`). **Ruling:** Task 26 marks BLZ-206 and BLZ-210 with a `Relates BLZ-703` link and a `## Superseded` body section written through E3's `--body-file`. The status stays `accepted`.
8. **The engine has no user-removal verb** (`blaze user` is `add` and `passwd` only), but BLZ-702 removes 8 smoke users at step 10. **Ruling:** Task 31 follows BLZ-702's own procedure, run by the operator. If its body names no mechanism, the removal is a reviewed SQL `DELETE` in `pg-psql -d blaze` that the operator runs, with the six identity tables in FK order. **Operator question 2.**
9. **The backup directory mode must change before step 4, not in F2.** `k8s-up.sh` runs only at cluster create. The first nightly dump after the migrate holds credential hashes, and step 6 is before F2. **Ruling:** Task 11 sets mode `0750`, owner 26, group the operator's primary group (OD-B4) on the live node by hand. F2 (Task 16) makes `k8s-up.sh` do the same on a fresh cluster.
10. **The rehearsal runs inside the live pod against `blaze_rehearsal`.** Plan A Finding 4 wanted the pre-E1 engine to create the v5 database. There is none in the pod, and running one on the laptop would need the database password outside the pod (A3). **Ruling:** the v6 engine runs `db init` and `db load`, then `pg-psql` drops the eight v6 tables and stamps `5`. That is `makeV5`'s definition of "the shape of a database a 0.9.0 engine created" (Plan A Task 1), on which E1's own tests rely.
11. **F1 also drops the top-level `codeRepos: []`.** Its only reader is reconcile, which D6 drops. Task 7's audit gate confirms the config still loads.
12. **Five project descriptions cite `docs/exec-board/decisions/…`** (CRP, KPA, OMA, SN, STA). D8 names OMA only. **Ruling:** F1 prefixes every such path in all five with `docs-central/`. H3 lands the files there. A citation of `2026-07-20-consultancy-audit-tool-slate.md` names blaze-pm's copy, so F1 also renames it to `…-slate.blaze-pm.md`, the name it lands under (OD-B3).
13. **Alert coverage counts seven CronJobs, not six.** R7 says "6 CronJobs". The live cluster already has 6 before `blaze-audit`: arc-disk-reclaim, arc-listener-watchdog, blaze-pg-backup, actions-spend-guardrail, deploy-drift and oba-deploy-freshness. Task 14 writes the live count, and Task 17 proves the rules fire for `blaze-audit`.
14. **E3 writes bodies through new routes, not `EDITABLE_FIELDS`.** Adding `body` there would let the groomer rewrite bodies (`GROOMER_MAY_CHANGE`) and make the panel render it (`fields.mjs`). So `POST /api/body` (`{id, body?, ac?}`) and `POST /api/ac/add` (`{id, text}`) are new `write` routes. `POST /api/ac` (toggle) gains a shape check.
15. **An older server silently drops `body` and `ac`.** `newRequestOrErrors` rebuilds the request and discards unknown keys. **Ruling:** every E3 write answer echoes `bodyBytes` and `acItems`. A client that sent body or AC and gets no `bodyBytes` back exits 1, naming the ticket created with the template body.
16. **`ac toggle` counts from 1 on the CLI** (the n-th checkbox under the heading, as a person reads it) and from 0 on the API (`/api/ac`'s `index`, unchanged).
17. **Versions.** E3 bumps 0.10.0 → **0.11.0**. Remote body flags against a 0.10.0 server fail by Finding 15, so the operator must be able to tell the two apart. Plan A's "tag v0.10.0 at the cutover" becomes: Task 5 tags `v0.10.0` at `1475d6e`, E2's merge and the last 0.10.0 commit, and `v0.11.0` at E3's merge commit. The live image is already E3 when the cutover runs.
18. **G cannot deploy over the operator's uncommitted `feature-pr-bundling` edit.** G rewrites that file's "Closing the tickets" section (spec §6), and the edit rewrites the same section for fs-board reconcile, so `git pull --ff-only` refuses. **Ruling:** G changes that section in its own commit, so it is easy to merge. Task 22's deploy waits for the operator to commit, merge or discard their edit. **Operator question 3.**
19. **R12's "`gen_launchpad.py` reads `frontmatter.resolution`"** matches E2's `list --json` shape: a bare array of `{id, project, status, frontmatter}`.

## Review Focus

1. **A body or AC list sent to a server older than BLZ-729.** The expected behaviour is exit 1, naming the created ticket and "the server ignored the body (older than BLZ-729)". It is never a silent success. Pinned in Task 3 (`remote new with --body-file against a server that drops body exits 1`).
2. **The nightly gate on an empty or unobservable board.** 0 tickets read, a missing matrices directory, or a `could-not-observe` audit must each end non-zero with one `BLAZE-AUDIT-RESULT` line naming the cause. Pinned in Task 4 (engine exit codes) and Task 14 (the script's exit for each audit and matrices rc).
3. **A credential surfacing during the cutover or from the wrapper.** Migrate output, rehearsal output, the CronJob log and every `blaze-live` refusal carry counts and paths only. Pinned in Task 18 (`test_never_prints_token`), Task 14 (the result line carries no JSON payload), and the evidence `rg` check in Tasks 10–12.
4. **A pod that still needs a laptop file after F2.** That would be an identity fallback, a setup token, or a project directory `loadProject` checks. After F2 the pod mounts no hostPath. Config files are read-only. `/data/projects/<KEY>/` exists through the subPath mounts. The step-5 smokes pass again. Pinned in Task 13 (chart tests) and Task 17 (live gate). Task 13's merge waits on Task 12.
5. **An archive that loses a ref.** That would be a second stash, a detached HEAD, a dirty worktree, a `[gone]` upstream or `core.hooksPath`. The bundle's ref count must equal the source's, every stash has a branch and a patch, and the manifest records upstreams and hooksPath. Pinned in Task 28 (manifest) and Task 29 (the count comparison).

---

## File Structure

| Repo · file | Task | Change |
|---|---|---|
| blaze `scripts/model/ticket-body.mjs` | 1 | **new.** `SCAFFOLD_BODY`, `AC_HEADING_RE`, `BODY_MAX_BYTES`, `AC_ITEM_MAX`, `AC_MAX_ITEMS`, `bodyOrErrors`, `acItemsOrErrors`, `withAcSection`, `withAcAppended`, `acItemCount` |
| blaze `scripts/model/new-request.mjs`, `scripts/new.mjs`, `scripts/serve.mjs` | 1 | `body` and `ac` on `/api/new` |
| blaze `scripts/edit.mjs`, `scripts/serve.mjs`, `scripts/model/serve-auth.mjs` | 2 | `applyBody`, `applyAcAdd`; `POST /api/body`, `POST /api/ac/add`; the `/api/ac` shape check |
| blaze `scripts/remote-client.mjs`, `scripts/cli.mjs`, `scripts/new-runner.mjs`, `scripts/edit-runner.mjs` | 3 | `--body-file`, `--ac-file`, remote `ac add|toggle`, the older-server check |
| blaze `scripts/audit-runner.mjs`, `scripts/matrices-runner.mjs` | 4 | `ticketCount`, empty-read `could-not-observe`; `--check` without a directory exits 2 |
| blaze `docs/guide/commands.md`, `docs/operations/live-board.md`, `AGENTS.md`, `docs/architecture.md`, `package.json`, `package-lock.json`, `tests/package.test.mjs` | 3, 4 | docs; 0.11.0 |
| service-platform `deploy/apps/blaze/chart/values.yaml`, `templates/configmap.yaml`, `templates/projects-configmap.yaml` (new), `templates/deployment.yaml`, `templates/_helpers.tpl` | 6, 13 | config and 11 project files in values; per-file mounts; checksum; then emptyDir `/data`, no hostPath or git |
| service-platform `tests/blaze-chart/test_board_config.py`, `tests/blaze-chart/test_project_files.py` (new), `tests/blaze-chart/fixtures/v4-spine.blaze.config.json` (deleted) | 6 | the fixture derives from values (INF-932) |
| service-platform `tests/blaze-chart/test_data_root.py` (new), `test_blaze_postgres.py` | 13 | no hostPath, emptyDir, read-only, no git |
| service-platform `templates/audit-cronjob.yaml`, `templates/audit-script-configmap.yaml` (new), `tests/blaze-chart/test_audit_cronjob.py` (new), `test_flush_removed.py`, `obs-ingress/cronjob-*-rule.yaml` comments, `deploy/…/kube-prometheus-stack/values-dev.yaml` comment | 14 | `blaze-audit` |
| service-platform `templates/middleware.yaml` (deleted), `templates/ingress.yaml`, values `auth`, `scripts/k8s-up.sh`, `.env.example`, `docs/operations/runbook.md`, `docs/services/blaze.md`, `tests/blaze-chart/test_no_ingress_cors.py` | 15 | basic-auth removed (BLZ-697) |
| service-platform `scripts/k8s-up.sh`, `tests/blaze-chart/test_k8s_up_mounts.py`, `docs/services/blaze.md`, `docs/operations/runbook.md`, `docs/decisions/0026-board-data-in-postgres-config-in-the-chart.md` (new), `docs/decisions/0015-…md`, `docs/changelog.md` | 6, 16 | k8s-up, 0750, docs, ADR |
| claude-config `scripts/blaze-live` (new), `scripts/install.sh`, `scripts/test_blaze_live.py` (new), `scripts/test_install_blaze_live.py` (new) | 18 | the wrapper and its install step |
| claude-config `skills/workflow/blaze-live-board/SKILL.md` (new), `scripts/test_live_board_wording.py` (new) | 19, 20 | the skill; a guard against bare `blaze` commands |
| claude-config `agents/*.md` (4), `skills/**` (§6 list + recon extras), `docs/diagrams/*.md` (3), `README.md`, `docs/architecture.md`, `docs/decisions/0012-…md`, `docs/changelog.md` | 20 | the repoint |
| claude-config `hooks/check-unpushed.sh`, `scripts/blaze-bundle-push.sh` (deleted), `scripts/test_blaze_bundle_push.py` (deleted), `scripts/scan_public_leakage.py`, `scripts/project_keys.txt` (new), `scripts/test_scan_public_leakage.py`, `global/settings.json`, `scripts/install.sh`, `hooks/blaze-activity.sh` (deleted), `scripts/test_blaze_activity_hook.py` (deleted), `.github/workflows/claude-kit-ci.yml` | 21 | hooks, scripts, settings (BLZ-718, BLZ-725) |
| obs-maturity-audit `docs/legal/` (2), `docs/design/2026-07-20-oma-engine-v1-design.md`, `docs/diagrams/oma-engine-v1-architecture.md`, `templates/engagement/README.md`, `tests/oma/test_moved_docs.py` (new), 4 citations | 23 | H1 |
| k8s-posture-audit `tests/kpa/test_engagement_templates.py`, `templates/engagement/README.md`, 5 citations | 24 | H2 |
| docs-central `scripts/gen_launchpad.py`, `scripts/tests/test_gen_launchpad.py` (new), `docs/exec-board/decisions/` (3 new), `docs/engineering/platform-launchpad.md` | 25 | H3 |
| blaze-pm (local) `final-wip/*` branches, tombstone commit on `BLZ-305-v4-spine` | 28, 29 | archive |
| claude-config `hooks/blaze-pm-write-guard.sh`, `scripts/test_blaze_pm_write_guard.py` (both deleted), `global/settings.json`, CI, `docs/architecture.md`, `docs/changelog.md` | 30 | G-final |

## Seam-closure ledger (E3)

| Line (at `d3223c4`) | Today | After | Task |
|---|---|---|---|
| 966 `["edit.mjs", { writes: [], sanctioned: [], inert: ["applyEdit", "applyToggleAc"] }]` | as shown | `inert: ["applyEdit", "applyToggleAc", "applyBody", "applyAcAdd"]`, with `// BLZ-729: whole-body replace and AC append write through the injected port, like applyToggleAc.` | 2 |

`model/ticket-body.mjs` imports nothing allowlisted, so it needs no row. If the walk disagrees for any row, the walk wins (Global Constraints).

## Task order and routing

| # | Task | Ticket | Implementer | Reviewer |
|---|---|---|---|---|
| 1 | Body and AC model; `body`/`ac` on `/api/new` | BLZ-729 | **opus** (network-facing write) | opus |
| 2 | `/api/body`, `/api/ac/add`, the `/api/ac` shape check | BLZ-729 | **opus** (auth scopes) | opus |
| 3 | Remote and local flags, `ac add|toggle`, the older-server check, docs, 0.11.0 | BLZ-729 | sonnet | opus |
| 4 | Audit `ticketCount` and empty read; matrices `--check` without a directory | BLZ-714 | sonnet | opus |
| 5 | E3 verification, push, PR, merge, tags | — | haiku checks; **opus** review | — |
| 6 | F1: config and project files once, in values | BLZ-712 | sonnet | opus |
| 7 | F1 verification, PR, merge, §5 step 1 gate | — | sonnet | opus |
| 8 | Create and load `blaze_rehearsal` | BLZ-715 | sonnet | opus |
| 9 | §8 governance rows | BLZ-715 | sonnet | **opus** |
| 10 | Rehearse §5 steps 3–6 on `blaze_rehearsal` | BLZ-716 | **opus** (migration) | opus |
| 11 | Cutover: freeze, dump, migrate, restart (§5 steps 3–5) | BLZ-716 | **opus**, operator-gated | opus (adversarial-verifier) |
| 12 | Unfreeze and one-day watch (§5 step 6) | BLZ-716 | sonnet | opus |
| 13 | F2: emptyDir `/data`, no hostPath or git, read-only config | BLZ-713 | sonnet | opus |
| 14 | F2: the `blaze-audit` CronJob | BLZ-714 | sonnet | opus |
| 15 | F2: remove basic-auth | BLZ-697 | sonnet | opus |
| 16 | F2: `k8s-up.sh`, 0750, docs, ADR-0026 | BLZ-713 | sonnet | opus |
| 17 | F2 verification, probe, PR, merge, §5 step 7 gate | — | sonnet | opus |
| 18 | `blaze-live` wrapper and install step | BLZ-717 | **opus** (credential handling) | opus |
| 19 | `blaze-live-board` skill | BLZ-717 | sonnet | opus |
| 20 | Repoint agents, skills, diagrams and docs | BLZ-718 | sonnet | opus |
| 21 | Hooks, scripts, settings; remove `blaze-activity` | BLZ-718, BLZ-725 | sonnet | opus |
| 22 | G verification, PR, merge, deploy, live probe | — | sonnet; operator steps | opus |
| 23 | H1 obs-maturity-audit | BLZ-719 | sonnet | opus |
| 24 | H2 k8s-posture-audit | BLZ-719 | sonnet | opus |
| 25 | H3 docs-central | BLZ-720 | sonnet | opus |
| 26 | Board ops (BLZ-722) and the §5 step 8 gate | BLZ-722 | sonnet | opus |
| 27 | Archive: pre-checks, inventory, preserve | BLZ-721 | **opus** (irreversible prep) | opus |
| 28 | Archive: stash refs, manifest, tombstone commit, G-data probe | BLZ-721 | **opus** | opus |
| 29 | Archive: bundle, verify, operator push and archive, `.blaze/`, remove checkouts | BLZ-721 | **opus**, operator-gated | opus (adversarial-verifier) |
| 30 | G-final: remove the interim write guard | BLZ-721 | sonnet | opus |
| 31 | Step 10: day 14 | BLZ-702 | operator; sonnet records | — |

Order is strictly sequential, except that Tasks 6–7 (F1) may run while E3 is in review. Task 13 starts only after Task 12's gate.

---

## E3 — hjr15/blaze, remote body and acceptance-criteria authoring (BLZ-729, R1)

**Setup:** `cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-729-e3-remote-body-authoring -b BLZ-729-e3-remote-body-authoring origin/main`, then the engine environment. Record the baseline (`npm test` with and without PG) in the Task 5 report. `pod-blaze move BLZ-729 in-progress` and `pod-blaze move BLZ-714 in-progress`.

**Scope (OD-B5):** whole-body replace and whole-AC replace through `new` and `edit` with `--body-file` and `--ac-file`; remote `ac add` and `ac toggle`; no per-item edit or remove. Estimate 480.

### Task 1: Body and AC model; `body` and `ac` on `/api/new` (BLZ-729, part 1)

**Files:**
- Create: `scripts/model/ticket-body.mjs`, `tests/ticket-body.test.mjs`
- Modify: `scripts/model/new-request.mjs` (`newRequestOrErrors`), `scripts/new.mjs` (`applyNew`; the `:75` scaffold moves to `SCAFFOLD_BODY`), `scripts/edit.mjs` (`applyToggleAc` imports `AC_HEADING_RE`), `scripts/serve.mjs` (the `/api/new` answer)
- Modify test: `tests/serve-api-new.test.mjs`

**Interfaces** (`ticket-body.mjs`, pure, no imports beyond `node:buffer`):
- `SCAFFOLD_BODY = "## Context\n\n## Acceptance Criteria\n\n- [ ] \n\n## Notes\n"` (moved verbatim from `new.mjs:75`).
- `AC_HEADING_RE = /^\s{0,3}#{1,6}\s+acceptance criteria\s*$/i` (moved from `edit.mjs:107`; `applyToggleAc` imports it).
- `BODY_MAX_BYTES = 131072`. That is 128 KiB of UTF-8, leaving JSON-escaping headroom under `readJsonBody`'s 256 KiB request cap. `AC_ITEM_MAX = 500` (characters). `AC_MAX_ITEMS = 100`.
- `bodyOrErrors(v) → { body } | { errors: string[] }`. Errors:
  - not a string: `body must be a string`;
  - blank after trim: `body must not be blank`;
  - over the cap: `body is <n> bytes; the limit is 131072`;
  - contains `\0`: `body must not contain a NUL byte`.

  CRLF becomes LF. The result ends with exactly one `\n`.
- `acItemsOrErrors(v) → { items: { text, checked }[] } | { errors }`.
  - It takes an array of 1..100 strings.
  - Each is trimmed. A leading `- [ ] `, `- [x] ` / `- [X] ` or `- ` is stripped, and `checked` is true only for `[x]`/`[X]`.
  - Each remaining text must be non-blank, single-line and ≤ 500 characters.
  - Errors name the 1-based item: `ac item 3 is blank`, `ac item 3 spans more than one line`, `ac item 3 is over 500 characters`, `ac takes 1 to 100 items`, `ac must be an array of strings`.
- `withAcSection(body, items) → string`. It replaces everything between the first heading matching `AC_HEADING_RE` and the next heading of any level with `\n` + one `- [ ] text` / `- [x] text` line per item + `\n\n`. With no AC heading, it inserts `## Acceptance Criteria\n\n<lines>\n\n` before the first `## Notes` heading, or appends it at the end.
- `withAcAppended(body, text) → { body, index }`. It appends `- [ ] text` after the last checkbox line of the AC section, or as its first line, creating the section as above. It **replaces** a lone scaffold `- [ ] ` with empty text rather than leaving it. `index` is the new item's 0-based ordinal.
- `acItemCount(body) → number`: the checkbox lines under the AC heading, by `applyToggleAc`'s rule.
- `newRequestOrErrors`: optional `body` (through `bodyOrErrors`) and `ac` (through `acItemsOrErrors`). Errors are prefixed as today. `request` gains `body` and `ac`, or `null` for each.
- `applyNew(projectsDir, { …, body = null, ac = null })`: the body is `body ?? SCAFFOLD_BODY`, then `withAcSection(b, ac)` when `ac` is given. The existing `validateTicket` runs on that body.
- The `/api/new` answer gains `bodyBytes` (UTF-8 length of the stored body) and `acItems` (`acItemCount`). Both are **always** present.

- [ ] **Step 1: Write the failing tests.**
  - `tests/ticket-body.test.mjs` (pure):
    - `"BLZ-729: bodyOrErrors refuses non-strings, blanks, NUL and oversize, and normalises CRLF"`. `"a\r\nb"` → `{ body: "a\nb\n" }`. `" \n"` → errors `["body must not be blank"]`. `"x".repeat(131073)` → errors match `/131073 bytes; the limit is 131072/`.
    - `"BLZ-729: acItemsOrErrors parses checkbox prefixes and names the bad item"`. `["- [x] done", "todo", "- plain"]` → `[{text:"done",checked:true},{text:"todo",checked:false},{text:"plain",checked:false}]`. `["ok", " "]` → `["ac item 2 is blank"]`. `[]` → `["ac takes 1 to 100 items"]`.
    - `"BLZ-729: withAcSection replaces the section and keeps the rest"`. On `SCAFFOLD_BODY` with `[{text:"a"},{text:"b",checked:true}]` → `"## Context\n\n## Acceptance Criteria\n\n- [ ] a\n- [x] b\n\n## Notes\n"`.
    - `"BLZ-729: withAcSection inserts before Notes when there is no AC heading"` and `"…appends at the end when there is no Notes heading either"`.
    - `"BLZ-729: withAcAppended replaces the scaffold's empty checkbox"`. `withAcAppended(SCAFFOLD_BODY, "first")` → the body has exactly one checkbox, `- [ ] first`, and `index === 0`. A second append → `index === 1`.
    - `"BLZ-729: acItemCount counts by applyToggleAc's heading rule"`. A `## AC` heading counts 0 (`applyToggleAc` does not match it).
  - `tests/serve-api-new.test.mjs`, in the db-mode `describe` (its `dbBoard()` + `startServer` scaffolding):
    - `"BLZ-729: /api/new stores a given body and AC list"`. It posts `{…, body: "## Context\n\nwhy\n", ac: ["one", "- [x] two"]}` → 200, `bodyBytes > 0`, `acItems === 2`. The stored body (`openSqliteRead(…).getTicket(null, id).body`) includes `why` and `- [x] two`.
    - `"BLZ-729: /api/new without body keeps the template and still echoes bodyBytes"` → `acItems === 1` (the scaffold's empty box).
    - `"BLZ-729: a bad body or AC is 422 and burns no id"`. `body: "  "` → 422 naming `body must not be blank`. A following valid create gets the next id, unchanged from before the refusal (mirror the existing "no id burnt" test).
- [ ] **Step 2: Run and watch them fail.** `node --test tests/ticket-body.test.mjs tests/serve-api-new.test.mjs`. Expected: ERR_MODULE_NOT_FOUND for `ticket-body.mjs`, then a missing `bodyBytes`.
- [ ] **Step 3: Implement** the Interfaces block. `edit.mjs` imports `AC_HEADING_RE` and keeps its behaviour.
- [ ] **Step 4: Run and watch them pass,** then `npm test` with and without PG. `tests/edit-ac.test.mjs` must stay green unchanged.
- [ ] **Step 5: THE DEBT STEP, then commit.**
  ```bash
  git add scripts/model/ticket-body.mjs scripts/model/new-request.mjs scripts/new.mjs scripts/edit.mjs scripts/serve.mjs tests/ticket-body.test.mjs tests/serve-api-new.test.mjs scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-729: a ticket body and its acceptance criteria can be given at create, and /api/new echoes what it stored"
  ```

### Task 2: `POST /api/body`, `POST /api/ac/add`, and the `/api/ac` shape check (BLZ-729, part 2)

**Files:**
- Modify: `scripts/edit.mjs` (`applyBody`, `applyAcAdd`), `scripts/serve.mjs` (two routes; the `/api/ac` check), `scripts/model/serve-auth.mjs` (`ROUTE_SCOPES`), `tests/model/seam-closure.test.mjs` (ledger row 966), `tests/model/serve-auth.test.mjs` (if it pins `ROUTE_SCOPES` exactly)
- Create test: `tests/serve-api-body.test.mjs`

**Interfaces:**
- `applyBody(projectsDir, id, { body = null, ac = null }, opts) → Promise<{ ok, errors?, bodyBytes?, acItems? }>`:
  - at least one of `body` and `ac` must be given, else `{ ok: false, errors: ["give body, ac, or both"] }`;
  - the new body is `body ?? found.body`, then `withAcSection(…, ac)` when `ac` is given;
  - `validateTicket` runs on the merged ticket with the **new** body (recon: `edit.mjs:50` validates with `found.body`);
  - it writes through `opts.writePort.write` exactly as `applyToggleAc` does (same actor and source), and returns `bodyBytes` and `acItems`;
  - an unknown id is `ticket <id> not found`, as `applyToggleAc` says it.
- `applyAcAdd(projectsDir, id, { text }, opts) → Promise<{ ok, errors?, index?, acItems? }>`: `text` goes through `acItemsOrErrors([text])`, then `withAcAppended`, then the same write.
- Routes, each beside `/api/ac`, through the resolved port, on any write mode (as `/api/ac` is):
  - `POST /api/body` `{ id, body?, ac? }`:
    - `id` must be a non-empty string;
    - `body` is checked by `bodyOrErrors` and `ac` by `acItemsOrErrors`, with 422 `{ errors }` **before** any read;
    - success: 200 `{ ok: true, bodyBytes, acItems }`; refusal: 422 `{ errors: withoutServerPaths(…) }`.
  - `POST /api/ac/add` `{ id, text }`: 200 `{ ok: true, index, acItems }`.
  - `POST /api/ac` `{ id, index, checked }`: new pre-check, 422 `["index must be a non-negative integer"]` / `["checked must be true or false"]`. The 200 answer gains `acItems`.
- `ROUTE_SCOPES` gains `"POST /api/body": "write"` and `"POST /api/ac/add": "write"` under `// BLZ-729: remote body and AC authoring (spec §7 E3, OD-B5)`.

- [ ] **Step 1: Write the failing tests** in `tests/serve-api-body.test.mjs`. The scaffolding is `serve-api-new`'s db mode, with a member and a viewer from `addUser`, and ENG-1 created through `/api/new`.
  - `"BLZ-729: the two routes are classified write"` (pure).
  - `"BLZ-729: /api/body replaces the body and records an edit event"` → 200. The stored body equals the sent one (normalised), and `listEvents` gains one `edit` event for ENG-1 with the member as actor.
  - `"BLZ-729: /api/body with ac only replaces just the AC section"`: the `## Context` text survives, and `acItems` is the sent count.
  - `"BLZ-729: /api/body refuses a body that fails validateTicket"`: a body of only `\n` is caught by `bodyOrErrors` → 422. Neither field given → 422 `give body, ac, or both`.
  - `"BLZ-729: /api/ac/add appends and toggle checks it"`: add `"ship it"` → `index 0` (the scaffold box replaced). `POST /api/ac {index:0, checked:true}` → 200, and the body has `- [x] ship it`.
  - `"BLZ-729: /api/ac refuses a malformed index or checked"`: `{index:"0"}` → 422, `{index:0, checked:"yes"}` → 422.
  - `"BLZ-729: a viewer is 403 on both routes; no token is 401"`.
  - `"BLZ-729: no answer contains a server path"`: an unknown id on each route → 422, and the text does not include `projectsDir`.
  - `"BLZ-729 (pg): body and AC round-trip on a Postgres board"` (`PG_SKIP`, `scratchPgDb`, `pgEnvFor`, a spawned `serve.mjs` as `identity-pg.test.mjs` does). `/api/new` with body, then `/api/body` with `ac`, then `GET /api/ticket?id=` → `ticket.body` carries both.
- [ ] **Step 2: Run and watch them fail.** `node --test tests/serve-api-body.test.mjs`. Expected: 404 on the new routes, and 200 where 422 is expected for `/api/ac`.
- [ ] **Step 3: Implement** the Interfaces block and the seam ledger row.
- [ ] **Step 4: Run and watch them pass:** `node --test tests/serve-api-body.test.mjs tests/edit-ac.test.mjs tests/model/serve-auth.test.mjs tests/model/seam-closure.test.mjs`, then `npm test` with and without PG.
- [ ] **Step 5: THE DEBT STEP, then commit.**
  ```bash
  git add scripts/edit.mjs scripts/serve.mjs scripts/model/serve-auth.mjs tests/serve-api-body.test.mjs tests/model/seam-closure.test.mjs <serve-auth test if touched> scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-729: POST /api/body replaces a ticket's body or AC, POST /api/ac/add appends a criterion, /api/ac checks its payload"
  ```

### Task 3: Remote and local flags, `ac add|toggle`, the older-server check, docs and 0.11.0 (BLZ-729, part 3)

**Files:**
- Modify: `scripts/remote-client.mjs`, `scripts/cli.mjs` (`SUBCOMMANDS.ac`), `scripts/new-runner.mjs`, `scripts/edit-runner.mjs`
- Modify: `package.json`, `package-lock.json`, `tests/package.test.mjs` (0.11.0)
- Create test: `tests/remote-body.test.mjs`
- Modify test: `tests/remote-mode.test.mjs` (its `requestFor` table, if a row now differs), `tests/fs-write-guard.test.mjs` (`ac` is a mutating, remote-only verb; add it wherever that test enumerates `SUBCOMMANDS`)
- Docs: `docs/guide/commands.md` (`new` and `edit` flags, a new `## ac` section, Remote mode), `docs/operations/live-board.md` (writing a body and AC from an agent), `AGENTS.md` (`## Remote mode`: the new verb and flags), `docs/architecture.md` (the `/api` table rows)

**Interfaces:**
- `requestFor(verb, argv, { readFile = (p) => readRegularFileSync(p, "utf8") } = {})`:
  - `new … --body-file P --ac-file Q`: `body` is the file text. `ac` is the non-blank lines of Q, as strings. Both are optional.
  - `edit <id> --body-file P [--ac-file Q]` and `edit <id> --ac-file Q` → `{ method: "POST", path: "/api/body", body: { id, body?, ac? } }`. Mixing a file flag with `<field> <value>` → `{ error: "usage: blaze edit <id> <field> <value…> | blaze edit <id> [--body-file P] [--ac-file Q]" }`.
  - `ac add <id> <text…>` → `POST /api/ac/add` with `{ id, text: rest.join(" ") }`.
  - `ac toggle <id> <n> [--uncheck]` → `POST /api/ac` with `{ id, index: n - 1, checked: !uncheck }`. `n` must match `/^[1-9]\d*$/`, else `{ error: "blaze ac toggle: <n> must be a criterion number counting from 1" }`. Any other subverb → `usage: blaze ac add <id> <text…> | blaze ac toggle <id> <n> [--uncheck]`.
  - A file that cannot be read → `{ error: "blaze <verb>: cannot read <flag> <path>: <code>" }` (code only, never content). Nothing is sent.
- `REMOTE_VERBS` gains `ac: "/api/ac"`. The subverb chooses the path.
- **The older-server check** (Finding 15), in `runRemote` after a 200: if the request carried `body` or `ac` and `answer.bodyBytes === undefined`, write to stderr:
  - for `new`: `blaze new: <origin> created <id> but ignored the body and acceptance criteria — the server is older than BLZ-729 (0.11.0); <id> has the template body`;
  - for `edit`: `… ignored the body …`.

  Exit 1.
- `successLine`: `edit` with files → `<id>: body replaced (<bodyBytes> bytes, <acItems> criteria) (remote: <origin>)`. `ac add` → `<id>: criterion <index+1> added (remote: …)`. `ac toggle` → `<id>: criterion <n> checked|unchecked (remote: …)`.
- `cli.mjs` `SUBCOMMANDS.ac = { file: null, desc: "add or toggle a ticket's acceptance criteria (remote mode — BLAZE_REMOTE_URL)", mutates: true, remoteOnly: true }`. `BLAZE_READONLY` refuses it as it refuses remote `new`.
- Local runners (fs, dual and db alike):
  - `new-runner.mjs` accepts `--body-file`/`--ac-file` and passes `body`/`ac` to `applyNew`, after the same `bodyOrErrors`/`acItemsOrErrors` checks (exit 1 with the errors);
  - `edit-runner.mjs <id> --body-file|--ac-file` calls `applyBody`.

  `ac` stays remote-only, like `show` and `list`.
- `package.json` `"version": "0.11.0"`, the lockfile's two version fields, and `tests/package.test.mjs`'s pin.

- [ ] **Step 1: Write the failing tests** in `tests/remote-body.test.mjs`.
  - `"BLZ-729: requestFor maps body and AC flags"` (pure, injected `readFile`):
    - `new --project ENG --type task T --body-file b --ac-file a` → body `{ …, body: "<b text>", ac: ["one", "two"] }`;
    - `edit ENG-1 --ac-file a` → path `/api/body`;
    - `ac toggle ENG-1 2 --uncheck` → `{ id: "ENG-1", index: 1, checked: false }`;
    - `ac toggle ENG-1 0` → the "counting from 1" error;
    - `edit ENG-1 --body-file b title x` → the usage error;
    - an unreadable file → the `cannot read` error naming the code, and the injected `readFile`'s text never appears.
  - `"BLZ-729: remote new, edit, ac add and ac toggle round-trip end to end"`. Spawn `cli.mjs` with `BLAZE_REMOTE_URL=http://127.0.0.1:<port>` and `BLAZE_TOKEN_FILE=<0600 file>` against a db-mode `startServer`. Each command exits 0. `show <id> --json` then has the sent body, `- [ ] added`, and `- [x]` on criterion 1 after the toggle. stdout and stderr never contain the token.
  - `"BLZ-729: remote new with --body-file against a server that drops body exits 1"` (Review Focus 1). A stub `http.createServer` answers `/api/new` with `{ ok: true, id: "ENG-9" }` (no `bodyBytes`) → exit 1, and stderr matches `/created ENG-9 but ignored the body/` and `/older than BLZ-729/`.
  - `"BLZ-729: ac is remote-only"`: run locally → exit 1, `/runs in remote mode only/`.
  - `"BLZ-729: local new and edit take the body flags"`: an fs board, `new-runner` with `--body-file` → the written file's body is the given text. `edit-runner ENG-1 --ac-file` → the AC section replaced.
  - `"BLZ-729: the version is 0.11.0"` (in `tests/package.test.mjs`).
- [ ] **Step 2: Run and watch them fail:** `node --test tests/remote-body.test.mjs tests/package.test.mjs`.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run and watch them pass:** the Step 2 command plus `tests/remote-mode.test.mjs tests/remote-reads.test.mjs tests/remote-token-file.test.mjs tests/fs-write-guard.test.mjs tests/cli.test.mjs`, then `npm test` with and without PG.
- [ ] **Step 5: Write the docs** (Files). `live-board.md` gains "Writing a body and acceptance criteria", with the `blaze-live new … --body-file … --ac-file …` and `blaze-live ac toggle <id> <n>` recipes, the 128 KiB cap, and the older-server message. Public hygiene: no `/home/` path, and the host is written `<board origin>`.
- [ ] **Step 6: THE DEBT STEP, then commit.**
  ```bash
  git add scripts/remote-client.mjs scripts/cli.mjs scripts/new-runner.mjs scripts/edit-runner.mjs package.json package-lock.json tests/package.test.mjs tests/remote-body.test.mjs <remote-mode / fs-write-guard tests if touched> docs/guide/commands.md docs/operations/live-board.md AGENTS.md docs/architecture.md scripts/ci/temp-cleanup-debt.json scripts/ci/quoted-sources.mjs docs/ci.md
  git commit -m "BLZ-729: blaze new/edit --body-file and --ac-file, remote blaze ac add|toggle, an older server's dropped body is an error; 0.11.0"
  ```

### Task 4: The audit's observed set and `matrices --check` without a directory (BLZ-714, R1)

**Files:**
- Modify: `scripts/audit-runner.mjs`, `scripts/matrices-runner.mjs`
- Create tests: `tests/audit-observed-set.test.mjs`, `tests/matrices-check-observed.test.mjs`
- Docs: `docs/guide/commands.md` (`## audit`: `ticketCount`, the empty-read verdict; `## matrices`: exit 2), `AGENTS.md` if it describes either exit code

**Interfaces:**
- `audit --json`: the report gains `ticketCount: tickets.length` in every run, with or without `--fail-on`.
- Under `--fail-on`, when `tickets.length === 0 && keys.length > 0`:
  - `verdict = "could-not-observe"`;
  - `failOnBlind` gains `"empty-read"`;
  - stderr: `blaze audit: --fail-on cannot pass — 0 tickets were read across <n> project(s); an empty read is not a clean board`;
  - exit 2.

  Without `--fail-on`, the exit is unchanged (Finding 2).
- `matrices --check`: when `out` does not exist, or is not a directory, print `blaze matrices: --check has nothing to compare against — <relative out> does not exist; render with --out <dir> instead` and exit **2**. That happens before any file comparison and after the project resolution.

- [ ] **Step 1: Write the failing tests.**
  - `tests/audit-observed-set.test.mjs`, spawning `audit-runner.mjs` over fs boards made with `scratch(mkdtempSync(…))`:
    - `"BLZ-714: --json reports ticketCount"`: a board with 2 tickets → `ticketCount === 2`;
    - `"BLZ-714: --fail-on over an empty read is could-not-observe, exit 2"`: a configured project and no tickets → exit 2, `failOnVerdict === "could-not-observe"`, `failOnBlind` includes `"empty-read"`, and stderr matches `/0 tickets were read across 1 project/`;
    - `"BLZ-714: without --fail-on an empty board still exits 0"`;
    - `"BLZ-714 (prove-test-discriminates): one ticket makes the same --fail-on run pass"` → exit 0, verdict `pass`.
  - `tests/matrices-check-observed.test.mjs`:
    - `"BLZ-714: --check without the directory exits 2, never 1"`;
    - `"BLZ-714: --check against a rendered directory still passes"`: `--out d`, then `--check --out d` → exit 0, `in sync`;
    - `"BLZ-714: --check against a changed file is still drift, exit 1"`.
- [ ] **Step 2: Run and watch them fail:** `node --test tests/audit-observed-set.test.mjs tests/matrices-check-observed.test.mjs`. Expected: no `ticketCount`; exit 0 and exit 1 where 2 is expected.
- [ ] **Step 3: Implement.** Then run `npm test`. If an existing test asserted a `--fail-on` **pass** over an empty corpus, that assertion is the defect R1 names: change it to the new verdict, with `// BLZ-714:` and the reason.
- [ ] **Step 4: Run and watch them pass,** then `npm test` with and without PG.
- [ ] **Step 5: Docs, THE DEBT STEP (if an existing test changed), commit.**
  ```bash
  git add scripts/audit-runner.mjs scripts/matrices-runner.mjs tests/audit-observed-set.test.mjs tests/matrices-check-observed.test.mjs docs/guide/commands.md <AGENTS.md / changed tests / debt files if touched>
  git commit -m "BLZ-714: blaze audit reports ticketCount and an empty read cannot pass --fail-on; matrices --check without a directory exits 2"
  ```

### Task 5: E3 verification, push, PR, merge and tags

**Routing:** haiku runs Steps 1–3 and reports the output verbatim. Opus does Step 4.

- [ ] **Step 1: Run the full suite twice** (without and with PG). Record both beside the baseline. Expected: fail 0.
- [ ] **Step 2: Run an end-to-end smoke on an ephemeral port** (scratchpad): a SQLite db board, a member token in a 0600 file.
  - `new` with both files → `show --json` → `ac add` → `ac toggle 1` → `edit --ac-file`. Each exits 0 and no output contains the token.
  - `audit --json --fail-on parse-error` on an empty configured board → exit 2.

  Paste the outputs into the PR body.
- [ ] **Step 3: Run the hygiene checks:** `node scripts/ci/hygiene-check.mjs origin/main` → 0. `git log origin/main..HEAD --format='%s%n%b' | rg -n 'Co-Authored-By|Signed-off-by'` → nothing. Every file in `git diff origin/main --stat` is in this plan's File Structure.
- [ ] **Step 4: Opus whole-branch review** against OD-B5, R1, Findings 1, 2 and 14–17, and Review Focus 1–2. Fixes go in new commits under the owning key, then Step 1 again.
- [ ] **Step 5: Push and open the PR** (orchestrator): `cd /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-729-e3-remote-body-authoring && git push -u origin BLZ-729-e3-remote-body-authoring && gh pr create --title "BLZ-703: E3 — remote body and acceptance-criteria authoring, and the audit and matrices observation checks" --body <children BLZ-729 and BLZ-714 (engine half); the smoke; the test summaries; the attribution line>`. Move BLZ-729 to `in-review` (`pod-blaze move BLZ-729 in-review`).
- [ ] **Step 6: Merge when CI is green** (Postgres job included). Read the checks first: never `--admin` over a failing check.
- [ ] **Step 7: Confirm the deploy, then tag.**
  - Wait for service-platform's `bump` commit naming the merge SHA, then check `kubectl --context k3d-service-platform -n blaze get pod -l app.kubernetes.io/name=blaze -o jsonpath='{.items[0].metadata.annotations.blaze\.howman\.link/source-commit}'` equals it. Smoke: `pod-blaze --help` lists `ac`.
  - Tag (Finding 17): `cd /home/rnamwoh/Documents/Code/blaze && git fetch origin && git tag -a v0.10.0 1475d6e -m "0.10.0 (E1+E2)" && git tag -a v0.11.0 <E3 merge SHA> -m "0.11.0 (E3)" && git push origin v0.10.0 v0.11.0`.
  - Log BLZ-729's time and move it to `done`: `pod-blaze log BLZ-729 <minutes>` then `pod-blaze move BLZ-729 done`. BLZ-714 stays `in-progress` until F2.

---

## F1 — service-platform, board config once in the chart (BLZ-712, absorbs INF-932)

**Setup:** `cd /home/rnamwoh/Documents/Code/service-platform && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/service-platform-worktrees/BLZ-712-f1-config-once -b BLZ-712-f1-config-once origin/main`. `pod-blaze move BLZ-712 in-progress`.

### Task 6: `blaze.config.json` and 11 `project.json` once, in values, without `codeRepos` or `loops.reconcile`

**Files** (`C` = `deploy/apps/blaze/chart`):
- Modify: `C/values.yaml`. It gains `boardConfig:` (the config as YAML: the current `configmap.yaml:66-290` JSON minus `database`, `codeRepos` and `loops.reconcile`) and `projectFiles:` (a map `KEY → object` of the 11 `project.json`, each minus `codeRepos`).
- Modify: `C/templates/configmap.yaml`. The literal JSON becomes `{{- $c := deepCopy .Values.boardConfig }}{{- if .Values.postgres.enabled }}{{- $_ := set $c "database" (dict "driver" "postgres") }}{{- end }}{{ toPrettyJson $c | nindent 4 }}`. The `:1-59` header comment is rewritten: the chart's values are the source of truth (INF-932); blaze-pm is retired.
- Create: `C/templates/projects-configmap.yaml`, `ConfigMap/blaze-projects`, one key `<KEY>.project.json` per `projectFiles` entry (`toPrettyJson`).
- Modify: `C/templates/deployment.yaml`.
  - The `checksum/config` annotation hashes both ConfigMap templates (`print (include configmap) (include projects-configmap) | sha256sum`).
  - A volume `projects-config` (configMap `blaze-projects`).
  - One mount per key, by `range $k, $_ := .Values.projectFiles`: `mountPath: /data/projects/{{ $k }}/project.json`, `subPath: {{ $k }}.project.json`, `readOnly: true`.
  - The hostPath mounts stay (R6).
- Modify: `tests/blaze-chart/test_board_config.py`. It derives from values (INF-932): load `C/values.yaml` with PyYAML.
- Delete: `tests/blaze-chart/fixtures/v4-spine.blaze.config.json`.
- Create: `tests/blaze-chart/test_project_files.py`
- Docs: `docs/services/blaze.md` (the ConfigMap paragraph `:42-49`: config and project files come from the chart's values; the fixture re-copy instruction is deleted), `docs/changelog.md` (an Unreleased entry for BLZ-712)

**Seed and three-way diff** (D4; the recon's §3 resolution, recorded verbatim in the PR body):
- `boardConfig` is seeded from the current rendered ConfigMap, which equals v4-spine.
- Kept divergences: no `commitMode`; `database` only when `postgres.enabled`.
- Divergences that go: `loops.reconcile` and top-level `codeRepos` (Finding 11).
- The BLZ-143 main checkout's older `schema` and its dirty `provider` line are discarded.
- `projectFiles` is seeded byte-for-byte from `v4-spine/projects/<KEY>/project.json` (identical in both checkouts), minus `codeRepos` in the 10 files that have it, and with the `exec-board` path prefix from Finding 12.

- [ ] **Step 1: Write the failing tests.**
  - `test_board_config.py`, rewritten:
    - `test_rendered_config_equals_values_plus_database`: rendered `blaze.config.json` == `boardConfig` + `{"database": {"driver": "postgres"}}` under `pg_docs`, and == `boardConfig` under `default_docs`;
    - `test_no_reconcile_loop_or_code_repos`: `"reconcile" not in cfg.get("loops", {})`, `"codeRepos" not in cfg`;
    - `test_projects_list_matches_project_files`: `cfg["projects"] == sorted(values["projectFiles"])` and the list is the 11 keys `ACA BLZ CRP FL INF KPA NCA OBA OMA SN STA`;
    - the existing "no `commitMode`/`provider`" assertion is kept.
  - `test_project_files.py`:
    - `test_one_key_per_project`: ConfigMap `blaze-projects` keys == `{f"{k}.project.json" for k in projectFiles}`;
    - `test_no_code_repos_in_any_project_file`;
    - `test_each_file_is_its_values_entry`: `json.loads(data[k]) == projectFiles[KEY]`, and each `key` field equals its map key;
    - `test_mounts_cover_every_key_read_only`: Deployment mounts at `/data/projects/<KEY>/project.json` with `subPath` `<KEY>.project.json` and `readOnly: true`, exactly one per key;
    - `test_checksum_covers_project_configmap`: rendering with `--set projectFiles.BLZ.name=changed` changes the `checksum/config` annotation;
    - `test_exec_board_paths_point_at_docs_central`: no description contains `docs/exec-board/` without a `docs-central/` prefix, and none names `consultancy-audit-tool-slate.md` (it must be `…-slate.blaze-pm.md`, Finding 12).
- [ ] **Step 2: Run and watch them fail:** `python3 -m pytest tests/blaze-chart -q`. Expected: `KeyError: boardConfig`, then the missing ConfigMap.
- [ ] **Step 3: Implement** the Files and Seed blocks. Prove the seed with one throwaway render diff: render origin/main's ConfigMap and this branch's, parse both, and the only differences are `loops.reconcile` and `codeRepos`. Paste that diff into the PR body.
- [ ] **Step 4: Run and watch them pass:** `python3 -m pytest tests/blaze-chart -q`, `helm lint C`, and the kubeconform render (Global Constraints).
- [ ] **Step 5: Write the docs, then commit.**
  ```bash
  git add deploy/apps/blaze/chart/values.yaml deploy/apps/blaze/chart/templates/configmap.yaml deploy/apps/blaze/chart/templates/projects-configmap.yaml deploy/apps/blaze/chart/templates/deployment.yaml tests/blaze-chart/test_board_config.py tests/blaze-chart/test_project_files.py tests/blaze-chart/fixtures/v4-spine.blaze.config.json docs/services/blaze.md docs/changelog.md
  git commit   # subject: "BLZ-712: board config and the 11 project.json live once in the chart's values, without codeRepos or loops.reconcile (INF-932)" + the Co-Authored-By trailer
  ```

### Task 7: F1 verification, PR, merge, and the §5 step 1 gate

- [ ] **Step 1: Take the baseline before merge** (the step-1 gate's comparison): `pod-blaze audit --json > <sdd-workspace>/evidence/f1-audit-before.json; echo rc=$?`. Record the per-kind counts (`jq '[.findings[].kind] | group_by(.) | map({(.[0]): length}) | add'`).
- [ ] **Step 2: Run the code-review skill** on the diff and summarise it in the PR body (process delta).
- [ ] **Step 3: Push and open the PR:** `cd /home/rnamwoh/Documents/Code/service-platform-worktrees/BLZ-712-f1-config-once && git push -u origin BLZ-712-f1-config-once && gh pr create --title "BLZ-703: F1 — board config and project files once, in the chart (INF-932)" --body <BLZ-712; INF-932 absorbed; the three-way diff; the render diff; the code-review summary; the attribution line>`. `pod-blaze move BLZ-712 in-review`.
- [ ] **Step 4: Merge when `validate` is green,** after a rebase onto any `bump` commit.
- [ ] **Step 5: Run the §5 step 1 gate** after ArgoCD rolls the pod (`kubectl --context k3d-service-platform -n blaze rollout status deploy/blaze --timeout=300s`):
  - `kubectl … exec deploy/blaze -- sh -c 'for k in ACA BLZ CRP FL INF KPA NCA OBA OMA SN STA; do grep -c codeRepos /data/projects/$k/project.json; done'`: every line is `0` (the ConfigMap copy wins over the hostPath file);
  - `pod-blaze audit --json` → the per-kind counts equal Step 1's, and `config-project-drift` is 0;
  - `curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.config/service-platform/local-ca/ca.crt https://blaze.howman.link/` → `200` or the sign-in redirect, as before.

  **The operator** confirms the board renders as before.
- [ ] **Step 6: Rollback, if a gate fails:** `git revert` the merge on `main`. ArgoCD resyncs (§5 step 1).
- [ ] **Step 7: Bookkeeping:** log and move BLZ-712 to `done`. `pod-blaze link INF-932 Duplicate BLZ-712`, `pod-blaze resolve INF-932 duplicate`, then move INF-932 to its terminal status.

---

## Governance verification — `blaze_rehearsal` and §8 (BLZ-715)

### Task 8: Create `blaze_rehearsal` and load it from the v4-spine tree (R5, Finding 10)

**GATE (operator go-ahead):** this creates a database on the live CNPG cluster. **The operator** says go. **Claude** runs every step.

- [ ] **Step 1: Probe the pod.** `kubectl --context k3d-service-platform -n blaze exec deploy/blaze -- sh -c 'command -v tar git >/dev/null && df -h /tmp | tail -1'` → prints the free space, and the exit is 0. If `tar` or `git` is missing, stop and report.
- [ ] **Step 2: Make a scratch clone of the oracle.**
  - `git clone --quiet --no-local --branch BLZ-305-v4-spine /home/rnamwoh/Documents/Code/blaze-pm <scratchpad>/rehearsal`, then `git -C <scratchpad>/rehearsal rev-parse HEAD` → `a65adb7b…`. It is a clone, so `.git` is a real directory for `db load`'s history walk.
  - Patch only the clone's `blaze.config.json`: `node -e` merges `"database": {"driver": "postgres"}`.
- [ ] **Step 3: Create the database:** `pg-psql -c "CREATE DATABASE blaze_rehearsal OWNER blaze"`. Then `pg-psql -l | grep blaze_rehearsal`.
- [ ] **Step 4: Copy the tree into the pod:** `tar -C <scratchpad>/rehearsal -cf - . | kubectl --context k3d-service-platform -n blaze exec -i deploy/blaze -- sh -c 'rm -rf /tmp/rehearsal && mkdir -p /tmp/rehearsal && tar -C /tmp/rehearsal -xf -'`.
- [ ] **Step 5: Load and verify:** `kubectl … exec deploy/blaze -- RH node scripts/cli.mjs db init`, then `… db load`, then `… db verify`. Expected:
  - `db load` prints the ticket count, which equals `git -C <scratchpad>/rehearsal ls-files 'projects/*/*/*.md' | wc -l`;
  - `db verify` exits 0.
- [ ] **Step 6: Give it the v5 shape** (Finding 10): `pg-psql -d blaze_rehearsal -c "DROP TABLE user_session, local_password, api_token, membership, user_identity, app_user, sprint, sprint_registry; UPDATE blaze_meta SET value='5' WHERE key='schema_version'; DELETE FROM blaze_meta WHERE key='authoritative';"`. Then `pg-psql -d blaze_rehearsal -tAc "SELECT key, value FROM blaze_meta ORDER BY key"` shows `schema_version|5` and no `authoritative` row.
- [ ] **Step 7: Write evidence** `task-8.md`: the commands, the counts, and the stamp.

### Task 9: The six §8 rows, in db mode against `blaze_rehearsal` (R2)

**Inputs:** the scratch clone from Task 8, `/tmp/rehearsal` in the pod, and PyYAML (`python3 -c 'import yaml'`; else `pip3 install --user --break-system-packages pyyaml`). Python scripts run from the **scratch clone's** root, never the oracle. Engine commands are `kubectl … exec deploy/blaze -- RH node scripts/cli.mjs …`, with output redirected to the laptop.

- [ ] **Step 1: Capture the engine side once:** `… RH node scripts/cli.mjs audit --json > <ev>/audit-rehearsal.json; echo rc=$?`. Check `jq .ticketCount` equals Task 8's load count.
- [ ] **Step 2: Row 1, duplicate ids.** `python3 scripts/duplicate_id_check.py` → exit 0. `jq '[.findings[]|select(.kind=="duplicate-status")]|length'` → `0`. `pg-psql -d blaze_rehearsal -tAc "SELECT count(*) FROM (SELECT id FROM ticket GROUP BY id HAVING count(*)>1) d"` → `0`. **Pass:** all three are 0.
- [ ] **Step 3: Row 2, terminal parents** (R2: same pairs, minus a documented delta).
  - Script pairs: parse `python3 scripts/terminal_parent_scan.py --list` into a set of `(parent, child)` pairs.
  - Engine pairs: `jq` the `terminal-parent-open-child` findings into `(parent, child)` pairs. Read `scripts/model/audit.mjs` (the finding's `ticket` and `detail` fields) for which field holds which.
  - Classify every pair in the symmetric difference into exactly one class:
    - **S1 (script-only):** the child is an open `risk`. This is BLZ-689's risk-child exemption (`audit.mjs:348`).
    - **S2 (script-only):** the child's status is terminal for its type but outside the script's set `{done, achieved, mitigated, accepted, obsolete}`, for example `implemented`, `rejected` or `verified`.
    - **E1 (engine-only):** the parent's status is terminal for its type but outside the script's set.
  - **Pass:** `script − S1 − S2 == engine − E1`, and every delta pair is listed in the evidence with its class. One unclassified pair is a **fail**: stop and report.
- [ ] **Step 4: Row 3, empty bodies.** The script side is `python3 scripts/empty_body_scan.py --json | jq -r '.[].id' | sort`. The engine side is `jq -r '.findings[]|select(.kind=="empty-body")|.ticket' | sort`. **Pass:** `diff` is empty.
- [ ] **Step 5: Row 4, config drift.** `python3 scripts/config_drift_check.py` → exit 0 (missing 0, extra 0). The engine's `config-project-drift` count is `0`. **Pass:** both.
- [ ] **Step 6: Row 5, matrices.**
  - Script side, in the scratch clone: `for p in ACA BLZ CRP FL INF KPA NCA OBA OMA SN STA; do python3 scripts/build_matrices.py --project $p || exit 1; done`. That regenerates all 22 files, NCA included (Finding 1).
  - Engine side: `… RH node scripts/cli.mjs matrices --out /tmp/rehearsal-matrices`, then `kubectl … exec deploy/blaze -- tar -C /tmp/rehearsal-matrices -cf - . | tar -C <scratchpad>/engine-matrices -xf -`.
  - **Pass:** `diff -r <scratchpad>/rehearsal/docs/matrices <scratchpad>/engine-matrices` prints nothing, and both have 22 files. Any diff is a fail. Report the first hunk per file.
- [ ] **Step 7: Row 6, diagrams.**
  - Make two copies, `A` and `B`, of the scratch clone.
  - In `A`, run `python3 /home/rnamwoh/Documents/Code/blaze-worktrees/BLZ-703-plan-b/scripts/embed_diagrams.py --repo-root A`. Any engine checkout at or after `d3223c4` works.
  - In `B`, run `python3 scripts/embed_diagrams.py` (blaze-pm's own).
  - **Pass:** `diff -r A/docs B/docs` prints nothing, and both exit 0.
- [ ] **Step 8: Write evidence** `task-9.md`: a table with one row per §8 script, its command, both outputs (counts, not full listings), and pass/fail. Row 2 has its delta list. If every row passes, copy the evidence into BLZ-715's body (Global Constraints), then log BLZ-715 and move it to `done`. Any fail stops the plan: BLZ-721 must not archive scripts whose replacement is unverified (D8 row "Archive after the §5 step 2 verify").

---

## Rehearsal and cutover — §5 steps 3–6 (BLZ-716)

**Rollback, for the whole section** (§5 step 4 as amended by #205, and R14):

| When | Rollback |
|---|---|
| Before the migrate commits | Its transaction aborts on its own. Stamp `5`, no v6 table. |
| After the commit, before or after the restart | `pg-psql -d blaze -c "UPDATE blaze_meta SET value='5' WHERE key='schema_version'"`, then `kubectl … rollout restart deploy/blaze`. The engine falls back to `identity.db` and `sprints.json`, which are untouched. Sessions and tokens created after step 4 are lost (accepted). **The v6 tables stay populated (R14).** A re-run of `db migrate --identity-from` then refuses as "already imported". Either clear the eight v6 tables first, or restore the step-3 dump (`pg_restore --clean --if-exists`). |
| To an image older than E1 | Revert the stamp first, because that engine refuses v6 as `newer`. Then revert the image. |

### Task 10: Rehearse §5 steps 3–6 on `blaze_rehearsal`

**GATE (operator go-ahead):** this reads the live `/data/.blaze/identity.db` (read-only, counts only) and writes credential hashes into `blaze_rehearsal`, which Step 8 drops.

- [ ] **Step 1 (step 3): Dump and list.** `kubectl … exec blaze-pg-1 -c postgres -- sh -c 'pg_dump -U postgres -Fc -d blaze_rehearsal -f /tmp/rh.dump && pg_restore --list /tmp/rh.dump | wc -l'` → a positive count.
- [ ] **Step 2 (step 4): Copy the sprints and migrate.**
  - `kubectl … exec -i deploy/blaze -- sh -c 'cat > /tmp/sprints.json' < /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine/sprints.json`.
  - `kubectl … exec deploy/blaze -- RH node scripts/cli.mjs db migrate --identity-from /data/.blaze/identity.db --sprints-from /tmp/sprints.json` → exit 0. It prints `schema v5 → v6`, `authoritative yes (written now)`, the identity line and the sprints line.
- [ ] **Step 3: Check the counts without reading values.**
  - Source counts: `kubectl … exec deploy/blaze -- node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/.blaze/identity.db',{readOnly:true});for(const t of ['app_user','user_identity','membership','api_token','local_password','user_session']){try{console.log(t,d.prepare('SELECT count(*) AS c FROM '+t).get().c)}catch{console.log(t,'absent')}}"`.
  - **Pass:** each count equals migrate's printed count, and `pg-psql -d blaze_rehearsal -tAc "SELECT value FROM blaze_meta WHERE key='schema_version'"` → `6`.
- [ ] **Step 4 (step 5): Serve the rehearsal database, and check sprints and new.**
  - Start a second server inside the pod on a port the Service does not expose: `kubectl … exec deploy/blaze -- RH sh -c 'PORT=4399 timeout 20 node scripts/serve.mjs >/tmp/rh-serve.log 2>&1 & sleep 6; node -e "fetch(\"http://127.0.0.1:4399/api/hash\").then(r=>console.log(r.status))"'` → `401`. The roster loaded from Postgres, so auth is on.
  - `kubectl … exec deploy/blaze -- RH node scripts/cli.mjs sprint list` → S1–S5, with S2 active.
  - `… RH node scripts/cli.mjs new --project BLZ --type task "rehearsal probe" --estimate 5 --parent BLZ-254 --sprint S5` → it prints a new id. Any open BLZ `feature` may replace `BLZ-254` if the create refuses that parent.
- [ ] **Step 5 (step 6): Check a dump holds the new tables:** `kubectl … exec blaze-pg-1 -c postgres -- sh -c 'pg_dump -U postgres -Fc -d blaze_rehearsal -f /tmp/rh2.dump && pg_restore --list /tmp/rh2.dump | grep -cE "TABLE DATA public (app_user|sprint) "'` → `2`.
- [ ] **Step 6: Rehearse the rollback (R14).**
  1. `pg-psql -d blaze_rehearsal -c "UPDATE blaze_meta SET value='5' WHERE key='schema_version'"`.
  2. Re-run Step 2's migrate → exit 1, with the "already imported" refusal (R14 observed).
  3. `kubectl … exec blaze-pg-1 -c postgres -- pg_restore -U postgres --clean --if-exists -d blaze_rehearsal /tmp/rh.dump`.
  4. Re-run Step 2's migrate → exit 0.

  Record each output.
- [ ] **Step 7: Write evidence** `task-10.md` and run the `rg` credential check over it.
- [ ] **Step 8: Clean up:** `pg-psql -c "DROP DATABASE blaze_rehearsal WITH (FORCE)"`; `kubectl … exec blaze-pg-1 -c postgres -- rm -f /tmp/rh.dump /tmp/rh2.dump`; `kubectl … exec deploy/blaze -- rm -rf /tmp/rehearsal /tmp/rehearsal-matrices /tmp/sprints.json /tmp/rh-serve.log`. Then `pg-psql -l | grep -c blaze_rehearsal` → `0`.

### Task 11: Cutover — freeze, dump, migrate, restart (§5 steps 3–5)

Each step's gate must pass before the next starts. A failed gate means: stop, apply the rollback table, and report.

- [ ] **Step 1: GATE (operator go-ahead): freeze** (§5 step 3).
  - **The operator** stops every session that writes to the board and issues no token until Task 12 Step 1.
  - **Claude** checks quiescence (skill `quiescence-gate-before-shared-resource-mutation`). Read the newest `ticket_event` row's timestamp with `pg-psql -d blaze -tAc` (look up the column name with `\d ticket_event`), twice, 5 minutes apart. **Pass:** the two reads are equal.
- [ ] **Step 2: Backup directory mode** (OD-B4, Finding 9). **Claude** runs, under Step 1's go-ahead: `docker exec k3d-service-platform-server-0 sh -c "chown 26:$(id -g) /host-blaze-pg-backups && chmod 0750 /host-blaze-pg-backups"`. `$(id -g)` expands on the laptop, which is intended. **Pass:** `stat -c '%a %u %g' ~/cluster-data/blaze-pg-backups` → `750 26 <operator gid>`, and `ls ~/cluster-data/blaze-pg-backups` still works as the operator.
- [ ] **Step 3: A manual dump.**
  - `kubectl --context k3d-service-platform -n blaze create job --from=cronjob/blaze-pg-backup blaze-pg-backup-precutover`, then `kubectl … wait --for=condition=complete job/blaze-pg-backup-precutover --timeout=900s`.
  - `kubectl … logs job/blaze-pg-backup-precutover | grep PGDUMP-RESULT` → `outcome=ok rc=0`.
  - Verify the newest file: `docker run --rm -v ~/cluster-data/blaze-pg-backups:/b:ro "$(kubectl … get cluster blaze-pg -o jsonpath='{.spec.imageName}')" pg_restore --list /b/<newest>.dump | wc -l` → positive.
  - **Pass:** the dump is verified. Record its name and size.
- [ ] **Step 4: GATE (operator go-ahead): migrate** (§5 step 4).
  - `kubectl … exec -i deploy/blaze -- sh -c 'cat > /tmp/sprints.json' < /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine/sprints.json`.
  - `pod-blaze db migrate --identity-from /data/.blaze/identity.db --sprints-from /tmp/sprints.json`.
  - **Pass:**
    - it exits 0;
    - `pg-psql -d blaze -tAc "SELECT value FROM blaze_meta WHERE key='schema_version'"` → `6`;
    - the printed per-table counts equal Task 10 Step 3's source-count command, run against the live file;
    - the sprints line names 5 sprints, with S2 active.
- [ ] **Step 5: Restart** (§5 step 5). `kubectl … rollout restart deploy/blaze && kubectl … rollout status deploy/blaze --timeout=300s`. Then:
  - **Claude:**
    - `curl -s -o /dev/null -w '%{http_code}\n' --cacert ~/.config/service-platform/local-ca/ca.crt https://blaze.howman.link/api/hash` → `401`;
    - `pod-blaze sprint list` → S1–S5, S2 active;
    - `pod-blaze new --project BLZ --type task "cutover probe" --estimate 5 --parent BLZ-703 --sprint S5` → accepted. Then `pod-blaze resolve <id> wont-do` and move it to `done`.
  - **The operator:**
    - reloads the board in the browser that was signed in before step 4, and it shows the board without a sign-in (an existing session survived);
    - the gantt shows S1–S5;
    - runs one call with an existing token from their own terminal;
    - creates a ticket through `/api/new` from each machine (remote mode, their own tokens), and resolves both `wont-do`.

  **Pass:** all of the above.
- [ ] **Step 6: Write evidence** `task-11.md` (no credential; `rg` check).

### Task 12: Unfreeze and one-day watch (§5 step 6)

- [ ] **Step 1: Unfreeze.** **The operator** resumes sessions.
- [ ] **Step 2: After the next nightly run (12:30 Australia/Sydney)**, run `docker run --rm -v ~/cluster-data/blaze-pg-backups:/b:ro <pg image> pg_restore --list /b/<newest>.dump | grep -cE 'TABLE DATA public (app_user|sprint) '` → `2`. Also `stat -c '%a' ~/cluster-data/blaze-pg-backups` → `750`, and `kubectl … get cronjob blaze-pg-backup -o jsonpath='{.status.lastSuccessfulTime}'` is today's.
- [ ] **Step 3: Write evidence** `task-12.md`. Copy tasks 10–12's evidence into BLZ-716's body, then log BLZ-716 and move it to `done`. **This gate releases F2** (Task 13).

---

## F2 — service-platform, no hostPath (BLZ-713, BLZ-714, BLZ-697; absorbs INF-933)

**Setup, after Task 12:** `cd /home/rnamwoh/Documents/Code/service-platform && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/service-platform-worktrees/BLZ-713-f2-drop-hostpaths -b BLZ-713-f2-drop-hostpaths origin/main`. Move BLZ-713, BLZ-714 (already `in-progress`) and BLZ-697 to `in-progress`.

### Task 13: emptyDir `/data`, no hostPath or git env, read-only config (BLZ-713, INF-933)

**Files:**
- Modify: `C/templates/deployment.yaml`:
  - delete the `projects`, `gitdir` and `blazedir` volumes and mounts (`:122-143`, `:201-234`);
  - add volume `data: { emptyDir: {} }` mounted at `/data`;
  - `readOnly: true` on the `/data/blaze.config.json` mount;
  - replace `command: ["/bin/sh","-c"]` and `args` (`:54-56`) with `command: ["node", "scripts/serve.mjs"]`;
  - delete the four `GIT_*` env (`:72-79`);
  - keep `HOME`, `fsGroup: 1000` and `runAsUser 1000`;
  - reword the `writePort` comment (`:83-90`): the fs rollback is gone after F2.
- Modify: `C/values.yaml` (delete `data:` `:11-26` and `git:` `:29-31`; reword the `writePort` doc `:71-76`), `deploy/apps/blaze/values-dev.yaml` (delete `data.*HostPath` `:76-90`)
- Create: `tests/blaze-chart/test_data_root.py`
- Modify: `tests/blaze-chart/test_blaze_postgres.py`, wherever it pins `GIT_`, `safe.directory`, `projects`, `gitdir`, `blazedir` or `hostPath` (grep first)

- [ ] **Step 1: Write the failing tests** in `test_data_root.py` (`dev_docs`, `pg_docs` and `default_docs` alike):
  - `test_deployment_mounts_no_hostpath`: no volume of Deployment `blaze` has `hostPath`. The backup CronJob and the PV keep theirs, so the test is scoped to the Deployment;
  - `test_data_root_is_emptydir`: the volume mounted at `/data` is an `emptyDir`;
  - `test_config_mounts_read_only`: every mount at `/data/blaze.config.json` or `/data/projects/*/project.json` has `readOnly: true`;
  - `test_no_git_env_or_shell_wrapper`: no env name starts with `GIT_`; `command == ["node", "scripts/serve.mjs"]`; no `args`; `"safe.directory"` appears in no rendered document;
  - `test_values_have_no_data_or_git_blocks`: `"data" not in values` and `"git" not in values`, for both values files.
- [ ] **Step 2: Run and watch them fail:** `python3 -m pytest tests/blaze-chart/test_data_root.py -q`.
- [ ] **Step 3: Implement** the Files block. Update `test_blaze_postgres.py`'s pins to match.
- [ ] **Step 4: Run and watch them pass:** the whole `tests/blaze-chart`, `helm lint`, and the kubeconform render.
- [ ] **Step 5: Commit** (`git add` the listed paths): `BLZ-713: the board pod mounts nothing from a laptop — emptyDir /data, read-only config, no git env (INF-933)`, plus the trailer.

### Task 14: The `blaze-audit` CronJob (BLZ-714, R3, R7)

**Files:**
- Create: `C/templates/audit-cronjob.yaml`, gated `if and .Values.postgres.enabled .Values.audit.enabled`. It copies `postgres-backup-cronjob.yaml`'s policy:
  - `concurrencyPolicy: Forbid`, `startingDeadlineSeconds: 86400`, history limits `3/3`, `backoffLimit: 1`, `activeDeadlineSeconds: {{ .Values.audit.activeDeadlineSeconds }}`, `enableServiceLinks: false`;
  - pod label `app.kubernetes.io/name: blaze-audit`;
  - image `{{ .Values.image.repository }}@{{ .Values.image.digest }}`, `runAsUser/Group 1000`, `runAsNonRoot`;
  - env `BLAZE_PROJECTS_DIR=/data/projects`, `BLAZE_WRITE_PORT=db`, the `BLAZE_DB_*` set, and `FAIL_ON`. **The DB env moves into a `blaze.dbEnv` helper in `_helpers.tpl`, which both the Deployment and the CronJob include**, so it has one source;
  - volumes: emptyDir `/data`, the `config` and `projects-config` mounts (read-only, the same mount helper as the Deployment), and `/scripts` from the script ConfigMap (`defaultMode 0555`);
  - command `["/scripts/audit.sh"]`.
- Create: `C/templates/audit-script-configmap.yaml`, `blaze-audit-script`, key `audit.sh`:
  ```sh
  #!/bin/sh
  # blaze-audit (BLZ-714): replaces blaze-pm's board-integrity.yml. Fails loudly into
  # CronJobLastRunFailed / CronJobStale; prints exactly one BLAZE-AUDIT-RESULT line.
  cd /app
  node scripts/cli.mjs audit --json --fail-on "$FAIL_ON" > /data/audit.json; a=$?
  node scripts/cli.mjs matrices --out /data/matrices > /dev/null; m=$?
  set -- $(node -e 'try{const r=JSON.parse(require("fs").readFileSync("/data/audit.json","utf8"));console.log(r.ticketCount??"?",r.failing??"?",r.failOnVerdict??"?")}catch{console.log("? ? unreadable")}')
  outcome=ok; [ $a -eq 2 ] && outcome=could-not-observe; [ $a -eq 1 ] && outcome=fail; [ $m -ne 0 ] && [ $outcome = ok ] && outcome=matrices-failed
  echo "BLAZE-AUDIT-RESULT outcome=$outcome audit_rc=$a matrices_rc=$m tickets=$1 failing=$2 verdict=$3"
  [ $a -eq 0 ] && [ $m -eq 0 ]
  ```
  The script body is given because the tests pin its exit table.
- Modify: `C/values.yaml`, adding:
  ```yaml
  audit:
    enabled: true
    schedule: "0 13 * * *"
    timeZone: Australia/Sydney
    activeDeadlineSeconds: 600
    failOn: [off-taxonomy-component, off-taxonomy-label, bad-link-key, unknown-link-type, dangling-target, dangling-parent, invalid-parent-type, parse-error, duplicate-status, config-unloadable, schema-malformed, project-mismatch, unreadable-ticket-directory]
  ```
  That is the 13 `HARD_KINDS` of `audit.mjs`, listed explicitly (recon flag 8). `FAIL_ON` is `join "," .Values.audit.failOn`.
- Modify: `tests/blaze-chart/test_flush_removed.py:19`, so the CronJob set is `<= {"blaze-pg-backup", "blaze-audit"}` (R7).
- Modify (comments and counts only): `obs-ingress/cronjob-freshness-rule.yaml` `:105-113` and `:146-156` (the per-namespace notification ceiling: blaze now has 2 CronJobs); the `kube-prometheus-stack` `values-dev.yaml` alert-coverage comment (`:~148-170`: the count becomes the live total, Finding 13, and it says the proof is re-run in Task 17).
- Create test: `tests/blaze-chart/test_audit_cronjob.py`

- [ ] **Step 1: Write the failing tests:**
  - `test_cronjob_named_and_labelled_apart`: CronJob `blaze-audit` exists under `pg_docs`, its pod label is `blaze-audit`, and the `blaze` Service's selector does not match the pod's labels;
  - `test_cronjob_uses_board_image_and_db_env`: the image equals the Deployment's; env names ⊇ the Deployment's `BLAZE_DB_*` set; `BLAZE_WRITE_PORT == "db"`;
  - `test_cronjob_policy`: Forbid, 86400, 3/3, backoffLimit 1, activeDeadlineSeconds 600;
  - `test_fail_on_names_every_hard_kind`: `FAIL_ON` splits to exactly the 13 kinds above;
  - `test_cronjob_mounts_read_only_no_hostpath`;
  - `test_absent_without_postgres`: no `blaze-audit` under `default_docs`;
  - script tests. Each extracts `audit.sh` from the rendered ConfigMap, rewrites `/app` and `/data` to a tmpdir, and runs it with a stub `node` first on `PATH` (stub exit codes per verb, and a canned `audit.json`):
    - `test_script_ok`: audit 0, matrices 0 → exit 0, one line `BLAZE-AUDIT-RESULT outcome=ok …`;
    - `test_script_fail`: audit 1 → exit ≠ 0, `outcome=fail`;
    - `test_script_could_not_observe`: audit 2 → exit ≠ 0, `outcome=could-not-observe`;
    - `test_script_matrices_failed`: matrices 1 → exit ≠ 0, `outcome=matrices-failed`;
    - `test_script_prints_one_line_and_no_json`: exactly one `BLAZE-AUDIT-RESULT` line, and stdout contains no `{`.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Consult `context7` for the `batch/v1` CronJob `timeZone` field (process delta).
- [ ] **Step 4: Run and watch them pass:** `tests/blaze-chart`, `helm lint`, kubeconform, and the promtool proofs (`promtool test rules tests/promtool/*.test.yaml`, if `promtool` is on PATH; else CI's `validate` step is the run).
- [ ] **Step 5: Commit:** `BLZ-714: a daily blaze-audit CronJob replaces blaze-pm's board-integrity.yml — audit --fail-on the hard kinds, then a matrices render`, plus the trailer.

### Task 15: Remove the dormant basic-auth (BLZ-697, R8)

**Files** (the full recon list):
- Delete: `C/templates/middleware.yaml`
- Modify:
  - `C/templates/ingress.yaml:11-12` (the annotation);
  - `C/values.yaml:33-46` and `values-dev.yaml:91-103` (`auth`);
  - `scripts/k8s-up.sh`:
    - `:53` (the two required `.env` names);
    - `:333-353` (the secret block). Keep `kubectl get ns blaze || kubectl create ns blaze` only if a later k8s-up step uses `-n blaze` before ArgoCD's first sync (grep for that);
    - `:529` (the log line);
  - `.env.example:108-111`; `docs/operations/runbook.md:189` and `:788`; `docs/services/blaze.md:78-82`.
- Modify test: `tests/blaze-chart/test_no_ingress_cors.py`. Delete `test_basic_auth_template_still_renders_when_opted_in` (`:235-240`). Keep `test_dev_board_has_no_basic_auth_middleware`.
- Create test (in `test_no_ingress_cors.py`): `test_basic_auth_is_gone`:
  - no rendered `Middleware`, even with `--set auth.enabled=true`;
  - no `router.middlewares` annotation;
  - `"BLAZE_BASICAUTH"` appears in neither `.env.example` nor `scripts/k8s-up.sh`;
  - `C/templates/middleware.yaml` does not exist.

- [ ] **Step 1: Write the failing test.** **Step 2: Run it and watch it fail.** **Step 3: Implement** the Files block. **Step 4: Run** `tests/blaze-chart`, `python3 scripts/check_bootstrap_secrets.py` (exit 0: the three sources stay in step), `bash -n scripts/k8s-up.sh`, and the render checks.
- [ ] **Step 5: Commit:** `BLZ-697: remove the dormant blaze basic-auth (Middleware, ingress annotation, values, k8s-up secret, .env, docs)`, plus the trailer. The live `Secret/blaze-basic-auth` is deleted by the operator in Task 17 (R8).

### Task 16: `k8s-up.sh` without blaze-pm, the 0750 backup directory, docs and ADR-0026 (BLZ-713, OD-B4)

**Files:**
- Modify: `scripts/k8s-up.sh`. Delete `:81-109` (the `BLAZE_PM_DIR` block) and `:145` (`"${blaze_volume_args[@]}" \`). In the node chown block (`:153-181`), `/host-blaze-pg` stays `26:26`, and `/host-blaze-pg-backups` becomes `chown 26:$(id -g)` plus `chmod 0750` (OD-B4).
- Modify test: `tests/blaze-chart/test_k8s_up_mounts.py`:
  - `test_no_blaze_pm_mounts`: k8s-up.sh contains none of `BLAZE_PM_DIR`, `host-blaze-projects`, `host-blaze-git`, `host-blaze-state`;
  - `test_backups_dir_is_0750_operator_group`: through `_run_chown_block`'s stub docker, the recorded commands include `chown 26:<the stub's id -g>` and `chmod 0750` for `/host-blaze-pg-backups`, and `chown 26:26` for `/host-blaze-pg`;
  - the existing loop regex (`:47-48`) is adjusted to the new block.
- Docs:
  - `docs/services/blaze.md`, rewritten to the live-board model:
    - `:12` (the image row);
    - `:15` (the Data row: CNPG `blaze-pg` holds tickets, identity and sprints);
    - `:19-40` (no hostPaths, no `BLAZE_PM_DIR`);
    - `:42-57` (config from values; loops: groomer disabled, no reconcile);
    - `:61-72` (security: identity in Postgres, backups hold hashes, dir 0750);
    - the env table without `GIT_*`;
    - a `blaze-audit` row;
    - `pod-blaze` defined once;
  - `docs/operations/runbook.md`:
    - `:29` (the board row);
    - `:288-443` (first-run setup: the blaze-pm and `BLAZE_PM_DIR` warnings go; setup is unreachable on this board, D2);
    - `:462` ("readable by you as a member of the directory's group, mode 0750", OD-B4);
    - `:1332-1380` (`blaze-audit` joins the CronJob alert runbook: what `BLAZE-AUDIT-RESULT outcome=…` means, and `pod-blaze audit` to reproduce);
  - Create `docs/decisions/0026-board-data-in-postgres-config-in-the-chart.md` (house ADR header):
    - **Context:** spec §1 and the retired blaze-pm working copy.
    - **Decision:**
      - board data (tickets, identity, sprints) in CNPG `blaze-pg`;
      - board config in this chart's values (F1);
      - no hostPath on the pod;
      - `blaze-audit` replaces `board-integrity.yml`;
      - the backup directory is 0750 because dumps hold credential hashes.
    - **Consequences:** a rollback past the archive restores from the bundle, not a checkout, and so on.
    - Cross-reference engine ADR-0039.
  - `docs/decisions/0015-…md`: a status line "Superseded in part by ADR-0026 (the bind mount)".
  - `docs/changelog.md`: Unreleased entries for BLZ-713, BLZ-714 and BLZ-697.
  - If `CLAUDE.md:22` mentions blaze-pm or a hostPath, write the proposed wording (user-only).

- [ ] **Step 1: Write the failing tests.** **Step 2: Run them and watch them fail.** **Step 3: Implement.** **Step 4: Run** `tests/blaze-chart` (including `test_docs_wiring.py`), `bash -n scripts/k8s-up.sh`, and `python3 scripts/check_bootstrap_secrets.py`.
- [ ] **Step 5: Commit:** `BLZ-713: k8s-up.sh drops the blaze-pm mounts and makes the backup dir 0750; docs and ADR-0026 for the live-board model`, plus the trailer.

### Task 17: F2 verification, the live probe, PR, merge, and the §5 step 7 gate

- [ ] **Step 1: Run the live audit probe before merge.** `pod-blaze audit --json --fail-on <the 13 kinds, comma-joined> > <ev>/f2-probe.json; echo rc=$?` → `rc=0`, and `jq .ticketCount` is about 3,000. A non-zero rc means the CronJob would alert from its first night: **stop**, list the findings, and the operator decides (fix on the board, or narrow `failOn` with a recorded ruling). `pod-blaze matrices --out /tmp/m` → exit 0.
- [ ] **Step 2: Run the code-review skill** and summarise it in the PR body.
- [ ] **Step 3: Push and open the PR:** `BLZ-703: F2 — no hostPath, emptyDir /data, read-only config, blaze-audit CronJob, basic-auth removed (INF-933, BLZ-697)`. The body lists BLZ-713, BLZ-714, BLZ-697 and INF-933, the probe result, the code-review summary, the proposed CLAUDE.md wording if any, and the attribution line. Move the three tickets to `in-review`.
- [ ] **Step 4: Merge when `validate` is green** (rebase first).
- [ ] **Step 5: Run the §5 step 7 gate** after the rollout:
  - `kubectl … get pod -l app.kubernetes.io/name=blaze -o yaml | grep -c hostPath` → `0`;
  - `kubectl … exec deploy/blaze -- sh -c 'ls /data/projects | wc -l; test -w /data && echo writable'` → `11`, `writable`;
  - repeat Task 11 Step 5's Claude-side smokes (401, `sprint list`, a probe `new` resolved `wont-do`). **The operator** repeats the browser-session and token checks.
- [ ] **Step 6: Run the alert proof (R7) after the first `blaze-audit` run.** Trigger one: `kubectl … create job --from=cronjob/blaze-audit blaze-audit-first`. Then:
  - its log has `BLAZE-AUDIT-RESULT outcome=ok`;
  - query Prometheus (the runbook's `kubectl port-forward` to `prometheus-operated`, then `curl …/api/v1/query`) for `kube_cronjob_status_last_successful_time{cronjob="blaze-audit"}` and `kube_cronjob_info{cronjob="blaze-audit"}` → one series each;
  - evaluate each rule's expression from `cronjob-last-run-failed-rule.yaml` and `cronjob-freshness-rule.yaml` with a `cronjob="blaze-audit"` selector → the series exists (value 0, not firing).

  Post the outputs as a PR comment.
- [ ] **Step 7: GATE (operator go-ahead): operator cleanup** (R8). **The operator** runs `kubectl --context k3d-service-platform -n blaze delete secret blaze-basic-auth` and removes `BLAZE_BASICAUTH_*` from their `.env`.
- [ ] **Step 8: Rollback, if a gate fails:** `git revert` F2. The hostPaths come back, and the files exist until Task 29.
- [ ] **Step 9: Bookkeeping:** log and move BLZ-713, BLZ-714 and BLZ-697 to `done`. `pod-blaze link INF-933 Duplicate BLZ-713`, resolve `duplicate`, then move it to terminal.

---

## G — claude-config, `blaze-live` and the repoint (BLZ-717, BLZ-718, BLZ-725)

**Setup:** `cd /home/rnamwoh/Documents/Code/claude-config && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/claude-config-worktrees/BLZ-717-g-blaze-live -b BLZ-717-g-blaze-live origin/main` (R10). Move BLZ-717, BLZ-718 and BLZ-725 to `in-progress`. The G0 guard (`hooks/blaze-pm-write-guard.sh`, its registration, its test and its CI line) is **not** touched in G (R9).

### Task 18: The `blaze-live` wrapper and its install step (BLZ-717, R11)

**Files:**
- Create: `scripts/blaze-live` (bash, mode 0755)
- Modify: `scripts/install.sh`. A new step **"5c. PATH tools"** after 5b:
  - `mkdir -p ~/.local/bin`;
  - if `~/.local/bin/blaze-live` is absent, or a symlink into this repo, then `ln -sfn "$REPO/scripts/blaze-live" ~/.local/bin/blaze-live`;
  - otherwise warn `blaze-live: ~/.local/bin/blaze-live is not ours — left alone` and continue.
  - `--check` reports a missing or foreign link as drift (non-zero), the way it reports the other drift.
- Create: `scripts/test_blaze_live.py`, `scripts/test_install_blaze_live.py` (in the style of the existing `test_install_*.py`: `HOME` is a tmpdir)
- Modify: `.github/workflows/claude-kit-ci.yml` (both tests in "Unit suites")
- Docs: `docs/architecture.md` (`scripts/` and install step 5c), `docs/changelog.md`

**Interfaces** (`scripts/blaze-live`):
- Resolved values. Each has an override env var for tests, and none is printed except as a path:
  - `url="${BLAZE_LIVE_URL:-https://blaze.howman.link}"`;
  - `token_file="${BLAZE_LIVE_TOKEN_FILE:-$HOME/.config/blaze/token}"`;
  - `ca="${BLAZE_LIVE_CA:-${LOCAL_CA_DIR:-$HOME/.config/service-platform/local-ca}/ca.crt}"`. That is `$(local-ca.sh path)/ca.crt` without depending on the service-platform checkout: `local-ca.sh`'s own default dir (R11);
  - `engine="${BLAZE_LIVE_ENGINE:-blaze}"`.
- Refusals. Each writes one line to stderr, exits 1 and never runs the engine:
  - `blaze-live: no token file at <path> — the operator issues one per machine (see the blaze-live-board skill)`;
  - `blaze-live: <path> must be a regular file with mode 0600 (it is <mode>)`;
  - `blaze-live: no CA certificate at <path> — set LOCAL_CA_DIR or BLAZE_LIVE_CA (service-platform: scripts/local-ca.sh path)`;
  - `blaze-live: engine '<engine>' not found on PATH`.
- Then `unset BLAZE_TOKEN` (the file is the only credential source: A3, D7), `export BLAZE_REMOTE_URL BLAZE_TOKEN_FILE NODE_EXTRA_CA_CERTS`, and `exec "$engine" "$@"`.
- It never reads the token file's content. Only `stat` and `test -f` touch it.

- [ ] **Step 1: Write the failing tests.** `scripts/test_blaze_live.py` uses a stub engine, a tmp script that prints `URL=`, `FILE=`, `CA=`, `TOKEN_SET=<yes|no>` and `ARGV=`. It never prints file contents.
  - `test_execs_engine_with_remote_env`: argv `show BLZ-1 --json` passes through, and the three paths are the overrides;
  - `test_unsets_inherited_blaze_token`: env `BLAZE_TOKEN=leak` → `TOKEN_SET=no`;
  - `test_refuses_missing_token_file`, `test_refuses_token_file_not_0600` (0644 → the message names `644`), `test_refuses_directory_as_token_file`, `test_refuses_missing_ca`, `test_refuses_missing_engine`: each exits 1, and the stub did not run (no `URL=` line);
  - `test_ca_defaults_follow_local_ca_dir`: `LOCAL_CA_DIR=<tmp>` → `CA=<tmp>/ca.crt`;
  - `test_never_prints_token`: the token file holds `tok-SECRET-123`. Across every case above, stdout and stderr never contain it.

  `scripts/test_install_blaze_live.py`:
  - `test_install_links_blaze_live`;
  - `test_install_leaves_a_foreign_file_alone`;
  - `test_check_reports_a_missing_link`.
- [ ] **Step 2: Run and watch them fail:** `python3 scripts/test_blaze_live.py; python3 scripts/test_install_blaze_live.py`.
- [ ] **Step 3: Implement** the wrapper and step 5c.
- [ ] **Step 4: Run and watch them pass,** then every unit suite in the workflow, `bash scripts/export-public.sh --dry-run` (the wrapper names the board host, so it must not be in the public export) and `bash scripts/context-budget.sh`.
- [ ] **Step 5: Commit:** `BLZ-717: blaze-live wrapper — remote mode with an operator-issued token file and the local CA, installed to ~/.local/bin`, plus the trailer.

### Task 19: The `blaze-live-board` skill (BLZ-717)

**Files:**
- Create: `skills/workflow/blaze-live-board/SKILL.md` (Format A; frontmatter `name: blaze-live-board`, `description: "Use when creating, moving, editing, logging, linking or reading a ticket on the live Blaze board from any repo — the board lives in Postgres behind blaze.howman.link and is driven with blaze-live; admin verbs run in the pod."`, **no `scope:`**)
- Create: `scripts/test_live_board_wording.py` (and add it to CI)

**Content, folded** (D7; recon §3 "Fold" list). Each item is one short section:
1. Where the board is. Data: CNPG `blaze-pg`. Config: service-platform `deploy/apps/blaze/chart` values. There is no checkout.
2. Setup, done once per machine by **the operator**: the `user add` command in D7, writing the token to `~/.config/blaze/token` with mode 0600. An agent never runs it.
3. Verbs: `blaze-live new|move|edit|resolve|log|link|show|list|ac`, with examples, including `--body-file`/`--ac-file` and `ac add|toggle` (E3).
4. **`pod-blaze`**, defined as R4's one-liner. The admin verbs: `audit`, `matrices --out /tmp/…`, `sprint`, `user` (operator-only), `db`, `import`.
5. The creation contract (fill-or-justify, from `metadata-governance.md` layer 1): `--parent`, `--estimate` (minutes), `--labels`, `--components`, link types exactly capitalised. A missing label or component is a service-platform chart PR to `projectFiles` (F1), never a local edit.
6. The type and workflow model and the four REQ/ADR rules (refs are citations, never cite by path, refs are monotonic, untraced work is legal). Requirement and architecture tickets take no estimate.
7. Moves are explicit and stepwise: `defined → in-progress → in-review → done`, `in-progress` at start, `in-review` at PR open, `log` then `done` at merge. Resolve first, then move, for a non-Done outcome. **There is no reconcile on this board** (D6). `branch:` and `pr:` stay empty. The `KEY-n` in the branch, commit and PR title is the join.
8. Hygiene: `pod-blaze audit` (soft and hard kinds) and the nightly `blaze-audit` CronJob.
9. Matrices: derived; `pod-blaze matrices --out /tmp/m`, then `kubectl cp` it out if a copy is needed.

**Dropped** (not mentioned, except item 7's one sentence): reconcile, groom, `codeRepos`, flush, `blaze publish`, batch commits, `BLAZE_SESSION`, `.ids` claim files, `metadata_audit.py`, the never-push-main rule and the pathspec rule.

- [ ] **Step 1: Write the failing test** `scripts/test_live_board_wording.py`. `FILES` lists the skill. Task 20 extends it with every repointed file. Tests:
  - `test_frontmatter_has_no_scope`;
  - `test_no_bare_blaze_commands`: in every fenced code block, no line's first token is `blaze` (it must be `blaze-live`, `pod-blaze` or `kubectl`);
  - `test_no_blaze_pm_paths`: no `blaze-pm/` and no `metadata_audit`;
  - `test_reconcile_only_as_dropped`: every line containing `reconcile` also contains `no reconcile` or `not` (the D6 sentence).
- [ ] **Step 2: Run it and watch it fail** (the file is missing).
- [ ] **Step 3: Write the skill.** Keep it under the context-budget ceiling (`bash scripts/context-budget.sh`).
- [ ] **Step 4: Run** the test, the context budget and the export dry-run.
- [ ] **Step 5: Commit:** `BLZ-717: blaze-live-board skill folds blaze-pm's skill, commands and AGENTS.md conventions for the live board`, plus the trailer.

### Task 20: Repoint agents, skills, diagrams and docs off blaze-pm (BLZ-718)

**Files and the change in each** (the recon's §1 and §2 hits, at their origin/main lines):
- `agents/blaze-board-operator.md`: rewritten around `blaze-live` and `pod-blaze` (D7). Removed: the blaze-pm paths, `metadata_audit.py`, the reconcile and groom duties, never-push-main, the pathspec rules, the `/blaze-*` commands (`/blaze-move` never existed). Hygiene gate: `pod-blaze audit`. Reading list: the `blaze-live-board` skill and the engine's `AGENTS.md`.
- `agents/backlog-audit-against-master.md`: walks `blaze-live list --project K --json`. Statuses come from the workflow, not `canceled/`/`duplicate/` directories. The code repo becomes an explicit input (`codeRepos` is gone, F1).
- `agents/program-project-manager.md`: "the live Blaze board (`blaze-live-board`)".
- `agents/blaze-data-model-architect.md`: the stance is rewritten. Postgres (schema v6) is the live store, and files are fs mode's store. "Index-as-future-DB-seam" becomes "the db port's schema-version and migrate discipline".
- `skills/meta/loop-orchestrator/loops/backlog-audit-against-master.md:13`: "the live board".
- Skills:
  - `ship-ticket`, `jira-status-walk-to-done`, `mid-work-jira-ticket-spawn`, `solve`, `promote-then-retire-spec`: every "reconcile moves it" becomes an explicit `blaze-live move` step, and every `blaze-pm/projects/…` read becomes `blaze-live show|list`. `mid-work-jira-ticket-spawn` uses `blaze-live edit` and `link`, never a frontmatter hand-edit.
  - `feature-pr-bundling`: the same, **in a separate commit** (Finding 18).
  - `pmo-team`, `ops-team`, `domain-team-router:54`, `workflow/plan-retire.md:160`: wording only.
  - `public-upstream-repo-forbids-coauthor-trailer:26`, `cross-repo-tool-migration-scan-audit-parallel-sweep`, `bash-date-u-naive-timestamp-dst-bug:13`: past tense ("blaze-pm, archived 2026-…").
  - `monorepo-build-workspace-deps-first:4`: `blaze-pm` is dropped from `scope:`.
- Diagrams `docs/diagrams/ship-ticket-lifecycle.md:20`, `solve-lifecycle.md:21`, `exec-hierarchy.md:114`. The pre-commit embed hook resyncs `README.md:280`.
- `docs/architecture.md:50`; `docs/decisions/0012-adopt-blaze-pm-supersede-jira.md`: a status banner "Amended 2026-…: the board moved to Postgres and blaze-pm is archived (BLZ-703)". The body is not edited.
- `docs/changelog.md`: Unreleased entries for BLZ-717 and BLZ-718.
- Not edited (historical, recon §2): `docs/reports/*`, `docs/archive/*`, `skills/skill-candidates.md`, `skills/candidates-archive.md`, `reflection-notes.md`, ADR bodies, `subagent-tree-mutating-tool-test-pollutes-real-tree`.
- `CLAUDE.md:16-18` (this repo's own) and `global/CLAUDE.md:40` are user-only. Their proposed wording goes in the PR body: the §6 row text, plus "body and AC with `--body-file`/`--ac-file`".

- [ ] **Step 1: Extend the failing test.** `FILES` in `test_live_board_wording.py` gains every file above except the past-tense ones. Run it → FAIL, listing each bare `blaze` and `blaze-pm/` hit.
- [ ] **Step 2: Edit the files.** Run `python3 scripts/test_live_board_wording.py`, every unit suite, the context budget and the export dry-run → green.
- [ ] **Step 3: Commit, twice.** First `BLZ-718: feature-pr-bundling closes tickets with explicit blaze-live moves on the live board`, staging only that file. Then `BLZ-718: repoint agents, skills, diagrams and docs from blaze-pm to the live board`, staging the rest. Both carry the trailer.

### Task 21: Hooks, scripts and settings; remove `blaze-activity` (BLZ-718, BLZ-725)

**Commit A, BLZ-718:**
- `hooks/check-unpushed.sh`: delete the `:21-26` comment, `EXCLUDED_REPOS` and its `:36` loop together. Keep `:77` (ADR-0019 evidence).
- Delete `scripts/blaze-bundle-push.sh`, `scripts/test_blaze_bundle_push.py`, and CI line `:37`.
- `scripts/scan_public_leakage.py`:
  - `discover_project_keys()` reads `scripts/project_keys.txt` (one key per line; `#` comments allowed);
  - a missing or empty file falls back to `FALLBACK_PROJECT_KEYS`;
  - `_DEFAULT_BLAZE_PM_PROJECTS_DIR` and `BLAZE_PM_PROJECTS_DIR` are removed.
  - Create `scripts/project_keys.txt`: the header `# regenerate: blaze-live list --projects --json | jq -r '.[].key'`, then the 11 keys.
- `scripts/test_scan_public_leakage.py`:
  - the discover tests are retargeted: `test_reads_checked_in_keys_file`, `test_missing_keys_file_falls_back`, `test_empty_keys_file_falls_back`;
  - `test_fallback_matches_the_live_board_when_present` is replaced by `test_keys_file_equals_all_eleven`, which never skips.
- `global/settings.json:9`: delete the blaze-pm push rule and fix the trailing comma.
- `scripts/install.sh:511-513`: the comment reads "the blaze engine's `.claude/skills`".
- If a test pins `check-unpushed.sh`'s exclusions, it changes in this commit. Otherwise add `scripts/test_check_unpushed.py::test_no_repo_is_excluded` (a repo named `blaze-pm` with an unpushed commit is reported) and register it in CI.

**Commit B, BLZ-725:**
- Delete `hooks/blaze-activity.sh` and `scripts/test_blaze_activity_hook.py`, and CI line `:38`.
- Delete its `global/settings.json:118` registration (the whole `PostToolUse` entry if it is the entry's only hook).
- Delete the `README.md:392` paragraph, the `scripts/test_hook_path_binding.py:15` comment mention, and any `docs/architecture.md` mention.
- `docs/changelog.md` entry (D10).

- [ ] **Step 1: Write the failing tests** (the scan tests; the check-unpushed test). Run them → FAIL.
- [ ] **Step 2: Implement Commit A.** Run every unit suite, the export dry-run (this is the live leak gate, which now reads the keys file) and `python3 scripts/test_hook_path_binding.py` → green. Commit, staging Commit A's paths.
- [ ] **Step 3: Implement Commit B.** Run `python3 scripts/test_hook_path_binding.py` (it catches a dangling settings entry) and the suites → green. Commit `BLZ-725: remove the blaze-activity hook — the Live view is let go on the live board (D10)`, plus the trailer.

### Task 22: G verification, PR, merge, deploy and the live probe

- [ ] **Step 1: Verify.** Every unit suite is green. `bash scripts/export-public.sh --dry-run` → 0. `bash scripts/context-budget.sh` → 0. `rg -n 'blaze-pm' --glob '!docs/reports/**' --glob '!docs/archive/**' --glob '!skills/*candidates*' .` → only history, the G0 guard and its test, ADR-0012's banner, and changelog lines.
- [ ] **Step 2: Push and open the PR:** `BLZ-703: G — blaze-live wrapper, blaze-live-board skill, repoint claude-config off blaze-pm, remove blaze-activity`. The body lists BLZ-717, BLZ-718 and BLZ-725, the proposed `global/CLAUDE.md:40` and `CLAUDE.md:16-18` wording (operator to apply), and the attribution line. Move the tickets to `in-review`.
- [ ] **Step 3: Merge when claude-kit CI is green.**
- [ ] **Step 4: GATE (operator go-ahead): deploy on this machine.**
  - **The operator** resolves their uncommitted `feature-pr-bundling` edit (commit, merge or discard; Finding 18; operator question 3).
  - **Claude** then:
    1. `cd /home/rnamwoh/Documents/Code/claude-config && git pull --ff-only && bash scripts/install.sh && bash scripts/install.sh --check` (exit 0).
    2. `cd /home/rnamwoh/Documents/Code/blaze && git pull --ff-only && npm ci --ignore-scripts` (Finding 3; untracked files there are left alone).
    3. `ln -sfn /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs ~/.local/bin/blaze`, then `readlink ~/.local/bin/blaze` (no `blaze-pm`).
    4. `ls -l ~/.local/bin/blaze-live` (a link into the claude-config checkout); `ls ~/.claude/hooks/blaze-activity.sh` → absent.
- [ ] **Step 5: GATE (operator go-ahead): the token.** **The operator**, in their own terminal, runs `kubectl --context k3d-service-platform -n blaze exec deploy/blaze -- node scripts/cli.mjs user add --email agent+<host>@howman.me --role member`. They write the printed token to `~/.config/blaze/token` (`install -m 600 /dev/null ~/.config/blaze/token` first) and restart nothing (D7). **Claude** checks only `stat -c %a ~/.config/blaze/token` → `600`.
- [ ] **Step 6: The live probe** (§5 step 8's "a fresh session creates and shows a ticket", plus §5 step 9's BLZ-729 gate). In a fresh Claude Code session:
  1. `blaze-live new --project BLZ --type task "blaze-live probe" --estimate 5 --parent BLZ-703 --body-file <f> --ac-file <g>`, where `f` holds `## Context\n\nPlan B Task 22 probe.\n` and `g` holds two lines;
  2. `blaze-live show <id>` → the body and two criteria;
  3. `blaze-live ac toggle <id> 1` → `criterion 1 checked`;
  4. `blaze-live ac add <id> "third"` → `criterion 3 added`;
  5. `blaze-live resolve <id> wont-do`, then move it to `done`.

  No output contains the token. Record it all in `task-22.md` and on BLZ-717.
- [ ] **Step 7: The second machine** (operator, when convenient): `git pull` and `bash scripts/install.sh` in its claude-config checkout, its own `user add` token (D7), and the same probe.
- [ ] **Step 8: Bookkeeping, now with `blaze-live`:** log and move BLZ-717, BLZ-718 and BLZ-725 to `done`.

---

## H — moves and repoints in the side repos (BLZ-719, BLZ-720)

### Task 23: H1 — obs-maturity-audit gains the legal kit, the OMA spec and its diagram (BLZ-719)

**Setup:** `cd /home/rnamwoh/Documents/Code/obs-maturity-audit && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/obs-maturity-audit-worktrees/BLZ-719-h1-legal-and-oma-spec -b BLZ-719-h1-legal-and-oma-spec origin/main && uv sync --dev`. `blaze-live move BLZ-719 in-progress`.

**Files** (copied from the read-only oracle `…/blaze-pm-worktrees/v4-spine`, content verbatim apart from one provenance line under each title, `> Moved from hjr15/blaze-pm \`<path>\` at a65adb7b (BLZ-719).`):
- `docs/legal/2026-07-20-oma-master-engagement-letter-DRAFT.md`, `docs/legal/2026-07-20-oma-data-handling-schedule-DRAFT.md` (new directory)
- `docs/design/2026-07-20-oma-engine-v1-design.md` (new directory; from `docs/specs/`)
- `docs/diagrams/oma-engine-v1-architecture.md`. Its front matter follows `docs/diagrams/architecture.md`'s (`type: architecture`, `format: mermaid`).
- Modify: `templates/engagement/README.md:47-48` (repo-relative `docs/legal/…`, R12)
- Modify citations to the archived URL `https://github.com/hjr15/blaze-pm/blob/BLZ-305-v4-spine/<path>`, which resolves after the archive push: `tests/fixtures/synthetic_pack.py:5`, `docs/operations/2026-07-29-oma-self-dogfood-INF-653.md:3`. Also `docs/decisions/0001-audit-engine-core.md:7`, where the ADR-0017 citation becomes BLZ-218, and the `.github/workflows/ci.yml:12` comment.
- Create test: `tests/oma/test_moved_docs.py`

- [ ] **Step 1: Write the failing test:**
  - `test_legal_kit_lives_in_repo`: both `docs/legal/` files exist, and `templates/engagement/README.md` names each by its repo-relative path;
  - `test_engine_spec_and_diagram_moved_in`;
  - `test_no_blaze_pm_working_copy_paths`: across `templates/`, `docs/`, `tests/` and `src/`, no `blaze-pm/docs/` string except inside an `https://github.com/hjr15/blaze-pm/` URL.
- [ ] **Step 2: Run it and watch it fail:** `uv run pytest tests/oma/test_moved_docs.py -q`.
- [ ] **Step 3: Copy and edit** per Files.
- [ ] **Step 4: Run** `uv run pytest -q`, `uv run ruff check .` and `uv run mypy` → green, with coverage ≥ 95.
- [ ] **Step 5: Commit, push, PR, merge.** Commit `BLZ-719: the OMA legal kit, engine spec and diagram move in from blaze-pm`, plus the trailer. PR `BLZ-703: H1 — OMA legal kit, engine spec and diagram move in from blaze-pm`. Merge when CI is green.

### Task 24: H2 — k8s-posture-audit points at obs-maturity-audit (BLZ-719)

**Setup:** `cd /home/rnamwoh/Documents/Code/k8s-posture-audit && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/k8s-posture-audit-worktrees/BLZ-719-h2-repoint-legal -b BLZ-719-h2-repoint-legal origin/main && uv sync --dev`. H1 is merged.

**Files:**
- Test first: `tests/kpa/test_engagement_templates.py`. `:51-52` assert `"obs-maturity-audit/docs/legal/2026-07-20-oma-master-engagement-letter-DRAFT.md"` and `…-data-handling-schedule-DRAFT.md`, and `:9`'s docstring says the same.
- `templates/engagement/README.md:48-49` (the paths), and `:44-45` ("held in the obs-maturity-audit repo").
- `docs/decisions/0001-kpa-engine.md:7`: ADR-0017 becomes BLZ-218.
- `docs/design/2026-07-21-kpa-engine-v1-design.md`:
  - `:4` → `docs-central/docs/exec-board/decisions/2026-07-20-consultancy-audit-tool-slate.blaze-pm.md` (OD-B3: blaze-pm's copy);
  - `:6` → `obs-maturity-audit/docs/design/2026-07-20-oma-engine-v1-design.md`;
  - `:9-12` → the archived URL.
- `src/kpa/checks/_predicates.py:7` → the archived URL; the `.github/workflows/ci.yml:12` comment.
- `CLAUDE.md:70` is user-only. Its proposed wording (BLZ-218 and "the live board") goes in the PR body.

- [ ] **Step 1: Edit the test,** then run `uv run pytest tests/kpa/test_engagement_templates.py -q` and watch it fail.
- [ ] **Step 2: Edit the files.** Run `uv run pytest -q`, `uv run ruff check .` and `uv run mypy` → green.
- [ ] **Step 3: Commit, push, PR, merge.** Commit `BLZ-719: point the engagement kit and design docs at obs-maturity-audit, docs-central and the blaze-pm archive`, plus the trailer. PR `BLZ-703: H2 — repoint k8s-posture-audit off blaze-pm`. After merge, log BLZ-719 and move it to `done`.

### Task 25: H3 — docs-central launchpad from the live board, and the exec-board memos (BLZ-720)

**Setup:** `cd /home/rnamwoh/Documents/Code/docs-central && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/docs-central-worktrees/BLZ-720-h3-launchpad-live-board -b BLZ-720-h3-launchpad-live-board origin/master` (R12: never the rescue checkout). G is deployed, so `blaze-live` is on PATH.

**Files:**
- Modify: `scripts/gen_launchpad.py`:
  - `INPUT_REPOS = ["service-platform", "claude-config"]`;
  - a new `fetch_tickets(run=subprocess.run) -> list | None`: `run(["blaze-live", "list", "--json"], capture_output=True, text=True, check=False)`. It returns `None` on a missing binary (`FileNotFoundError`), a non-zero exit, or JSON that is not a list;
  - `ticket_section(tickets) -> str`: heading `## Ticket tallies (live board)`, the table Project/Tickets/Resolved/Open. Resolved counts a truthy `t["frontmatter"].get("resolution")`; `project` is top-level (Finding 19). For `None` it is the heading plus `board unreachable — tallies not shown` and no table (§6);
  - the docstring drops blaze-pm and keeps "no wall clock". The board read is the one network input, named.
- Create test: `scripts/tests/test_gen_launchpad.py`
- Create: `docs/exec-board/decisions/2026-07-26-settleworks-structure-revisit-DECISION.md`, `…-proposal.md`, and `2026-07-20-consultancy-audit-tool-slate.blaze-pm.md` (OD-B3: beside the existing copy, verbatim, no content merge), copied from the v4-spine oracle.
- Regenerate: `docs/engineering/platform-launchpad.md` (run the script)

- [ ] **Step 1: Write the failing tests:**
  - `test_tallies_from_live_list`: an injected `run` returns a fake completed process whose stdout is 3 tickets (2 INF with one resolved, 1 OBA) → `ticket_section` has `| INF | 2 | 1 | 1 |` and `| OBA | 1 | 0 | 1 |`;
  - `test_unreachable_on_nonzero_exit`, `test_unreachable_on_bad_json`, `test_unreachable_when_binary_missing` (`run` raises `FileNotFoundError`): each gives `board unreachable` and no `|` table row;
  - `test_input_repos_drop_blaze_pm`.
- [ ] **Step 2: Run them and watch them fail:** `python -m pytest scripts/tests/test_gen_launchpad.py -q`.
- [ ] **Step 3: Implement,** then `python -m pytest scripts/tests/ -q` → green. Commit `BLZ-720: the platform launchpad tallies tickets from blaze-live list, and says so when the board is unreachable`, plus the trailer.
- [ ] **Step 4: Copy the memos and regenerate the launchpad** (`python3 scripts/gen_launchpad.py`). The tallies are about 3,000 tickets across 11 projects. Commit `BLZ-720: blaze-pm's exec-board memos move into docs-central (the slate memo kept beside the existing copy)`, plus the trailer.
- [ ] **Step 5: Push, PR, merge.** PR `BLZ-703: H3 — launchpad from the live board, exec-board memos moved in`. After merge, log BLZ-720 and move it to `done`.

### Task 26: Board operations (BLZ-722) and the §5 step 8 gate

- [ ] **Step 1: Mark the superseded ADR tickets** (D8, Finding 7). For BLZ-206 (ADR-0005) and BLZ-210 (ADR-0009):
  - `blaze-live link <id> Relates BLZ-703`;
  - `blaze-live show <id> --json | jq -r .body > <f>`, append `## Superseded\n\nSuperseded by BLZ-703 (Phase 5): <one sentence: the batch commit / the plain-file ledger is retired; the board lives in Postgres>.\n`, then `blaze-live edit <id> --body-file <f>`;
  - `blaze-live show <id>` shows the section.
- [ ] **Step 2: Check BLZ-202…218 against D8.** For each id, `blaze-live show <id> --json` gives the `ref`, which must be `ADR-0001`…`ADR-0017` in order, and the type `architecture`. Record a 17-row table (id, ref, status, D8 fate "Archive") in `task-26.md`. A gap or mismatch is reported, not fixed.
- [ ] **Step 3: Run the §5 step 8 gate.** For each of claude-config, docs-central, k8s-posture-audit and service-platform: `cd <repo> && git fetch origin && git grep -l blaze-pm origin/<default>`. Classify every hit as history, archive URL, changelog, or the G0 guard and its test (claude-config only, until Task 30). **Pass:** no other class. Record the list.
- [ ] **Step 4: Bookkeeping:** evidence onto BLZ-722, then log it and move it to `done`.

---

## Archive — hjr15/blaze-pm (BLZ-721, D9, R13, OD-B1, OD-B2)

**Archive directory:** `ARCH=~/cluster-data/archive/blaze-pm-final-$(date +%F)`. It is created at mode 0700 and holds the manifest, patches, the bundle, `pending-drained-*` and the retained `identity.db`. `BP=/home/rnamwoh/Documents/Code/blaze-pm` and `V4=/home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine`.

### Task 27: Pre-checks, inventory and preserve

- [ ] **Step 1: Pre-checks.** Every one must pass, or stop:
  - BLZ-729 is `done`, and Task 22 Step 6's remote body and AC write is recorded (OD-B1, §5 step 9 gate);
  - F2 has soaked: its merge was at least 1 day ago, and Task 17's gates passed (spec §12 item 5);
  - `readlink ~/.local/bin/blaze` names no `blaze-pm` (Finding 3);
  - `kubectl … get pod -l app.kubernetes.io/name=blaze -o yaml | grep -c hostPath` → `0`;
  - `ls $BP/.blaze/pending $V4/.blaze/pending 2>/dev/null | wc -l` → `0` (D9 step 4).
- [ ] **Step 2: Make the inventory** (read-only), written to `$ARCH/manifest.md` after `mkdir -p -m 0700 $ARCH`:
  - `git -C $BP worktree list --porcelain`;
  - per worktree, `git -C <wt> status --porcelain=v1 --untracked-files=all`;
  - `git -C $BP for-each-ref --format='%(refname) %(objectname:short) %(upstream:short) %(upstream:track)'` (keeps the ~31 `[gone]` upstreams; R13);
  - `git -C $BP stash list --format='%gd %H %gs'`;
  - `git -C $BP config --get core.hooksPath`;
  - `git -C $BP remote -v`;
  - `git -C $BP rev-list --all --count`.

  Expected (recon, 2026-10-27): 9 worktrees; 105 local branches; 2 stashes; dirty main checkout (3 paths + `.worktrees/`) and `board-main` (4 paths); detached `oba-followup` (`ac9e66d3`) and `sw-ui-refresh` (`a6a3003d`); hooksPath `$BP/.githooks`. Any extra state is added to the preserve list, not skipped.
- [ ] **Step 3: GATE (operator go-ahead): preserve.** For each dirty worktree, `git -C <wt> switch -c final-wip/<branch>`. Then `git -C <wt> add -- <each listed path>` (explicit pathspecs; **never** `.worktrees/`, which holds the nested worktrees), and `git -C <wt> commit -m "BLZ-721: final-wip — preserve the uncommitted state of <branch> before the archive"` with the trailer. For each detached HEAD, `git -C <wt> branch final-wip/detached-<wt-name> HEAD`. If `.githooks/pre-commit` refuses a commit, **stop and report**. Never `--no-verify` without the operator's word. A `git diff` export of that tree goes to `$ARCH/<wt>.diff` either way.

### Task 28: Stash refs, the tombstone commit, and the G-data probe

- [ ] **Step 1: Stashes** (Finding 4). For n in 0 and 1:
  - `git -C $BP branch final-wip/stash-$n "stash@{$n}"`;
  - `git -C $BP stash show -p --include-untracked "stash@{$n}" > $ARCH/stash-$n.patch`;
  - `git -C $BP rev-parse final-wip/stash-$n` equals the manifest's hash.
- [ ] **Step 2: The tombstone commit** (D8 rows marked delete or tombstone, D5 G-data) **in `$V4`** on `BLZ-305-v4-spine`:
  - `git rm -r --quiet projects sprints.json .github/workflows/board-integrity.yml .githooks package.json package-lock.json .claude/commands .claude/skills`;
  - `blaze.config.json` becomes `{ "projects": [], "database": { "driver": "postgres" } }` plus only what `loadConfig` needs to load (check with the current engine: `node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs audit` in a scratch copy either loads it or refuses, and both are acceptable per D8);
  - `README.md` becomes D8's tombstone text, with today's date;
  - `AGENTS.md` becomes a three-line tombstone that points at the engine's `AGENTS.md` and the `blaze-live-board` skill. The grooming rules stay in history.
  - Commit `BLZ-721: archive tombstone — the board lives in Postgres (blaze.howman.link); config in service-platform deploy/apps/blaze; this repo is read-only`, plus the trailer. The pre-commit hook runs from `$BP/.githooks` (hooksPath). That is why this happens before any checkout is removed.
- [ ] **Step 3: The G-data probe** (§9). `git clone --quiet $BP <scratchpad>/tombstone-probe && git -C <scratchpad>/tombstone-probe checkout BLZ-305-v4-spine`. The directory name avoids `blaze-pm`, so the G0 hook judges by origin, and the origin is a local path. Then, from inside it, with `BLAZE_REMOTE_URL` unset:
  - `npx --yes @hjr15/blaze-board@0.8.0 new --project BLZ --type task x --estimate 5` → non-zero ("unknown project" or a config refusal);
  - `npx --yes @hjr15/blaze-board@0.8.0 move BLZ-1 done` → non-zero;
  - the current engine, `node /home/rnamwoh/Documents/Code/blaze/scripts/cli.mjs new …` → non-zero (G-engine refusal).

  **Pass:** all three are non-zero and no file appears (`git status --short` is empty). If 0.8.0 cannot be fetched, record that and rely on the other two.

### Task 29: Bundle, verify, operator push and archive, `.blaze/`, remove checkouts

- [ ] **Step 1: Bundle** (Finding 5): `git -C $BP bundle create $ARCH/blaze-pm-final-$(date +%F).bundle --all && git bundle verify $ARCH/blaze-pm-final-*.bundle`.
- [ ] **Step 2: Verify the bundle by clone.**
  - `git clone --mirror $ARCH/blaze-pm-final-*.bundle <scratchpad>/bundle-check`.
  - **Pass:**
    - `git -C <scratchpad>/bundle-check rev-list --all --count` equals `git -C $BP rev-list --all --count`;
    - `git bundle list-heads $ARCH/*.bundle | wc -l` equals `git -C $BP for-each-ref | wc -l`. `refs/stash` is counted once on both sides;
    - every `final-wip/*` ref is present;
    - `git -C <scratchpad>/bundle-check rev-parse BLZ-305-v4-spine` equals the tombstone commit.
  - Record all of it in the manifest.
- [ ] **Step 3: GATE (operator go-ahead): the operator pushes and archives** (OD-B2). Claude prints these exact commands, and **the operator** runs them:
  ```bash
  git -C /home/rnamwoh/Documents/Code/blaze-pm-worktrees/v4-spine push origin BLZ-305-v4-spine
  git -C /home/rnamwoh/Documents/Code/blaze-pm push origin INF-748-config-json-projects-drift board/ddl-integrity-class oba-s2-day1-work
  gh repo edit hjr15/blaze-pm --default-branch BLZ-305-v4-spine
  gh repo archive hjr15/blaze-pm --yes
  ```
  None of them forces. The first push is a fast-forward of 80 commits (79 unpushed plus the tombstone). **Claude** then checks `gh repo view hjr15/blaze-pm --json isArchived,defaultBranchRef` → `true`, `BLZ-305-v4-spine`, and that `git ls-remote origin BLZ-305-v4-spine` equals the tombstone SHA.
- [ ] **Step 4: `.blaze/` disposition** (D9 step 4):
  - `cp -a $BP/.blaze/pending-drained-* $ARCH/`;
  - `install -m 600 $BP/.blaze/identity.db $ARCH/identity.db`, a copy kept 14 days and deleted in Task 31. Claude copies the file and never opens it;
  - **The operator** moves `$BP/.blaze/admin-api-token.txt` into Vaultwarden, or revokes the token it names. **Claude never opens it.**
  - Check `ls -la $ARCH` (modes) and `stat -c %a $ARCH` → `700`.
- [ ] **Step 5: GATE (operator go-ahead, irreversible): remove the checkouts** (D9 step 5).
  - For each of the 8 linked worktrees from the manifest, run `git -C $BP worktree remove --force <path>`. `--force` is safe only because Tasks 27–28 preserved every dirty tree, and the bundle verified.
  - Then `rm -rf $BP /home/rnamwoh/Documents/Code/blaze-pm-worktrees /home/rnamwoh/Documents/Code/.worktrees/blaze-pm-taxcode /home/rnamwoh/Documents/Code/blaze-pm-queue-snapshot-20260831-190249`. `activity.jsonl` goes with them (D10).
  - The k3d node still binds the old `/host-blaze-*` paths until `make k8s-reset`. After F2 nothing mounts them, which is harmless (§6).
  - **Pass:** `ls -d` of each path fails. The second machine has no clone (OD4).
- [ ] **Step 6: Bookkeeping:** the manifest summary (no credentials) goes into BLZ-721's body. BLZ-721 stays `in-progress` until Task 30 merges.

### Task 30: G-final — remove the interim write guard (BLZ-721, R9)

**Setup:** `cd /home/rnamwoh/Documents/Code/claude-config && git fetch origin && git worktree add /home/rnamwoh/Documents/Code/claude-config-worktrees/BLZ-721-g-final-remove-write-guard -b BLZ-721-g-final-remove-write-guard origin/main`.

**Files:**
- Delete `hooks/blaze-pm-write-guard.sh` and `scripts/test_blaze_pm_write_guard.py`.
- Delete its `global/settings.json:98` entry, CI line `:39`, and `docs/architecture.md:27`.
- Add a `docs/changelog.md` entry: "BLZ-721: the interim blaze-pm write guard is removed — blaze-pm is archived".

- [ ] **Step 1: Run the regression check first.** `python3 scripts/test_hook_path_binding.py` passes before the change. After deleting only the hook file, it fails on the dangling `settings.json` entry, which proves the binding test sees it. Then remove the entry → it passes.
- [ ] **Step 2: Run** every unit suite, the export dry-run and the context budget → green. `rg -n blaze-pm-write-guard` → only changelog lines.
- [ ] **Step 3: Commit, push, PR** `BLZ-703: G-final — remove the interim blaze-pm write guard`, and merge when CI is green.
- [ ] **Step 4: Deploy:** `cd /home/rnamwoh/Documents/Code/claude-config && git pull --ff-only && bash scripts/install.sh && bash scripts/install.sh --check`. Then `ls ~/.claude/hooks/blaze-pm-write-guard.sh` → absent (step 5b prunes it).
- [ ] **Step 5: Bookkeeping:** log BLZ-721 and move it to `done`. BLZ-703 stays open until Task 31.

### Task 31: Step 10 — day 14 (BLZ-702)

- [ ] **Step 1: GATE (operator go-ahead): 14 days after Task 29.** `rm -f ~/cluster-data/archive/blaze-pm-final-*/identity.db`, then `ls` confirms it is gone. The bundle, manifest and patches stay (A4).
- [ ] **Step 2: GATE (operator go-ahead): BLZ-702 removes the 8 smoke users.** **The operator** follows BLZ-702's procedure (Finding 8; operator question 2). **Claude** verifies with counts only: `pg-psql -d blaze -tAc "SELECT count(*) FROM app_user"` falls by 8, and the operator's own sign-in still works.
- [ ] **Step 3: Close out.**
  - Log BLZ-702 and move it to `done`.
  - Check every BLZ-703 child is terminal: `blaze-live list --project BLZ --json | jq -r '.[] | select(.frontmatter.parent=="BLZ-703") | "\(.id) \(.status)"'`. Then log BLZ-703 and move it to `done`.
  - Promote-then-retire this plan and the spec (skill `promote-then-retire-spec`) in a follow-up engine PR. It is not part of this plan.

---

## Self-review (2026-10-28, against the spec, `decisions.md` and the recon)

1. **Spec coverage.**

   | Item | Task |
   |---|---|
   | §5 step 1 (F1 + gate) | 6, 7 |
   | §5 step 2 / §8 (six rows; R2 delta) | 8, 9 |
   | §5 steps 3–6 rehearsed | 10 |
   | §5 steps 3–5 | 11 |
   | §5 step 6 (watch, backup contents, dir mode per OD-B4) | 11 Step 2, 12 |
   | §5 step 7 (F2) | 13–17 |
   | §5 step 8 (E2 done; G; H; the `rg` gate; fresh-session probe) | 18–26 |
   | §5 step 9 (archive, gated on BLZ-729) | 27–29; hook removal in 30 (R9) |
   | §5 step 10 | 31 |
   | §6, every row (recon extras per R9) | 6, 13–16, 18–25 |
   | §7 E3 (OD-B5) | 1–5 |
   | D4 (values, `codeRepos`, `loops.reconcile`, emptyDir) | 6, 13 |
   | D5 G-data | 28 |
   | D6 (wording, explicit moves) | 19, 20 |
   | D7 (wrapper, token, skill, operator rewrite) | 18–22 |
   | D8 (row by row: moves in 23 and 25, archive and tombstone in 28; ADR tickets in 26) | 23, 25, 26, 28 |
   | D9 (R13; OD-B2) | 27–29 |
   | D10 (claude-config half) | 21 |
   | §10 rows 9–19, 22, 23 | 6, 13–14, 9, 10–12, 18–19, 20–21, 23–24, 25, 27–30, 26, 21, 1–4 |
   | R1–R14 | R1: 4, 14. R2: 9. R3: 14 (Finding 1). R4, R5: Global Constraints. R6: 6. R7: 14, 17. R8: 15, 17. R9: 20–22, 30. R10: G setup. R11: 18. R12: 23, 25. R13: 27–29. R14: the cutover rollback table and 10 Step 6. |
   | OD-B1..B5 | 27 Step 1; 29 Step 3; 25, 24; 11, 16; 1–3 |

2. **Step scan.** Every message a test pins is given verbatim. Bodies appear only where a test does not determine them: `audit.sh`'s exit table, the decision rules for the R2 delta, and the archive's order. A "grep first" step names what to grep and what decides the edit.
3. **Type consistency.**
   - `bodyOrErrors`, `acItemsOrErrors`, `withAcSection`, `withAcAppended` and `acItemCount`: Tasks 1, 2 and 3.
   - `applyBody` and `applyAcAdd`: Task 2, consumed by 3.
   - `bodyBytes` and `acItems` in every answer: 1, 2 and 3.
   - `ticketCount` and `"empty-read"`: Task 4, consumed by 14's script and 17's probe.
   - `boardConfig` and `projectFiles`: 6, consumed by 13 and 14's mount helper.
   - `BLAZE-AUDIT-RESULT outcome=…`: 14, consumed by 16's runbook and 17.
   - `pod-blaze`, `pg-psql` and `RH`: defined once, used throughout.
4. **Review Focus.** Each of the five lines names its pinning test or gate and its owning task.
5. **Proportion.** 1,146 lines for 31 tasks, of which 17 carry a test cycle (1–4, 6, 13–16, 18–21, 23–25, 30). Code blocks are commands, one shell script whose exit table is the test, and the values block. Bodies are left to the implementer.

## Operator questions (open at writing)

1. **Matrices in the CronJob** (Finding 1, R3). Accept a render proof (`matrices --out`, NCA included) in place of `--check`? There is no committed copy left to check against. *Provisional ruling: yes.*
2. **BLZ-702's mechanism** (Finding 8). The engine has no remove verb. Is it an operator-run SQL `DELETE` across the six identity tables, or a new engine verb filed separately? *Provisional ruling: operator SQL per BLZ-702's body.*
3. **Your uncommitted `feature-pr-bundling` edit** (Finding 18). G rewrites the same section for explicit moves on the live board. Commit it first (G then merges over it), or discard it? G's deploy waits on this.
