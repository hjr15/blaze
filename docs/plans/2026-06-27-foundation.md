# Blaze Foundation Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the generic, config-driven file-based issue board — a publishable standalone/mirror kanban (carelia-tracker, de-Carelia-fied and brand-applied), ready for Plan 2 to add the supervisor + agentic loops.

**Architecture:** A folder of markdown tickets where status = directory. One config file (`blaze.config.json`) holds everything that was hardcoded. A shared loader (`config.mjs`) derives the ticket-key regex consumed by the scaffolder and the reconcile engine. `reconcile.mjs` mirrors a code repo's git/PR state onto the board (no-op in standalone mode); `serve.mjs` is the read-only web board, brand-styled.

**Tech Stack:** Node ≥16 (ES modules, built-ins only — `node:fs`, `node:http`, `node:child_process`, `node:path`, `node:url`), `node:test` runner, bash, `git` + `gh` CLIs. **Zero runtime dependencies.**

**Reference source:** The three existing scripts live in the sibling private repo at `/home/jordan/carelia-tracker/`. Tasks that generalize a script start by copying its source, then apply exact deltas. The spec is `docs/design.md`; the brand tokens are `brand/BRAND.md`. The repo already contains `docs/`, `brand/` (with `logo-primary.png`, `brand-sheet.png`, `BRAND.md`), and a git history of three commits on `main`.

## Global Constraints

- **Zero runtime dependencies.** Node built-ins only. No `npm install` of libraries. The only external programs invoked are `git`, `gh`, and (Plan 2) the configured agent CLI.
- **ES modules** (`"type": "module"`); `.mjs` for Node scripts, `.sh` for bash.
- **Status = directory.** There is no `status:` frontmatter field, ever.
- **Ticket key is configurable**, default `"TASK"`. Never hardcode `DEV` or `TASK` in logic — read `config.key` / the derived regexes.
- **Default config is standalone:** `codeRepo: null`. Reconcile must be a clean no-op in that mode.
- **Brand palette (exact hex):** Blaze Red `#FF3B1F`, Blaze Orange `#FF7A00`, Blaze Amber `#FFC107`, Deep Charcoal `#0F172A`, Light Neutral `#F6F7F9`. Priority ramp: urgent=Red, high=Orange, medium=Amber.
- **Tests run with `node --test`** and must pass with zero dependencies installed.
- **Commit after every task** with a conventional-commit message.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | name `blaze-board`, `type: module`, scripts `board`/`new`/`reconcile`/`test`, engines node ≥16 |
| `LICENSE` | MIT |
| `.gitignore` | editor/OS noise + `node_modules/` + `.blaze/` (Plan 2 runtime state) |
| `blaze.config.json` | the single config file (standalone defaults) |
| `scripts/config.mjs` | load config + defaults + env overrides; derive `idFromRef`/`fileRegex`; `--get` CLI |
| `scripts/new-ticket.sh` | scaffold next `<KEY>-NNN` ticket from `TEMPLATE.md` (key from config) |
| `scripts/reconcile.mjs` | mirror code-repo git/PR state → columns; exports pure `decide()`; no-op standalone |
| `scripts/serve.mjs` | read-only web board; title + columns from config; brand CSS |
| `tests/config.test.mjs` | `config.mjs` unit tests |
| `tests/reconcile.test.mjs` | `decide()` unit tests |
| `tests/new-ticket.test.mjs` | scaffolder integration test (temp board) |
| `AGENTS.md` | universal agent loop + grooming-rules section (Plan 2 groomer reads it) |
| `CONVENTIONS.md` | ticket shape + generic label taxonomy |
| `TEMPLATE.md` | generic ticket template (`TASK-000`) |
| `README.md` | generic rewrite + agent pitch + carelia-web mirror walkthrough + brand logo |
| `backlog/`…`duplicate/` | the seven column dirs (with `.gitkeep` + 1–2 example tickets) |

---

## Task 1: Scaffold the repo

**Files:**
- Create: `package.json`, `LICENSE`, `.gitignore`, `blaze.config.json`
- Create: `backlog/.gitkeep`, `todo/.gitkeep`, `in-progress/.gitkeep`, `in-review/.gitkeep`, `done/.gitkeep`, `canceled/.gitkeep`, `duplicate/.gitkeep`

**Interfaces:**
- Produces: `blaze.config.json` (consumed by every later task via `config.mjs`); the seven column directories.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "blaze-board",
  "version": "0.1.0",
  "description": "A file-based, git-native issue board that AI coding agents can drive. Tickets are markdown; status is the directory.",
  "type": "module",
  "scripts": {
    "board": "node scripts/serve.mjs",
    "new": "bash scripts/new-ticket.sh",
    "reconcile": "node scripts/reconcile.mjs",
    "test": "node --test"
  },
  "engines": { "node": ">=16" },
  "license": "MIT"
}
```

- [ ] **Step 2: Create `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Jordan Lyons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 3: Create `.gitignore`**

```
# Editor / OS noise
.DS_Store
*.swp
*~
.vscode/
.idea/

# Node
node_modules/

# Blaze runtime state (Plan 2)
.blaze/
```

