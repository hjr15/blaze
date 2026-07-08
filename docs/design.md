# Blaze — design

**Date:** 2026-06-27
**Status:** approved (brainstorm), pre-implementation

## One-liner

Blaze is a local **app** for a file-based, git-native issue board — and its backend
is agent loops that act on the board through git. Tickets are markdown files; a
ticket's status is the folder it sits in. You launch `blaze`, a browser tab opens
onto the board, and behind it a supervisor runs two loops: a deterministic
**reconcile** loop that mirrors a code repo's git/PR state onto the board, and an
agentic **groomer** loop that drives a coding agent (`claude -p` by default) to
triage, label, dedupe, and flesh out tickets — committing every change as a small,
revertable git commit. No database, no login, no API keys inside Blaze.

It is a clean, generalized extraction of the private `carelia-tracker` tool, with an
app shell and the groomer loop added. `carelia-tracker` stays exactly as it is and
is not touched by this work.

## Why it exists / the agent angle

The board is already the ideal substrate for AI coding agents: plain text and git,
so an agent reads, writes, and moves tickets with the file tools it already has — no
API client, no auth, no SDK. Blaze leans all the way into that: the *backend itself*
is agent loops whose only way of affecting the world is git. The groomer doesn't call
a hosted service; it shells out to whatever coding agent you already run, exactly as
the reconcile engine shells out to `git` and `gh`.

## Goals

- A generic, publishable OSS app (MIT) anyone can clone and run as either a
  standalone markdown kanban or a live mirror of their own code repo.
- Everything Carelia-specific (the `DEV` key, the `carelia-web` sibling path, the
  NDIS/shifts label taxonomy) becomes configuration.
- Preserve the original's character: **zero runtime dependencies**, Node built-ins
  only, "the directory is the status" as the single rule. The groomer adds no
  dependency — it spawns an external agent CLI the same way reconcile spawns git/gh.
- A launch-it-like-an-app experience: one command, a live board, agent activity you
  can watch and control.

## Non-goals (YAGNI)

- **No code-writing worker loops.** The loops keep the *board*; they never cut
  branches or write code in the mirrored repo. (This was an explicit fork in the
  brainstorm — autonomous implementers are deferred.)
- No embedded Anthropic SDK and no API key handling inside Blaze — the agent CLI owns
  auth. (A provider seam is possible later; not built now.)
- No MCP server; no second git provider (GitHub via `gh` only, with a clean
  `provider` seam); no database; no login.
- No migration of `carelia-tracker` onto Blaze, and no changes to `carelia-web`.
  carelia-web appears only as the README's worked example.

## Relationship to carelia-tracker (decided: clean extraction)

```
blaze/ (public, generic, app + loops)     carelia-tracker/ (private, unchanged)
   key configurable                            DEV hardcoded
   codeRepo configurable          │            mirrors carelia-web as today
   supervisor + groomer + web app │            scripts only, no groomer
   published to GitHub            │            you keep using it as-is
        └────── no link, they diverge ──────────┘
```

Blaze is built fresh from the *shape* of carelia-tracker (its scripts and docs are
the reference), not by mutating it in place. No private ticket history enters the
public repo.

## Architecture

```
  $ blaze                                  one command
     │
     ▼
  supervisor (scripts/supervisor.mjs, node, zero-dep)
     │
     ├── serves the web app ──────────►  http://localhost:4321
     │      board columns + live agent-activity feed (SSE)
     │      controls: ▶ reconcile  ▶ groomer  ⏸ stop  ↩ revert
     │
     └── runs the loops ───────────────┐
                                        │
            ┌───────────────────────────┴───────────────────┐
            ▼                                                ▼
     reconcile loop (deterministic)              groomer loop (agentic)
       git/PR state → board columns                spawn: claude -p "<prompt>"
       fills branch:/pr: frontmatter               (cwd = board repo)
       self-disables in standalone mode            → agent edits ticket .md files
            │                                       → supervisor commits chore(groom):
            └──────────── all effects go through GIT (the board repo) ─────────────┘
                          (moves · edits · commits)   + reconcile READS the code repo
```

- The **supervisor** is a plain orchestrator (not itself an agent): it owns the loop
  lifecycle, the SSE event bus, and a tiny local control API the web app calls.
- **reconcile** is the original engine, generalized — a deterministic loop, not an
  agent.
