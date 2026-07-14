# Diagrams

Canonical home for every diagram in this repo. Each file holds exactly one diagram
with frontmatter declaring its `title`, `type`, and `format`.

| File | Type | Shows |
|---|---|---|
| [architecture.md](architecture.md) | architecture | The engine at runtime — CLI, supervisor + loops, web board, model, data/git |
| [engine-data-split.md](engine-data-split.md) | architecture | Published engine ⟂ data repo, and the `resolveRoots` attachment ladder |
| [type-hierarchy.md](type-hierarchy.md) | data-model | The built-in ticket type registry and its parent rules |
| [workflow-state-machines.md](workflow-state-machines.md) | state-machine | The three workflows (delivery / goal / risk) as state machines |

## Embedding elsewhere

To render a diagram inline in `README.md`, `AGENTS.md`, or another doc, wrap a
synced copy in marker comments:

````markdown
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
    Groom -. edits ticket .md .-> Files
```
<!-- DIAGRAM:END -->
````

Humans edit only the canonical file under `docs/diagrams/`. Run
`python scripts/embed_diagrams.py` to sync every embed (or `--check` to verify they
are in sync in CI). Mermaid blocks are rendered by GitHub and adapt to the reader's
light or dark theme automatically.