- [ ] **Step 4: Create `blaze.config.json`**

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
    "groomer": { "enabled": true, "intervalSec": 300, "columns": ["backlog"] }
  }
}
```

- [ ] **Step 5: Create the seven column directories with `.gitkeep`**

```bash
cd /home/jordan/blaze
for d in backlog todo in-progress in-review done canceled duplicate; do
  mkdir -p "$d" && touch "$d/.gitkeep"
done
```

- [ ] **Step 6: Verify the config parses and dirs exist**

Run: `node -e "JSON.parse(require('fs').readFileSync('blaze.config.json','utf8')); console.log('ok')" && ls -d */ | tr '\n' ' '`
Expected: prints `ok` then `backlog/ canceled/ docs/ done/ duplicate/ in-progress/ in-review/ todo/` (order may vary; the seven columns must be present).

- [ ] **Step 7: Commit**

```bash
git add package.json LICENSE .gitignore blaze.config.json backlog todo in-progress in-review done canceled duplicate
git commit -m "feat: scaffold blaze repo, config, and column directories"
```

---

## Task 2: Config loader (`scripts/config.mjs`)

**Files:**
- Create: `scripts/config.mjs`
- Test: `tests/config.test.mjs`

**Interfaces:**
- Produces:
  - `ROOT` — absolute path to the repo root (one level above `scripts/`).
  - `loadConfig({ root?, env?, fileName? }) → frozen config object` with all `DEFAULTS` fields plus derived:
    - `codeRepoPath: string|null` — `codeRepo` resolved absolute against `root`, or `null`.
    - `idFromRef(ref: string) → "<KEY>-<n>" | null` — case-insensitive key match, normalized to the configured key casing.
    - `fileRegex: RegExp` — matches ticket filenames `^<KEY>-\d+.*\.md$`.
    - `idLineRegex: RegExp` — matches a frontmatter `id:` line `^id:\s*(<KEY>-\d+)` (multiline).
  - `--get <field>` CLI: prints `loadConfig()[field]` (used by `new-ticket.sh`).

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/config.mjs";

function withConfig(json) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  if (json !== null) writeFileSync(join(dir, "blaze.config.json"), JSON.stringify(json));
  return dir;
}

test("applies defaults when no config file exists", () => {
  const dir = withConfig(null);
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "TASK");
  assert.equal(cfg.boardTitle, "Blaze");
  assert.equal(cfg.codeRepo, null);
  assert.equal(cfg.codeRepoPath, null);
  assert.deepEqual(cfg.terminal, ["done", "canceled", "duplicate"]);
  rmSync(dir, { recursive: true, force: true });
});

test("file overrides defaults; loops deep-merge", () => {
  const dir = withConfig({ key: "PROJ", loops: { groomer: { intervalSec: 99 } } });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.key, "PROJ");
  assert.equal(cfg.loops.groomer.intervalSec, 99);
  assert.equal(cfg.loops.groomer.enabled, true); // default preserved
  assert.equal(cfg.loops.reconcile.intervalSec, 60); // default branch intact
  rmSync(dir, { recursive: true, force: true });
});

test("env overrides win over file", () => {
  const dir = withConfig({ key: "PROJ", port: 4321 });
  const cfg = loadConfig({ root: dir, env: { BLAZE_KEY: "OPS", BLAZE_PORT: "8080", BLAZE_CODE_REPO: "../app" } });
  assert.equal(cfg.key, "OPS");
  assert.equal(cfg.port, 8080);
  assert.equal(cfg.codeRepo, "../app");
  assert.ok(cfg.codeRepoPath.endsWith("/app"));
  rmSync(dir, { recursive: true, force: true });
});

test("idFromRef extracts the key id case-insensitively", () => {
  const dir = withConfig({ key: "DEV" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.idFromRef("jordan/DEV-12-foo"), "DEV-12");
  assert.equal(cfg.idFromRef("epic/dev-9-bar"), "DEV-9");
  assert.equal(cfg.idFromRef("main"), null);
  rmSync(dir, { recursive: true, force: true });
});

test("fileRegex matches ticket files only", () => {
  const dir = withConfig({ key: "TASK" });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.ok(cfg.fileRegex.test("TASK-1-fix-thing.md"));
  assert.ok(!cfg.fileRegex.test("README.md"));
  assert.ok(!cfg.fileRegex.test("TASK-.md"));
  rmSync(dir, { recursive: true, force: true });
});

test("throws a clear error on malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "blaze-cfg-"));
  writeFileSync(join(dir, "blaze.config.json"), "{ not json");
  assert.throws(() => loadConfig({ root: dir, env: {} }), /cannot parse/);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/config.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/config.mjs'`.

- [ ] **Step 3: Write `scripts/config.mjs`**

