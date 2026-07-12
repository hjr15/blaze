---
title: Engine architecture
type: architecture
format: mermaid
---

## Caption

The Blaze engine at runtime. One `blaze` command is the entry point: CLI verbs
dispatch to thin `*-runner.mjs` wrappers around pure cores in `scripts/model/`,
`blaze start` boots the supervisor (web board + the reconcile and groomer loops),
and `blaze board` serves the read/write web board on its own. Every component
reads and writes the same markdown ticket files under `projects/<KEY>/<status>/`;
the derived `.blaze/` caches are disposable, while the pending queues hold
queued-but-uncommitted batch ops (session-keyed since v0.4.0) and the advisory
`commit.lock/` serializes git writes. Git is the history and the bus. The board
is a rendering over the files, never a second source of truth.

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
        M1["schema · workflows · rules<br/>move-plan · ticket"]
        M2["index · rollup · time · ids<br/>activity · transitions · search · filters · metrics"]
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
    Groom -. edits ticket .md .-> Files
```

## Worked example

- **`blaze move ENG-12 in-review`** → `move-runner.mjs` calls the pure `move-plan`
  core (validates the transition against the ticket type's workflow), writes the
  file to the new status directory, and — in `per-op` mode — commits just that
  file; in `batch` mode it queues the op to `.blaze/pending-commit.jsonl` for a
  later `blaze commit`.
- **Dragging a card in the web board** POSTs `/api/move`; `serve.mjs` runs the same
  `move-plan` core, so the CLI and the board can never disagree on what a legal
  move is. A rejected move returns a 422 and the card snaps back — the server is
  the source of truth, the DOM is never moved optimistically.
- **`reconcile`** reads the mirrored code repos' branch/PR state through `git`/`gh`
  and moves only delivery-workflow tickets that carry a matching `<KEY>-<n>` branch;
  goals and risks are always manual.
