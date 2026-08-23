# Architecture

The current as-built shape of the Blaze **engine**. For the original design
rationale (why file-based, why the loops, the brand) see [`design.md`](design.md);
for customising the type/workflow registry see
[`schema-customization.md`](schema-customization.md); for the config-schema
compat guard see [`schema-versioning.md`](schema-versioning.md). Diagrams are
authored once in [`diagrams/`](diagrams/) and embedded below.

## The one rule

A ticket is a markdown file, and **its status is the directory it sits in** —
`projects/<KEY>/<status>/<id>-slug.md`. There is no `status:` field, so status
cannot drift out of sync with reality, and `git log --follow` on a ticket file is
its full audit trail. Everything else is built to preserve that: the derived
`.blaze/` caches are disposable, the web board is a rendering, and every mutation
goes through git.

## Runtime components

One `blaze` command is the entry point. CLI verbs dispatch through thin
`scripts/*-runner.mjs` wrappers to pure cores in `scripts/model/`; `blaze start`
boots the supervisor (web board + reconcile and groomer loops); `blaze board`
serves the read/write web board alone.

<!-- DIAGRAM:BEGIN docs/diagrams/architecture.md -->
```mermaid
flowchart TB
    CLI["blaze CLI (scripts/cli.mjs)"]

    subgraph Runners["CLI verbs → *-runner.mjs"]
        direction LR
        R1["new · move · edit<br/>resolve · log"]
        R2["commit · rollup<br/>reindex · migrate"]
    end

    subgraph Sup["blaze start → supervisor.mjs"]
        direction TB
        Rec["reconcile loop<br/>(deterministic: git/PR → status)"]
        Groom["groomer loop<br/>(agentic: spawns agentCommand)"]
    end

    subgraph Board["blaze board → serve.mjs (web board)"]
        direction TB
        Views["views/: page (switcher)<br/>board · list · live · metrics · map · panel"]
        API["GET /api/{hash,sync,live,panel,reconcile-preview}<br/>POST /api/{move,edit,resolve,log,ac}"]
    end

    subgraph Model["scripts/model/ — one rules home"]
        direction LR
        M1["schema · workflows · rules<br/>move-plan · ticket · taxonomy"]
        M2["index · rollup · time · ids<br/>activity · transitions · search · filters · metrics · links"]
    end

    subgraph Data["Data repo (own git history)"]
        direction TB
        Files["projects/&lt;KEY&gt;/&lt;status&gt;/&lt;id&gt;-slug.md<br/>(source of truth)"]
        Caches[".blaze/ — index.json · transitions.json<br/>activity.jsonl (derived, disposable)<br/>pending/&lt;session&gt;.jsonl + fallback queue<br/>commit.lock/ (write coordination)"]
    end

    CLI --> Runners
    CLI --> Sup
    CLI --> Board
    Sup --> Board

    Runners --> Model
    Rec --> Model
    Board --> Model
    Model --> Files
    Model --> Caches
    Rec -. reads branches/PRs .-> Ext["mirrored code repos (git + gh)"]
    Groom -. edits ticket files .-> Files
```
<!-- DIAGRAM:END -->

- **CLI + runners** — `cli.mjs` maps each verb (`new`, `move`, `edit`, `resolve`,
  `log`, `commit`, `rollup`, `reindex`, `migrate`, `reconcile`, `groom`) to a
  `*-runner.mjs` that wraps a pure `apply*`/model core and then commits via
  `commit-or-queue.mjs` (per-op commit, or a queued entry in `batch` mode —
  session-keyed to `.blaze/pending/<session>.jsonl` since v0.4.0, where
  `<session>` is `BLAZE_SESSION` if set, else auto-derived from the agent
  harness's own session id, else the shared legacy fallback when neither is
  present — so `blaze commit` flushes only the caller's queue, refusing the
  fallback without `--shared`, and `--all` sweeps them all unconditionally).
  Both git-write surfaces serialize on the advisory `commit-lock.mjs`
  (`.blaze/commit.lock/`, stale locks auto-stolen) — see AGENTS.md
  "Sessions (parallel agents on one board)".
  `cli.mjs`'s `SUBCOMMANDS` table is the single dispatch point (no separate
  switch) and the only place a verb's `mutates` classification lives:
  `BLAZE_READONLY=1` (AGENTS.md "Read-only mode") makes it refuse to spawn any
  mutating runner, gated here rather than inside `commit-or-queue.mjs` — every
  mutating verb writes/renames the ticket file before it ever reaches a commit
  decision, so declining only the commit would leave a relocated-but-uncommitted
  file in a shared tree. `commit-or-queue.mjs`, `pending-ledger.mjs`, and
  `serve.mjs`'s `/api/*` handlers carry the same check as defence-in-depth for
  callers that reach them by some path other than `cli.mjs` dispatch.