```javascript
// config.mjs — load blaze.config.json with defaults + env overrides, and derive
// the key-based regexes that reconcile.mjs and new-ticket.sh share.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  key: "TASK",
  boardTitle: "Blaze",
  codeRepo: null,
  provider: "github",
  columns: ["backlog", "todo", "in-progress", "in-review", "done", "canceled", "duplicate"],
  terminal: ["done", "canceled", "duplicate"],
  defaultLabels: ["frontend", "backend", "infra", "docs", "bug", "chore"],
  port: 4321,
  agentCommand: "claude -p",
  loops: {
    reconcile: { enabled: true, intervalSec: 60 },
    groomer: { enabled: true, intervalSec: 300, columns: ["backlog"] },
  },
};

export function loadConfig({ root = ROOT, env = process.env, fileName = "blaze.config.json" } = {}) {
  const path = join(root, fileName);
  let file = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`blaze: cannot parse ${fileName}: ${e.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...file };
  cfg.loops = {
    reconcile: { ...DEFAULTS.loops.reconcile, ...(file.loops && file.loops.reconcile) },
    groomer: { ...DEFAULTS.loops.groomer, ...(file.loops && file.loops.groomer) },
  };

  // Env overrides (highest precedence).
  if (env.BLAZE_KEY) cfg.key = env.BLAZE_KEY;
  if (env.BLAZE_PORT) cfg.port = Number(env.BLAZE_PORT);
  if (env.BLAZE_AGENT_COMMAND) cfg.agentCommand = env.BLAZE_AGENT_COMMAND;
  if (env.BLAZE_CODE_REPO !== undefined) cfg.codeRepo = env.BLAZE_CODE_REPO || null;

  // Derived values.
  cfg.codeRepoPath = cfg.codeRepo
    ? (isAbsolute(cfg.codeRepo) ? cfg.codeRepo : resolve(root, cfg.codeRepo))
    : null;
  cfg.idRegex = new RegExp("\\b" + cfg.key + "-(\\d+)", "i");
  cfg.idFromRef = (ref) => {
    const m = cfg.idRegex.exec(ref || "");
    return m ? `${cfg.key}-${m[1]}` : null;
  };
  cfg.fileRegex = new RegExp("^" + cfg.key + "-\\d+.*\\.md$");
  cfg.idLineRegex = new RegExp(`^id:\\s*(${cfg.key}-\\d+)`, "m");

  return Object.freeze(cfg);
}

