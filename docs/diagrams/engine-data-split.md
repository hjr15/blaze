---
title: Engine ⟂ data split
type: architecture
format: mermaid
---

## Caption

Blaze ships as two independent halves. The **engine** is the published package
`@hjr15/blaze-board` — the `blaze` CLI, the web board, and the pure model; it
holds no tickets. The **data repo** is any directory with its own git history
holding `blaze.config.json`, a `projects/<KEY>/<status>/` tree, and the derived
`.blaze/` caches. One global engine install can drive any number of unrelated
data repos. At startup every entry point resolves which data repo to attach to
via the same three-rung `resolveRoots` ladder, so the engine's install location
and the data's location are fully decoupled.

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

## Worked example

Install the engine once (`npm i -g @hjr15/blaze-board`), then attach it to a data
repo two ways:

- **Run from inside the data repo** — `cd my-tracker && blaze board` matches rung 2
  (`./projects`).
- **Point at it from anywhere** — `BLAZE_PROJECTS_DIR=/path/to/my-tracker/projects
  blaze board` matches rung 1.

Upgrading the engine (`npm update -g`) never touches any board's ticket history;
each data repo keeps its own git log. Rung 3 exists only for the historical
single-tree layout and deliberately throws rather than silently treating an
installed `node_modules/` engine directory as a data root.