- **groomer** is the agentic loop: it builds a prompt, spawns the configured agent
  command against the board repo, lets the agent edit ticket files, then commits the
  diff. Every grooming change is one small `chore(groom):` commit.
- The board repo is the shared blackboard; git is the bus. The only thing Blaze
  *reads* from outside the board repo is the mirrored code repo's git/PR state.

## Two modes (unchanged generalization)

1. **Standalone board** (`codeRepo: null`, default) — a personal/team markdown
   kanban. Reconcile is a clean no-op; you move tickets by hand (`git mv`). The
   groomer still runs (it grooms the board regardless of any code repo).
2. **Mirror mode** (`codeRepo` set) — reconcile reads the code repo's branches + PRs
   and drives `in-progress → in-review → done` automatically, joining on the
   `<key>-<n>` in branch names. The carelia-web walkthrough is the README's example.

## The groomer loop (the new agentic part)

**Trigger:** a filesystem watch on the groomed columns (default: `backlog/`) plus a
timer (default 300s) plus a manual "run groomer now" button in the web app.

**What it does** (one ticket at a time, defined once in `AGENTS.md` so the human rules
and the agent prompt share a source):
- triage a new backlog ticket — set `type` and `priority`,
- apply labels from the configured taxonomy,
- draft acceptance criteria when missing,
- flag likely duplicates (point at the surviving id),
- link related tickets.

**How a pass runs:**
1. supervisor picks an ungroomed ticket, builds the grooming prompt (ticket body +
   the `AGENTS.md` grooming rules + the label taxonomy from config),
2. spawns `agentCommand` (default `claude -p "<prompt>"`) with `cwd` = the board repo,
3. the agent edits the ticket `.md` file(s) in place,
4. the supervisor stages just those files and commits
   `chore(groom): <id> <one-line summary>`,
5. the commit streams to the web app's activity feed with a one-click **revert**
   (`git revert` of that commit).

**Autonomy & safety:** auto-commit, review via git — the same posture reconcile
already uses for moves. Bounded by construction: the groomer only ever touches ticket
`.md` files in the board repo (never the code repo, never code), each change is its
own small revertable commit, and config scopes which columns it grooms and how often.
A `groomer.enabled: false` switch turns it off entirely.

## Configuration — `blaze.config.json`

```json
{
  "key": "TASK",
  "boardTitle": "Blaze",
  "codeRepo": null,
  "provider": "github",
  "columns": ["backlog", "todo", "in-progress", "in-review", "done", "canceled", "duplicate"],
  "terminal": ["done", "canceled", "duplicate"],
  "defaultLabels": ["frontend", "backend", "infra", "docs", "bug", "chore"],
  "port": 4321,
  "agentCommand": "claude -p",
  "loops": {
    "reconcile": { "enabled": true, "intervalSec": 60 },
    "groomer":   { "enabled": true, "intervalSec": 300, "columns": ["backlog"] }
  }
}
```

| Field | Meaning | Default |
|---|---|---|
| `key` | Ticket id prefix; `TASK-001`, branch `you/TASK-001-slug` | `"TASK"` |
| `boardTitle` | Web app heading + `<title>` | `"Blaze"` |
| `codeRepo` | Path to the repo to mirror; `null` = standalone | `null` |
| `provider` | Reconcile provider; only `github` implemented | `"github"` |
| `columns` / `terminal` | Lifecycle columns / sticky terminal columns | the seven shown |
| `defaultLabels` | Label taxonomy (docs + groomer prompt + scaffolder) | generic set |
| `port` | Web app port | `4321` |
| `agentCommand` | Command the groomer spawns (the prompt is appended) | `"claude -p"` |
| `loops` | Per-loop enable / cadence / groomed columns | shown above |

`scripts/config.mjs` loads this with defaults + env overrides (`BLAZE_CODE_REPO`,
`BLAZE_KEY`, `BLAZE_PORT`, `BLAZE_AGENT_COMMAND`), and exports the key→regex derivation
so reconcile, the scaffolder, and the groomer share one source of truth for the key.

**Historical (pre multi-project port):** the layout below reflects the original
single-board design; see `AGENTS.md` / `README.md` for the current
`projects/<KEY>/...` layout.

## Repo layout