// CLI: `node scripts/config.mjs --get <field>` prints one field (for new-ticket.sh).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--get");
  if (i !== -1) {
    const cfg = loadConfig();
    const v = cfg[process.argv[i + 1]];
    console.log(v === undefined || v === null ? "" : v);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/config.test.mjs`
Expected: PASS — all six tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/config.mjs tests/config.test.mjs
git commit -m "feat(config): config loader with defaults, env overrides, key regexes"
```

---

## Task 3: Generalize the ticket scaffolder (`scripts/new-ticket.sh`)

**Files:**
- Create: `scripts/new-ticket.sh` (copied from `/home/jordan/carelia-tracker/scripts/new-ticket.sh`, then edited)
- Create: `TEMPLATE.md` (needed by the scaffolder; generic version)
- Test: `tests/new-ticket.test.mjs`

**Interfaces:**
- Consumes: `scripts/config.mjs --get key`; `TEMPLATE.md`.
- Produces: a ticket file `backlog/<KEY>-NNN-<slug>.md` from a title + optional `--type/--priority/--labels`.

- [ ] **Step 1: Create `TEMPLATE.md`** (generic, key-agnostic)

```markdown
---
id: TASK-000
title: Short imperative summary of the work
type: feature          # feature | bug | improvement | chore
priority: medium       # urgent | high | medium | low | none
labels: []             # e.g. [frontend, bug] — see CONVENTIONS.md
project:               # optional grouping
assignee: unassigned   # a name, or unassigned
estimate:              # story points (optional)
parent:                # parent ticket id when this is a sub-issue of an epic (optional)
branch:                # you/TASK-000-short-slug (auto-filled by reconcile in mirror mode)
created: 2026-01-01    # YYYY-MM-DD
updated: 2026-01-01    # YYYY-MM-DD — bump on every edit
---

## Context

What's wrong, or what we want, and *why*. One or two short paragraphs.

## Acceptance criteria

- [ ] The observable, testable thing that must be true when this is done
- [ ] Another one

## Notes

Implementation hints, open questions, decisions made along the way.
```

> The `id:` line uses `TASK-000` as the literal placeholder; the scaffolder rewrites it with the configured key. If the key is not `TASK`, that is fine — the scaffolder replaces the whole `id:` line.

- [ ] **Step 2: Write the failing test**

Create `tests/new-ticket.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeBoard(key) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-board-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "backlog"), { recursive: true });
  mkdirSync(join(dir, "todo"), { recursive: true });
  copyFileSync(join(REPO, "scripts", "new-ticket.sh"), join(dir, "scripts", "new-ticket.sh"));
  copyFileSync(join(REPO, "scripts", "config.mjs"), join(dir, "scripts", "config.mjs"));
  copyFileSync(join(REPO, "TEMPLATE.md"), join(dir, "TEMPLATE.md"));
  const cfg = { key, columns: ["backlog", "todo", "in-progress", "in-review", "done", "canceled", "duplicate"] };
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify(cfg));
  return dir;
}

test("creates the first ticket with the configured key and a slug", () => {
  const dir = makeBoard("TASK");
  execFileSync("bash", ["scripts/new-ticket.sh", "Fix shift overlap validation"], { cwd: dir });
  const files = readdirSync(join(dir, "backlog")).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  assert.equal(files[0], "TASK-001-fix-shift-overlap-validation.md");
  const body = readFileSync(join(dir, "backlog", files[0]), "utf8");
  assert.match(body, /^id: TASK-001$/m);
  assert.match(body, /^title: Fix shift overlap validation$/m);
  rmSync(dir, { recursive: true, force: true });
});

test("next id is max+1 across all columns, honouring a custom key", () => {
  const dir = makeBoard("DEV");
  writeFileSync(join(dir, "todo", "DEV-007-existing.md"), "---\nid: DEV-007\n---\n");
  execFileSync("bash", ["scripts/new-ticket.sh", "Add CSV export", "--priority", "high"], { cwd: dir });
  const files = readdirSync(join(dir, "backlog")).filter((f) => f.endsWith(".md"));
  assert.equal(files[0], "DEV-008-add-csv-export.md");
  const body = readFileSync(join(dir, "backlog", files[0]), "utf8");
  assert.match(body, /^priority: high$/m);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/new-ticket.test.mjs`
Expected: FAIL — `new-ticket.sh` does not exist yet (copyFileSync throws ENOENT).

- [ ] **Step 4: Create `scripts/new-ticket.sh`**

Copy `/home/jordan/carelia-tracker/scripts/new-ticket.sh` to `scripts/new-ticket.sh`, then apply these deltas:

1. After `cd "$ROOT"`, read the key from config:

```bash
KEY="$(node "$ROOT/scripts/config.mjs" --get key)"
KEY="${KEY:-TASK}"
```

2. Replace the next-id scan and id format (the `LAST=…`, `NEXT=…`, `ID=…` block) with:

```bash
LAST="$(ls */${KEY}-*.md 2>/dev/null | grep -oE "${KEY}-[0-9]+" | grep -oE '[0-9]+' \
        | sort -n | tail -1 || true)"
NEXT=$(( ${LAST:-0} + 1 ))
ID="$(printf "${KEY}-%03d" "$NEXT")"
```

3. Leave the slug, label-formatting, `DEST="backlog/${ID}-${SLUG}.md"`, the `sed` template patch, and the comment-stripping `sed` exactly as in the source. The `id:` replacement line `-e "s/^id: .*/id: ${ID}/"` already rewrites the template's `TASK-000` to the configured id.

The full resulting file:

```bash
#!/usr/bin/env bash
# new-ticket.sh — scaffold the next <KEY>-NNN ticket into backlog/ from TEMPLATE.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEY="$(node "$ROOT/scripts/config.mjs" --get key)"
KEY="${KEY:-TASK}"

TITLE="${1:-}"
if [[ -z "$TITLE" ]]; then
  echo "usage: $0 \"Ticket title\" [--type T] [--priority P] [--labels a,b]" >&2
  exit 1
fi
shift

TYPE="feature"
PRIORITY="medium"
LABELS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)     TYPE="$2"; shift 2 ;;
    --priority) PRIORITY="$2"; shift 2 ;;
    --labels)   LABELS="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

LAST="$(ls */${KEY}-*.md 2>/dev/null | grep -oE "${KEY}-[0-9]+" | grep -oE '[0-9]+' \
        | sort -n | tail -1 || true)"
NEXT=$(( ${LAST:-0} + 1 ))
ID="$(printf "${KEY}-%03d" "$NEXT")"

SLUG="$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"

TODAY="$(date +%F)"

if [[ -n "$LABELS" ]]; then
  YAML_LABELS="[$(printf '%s' "$LABELS" | sed -E 's/,/, /g')]"
else
  YAML_LABELS="[]"
fi

DEST="backlog/${ID}-${SLUG}.md"
if [[ -e "$DEST" ]]; then
  echo "refusing to overwrite existing $DEST" >&2
  exit 1
fi

sed -E \
  -e "s/^id: .*/id: ${ID}/" \
  -e "s|^title: .*|title: ${TITLE}|" \
  -e "s/^type: .*/type: ${TYPE}/" \
  -e "s/^priority: .*/priority: ${PRIORITY}/" \
  -e "s|^labels: .*|labels: ${YAML_LABELS}|" \
  -e "s/^created: .*/created: ${TODAY}/" \
  -e "s/^updated: .*/updated: ${TODAY}/" \
  TEMPLATE.md > "$DEST"

sed -i -E 's/^(type: [a-z]+) +#.*/\1/; s/^(priority: [a-z]+) +#.*/\1/' "$DEST"

echo "created $DEST"
```

Then make it executable: `chmod +x scripts/new-ticket.sh`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/new-ticket.test.mjs`
Expected: PASS — both tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/new-ticket.sh TEMPLATE.md tests/new-ticket.test.mjs
git commit -m "feat(scaffold): config-keyed new-ticket.sh + generic TEMPLATE.md"
```

---

## Task 4: Generalize reconcile + extract pure `decide()` (`scripts/reconcile.mjs`)

**Files:**
- Create: `scripts/reconcile.mjs` (copied from `/home/jordan/carelia-tracker/scripts/reconcile.mjs`, then edited)
- Test: `tests/reconcile.test.mjs`

**Interfaces:**
- Consumes: `loadConfig` from `config.mjs`.
- Produces:
  - `decide({ pr, branch }, currentDir, cfg) → { target, branchVal, prVal, moved, skip }` — pure git-state → column decision.
  - `reconcile({ fetch?, commit?, push? }) → { ok, error?, changes, committed }` — the loop body (no-op when `cfg.codeRepoPath` is null).

- [ ] **Step 1: Write the failing test**

Create `tests/reconcile.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../scripts/reconcile.mjs";

const cfg = { terminal: ["done", "canceled", "duplicate"] };

test("merged PR moves a ticket to done", () => {
  const d = decide({ pr: { state: "MERGED", number: 5, url: "u", headRefName: "you/TASK-5-x" } }, "in-review", cfg);
  assert.equal(d.target, "done");
  assert.equal(d.moved, true);
  assert.equal(d.prVal, "#5 — u");
  assert.equal(d.branchVal, "you/TASK-5-x");
});

test("open PR moves to in-review", () => {
  const d = decide({ pr: { state: "OPEN", number: 6, url: "u", headRefName: "b" } }, "todo", cfg);
  assert.equal(d.target, "in-review");
  assert.equal(d.moved, true);
});

test("closed (unmerged) PR moves to in-progress", () => {
  const d = decide({ pr: { state: "CLOSED", number: 7, url: "u", headRefName: "b" } }, "in-review", cfg);
  assert.equal(d.target, "in-progress");
});

test("branch with no PR moves to in-progress", () => {
  const d = decide({ branch: "you/TASK-8-y" }, "todo", cfg);
  assert.equal(d.target, "in-progress");
  assert.equal(d.branchVal, "you/TASK-8-y");
  assert.equal(d.prVal, null);
});

test("no git signal is skipped and left in place", () => {
  const d = decide({}, "backlog", cfg);
  assert.equal(d.skip, true);
  assert.equal(d.moved, false);
  assert.equal(d.target, "backlog");
});

test("terminal columns are sticky — a merged PR on a done ticket does not move it", () => {
  const d = decide({ pr: { state: "MERGED", number: 9, url: "u", headRefName: "b" } }, "done", cfg);
  assert.equal(d.target, "done");
  assert.equal(d.moved, false);
});

test("terminal stickiness also holds for a branch-only signal on a canceled ticket", () => {
  const d = decide({ branch: "b" }, "canceled", cfg);
  assert.equal(d.target, "canceled");
  assert.equal(d.moved, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/reconcile.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/reconcile.mjs'`.

- [ ] **Step 3: Create `scripts/reconcile.mjs`**

Copy `/home/jordan/carelia-tracker/scripts/reconcile.mjs` to `scripts/reconcile.mjs`, then apply these deltas:

1. Add the import and load config at the top (after the existing imports), and delete the `WEB`/`DIRS`/`TERMINAL` constants:

```javascript
import { loadConfig } from "./config.mjs";
const cfg = loadConfig();
const WEB = cfg.codeRepoPath;
const DIRS = cfg.columns;
const TERMINAL = new Set(cfg.terminal);
```

2. Delete the local `idFromRef` function; use `cfg.idFromRef` everywhere it was called.

3. In `gather()`, replace the standalone guard so a null code repo short-circuits:

```javascript
function gather({ fetch }) {
  if (!WEB) return { ok: true, standalone: true, prMap: new Map(), branchMap: new Map() };
  if (!existsSync(WEB) || !existsSync(join(WEB, ".git"))) {
    return { ok: false, error: `code repo not found at ${WEB} (set codeRepo / BLAZE_CODE_REPO)` };
  }
  // ...rest unchanged, but replace idFromRef(...) → cfg.idFromRef(...)
  // and replace the feature-branch heuristic regex /\/dev-\d+/i with cfg.idRegex-based:
  //   const feat = new RegExp(`/${cfg.key}-\\d+`, "i");
  //   if (!existing || (feat.test(ref) && !feat.test(existing))) branchMap.set(id, ref);
}
```

4. In `reconcile()`, after `const state = gather({ fetch });`, add a standalone no-op:

```javascript
  if (state.standalone) return { ok: true, standalone: true, changes: [] };
```

5. Replace the per-file match `/^DEV-\d+.*\.md$/` with `cfg.fileRegex.test(file)`, and `parseId(raw)` to use `cfg.idLineRegex`:

```javascript
function parseId(raw) {
  const m = cfg.idLineRegex.exec(raw);
  return m ? m[1] : null;
}
```

6. Extract the decision into an exported pure function, and call it from the loop. Add near the top (after the helpers):

```javascript
// Pure decision: given the git signal for a ticket id and its current column,
// return the target column + the branch/pr metadata to write. No I/O.
export function decide({ pr, branch }, currentDir, cfg) {
  let target, branchVal = null, prVal = null;
  if (pr) {
    target = pr.state === "MERGED" ? "done" : pr.state === "OPEN" ? "in-review" : "in-progress";
    branchVal = pr.headRefName;
    prVal = `#${pr.number} — ${pr.url}`;
  } else if (branch) {
    target = "in-progress";
    branchVal = branch;
  } else {
    return { target: currentDir, branchVal: null, prVal: null, moved: false, skip: true };
  }
  if (cfg.terminal.includes(currentDir)) target = currentDir;
  return { target, branchVal, prVal, moved: target !== currentDir, skip: false };
}
```

In the file loop, replace the inline target/branchVal/prVal computation with:

```javascript
      const d = decide({ pr: prMap.get(id), branch: branchMap.get(id) }, dir, cfg);
      if (d.skip) continue;
      const { target, branchVal, prVal, moved } = d;