- **Model (`scripts/model/`)** — the single home for all rules: `schema`,
  `workflows`, `rules`, `move-plan`, `ticket`, `taxonomy` (validation +
  transitions); `index`, `rollup`, `time`, `ids`, `activity`, `transitions`,
  `search`, `filters`, `metrics`, `links` (derived views over the files). The
  CLI, the board, and the loops all call these — no rule is ever duplicated in a
  consumer. Two of these are the metadata-gate additions: `taxonomy` runs at
  `new`/`edit` write time, rejecting a `labels`/`components` value the project
  hasn't declared (empty/undeclared taxonomy opts out); `links` runs at
  `reindex`/index-build time, warning (never failing) on a malformed `to:` key,
  an unknown link type, or a dangling target.
- **Web board (`scripts/serve.mjs` + `scripts/views/`)** — `views/page.mjs` is the
  switcher shell composing the Board / List / Live / Metrics / Map views and the
  detail panel, each a `{ render, styles, clientScript }` module over the served
  model. `serve.mjs` is routing plus the `/api/*` handlers.
- **Supervisor + loops (`scripts/supervisor.mjs`, `scripts/loops/`)** — the
  deterministic `reconcile` loop (git/PR state → status) and the agentic `groomer`
  loop (spawns the configured `agentCommand` to triage a backlog ticket). All loop
  effects go through git on the data repo.

## HTTP surface

The board serves a small JSON API. **Every `/api/*` request `blaze board` serves passes
through `model/serve-auth.mjs`'s `gate()`**, which classifies the route and decides it;
an `/api/*` route with no classification is a `404`, so an endpoint added without a
scope fails closed rather than inheriting the previous one's. Board content — `GET /`
and `GET /view/<name>` — is gated at `read`, because the page is rendered server-side
and carries every ticket.

> **Scope of that claim.** It covers `serve.mjs`, the board server. `blaze start`
> (`supervisor.mjs`) runs a **second, separate HTTP server** on `127.0.0.1` that imports
> neither `gate` nor `checkBindSafety`, and its `/control/*` routes — including
> `/control/revert`, which shells out to `git revert` — take no token and no CSRF
> header. That is pre-existing and loopback-only, not introduced or fixed here; it is
> tracked separately.

**Who may call it depends on whether the board has any identities** (ADR-0013):

| Identities | Bind address | Behaviour |
|---|---|---|
| none | loopback (`127.0.0.1`, `::1`, `localhost`) | Served without authentication, exactly as Blaze always has — the bind address *is* the boundary |
| none | anything else | **`blaze board` refuses to start**, naming both fixes. `checkBindSafety` is called before `.listen()`, so nothing is ever served. This is the behaviour *until a first-run setup flow exists*, not a permanent design choice |
| one or more | any | Every `/api/*` call needs `Authorization: Bearer blz_…`; the token's scopes are re-intersected with its owner's current role on every request |