```
blaze/
├── README.md            # generic rewrite; "why this shape" + agent pitch +
│                        #   the carelia-web mirror walkthrough as the example
├── AGENTS.md            # the universal agent loop AND the groomer's grooming rules
├── CONVENTIONS.md       # ticket shape + generic label taxonomy
├── TEMPLATE.md          # generic ticket template
├── LICENSE              # MIT
├── blaze.config.json    # the one config file
├── package.json         # bin: blaze; scripts: start / board / new / reconcile / groom
├── .claude/
│   ├── skills/          # new-ticket, reconcile, board, groom
│   └── commands/        # /blaze-new, /blaze-board, /blaze-reconcile, /blaze-groom
├── scripts/
│   ├── config.mjs       # NEW — loads blaze.config.json + env overrides
│   ├── supervisor.mjs   # NEW — boots web app + runs the loops; SSE bus; control API
│   ├── serve.mjs        # generalized + agent-activity feed + controls (web app)
│   ├── reconcile.mjs    # generalized; pure decide() extracted; usable as a loop
│   ├── new-ticket.sh    # generalized (key + padding from config)
│   └── loops/
│       └── groomer.mjs  # NEW — prompt build → spawn agentCommand → commit
├── tests/               # NEW — node:test for the pure logic (see Testing)
├── brand/               # logo assets + BRAND.md (palette, type, usage)
├── docs/
│   └── design.md        # this file
└── backlog/ todo/ in-progress/ in-review/ done/ canceled/ duplicate/
```

## Component behaviour & the generalization deltas

The three original scripts keep their logic; hardcoded values move to config. The
supervisor, the groomer, and the web-app additions are new.

### `scripts/config.mjs` (new)
Resolves repo root, reads `blaze.config.json`, applies defaults, overlays env
overrides, exports a frozen config plus the id regex
`new RegExp("\\b" + key + "-(\\d+)", "i")`.

**Data root.** The engine (this install) and the data (`blaze.config.json`,
`projects/`, `.blaze/`) may live in separate trees. `resolveRoots()` returns
`{ engineRoot, dataRoot, projectsDir }` via a ladder: `BLAZE_PROJECTS_DIR` env
(dataRoot = its parent) → `./projects` under the CWD → the engine tree itself
(single-tree back-compat). Empty env counts as unset. Every entrypoint (CLI
runners, `serve.mjs`, `supervisor.mjs`, `reconcile.mjs`, the groomer) resolves
roots once and passes `dataRoot`/`projectsDir` through rather than assuming the
engine tree.

### `scripts/reconcile.mjs`
Delta from the original:
- `WEB` → `config.codeRepo` (absolute-resolved, `BLAZE_CODE_REPO` override). If
  `null`, reconcile is a clean no-op (`"standalone board — nothing to reconcile"`).
- id matchers, `DIRS`/`TERMINAL` → driven by config.
- **Refactor:** extract the pure decision `decide(state, currentDir, config) →
  { target, branchVal, prVal, moved }`; this is what the tests exercise. The
  file-moving/committing shell wraps it, behaviour unchanged.