```

7. Keep the CLI `main()` and all flag handling unchanged, but in the "already in sync" / standalone branch, print a friendly message when `r.standalone`:

```javascript
  if (r.standalone) { if (!quiet) console.log("reconcile: standalone board — nothing to reconcile."); return; }
```

(The commit message string `chore(board): reconcile …` stays as-is — it is already generic.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/reconcile.test.mjs`
Expected: PASS — all seven `decide()` tests pass.

- [ ] **Step 5: Verify the standalone no-op end-to-end**

Run: `node scripts/reconcile.mjs --no-commit`
Expected: prints `reconcile: standalone board — nothing to reconcile.` and exits 0 (because `blaze.config.json` has `codeRepo: null`).

- [ ] **Step 6: Commit**

```bash
git add scripts/reconcile.mjs tests/reconcile.test.mjs
git commit -m "feat(reconcile): config-driven mirror with extracted pure decide()"
```

---

## Task 5: Generalize + brand the web board (`scripts/serve.mjs`)

**Files:**
- Create: `scripts/serve.mjs` (copied from `/home/jordan/carelia-tracker/scripts/serve.mjs`, then edited)

**Interfaces:**
- Consumes: `loadConfig` from `config.mjs`; reads ticket markdown fresh per request.
- Produces: a localhost board on `cfg.port`, titled `cfg.boardTitle`, columns from `cfg.columns`, brand-styled.