Create the first identity — which turns authentication on — with
[`blaze user add`](guide/commands.md#user).

The `x-blaze-csrf` header is **not** authentication and never was: it is a
per-process `randomUUID()` embedded in the served HTML, readable by anyone who can
`GET /`. It is forgery protection for the browser flow, retained as defence-in-depth
alongside the gate, and removed with the last cookie (ADR-0013 §7).

Scopes are `read` ⊂ `write` ⊂ `admin` by role: **viewer** = `read`, **member** =
`read, write`, **admin** = `read, write, admin`.

| Method | Route | Scope | Purpose |
|---|---|---|---|
| GET | `/` | `read` | The board page (`views/page.mjs`) — rendered server-side, so it carries every ticket and the CSRF token |
| GET | `/view/<name>` | `read` | JSON fragment (`{ view, html, chipbar, crumbs, total, subline }`) for a client-side view swap; 404 for an unknown or config-disabled view (`views.<name>: false`, see [AGENTS.md — Configuration](../AGENTS.md#configuration)) |
| GET | `/api/hash` | `read` | Cheap content hash — the client reloads only when tickets change |
| GET | `/api/sync` | `read` | Unsynced-commit count for the `⇧ N ahead` badge |
| GET | `/api/live` | `read` | Live agent-activity feed (`model/activity.mjs`) |
| GET | `/api/panel?id=` | `read` | Detail-panel HTML for one ticket |
| GET | `/api/reconcile-preview` | `read` | Dry-run of the code-bound moves reconcile would make |
| GET | `/api/matrix` · `/api/coverage` | `read` | v4 traceability matrix and coverage (BLZ-323) |
| POST | `/api/move` · `/api/edit` · `/api/resolve` · `/api/log` · `/api/ac` | `write` | Mutations — each validates through the model core, writes one file, commits it locally (never `git add -A`, never auto-push) |
| POST | `/api/artifact` · `/api/link` · `/api/baseline` | `write` | v4 artifact model mutations (BLZ-323) |
| POST | `/api/field` | `admin` | Defining a filterable field emits `ALTER TABLE` and spends the install-wide field budget ADR-0018 shares across every project — an administrative act, not an ordinary write |
| *anything else under* `/api/` | — | **`404 unknown endpoint`** — unclassified is denied |

`ROUTE_SCOPES` in `scripts/model/serve-auth.mjs` is the single source of the `/api/*`
rows; `pageScopeFor()` beside it owns the two content rows. An `/api/*` route absent
from `ROUTE_SCOPES` cannot be called through `serve.mjs` at all. An unknown *page* path
is still a plain `404` rather than an auth decision — the page router is not a fixed
table, and turning every typo into a `401` would both change long-standing behaviour and
leak whether a path exists.

**A browser cannot set an `Authorization` header itself.** Once a board has users, its
content is reachable from the API, from `curl`, or through a reverse proxy that adds the
header — not from a bare browser tab. That is a known gap, not a finished story: the
board was already unusable in a browser at that point (the page rendered while every XHR
returned `401`), and gating `/` makes the failure honest instead of leaky. A first-run
sign-in flow is tracked separately and will replace this.

## Engine ⟂ data split

The engine is published as `@hjr15/blaze-board` and holds no tickets; the data
lives in a separate repo with its own git history. One engine install drives any
number of data repos, attaching via the `resolveRoots` ladder.

<!-- DIAGRAM:BEGIN docs/diagrams/engine-data-split.md -->
```mermaid
flowchart TB
    subgraph Engine["Engine — npm @hjr15/blaze-board (public)"]
        direction TB
        Bin["blaze CLI · supervisor · serve"]
        Model["scripts/model/ + scripts/views/"]
        Note["no tickets, no config — pure engine"]
    end

    subgraph Resolve["resolveRoots ladder (config.mjs) — first match wins"]
        direction TB
        L1["1 · BLAZE_PROJECTS_DIR env<br/>explicit projects/ dir; dataRoot = its parent"]
        L2["2 · ./projects under CWD<br/>run from inside the data repo"]
        L3["3 · engine tree itself<br/>single-tree back-compat only;<br/>refuses when installed under node_modules"]
        L1 --> L2 --> L3
    end

    subgraph DataA["Data repo A (own git)"]
        DA["blaze.config.json · projects/ · .blaze/"]
    end
    subgraph DataB["Data repo B (own git)"]
        DB["blaze.config.json · projects/ · .blaze/"]
    end

    Engine --> Resolve
    Resolve -->|dataRoot / projectsDir| DataA
    Resolve -->|dataRoot / projectsDir| DataB
```
<!-- DIAGRAM:END -->

## The type registry

Types, their hierarchy, parent rules, and required fields are defined once in
`model/schema.mjs` and overridable per data repo through a `schema` block.

<!-- DIAGRAM:BEGIN docs/diagrams/type-hierarchy.md -->
```mermaid
flowchart TD
    goal["goal · level 4<br/>workflow: goal<br/>requires: title, description"]
    requirement["requirement · level 3<br/>workflow: requirement<br/>requires: title, description"]
    architecture["architecture · level 2<br/>workflow: architecture<br/>requires: title, description"]
    feature["feature · level 1<br/>workflow: delivery<br/>requires: title, description"]
    risk["risk · level 1<br/>workflow: risk<br/>requires: title, description,<br/>likelihood, impact"]
    story["story · level 0<br/>workflow: delivery<br/>requires: title, description, estimate"]
    task["task · level 0<br/>workflow: delivery<br/>requires: title, description, estimate"]
    bug["bug · level 0<br/>workflow: delivery<br/>requires: title, description, estimate"]
    subtask["subtask · level -1<br/>workflow: delivery<br/>requires: title, description"]

    goal --> requirement
    goal --> architecture
    goal --> feature
    goal --> risk
    requirement --> architecture
    requirement --> feature
    requirement --> story
    requirement --> risk
    architecture --> feature
    architecture --> risk
    feature --> story
    feature --> task
    feature --> bug
    feature --> risk
    story --> task
    story --> bug
    story --> subtask
    task --> subtask
    bug --> subtask
```
<!-- DIAGRAM:END -->

## Workflows

Each type is bound to one of three workflows. Transitions are enforced (adjacent
edge or reopen only); entering a terminal status auto-sets `resolution` on a
separate axis.

<!-- DIAGRAM:BEGIN docs/diagrams/workflow-state-machines.md -->
```mermaid
stateDiagram-v2
    state "delivery — feature / story / task / bug / subtask" as delivery {
        [*] --> defined
        defined --> in_progress: in-progress
        in_progress --> in_review: in-review
        in_review --> done: done → resolution done
        done --> defined: reopen
    }

    state "goal" as goal {
        [*] --> g_defined
        g_defined --> g_in_progress: in-progress
        g_in_progress --> achieved: achieved → resolution done
        achieved --> g_defined: reopen
    }

    state "risk" as risk {
        [*] --> identified
        identified --> mitigated: done
        identified --> accepted: done
        identified --> obsolete: wont-do
        mitigated --> identified: reopen
        accepted --> identified: reopen
        obsolete --> identified: reopen
    }
```
<!-- DIAGRAM:END -->