- GitHub via `gh` retained; the PR-gathering step is the future `provider` seam.
- Exposed both as a CLI (today's flags) and as a callable the supervisor runs on a
  timer, emitting each move to the SSE bus.

### `scripts/loops/groomer.mjs` (new)
Selects an ungroomed ticket in the configured columns, builds the prompt, spawns
`config.agentCommand` (cwd = board repo) via `child_process`, waits, stages the
touched ticket files, commits `chore(groom): <id> <summary>`, emits the commit to the
SSE bus. Pure, testable helpers: prompt assembly, "which ticket next", commit-message
formatting, and parsing the changed-files set from `git diff --name-only`.

### `scripts/supervisor.mjs` (new)
Boots the web app and the enabled loops; owns timers + filesystem watches; runs an
in-process event bus that the web app subscribes to over SSE; exposes a tiny
localhost control API (`POST /control/{loop}/{start|stop|run}`, `POST /control/revert
{sha}`) the web app calls. Zero-dep (`http`, `child_process`, `fs`).

### `scripts/serve.mjs` (web app)
`boardTitle` + `columns` from config. Adds: a live **agent-activity** panel fed by an
`EventSource` over SSE (reconcile moves + groom commits, each with a timestamp, ticket
id, summary; groom commits carry a revert control); and a control strip (start/stop
each loop, run-now, revert). The kanban itself and the fresh-markdown auto-reload are
unchanged.

**Board core UX (views over the served model — no new source of truth):** a
client-side **search** box (matches a `data-search` index of id/title/labels/assignee
stamped on each card/row; model seam `scripts/model/search.mjs`); **status filter
chips** with live counts and `All`/`Active` presets, `Active` being the schema-driven
non-terminal set (`scripts/model/filters.mjs`) and the selection serialised to the URL
hash so a filtered board is a shareable link — search and chips compose in one
`applyFilters()` pass; and a **detail panel** served by `GET /api/panel?id=` (pure
`scripts/views/panel-content.mjs` → rendered description, full frontmatter table,
parent/children from the derived index, links; 404 for an unknown id). The panel is the
shared `window.blazePanel.open(id)` seam the map node-click and field-editing views
reuse; AC checkboxes toggle through the existing commit-on-edit `/api/ac` path.

### `bin` / scripts
`blaze` (bin) boots the supervisor (web app + loops) — the "launch like an app" entry.
Subcommands stay available: `blaze new "title"`, `blaze reconcile`, `blaze groom`
(one groomer pass), `blaze board` (viewer only). npm scripts mirror these.

## Agent-native layer

### `AGENTS.md` (universal, and the groomer's source of rules)
The contract any agent reads before touching the board: the directory-is-status rule,
the create→move→reconcile loop, the `<key>-<n>` join key, the frontmatter fields, and
the standalone-vs-mirror distinction. It *also* contains the grooming rules section,
which the groomer loads verbatim into its prompt — so the human-facing rules and the
agent's instructions are one source.

### `.claude/` plugin (Claude Code, first-class)
- **Skills:** `new-ticket`, `reconcile`, `board`, `groom` — thin wrappers over the
  scripts.
- **Commands:** `/blaze-new "title"`, `/blaze-board`, `/blaze-reconcile`, `/blaze-groom`.

## Testing

Built-in `node:test` runner (keeps zero-dep). The agent call is shelled out, so the
groomer is testable end-to-end with a **stub `agentCommand`** — a tiny shell script
that deterministically edits a ticket file — letting us assert the full
spawn→edit→commit→event path without a live model.

- `reconcile.decide(...)` — every row of the state→column table, terminal stickiness,
  and the idempotent "no git signal → leave it" case.
- `config.mjs` — defaults applied, env overrides win, key→regex derivation.
- `new-ticket` id/slug derivation — next-id = max+1, slug normalization, padding.
- `groomer` — next-ticket selection, prompt assembly, changed-files parsing,
  commit-message formatting, and a stub-agent end-to-end pass producing one
  `chore(groom):` commit.

Run with `node --test`. No vitest, no deps.

## Brand

Blaze ships with a brand kit (`brand/`): a comet/meteor mark with a flame trail and a
white **ticket card** embedded in its head — a task card moving fast, tying the name
to the product. Full token reference in `brand/BRAND.md`.

- **Palette** (CSS tokens in `serve.mjs`): Blaze Red `#FF3B1F`, Blaze Orange `#FF7A00`,
  Blaze Amber `#FFC107`, Deep Charcoal `#0F172A`, Light Neutral `#F6F7F9`.
- **Web app:** dark brand surface (Deep Charcoal background, Light Neutral text — the
  board is a dark UI), Blaze Orange accents and a Red↕Amber "live" pulse on the activity
  feed; header carries the icon-only mark + wordmark + tagline. (Tokens already support
  a light-mode inversion later.)
- **Priority heat ramp:** the warm palette *is* the kanban priority colour-coding —
  urgent = Red, high = Orange, medium = Amber, low/none = charcoal tints. No extra
  colours.
- **Type:** bold/modern/confident headings, clean/readable body — system stack by
  default to stay zero-dependency; a self-hosted webfont can be added later.
- **Tagline:** "Agentic AI for App Development." Copy reads "resolves issues" as
  triage/prioritize/drive-to-resolution via the board (matching the v1 board-keeper
  scope), not autonomous code fixes.

## Docs, license, publishing

- README rewritten generic: keep the "why this shape" rationale, add the agent pitch,
  the app/loops overview, and the carelia-web mirror walkthrough as the worked example.
- CONVENTIONS.md label taxonomy genericized to `defaultLabels`.
- **MIT** license.
- Ready to `gh repo create blaze --public --source . --push`. npm publish is optional
  and out of scope for v1 (clone-and-run); if ever done, the package name can be
  suffixed/scoped while the `blaze` command name is unaffected.

## Open questions

None blocking. Deferred by YAGNI: code-writing worker loops, embedded SDK provider,
GitLab/Forgejo provider, MCP server.