- [ ] **Step 1: Copy the source and wire in config**

Copy `/home/jordan/carelia-tracker/scripts/serve.mjs` to `scripts/serve.mjs`. At the top, add:

```javascript
import { loadConfig } from "./config.mjs";
const cfg = loadConfig();
```

Then apply these substitutions (line numbers approximate — match on the literal text):
- The hardcoded port (`4321` / `process.env.PORT`) → `process.env.PORT || cfg.port`.
- `<title>carelia-tracker</title>` → `` <title>${cfg.boardTitle}</title> `` (ensure the template literal is in a JS string that interpolates; if the HTML is a plain string, build it with `cfg.boardTitle`).
- `<h1>carelia-tracker</h1>` → `` <h1>${cfg.boardTitle}</h1> ``.
- The console banner `carelia-tracker board → http://localhost:${PORT}` → `` ${cfg.boardTitle} board → http://localhost:${PORT} ``.
- The column list that builds `columnsHtml` (the array the board iterates) → source it from `cfg.columns` instead of any hardcoded array.

- [ ] **Step 2: Decouple the auto-reconcile timer (defer the loop to Plan 2)**

Find the startup block that calls reconcile on boot and every 60s (the `// Keep the board mirrored…` section). Replace it so it only runs in mirror mode and never in standalone:

```javascript
import { reconcile } from "./reconcile.mjs";
if (cfg.codeRepoPath && cfg.loops.reconcile.enabled) {
  const tick = () => { try { reconcile({ fetch: true, commit: true, push: true }); } catch {} };
  tick();
  setInterval(tick, cfg.loops.reconcile.intervalSec * 1000);
}
```

(In standalone mode the board is a pure viewer — correct for Plan 1. Plan 2's supervisor takes over loop management.)

- [ ] **Step 3: Apply the brand palette to the inline CSS**

In the `<style>` block, add the brand tokens at the top of `:root` and set the base surface colours:

```css
:root {
  --blaze-red: #FF3B1F;
  --blaze-orange: #FF7A00;
  --blaze-amber: #FFC107;
  --charcoal: #0F172A;
  --neutral: #F6F7F9;
}
body { background: var(--neutral); color: var(--charcoal); }
h1 { color: var(--charcoal); }
```

Then find the existing priority-colour rules (cards are already colour-coded by priority) and set them to the brand heat ramp. The card priority is exposed via a `data-priority` attribute (the source sets a priority class/attribute per card — match whichever it uses):

```css
.card[data-priority="urgent"] { border-left: 4px solid var(--blaze-red); }
.card[data-priority="high"]   { border-left: 4px solid var(--blaze-orange); }
.card[data-priority="medium"] { border-left: 4px solid var(--blaze-amber); }
.card[data-priority="low"], .card[data-priority="none"] { border-left: 4px solid var(--charcoal); opacity: .9; }
```

> If the source colour-codes priority via a CSS class (e.g. `.priority-urgent`) rather than a `data-priority` attribute, apply the same three brand colours to those existing selectors instead of adding new ones — do not introduce a second styling mechanism.

- [ ] **Step 4: Manual verification**

Run: `node scripts/serve.mjs` then open `http://localhost:4321`.
Expected: the page title and `<h1>` read **Blaze**; the seven columns render; the background is light neutral with charcoal text; any seeded tickets colour-code by priority on the warm ramp. Stop with Ctrl-C.

- [ ] **Step 5: Commit**

```bash
git add scripts/serve.mjs
git commit -m "feat(board): config-driven, brand-styled web board"
```

---

## Task 6: Docs — AGENTS.md, CONVENTIONS.md, README.md, and example tickets

**Files:**
- Create: `AGENTS.md`, `CONVENTIONS.md`, `README.md`
- Create: `backlog/TASK-001-welcome-to-blaze.md`, `backlog/TASK-002-try-mirror-mode.md`

**Interfaces:**
- Consumes: nothing executable. `AGENTS.md`'s "Grooming rules" section is the source Plan 2's groomer loads into its prompt.

- [ ] **Step 1: Create `AGENTS.md`**

````markdown
# Driving Blaze with an agent

Blaze is a file-based issue board. **A ticket's status is the directory it sits in** —
there is no `status:` field, so it cannot drift. Any coding agent (Claude Code, Cursor,
Codex, …) can drive the board with ordinary file tools.

## The one rule

To change a ticket's status, move the file:

```bash
git mv todo/TASK-008-fix-thing.md in-progress/
```

The seven columns in workflow order: `backlog → todo → in-progress → in-review → done`,
plus `canceled` and `duplicate`.

## The loop

1. **Create** a ticket in `backlog/` (`npm run new "Title"` or copy `TEMPLATE.md`).
2. **You** move it to `todo/` when you commit to it (intent is a human decision).
3. In **mirror mode**, `reconcile` takes over from there: cut a code-repo branch named
   `you/<KEY>-<n>-slug` and the ticket lands in `in-progress/`; open a PR and it moves
   to `in-review/`; merge and it lands in `done/`. Never hand-move a ticket through the
   reconcile-owned columns.

## The join key

The only coupling between board and code is the branch name. Every branch embeds the
ticket key, e.g. `jordan/TASK-12-add-export`. Reconcile greps `TASK-12` out of it and
matches it to `*/TASK-12-*.md`. No API, no webhook, no stored id.

## Frontmatter

`id`, `title`, `type`, `priority`, `labels`, optional `project`/`assignee`/`estimate`/
`parent`, and the reconcile-filled `branch`/`pr`. See `CONVENTIONS.md`.

## Querying the board

```bash
for d in todo in-progress in-review; do echo "## $d"; ls "$d"/*.md 2>/dev/null; done
grep -rl '^priority: urgent' --include='*.md' .
```

## Grooming rules (used by the groomer loop)

When grooming a freshly-captured ticket, make these and only these edits to its `.md`
file, then stop:

- **Type & priority:** set `type` (feature/bug/improvement/chore) and `priority`
  (urgent/high/medium/low/none) from the ticket's content.
- **Labels:** add labels from the project taxonomy in `CONVENTIONS.md` that match the
  area/intent. Do not invent new labels.
- **Acceptance criteria:** if the `## Acceptance criteria` list is empty or a
  placeholder, draft 2–4 concrete, testable checkboxes from the context.
- **Duplicates:** if the ticket clearly duplicates another, note it in `## Notes`
  pointing at the surviving id (do not move or delete it — that stays a human decision).
- **Links:** in `## Notes`, link closely-related tickets by id.

Bump `updated:` to today on any edit. Never touch the `id`, never change the directory,
never edit code or any file outside the board.
````

- [ ] **Step 2: Create `CONVENTIONS.md`**

```markdown
# Conventions — the ticket shape

The canonical shape is `TEMPLATE.md`. This file explains each field.

## File naming

`<STATUS-DIR>/<KEY>-<n>-<short-slug>.md`, e.g. `todo/TASK-008-fix-overlap.md`.
`<KEY>` defaults to `TASK` (set `key` in `blaze.config.json`). Ids are sequential,
never reused; next id is `max(existing) + 1`.

## Status = directory (no field)

There is no `status:` field. The directory is the single source of truth.

| Directory | Meaning |
|---|---|
| `backlog/` | Captured, not yet committed to |
| `todo/` | Committed to, ready to pick up |
| `in-progress/` | Actively being worked |
| `in-review/` | PR open / awaiting review |
| `done/` | Shipped |
| `canceled/` | Won't do |
| `duplicate/` | Superseded — point to the surviving id |

## Frontmatter fields

| Field | Required | Values |
|---|---|---|
| `id` | yes | `<KEY>-<n>` — matches the filename |
| `title` | yes | Short imperative summary |
| `type` | yes | `feature` · `bug` · `improvement` · `chore` |
| `priority` | yes | `urgent` · `high` · `medium` · `low` · `none` |
| `labels` | no | area/intent labels — see below |
| `project` | no | optional grouping |
| `assignee` | no | a name, or `unassigned` |
| `estimate` | no | story points (integer) |
| `parent` | no | parent ticket id when this is a sub-issue of an epic |
| `branch` | no | the code-repo branch — auto-filled by reconcile in mirror mode |
| `pr` | no | the PR as `#<n> — <url>` — auto-filled by reconcile |
| `created` | yes | `YYYY-MM-DD` |
| `updated` | yes | `YYYY-MM-DD` — bump on every edit |

## Labels

Free-form, but keep to a consistent taxonomy so search stays useful. The default set
(`blaze.config.json` → `defaultLabels`): `frontend`, `backend`, `infra`, `docs`, `bug`,
`chore`. Customize for your project.

## Epics & sub-issues

An epic is a ticket whose children set `parent: <KEY>-<n>`. The epic stays in
`in-progress/` while its sub-issues move independently; it reaches `done/` when the last
child does.
```

- [ ] **Step 3: Create `README.md`**

```markdown
<p align="center">
  <img src="brand/logo-primary.png" alt="Blaze" width="420">
</p>

<p align="center"><b>Agentic AI for App Development</b><br>
A file-based, git-native issue board that AI coding agents can drive.</p>

---

Blaze is a super-clean issue tracker that lives next to your code. **Tickets are
markdown files. Their status is the directory they sit in.** No app, no database, no
login — plain text, versioned in git, greppable, and trivial for an AI coding agent to
drive with the file tools it already has.

```
blaze/
├── backlog/        ← captured, not yet committed to
├── todo/           ← committed to, ready to pick up
├── in-progress/    ← actively being worked
├── in-review/      ← PR open / awaiting review
├── done/           ← shipped
├── canceled/  duplicate/
└── blaze.config.json
```

## The one rule

A ticket's status is **which folder it's in**. To change status, move the file:

```bash
git mv todo/TASK-008-fix-thing.md in-progress/
```

`git log --follow` on a file is its full history.

## Two ways to run it

**Standalone** (default) — a personal/team markdown kanban. You move tickets by hand.

```bash
npm run new "Fix the export bug"     # scaffolds backlog/TASK-001-fix-the-export-bug.md
npm run board                        # → http://localhost:4321
```

**Mirror mode** — point Blaze at a code repo and it tracks status from git automatically.
Set `codeRepo` in `blaze.config.json` (and `key` to match your branch convention):

```json
{ "key": "TASK", "codeRepo": "../my-app" }
```

Now the branch name *is* the link. A branch `you/TASK-12-add-export` in `../my-app`
moves ticket `TASK-12` to `in-progress/`; opening its PR moves it to `in-review/`;
merging moves it to `done/` — all via `npm run reconcile` (needs `gh` authed).

### Worked example: mirroring a real repo

Say your code repo uses `DEV-<n>` branch names (e.g. `jordan/DEV-309-ics-feed`). Drop
Blaze in as a sibling and configure:

```json
{ "key": "DEV", "boardTitle": "My Dev Board", "codeRepo": "../my-app" }
```

`reconcile` reads `../my-app`'s branches + PRs, greps the `DEV-<n>` out of each branch
name, and drives the matching ticket through the columns. There is nothing to install
in the code repo — the naming convention is the whole integration.

## Driving it with an AI agent

See [`AGENTS.md`](AGENTS.md) — the create → move → reconcile loop, the join key, and the
grooming rules, written for any coding agent. Claude Code users also get a plugin under
`.claude/` (commands `/blaze-new`, `/blaze-board`, `/blaze-reconcile`).

## Configuration

Everything lives in [`blaze.config.json`](blaze.config.json): the ticket `key`, the
`codeRepo` to mirror (`null` = standalone), `columns`, `defaultLabels`, the board
`port`, and more. See [`docs/design.md`](docs/design.md) for the full reference.

## License

MIT.
```

> The README mentions the `.claude/` plugin and `/blaze-*` commands, which Plan 2 delivers. That is intentional forward-reference; the line is accurate by the time both plans are built.

- [ ] **Step 4: Create two example tickets**

`backlog/TASK-001-welcome-to-blaze.md`:

```markdown
---
id: TASK-001
title: Welcome to Blaze — move me to todo/
type: chore
priority: medium
labels: [docs]
assignee: unassigned
created: 2026-06-27
updated: 2026-06-27
---

## Context

This is an example ticket. A ticket's status is the folder it lives in. Try
`git mv backlog/TASK-001-welcome-to-blaze.md todo/` and refresh the board.

## Acceptance criteria

- [ ] You moved this ticket to another column
- [ ] You ran `npm run board` and saw it move

## Notes

Delete these example tickets whenever you like.
```

`backlog/TASK-002-try-mirror-mode.md`:

```markdown
---
id: TASK-002
title: Try mirror mode against a code repo
type: feature
priority: low
labels: [docs]
assignee: unassigned
created: 2026-06-27
updated: 2026-06-27
---

## Context

Set `codeRepo` in `blaze.config.json` to a sibling repo and run `npm run reconcile` to
see tickets track your branches and PRs automatically.

## Acceptance criteria

- [ ] `codeRepo` points at a real repo
- [ ] `npm run reconcile` moved a ticket based on a branch/PR

## Notes

See README.md → "Worked example".
```

- [ ] **Step 5: Verify the board renders the docs + examples**

Run: `node scripts/serve.mjs` and open `http://localhost:4321`.
Expected: two example tickets appear in the backlog column. Stop with Ctrl-C.

- [ ] **Step 6: Run the full test suite**

Run: `node --test`
Expected: PASS — all tests across `tests/` pass with zero dependencies installed.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md CONVENTIONS.md README.md backlog/TASK-001-welcome-to-blaze.md backlog/TASK-002-try-mirror-mode.md
git commit -m "docs: AGENTS, CONVENTIONS, README, and example tickets"
```

---

## Done criteria (Plan 1)

- `npm run new "X"` scaffolds a correctly-keyed ticket; `npm run board` serves a
  brand-styled **Blaze** kanban; `npm run reconcile` is a clean no-op standalone and
  mirrors git/PR state when `codeRepo` is set.
- `node --test` passes with zero dependencies.
- The repo is a publishable generic board (MIT, README, AGENTS, brand).

**Next:** Plan 2 — `scripts/supervisor.mjs` (boots the board + loops, SSE event bus,
control API), `scripts/loops/groomer.mjs` (prompt → spawn `agentCommand` → commit), the
web-app activity feed + controls + revert, and the `.claude/` plugin (skills + commands).
```
