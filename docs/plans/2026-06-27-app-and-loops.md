# Blaze App + Agentic Loops Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the generic board from Plan 1 into a launchable app — `blaze` boots a supervisor that serves a live web app and runs two loops on the board: deterministic `reconcile` and the agentic `groomer` (spawns `claude -p`, edits ticket files, auto-commits). Plus the `.claude/` plugin.

**Architecture:** A supervisor (`scripts/supervisor.mjs`) is the HTTP server and loop manager. It reuses Plan 1's board renderer (`serve.mjs`, refactored to export `boardData`/`pageHtml`/`contentHash`), layers on an activity feed (SSE over an in-process event bus) and a control strip, and runs the loops on timers + a filesystem watch. The groomer (`scripts/loops/groomer.mjs`) shells out to the configured agent command and commits each grooming change as a small `chore(groom):` commit. All effects go through git on the board repo.

**Tech Stack:** Same as Plan 1 — Node ≥16 ES modules, built-ins only (`node:http`, `node:child_process`, `node:fs`, `node:crypto`, `node:path`), `node:test`. **Zero runtime dependencies.** The only external program the groomer invokes is `config.agentCommand` (default `claude -p`).

**Prerequisite:** Plan 1 (`docs/plans/2026-06-27-foundation.md`) is fully implemented and `node --test` is green. This plan modifies `scripts/serve.mjs` and `package.json` from Plan 1 and adds new files.

## Global Constraints

- **Zero runtime dependencies.** Node built-ins only. External programs invoked: `git`, `gh` (reconcile), and `config.agentCommand` (groomer).
- **No API key in Blaze.** The agent CLI owns its own auth. Blaze only spawns it.
- **The groomer only edits ticket `.md` files in the board repo.** Never the code repo, never code. Each grooming change is one small, revertable `chore(groom):` commit (auto-commit; review/revert via git + the activity feed).
- **The groomer prompt is built from `AGENTS.md` → "## Grooming rules"** — that section (authored in Plan 1) is the single source of the grooming contract.
- **Runtime state lives in `.blaze/`** (gitignored in Plan 1). Never commit it.
- **Brand:** the app reuses the dark brand surface and tokens already in `serve.mjs` (`--charcoal`, `--neutral`, `--blaze-orange`, `--blaze-red`, `--blaze-amber`). The "live"/active accent is Blaze Orange.
- **Tests run with `node --test`** and pass with zero dependencies installed.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/event-bus.mjs` | NEW — tiny in-process pub/sub for the activity feed (SSE) |
| `scripts/serve.mjs` | MODIFY — export `boardData()`, `contentHash()`, `pageHtml(opts)`; guard the standalone server behind an `if main` check |
| `scripts/loops/groomer.mjs` | NEW — pure helpers + `groomOnce()` (spawn agent → stage → commit → state) + CLI |
| `scripts/supervisor.mjs` | NEW — `createApp(cfg,{root})` (HTTP server: board + SSE + control API) + loop manager; the `blaze` app entry |
| `scripts/cli.mjs` | NEW — `blaze` dispatcher (`start`/`board`/`reconcile`/`groom`/`new`) |
| `package.json` | MODIFY — add `bin.blaze`, scripts `start`/`groom` |
| `.claude/commands/blaze-*.md` | NEW — slash commands |
| `.claude/skills/blaze/SKILL.md` | NEW — "drive the board" skill |
| `tests/event-bus.test.mjs` | NEW |
| `tests/groomer.test.mjs` | NEW — pure helpers + stub-agent end-to-end |
| `tests/supervisor.test.mjs` | NEW — SSE + control API integration |

---

## Task 1: Event bus (`scripts/event-bus.mjs`)

**Files:**
- Create: `scripts/event-bus.mjs`
- Test: `tests/event-bus.test.mjs`

**Interfaces:**
- Produces: `createBus() → { publish(evt), subscribe(fn) → unsubscribe, size() }`. Synchronous fan-out; a throwing subscriber must not break the others.

- [ ] **Step 1: Write the failing test**

Create `tests/event-bus.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBus } from "../scripts/event-bus.mjs";

test("subscribers receive published events; unsubscribe stops them", () => {
  const bus = createBus();
  const seen = [];
  const off = bus.subscribe((e) => seen.push(e));
  bus.publish({ a: 1 });
  assert.deepEqual(seen, [{ a: 1 }]);
  off();
  bus.publish({ a: 2 });
  assert.deepEqual(seen, [{ a: 1 }]);
  assert.equal(bus.size(), 0);
});

test("a throwing subscriber does not break others", () => {
  const bus = createBus();
  const seen = [];
  bus.subscribe(() => { throw new Error("boom"); });
  bus.subscribe((e) => seen.push(e));
  bus.publish({ ok: true });
  assert.deepEqual(seen, [{ ok: true }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/event-bus.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `scripts/event-bus.mjs`**

```javascript
// event-bus.mjs — a tiny synchronous in-process pub/sub for the activity feed.
export function createBus() {
  const subs = new Set();
  return {
    publish(evt) {
      for (const fn of subs) {
        try { fn(evt); } catch { /* one bad subscriber must not break the rest */ }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    size() { return subs.size; },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/event-bus.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/event-bus.mjs tests/event-bus.test.mjs
git commit -m "feat(bus): in-process event bus for the activity feed"
```

---

## Task 2: Refactor `serve.mjs` to export the renderer

**Files:**
- Modify: `scripts/serve.mjs`

**Interfaces:**
- Produces (new exports):
  - `boardData() → { cols: [{ dir, label, tickets }], total: number }`
  - `contentHash() → string`
  - `pageHtml({ afterHeader?: string, beforeBodyEnd?: string } = {}) → string` — the full board page with two injection points: HTML inserted right after the sticky `</header>`, and HTML/script inserted right before `</body>`.
- The standalone server (and its mirror-mode reconcile timer from Plan 1) now runs only when the file is executed directly.

- [ ] **Step 1: Export `boardData` and `contentHash`**

In `scripts/serve.mjs`, add the `export` keyword to `contentHash` (currently `function contentHash()`). Add a new exported `boardData` just above `page`:

```javascript
export function boardData() {
  const cols = COLUMNS.map((c) => ({ ...c, tickets: readColumn(c.dir) }));
  const total = cols.reduce((n, c) => n + c.tickets.length, 0);
  return { cols, total };
}
```

- [ ] **Step 2: Convert `page()` to an exported `pageHtml(opts)` with injection points**

Rename `function page()` to `export function pageHtml({ afterHeader = "", beforeBodyEnd = "" } = {})`. At the top of its body, replace the `cols`/`total` computation with a call to `boardData`:

```javascript
const { cols, total } = boardData();
```

In the returned template, insert `afterHeader` immediately after the closing `</header>` tag and before `<div class="board">`:

```javascript
  </header>
  ${afterHeader}
  <div class="board">${columnsHtml}</div>
```

And insert `beforeBodyEnd` immediately before `</body>`:

```javascript
    setInterval(poll, 3000);
  </script>
  ${beforeBodyEnd}
</body>
</html>`;
```

- [ ] **Step 3: Guard the standalone server behind an `if main` check**

Wrap the `createServer(...).listen(...)` call and the Plan 1 mirror-mode reconcile timer in a direct-execution guard so importing the module has no side effects. Replace the server `createServer((req,res)=>{ … if (req.url==="/"){ res.end(page()); } … }).listen(PORT, …)` and the reconcile block with:

```javascript
import { fileURLToPath } from "node:url"; // already imported at top — keep one copy

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer((req, res) => {
    if (req.url === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(contentHash());
      return;
    }
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml());
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }).listen(PORT, () => {
    console.log(`${cfg.boardTitle} board → http://localhost:${PORT}`);
  });

  // Mirror mode only: keep the board synced to the code repo (Plan 1 behaviour).
  if (cfg.codeRepoPath && cfg.loops.reconcile.enabled) {
    const tick = () => { try { reconcile({ fetch: true, commit: true, push: true }); } catch {} };
    tick();
    setInterval(tick, cfg.loops.reconcile.intervalSec * 1000);
  }
}
```

(Remove the now-duplicated unguarded `createServer`/`reconcile` blocks left from Plan 1.)

- [ ] **Step 4: Verify the standalone board still works and imports are side-effect-free**

Run: `node -e "import('./scripts/serve.mjs').then(m => console.log(typeof m.pageHtml, typeof m.boardData, m.pageHtml().includes('<!doctype')))"`
Expected: prints `function function true` and the process exits immediately (no server started on import).
Then: `node scripts/serve.mjs` opens the board on the configured port as before; Ctrl-C to stop.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/serve.mjs
git commit -m "refactor(board): export boardData/pageHtml/contentHash; guard standalone server"
```

---

## Task 3: Groomer pure helpers (`scripts/loops/groomer.mjs`)

**Files:**
- Create: `scripts/loops/groomer.mjs` (helpers only this task; `groomOnce` + CLI in Task 4)
- Test: `tests/groomer.test.mjs`

**Interfaces:**
- Produces:
  - `hashContent(s: string) → string` (sha1 hex)
  - `loadState(root) → { groomed: {} }`, `saveState(root, state)`
  - `selectNextTicket(root, cfg, state) → { id, file, col, rel, raw } | null` — first ticket in `cfg.loops.groomer.columns` whose current content hash differs from the recorded one
  - `extractGroomingRules(agentsMd: string) → string` — the `## Grooming rules` section
  - `buildPrompt(ticket, rules, cfg) → string`
  - `parseChangedFiles(gitDiffOutput: string) → string[]`
  - `commitMessage(id: string, files: string[]) → string`

- [ ] **Step 1: Write the failing test (pure helpers)**

Create `tests/groomer.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashContent, loadState, saveState, selectNextTicket,
  extractGroomingRules, buildPrompt, parseChangedFiles, commitMessage,
} from "../scripts/loops/groomer.mjs";
import { loadConfig } from "../scripts/config.mjs";

function board() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-groom-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({ key: "TASK" }));
  return dir;
}

test("hashContent is deterministic", () => {
  assert.equal(hashContent("abc"), hashContent("abc"));
  assert.notEqual(hashContent("abc"), hashContent("abd"));
});

test("selectNextTicket returns the first ungroomed ticket, then null once recorded", () => {
  const dir = board();
  const cfg = loadConfig({ root: dir, env: {} });
  const raw = "---\nid: TASK-001\ntitle: x\n---\nbody\n";
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"), raw);
  let state = { groomed: {} };
  const t = selectNextTicket(dir, cfg, state);
  assert.equal(t.id, "TASK-001");
  assert.equal(t.col, "backlog");
  state.groomed["TASK-001"] = hashContent(raw);
  assert.equal(selectNextTicket(dir, cfg, state), null);
  rmSync(dir, { recursive: true, force: true });
});

test("state round-trips through .blaze/state.json", () => {
  const dir = board();
  saveState(dir, { groomed: { "TASK-1": "deadbeef" } });
  assert.deepEqual(loadState(dir), { groomed: { "TASK-1": "deadbeef" } });
  rmSync(dir, { recursive: true, force: true });
});

test("extractGroomingRules slices the section", () => {
  const md = "# Title\n\n## The loop\nx\n\n## Grooming rules\n- set type\n- add labels\n\n## Querying\ny\n";
  const rules = extractGroomingRules(md);
  assert.match(rules, /## Grooming rules/);
  assert.match(rules, /add labels/);
  assert.doesNotMatch(rules, /Querying/);
});

test("buildPrompt names the target file, the rules, and the labels", () => {
  const dir = board();
  const cfg = loadConfig({ root: dir, env: {} });
  const ticket = { rel: "backlog/TASK-001-x.md", raw: "ticket body" };
  const p = buildPrompt(ticket, "## Grooming rules\n- set type", cfg);
  assert.match(p, /backlog\/TASK-001-x\.md/);
  assert.match(p, /Grooming rules/);
  assert.match(p, new RegExp(cfg.defaultLabels[0]));
  assert.match(p, /ticket body/);
  rmSync(dir, { recursive: true, force: true });
});

test("parseChangedFiles + commitMessage", () => {
  assert.deepEqual(parseChangedFiles("backlog/a.md\n\nbacklog/b.md\n"), ["backlog/a.md", "backlog/b.md"]);
  assert.equal(commitMessage("TASK-7", ["backlog/a.md"]), "chore(groom): TASK-7 1 file(s) groomed");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/groomer.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers in `scripts/loops/groomer.mjs`**

```javascript
// groomer.mjs — the agentic board-keeper loop: pick an ungroomed ticket, drive the
// configured agent command to edit it, then auto-commit the change.
import { createHash } from "node:crypto";
import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";

export function hashContent(s) {
  return createHash("sha1").update(s).digest("hex");
}

export function loadState(root) {
  const p = join(root, ".blaze", "state.json");
  if (!existsSync(p)) return { groomed: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return s && s.groomed ? s : { groomed: {} };
  } catch {
    return { groomed: {} };
  }
}

export function saveState(root, state) {
  const dir = join(root, ".blaze");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

export function selectNextTicket(root, cfg, state) {
  for (const col of cfg.loops.groomer.columns) {
    let files = [];
    try {
      files = readdirSync(join(root, col)).filter((f) => cfg.fileRegex.test(f));
    } catch {
      continue;
    }
    files.sort();
    for (const file of files) {
      const rel = `${col}/${file}`;
      const raw = readFileSync(join(root, rel), "utf8");
      const m = cfg.idLineRegex.exec(raw);
      if (!m) continue;
      const id = m[1];
      if (state.groomed[id] !== hashContent(raw)) return { id, file, col, rel, raw };
    }
  }
  return null;
}

export function extractGroomingRules(agentsMd) {
  const m = /## Grooming rules[\s\S]*?(?=\n## |\n# |$)/.exec(agentsMd || "");
  return m ? m[0].trim() : "";
}

export function buildPrompt(ticket, rules, cfg) {
  return [
    `You are grooming an issue-tracker ticket. Edit ONLY the file at ${ticket.rel} and no other file.`,
    `Use only these labels: ${cfg.defaultLabels.join(", ")}.`,
    ``,
    rules,
    ``,
    `--- ticket: ${ticket.rel} ---`,
    ticket.raw,
  ].join("\n");
}

export function parseChangedFiles(diffOut) {
  return diffOut.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function commitMessage(id, files) {
  return `chore(groom): ${id} ${files.length} file(s) groomed`;
}
```

- [ ] **Step 4: Run to verify the helper tests pass**

Run: `node --test tests/groomer.test.mjs`
Expected: PASS — all helper tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/loops/groomer.mjs tests/groomer.test.mjs
git commit -m "feat(groomer): pure helpers (select/prompt/state/commit-message)"
```

---

## Task 4: Groomer runner `groomOnce()` + CLI

**Files:**
- Modify: `scripts/loops/groomer.mjs`
- Test: `tests/groomer.test.mjs` (add the end-to-end test)

**Interfaces:**
- Consumes: the Task 3 helpers; `config.agentCommand`; `git`.
- Produces: `groomOnce({ root, cfg, agentsMd, today }) → event | null`, where `event` is one of:
  - `{ type: "groom", id, sha, files, ts }` (committed),
  - `{ type: "groom", id, noop: true, ts }` (agent made no change),
  - `{ type: "groom", id, error, ts }` (agent failed).
  Sets env `BLAZE_GROOM_TARGET=<rel path>` when spawning so scripted/stub agents know the file; real agents read the prompt. Returns `null` when nothing needs grooming.

- [ ] **Step 1: Write the failing end-to-end test (stub agent)**

Append to `tests/groomer.test.mjs`:

```javascript
import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";

function gitBoard() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-groom-e2e-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  // A stub "agent": reads BLAZE_GROOM_TARGET, flips empty labels to [backend].
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, '#!/usr/bin/env bash\nsed -i -E "s/^labels: \\[\\]/labels: [backend]/" "$BLAZE_GROOM_TARGET"\n');
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK",
    agentCommand: `bash ${stub}`,
    loops: { groomer: { columns: ["backlog"] } },
  }));
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"),
    "---\nid: TASK-001\ntitle: x\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  return dir;
}

test("groomOnce drives the stub agent and auto-commits one chore(groom) change", async () => {
  const { groomOnce } = await import("../scripts/loops/groomer.mjs");
  const dir = gitBoard();
  const cfg = loadConfig({ root: dir, env: {} });
  const evt = groomOnce({ root: dir, cfg, agentsMd: "## Grooming rules\n- add labels\n", today: "2026-06-27" });
  assert.equal(evt.type, "groom");
  assert.equal(evt.id, "TASK-001");
  assert.ok(evt.sha, "expected a commit sha");
  const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
  assert.match(log, /chore\(groom\): TASK-001/);
  const body = readFileSync(join(dir, "backlog", "TASK-001-x.md"), "utf8");
  assert.match(body, /labels: \[backend\]/);
  // Idempotent: the same ticket is now recorded as groomed.
  assert.equal(groomOnce({ root: dir, cfg, agentsMd: "## Grooming rules\n", today: "2026-06-27" }), null);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/groomer.test.mjs`
Expected: FAIL — `groomOnce` is not exported yet.

- [ ] **Step 3: Add `groomOnce` and the CLI to `scripts/loops/groomer.mjs`**

Add the imports `spawnSync, execFileSync` from `node:child_process` and `fileURLToPath` from `node:url` at the top, then append:

```javascript
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function groomOnce({ root, cfg, agentsMd, today }) {
  const state = loadState(root);
  const ticket = selectNextTicket(root, cfg, state);
  if (!ticket) return null;

  const prompt = buildPrompt(ticket, extractGroomingRules(agentsMd), cfg);
  const [cmd, ...args] = cfg.agentCommand.split(" ");
  const r = spawnSync(cmd, [...args, prompt], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BLAZE_GROOM_TARGET: ticket.rel },
  });
  if (r.status !== 0) {
    return { type: "groom", id: ticket.id, error: ((r.stderr || "agent command failed") + "").slice(0, 200), ts: today };
  }

  const diff = execFileSync("git", ["-C", root, "diff", "--name-only"], { encoding: "utf8" });
  const changed = parseChangedFiles(diff).filter((f) => cfg.columns.some((c) => f.startsWith(`${c}/`)));
  const record = () => {
    const raw = readFileSync(join(root, ticket.rel), "utf8");
    state.groomed[ticket.id] = hashContent(raw);
    saveState(root, state);
  };

  if (!changed.length) {
    record(); // mark groomed so we don't re-run on a no-op
    return { type: "groom", id: ticket.id, noop: true, ts: today };
  }

  execFileSync("git", ["-C", root, "add", ...changed]);
  execFileSync("git", ["-C", root, "commit", "-m", commitMessage(ticket.id, changed)]);
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  record();
  return { type: "groom", id: ticket.id, sha, files: changed, ts: today };
}

// CLI: `node scripts/loops/groomer.mjs` runs one grooming pass.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadConfig, ROOT } = await import("../config.mjs");
  const cfg = loadConfig();
  let agentsMd = "";
  try { agentsMd = readFileSync(join(ROOT, "AGENTS.md"), "utf8"); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const evt = groomOnce({ root: ROOT, cfg, agentsMd, today });
  console.log(evt ? JSON.stringify(evt) : "groomer: nothing to groom.");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/groomer.test.mjs`
Expected: PASS — helper tests and the end-to-end stub-agent test pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/loops/groomer.mjs tests/groomer.test.mjs
git commit -m "feat(groomer): groomOnce — spawn agent, auto-commit, record state; CLI"
```

---

## Task 5: Supervisor — server, board page, activity feed (SSE)

**Files:**
- Create: `scripts/supervisor.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `ROOT` (config.mjs); `pageHtml`, `contentHash` (serve.mjs); `createBus` (event-bus.mjs); `reconcile` (reconcile.mjs); `groomOnce` (groomer.mjs).
- Produces: `createApp(cfg, { root = ROOT } = {}) → { server, bus, startLoop, stopLoop, runReconcile, runGroomer }`. The HTTP server serves `/` (board + control strip + activity feed), `/api/hash`, `/events` (SSE), and the control routes (Task 6). This task wires `/`, `/api/hash`, `/events`, and the front-end activity feed; Task 6 adds the loop manager + control routes.

- [ ] **Step 1: Create `scripts/supervisor.mjs` (server + SSE + page injection)**

```javascript
#!/usr/bin/env node
// supervisor.mjs — boots the Blaze app: serves the board + activity feed and runs
// the loops. All loop effects go through git on the board repo.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ROOT } from "./config.mjs";
import { pageHtml, contentHash } from "./serve.mjs";
import { createBus } from "./event-bus.mjs";
import { reconcile } from "./reconcile.mjs";
import { groomOnce } from "./loops/groomer.mjs";
import { execFileSync } from "node:child_process";

const today = () => new Date().toISOString().slice(0, 10);

// ---- the control strip + activity feed injected into the board page ----
const CONTROLS_HTML = `
  <section id="blaze-app">
    <div class="ctl-strip">
      <strong>Loops</strong>
      <span class="ctl-group" data-loop="reconcile">reconcile
        <button data-act="start">▶</button><button data-act="stop">⏸</button><button data-act="run">run</button>
      </span>
      <span class="ctl-group" data-loop="groomer">groomer
        <button data-act="start">▶</button><button data-act="stop">⏸</button><button data-act="run">run</button>
      </span>
      <span id="conn" class="sub">● live</span>
    </div>
    <ol id="activity" class="activity"></ol>
  </section>
  <style>
    #blaze-app { padding: 0 20px 8px; }
    .ctl-strip { display:flex; align-items:center; gap:12px; flex-wrap:wrap;
      padding:8px 10px; background:#161b22; border:1px solid #21262d; border-radius:8px; }
    .ctl-group { color:#adbac7; font-size:12px; }
    .ctl-strip button { appearance:none; border:0; cursor:pointer; font:inherit; font-size:11px;
      margin-left:3px; padding:2px 8px; border-radius:6px; color:var(--charcoal); background:var(--blaze-orange); }
    .ctl-strip button:hover { background:var(--blaze-red); color:var(--neutral); }
    #conn { margin-left:auto; color:var(--blaze-orange); }
    .activity { list-style:none; margin:8px 0 0; padding:0; max-height:180px; overflow:auto;
      font-size:12px; font-family:ui-monospace, monospace; }
    .activity li { padding:4px 8px; border-bottom:1px solid #21262d; color:#adbac7; display:flex; gap:8px; }
    .activity .revert { margin-left:auto; cursor:pointer; color:var(--blaze-orange); background:none; border:0; font:inherit; }
  </style>`;

const ACTIVITY_SCRIPT = `
  <script>
    const act = document.getElementById("activity");
    const conn = document.getElementById("conn");
    function line(e) {
      const li = document.createElement("li");
      let txt = e.type;
      if (e.type === "reconcile") txt = e.id + ": " + e.from + " → " + e.to;
      else if (e.type === "groom") txt = e.error ? ("groom " + e.id + " failed: " + e.error)
        : e.noop ? ("groom " + e.id + ": no change") : ("groom " + e.id + " (" + (e.files||[]).length + " file)");
      else if (e.type === "status") txt = e.loop + " " + e.state;
      else if (e.type === "error") txt = (e.loop||"") + " error: " + e.message;
      li.innerHTML = "<span>" + (e.ts||"") + "</span><span>" + txt + "</span>";
      if (e.type === "groom" && e.sha) {
        const b = document.createElement("button");
        b.className = "revert"; b.textContent = "↩ revert";
        b.onclick = () => fetch("/control/revert", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ sha: e.sha }) });
        li.appendChild(b);
      }
      act.prepend(li);
      while (act.children.length > 100) act.removeChild(act.lastChild);
    }
    const es = new EventSource("/events");
    es.onmessage = (m) => { try { line(JSON.parse(m.data)); } catch {} };
    es.onerror = () => { conn.textContent = "● offline"; };
    es.onopen = () => { conn.textContent = "● live"; };
    document.querySelectorAll(".ctl-group").forEach((g) =>
      g.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () =>
          fetch("/control/" + g.dataset.loop + "/" + b.dataset.act, { method: "POST" }))));
  </script>`;

export function createApp(cfg, { root = ROOT } = {}) {
  const bus = createBus();

  function runReconcile() { /* implemented in Task 6 */ }
  function runGroomer() { /* implemented in Task 6 */ }
  function startLoop() { /* implemented in Task 6 */ }
  function stopLoop() { /* implemented in Task 6 */ }

  const server = createServer((req, res) => {
    if (req.url === "/api/hash") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(contentHash());
      return;
    }
    if (req.url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const off = bus.subscribe((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
      const hb = setInterval(() => res.write(": hb\n\n"), 15000);
      req.on("close", () => { clearInterval(hb); off(); });
      return;
    }
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pageHtml({ afterHeader: CONTROLS_HTML, beforeBodyEnd: ACTIVITY_SCRIPT }));
      return;
    }
    // Control routes are added in Task 6.
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  return { server, bus, startLoop, stopLoop, runReconcile, runGroomer };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  const port = Number(process.env.PORT) || cfg.port;
  app.server.listen(port, () => console.log(`${cfg.boardTitle} app → http://localhost:${port}`));
}
```

- [ ] **Step 2: Manual verification**

Run: `node scripts/supervisor.mjs` then open `http://localhost:4321`.
Expected: the board renders with a "Loops" control strip and an (empty) activity feed; the `● live` indicator shows. Stop with Ctrl-C.

- [ ] **Step 3: Commit**

```bash
git add scripts/supervisor.mjs
git commit -m "feat(supervisor): app server with board, SSE activity feed, controls UI"
```

---

## Task 6: Supervisor — loop manager, control API, revert

**Files:**
- Modify: `scripts/supervisor.mjs`
- Test: `tests/supervisor.test.mjs`

**Interfaces:**
- Consumes: `reconcile`, `groomOnce`, the bus.
- Produces: working `runReconcile`/`runGroomer`/`startLoop`/`stopLoop`; control routes `POST /control/:loop/:action` (`start|stop|run`) and `POST /control/revert` (`{ sha }`). Each loop action publishes a `status`/result event to the bus. The groomer never runs concurrently with itself; reconcile never runs concurrently with itself.

- [ ] **Step 1: Write the failing integration test**

Create `tests/supervisor.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/config.mjs";
import { createApp } from "../scripts/supervisor.mjs";

function gitBoard() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-sup-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, '#!/usr/bin/env bash\nsed -i -E "s/^labels: \\[\\]/labels: [backend]/" "$BLAZE_GROOM_TARGET"\n');
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK", agentCommand: `bash ${stub}`, loops: { groomer: { columns: ["backlog"] } },
  }));
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"),
    "---\nid: TASK-001\ntitle: x\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n");
  for (const a of [["init","-q"],["config","user.email","t@t"],["config","user.name","t"],["add","-A"],["commit","-q","-m","seed"]])
    execFileSync("git", ["-C", dir, ...a]);
  return dir;
}

function sseFirstEvent(port) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request({ port, path: "/events" }, (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          const m = buf.match(/data: (.*)\n\n/);
          if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  });
}

function post(port, path) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request({ port, path, method: "POST" }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.end();
    });
  });
}

test("control/groomer/run publishes a groom event on the SSE stream and commits", async () => {
  const dir = gitBoard();
  const cfg = loadConfig({ root: dir, env: {} });
  const app = createApp(cfg, { root: dir });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;

  const eventP = sseFirstEvent(port);
  await new Promise((r) => setTimeout(r, 50)); // let the stream attach before publishing
  await post(port, "/control/groomer/run");
  const evt = await eventP;

  assert.equal(evt.type, "groom");
  assert.equal(evt.id, "TASK-001");
  const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
  assert.match(log, /chore\(groom\): TASK-001/);

  app.server.close();
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/supervisor.test.mjs`
Expected: FAIL — `runGroomer` is a stub; no event is published, so the SSE promise never resolves (test times out / fails).

- [ ] **Step 3: Implement the loop manager + control routes**

In `scripts/supervisor.mjs`, replace the four stub functions inside `createApp` with real ones, and add the control routes. Replace the stub block:

```javascript
  const loops = { reconcile: { timer: null, busy: false }, groomer: { timer: null, busy: false } };

  function runReconcile() {
    if (!cfg.codeRepoPath || loops.reconcile.busy) return;
    loops.reconcile.busy = true;
    try {
      const r = reconcile({ fetch: true, commit: true, push: true });
      if (r && r.ok && r.changes) {
        for (const c of r.changes) bus.publish({ type: "reconcile", id: c.id, from: c.from, to: c.to, moved: c.moved, ts: today() });
      } else if (r && !r.ok) {
        bus.publish({ type: "error", loop: "reconcile", message: r.error, ts: today() });
      }
    } catch (e) {
      bus.publish({ type: "error", loop: "reconcile", message: e.message, ts: today() });
    } finally {
      loops.reconcile.busy = false;
    }
  }

  function runGroomer() {
    if (loops.groomer.busy) return;
    loops.groomer.busy = true;
    try {
      let agentsMd = "";
      try { agentsMd = readFileSync(join(root, "AGENTS.md"), "utf8"); } catch {}
      const evt = groomOnce({ root, cfg, agentsMd, today: today() });
      if (evt) bus.publish(evt);
    } catch (e) {
      bus.publish({ type: "error", loop: "groomer", message: e.message, ts: today() });
    } finally {
      loops.groomer.busy = false;
    }
  }

  function startLoop(name) {
    const fn = name === "reconcile" ? runReconcile : runGroomer;
    if (loops[name].timer) return;
    fn();
    loops[name].timer = setInterval(fn, cfg.loops[name].intervalSec * 1000);
    bus.publish({ type: "status", loop: name, state: "started", ts: today() });
  }

  function stopLoop(name) {
    if (loops[name].timer) { clearInterval(loops[name].timer); loops[name].timer = null; }
    bus.publish({ type: "status", loop: name, state: "stopped", ts: today() });
  }
```

Then, in the request handler, add the control routes immediately before the final 404:

```javascript
    const ctl = req.url && req.url.match(/^\/control\/(reconcile|groomer)\/(start|stop|run)$/);
    if (ctl && req.method === "POST") {
      const [, name, action] = ctl;
      if (action === "start") startLoop(name);
      else if (action === "stop") stopLoop(name);
      else (name === "reconcile" ? runReconcile : runGroomer)();
      res.writeHead(204); res.end();
      return;
    }
    if (req.url === "/control/revert" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { sha } = JSON.parse(body || "{}");
          execFileSync("git", ["-C", root, "revert", "--no-edit", sha]);
          bus.publish({ type: "status", loop: "groomer", state: `reverted ${sha.slice(0, 7)}`, ts: today() });
        } catch (e) {
          bus.publish({ type: "error", loop: "groomer", message: `revert failed: ${e.message}`, ts: today() });
        }
        res.writeHead(204); res.end();
      });
      return;
    }
```

- [ ] **Step 4: Auto-start enabled loops in the `if main` block**

Update the direct-execution block at the bottom so enabled loops start when the app launches:

```javascript
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  const port = Number(process.env.PORT) || cfg.port;
  app.server.listen(port, () => {
    console.log(`${cfg.boardTitle} app → http://localhost:${port}`);
    if (cfg.loops.reconcile.enabled && cfg.codeRepoPath) app.startLoop("reconcile");
    if (cfg.loops.groomer.enabled) app.startLoop("groomer");
  });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test tests/supervisor.test.mjs`
Expected: PASS — the groom event arrives on the SSE stream and the commit lands.

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: PASS — all tests across `tests/` pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/supervisor.mjs tests/supervisor.test.mjs
git commit -m "feat(supervisor): loop manager, control API, revert; auto-start loops"
```

---

## Task 7: CLI + bin (`scripts/cli.mjs`, `package.json`)

**Files:**
- Create: `scripts/cli.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: the `blaze` command. `blaze` / `blaze start` → supervisor (the app); `blaze board` → standalone viewer; `blaze reconcile` → one reconcile; `blaze groom` → one groomer pass; `blaze new "Title"` → scaffolder. Passes through extra args and the child's exit code.

- [ ] **Step 1: Create `scripts/cli.mjs`**

```javascript
#!/usr/bin/env node
// cli.mjs — the `blaze` command. Dispatches to the scripts.
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const node = (file, args = []) => spawnSync(process.execPath, [join(here, file), ...args], { stdio: "inherit" });
const bash = (file, args = []) => spawnSync("bash", [join(here, file), ...args], { stdio: "inherit" });

let r;
switch (cmd) {
  case undefined:
  case "start": r = node("supervisor.mjs"); break;
  case "board": r = node("serve.mjs"); break;
  case "reconcile": r = node("reconcile.mjs", rest); break;
  case "groom": r = node("loops/groomer.mjs", rest); break;
  case "new": r = bash("new-ticket.sh", rest); break;
  default:
    console.log("usage: blaze [start|board|reconcile|groom|new]");
    process.exit(1);
}
process.exit(r.status ?? 0);
```

Make it executable: `chmod +x scripts/cli.mjs`.

- [ ] **Step 2: Update `package.json`**

Add the `bin` field and the `start`/`groom` scripts (keep the existing `board`/`new`/`reconcile`/`test`):

```json
{
  "name": "blaze-board",
  "version": "0.1.0",
  "description": "A file-based, git-native issue board that AI coding agents can drive. Tickets are markdown; status is the directory.",
  "type": "module",
  "bin": { "blaze": "scripts/cli.mjs" },
  "scripts": {
    "start": "node scripts/supervisor.mjs",
    "board": "node scripts/serve.mjs",
    "new": "bash scripts/new-ticket.sh",
    "reconcile": "node scripts/reconcile.mjs",
    "groom": "node scripts/loops/groomer.mjs",
    "test": "node --test"
  },
  "engines": { "node": ">=16" },
  "license": "MIT"
}
```

- [ ] **Step 3: Verify the CLI dispatches**

Run: `node scripts/cli.mjs new "CLI smoke test"` then `ls backlog/`
Expected: a new `TASK-00N-cli-smoke-test.md` appears. (Delete it afterward if you like: `git rm` or `rm`.)
Run: `node scripts/cli.mjs` (no args) starts the app on the configured port; Ctrl-C to stop.

- [ ] **Step 4: Commit**

```bash
git add scripts/cli.mjs package.json
git commit -m "feat(cli): blaze command (start/board/reconcile/groom/new)"
```

---

## Task 8: Claude Code plugin (`.claude/`)

**Files:**
- Create: `.claude/commands/blaze-new.md`, `.claude/commands/blaze-board.md`, `.claude/commands/blaze-reconcile.md`, `.claude/commands/blaze-groom.md`
- Create: `.claude/skills/blaze/SKILL.md`

**Interfaces:**
- Produces: Claude Code slash commands and a skill that drive the board via the scripts. No unit test (markdown manifests); verified structurally.

- [ ] **Step 1: Create the slash commands**

`.claude/commands/blaze-new.md`:

```markdown
---
description: Scaffold a new Blaze ticket in backlog/ from a title.
---

Run `npm run new -- "$ARGUMENTS"` from the board repo root to scaffold the next
ticket into `backlog/`, then report the created file path. If `$ARGUMENTS` is empty,
ask the user for a ticket title first.
```

`.claude/commands/blaze-board.md`:

```markdown
---
description: Open the Blaze board (standalone viewer).
---

Run `npm run board` to serve the read-only board, and tell the user the URL
(http://localhost:4321 by default). For the full app with live agent activity and
controls, use `npm start` (the supervisor) instead.
```

`.claude/commands/blaze-reconcile.md`:

```markdown
---
description: Sync the board to the code repo's git/PR state (mirror mode).
---

Run `npm run reconcile` to mirror the configured `codeRepo`'s branches and PRs onto
the board. In standalone mode (`codeRepo: null`) this is a no-op — tell the user to set
`codeRepo` in `blaze.config.json` if they expected moves.
```

`.claude/commands/blaze-groom.md`:

```markdown
---
description: Run one groomer pass over the backlog.
---

Run `npm run groom` to have the configured agent triage/label/flesh-out the next
ungroomed ticket and auto-commit the change. Report the resulting event (the ticket id
and whether it committed, was a no-op, or errored).
```

- [ ] **Step 2: Create the skill**

`.claude/skills/blaze/SKILL.md`:

```markdown
---
name: blaze
description: Use when working in a Blaze board repo — creating, moving, or grooming tickets, or wiring the board to a code repo. Explains the directory-is-status model and the reconcile/groomer loops.
---

# Driving a Blaze board

Blaze is a file-based issue board: a ticket's status is the directory it sits in
(`backlog → todo → in-progress → in-review → done`, plus `canceled`/`duplicate`). The
full contract is in the repo's `AGENTS.md` — read it before acting.

- **Create:** `npm run new -- "Title"` (or `/blaze-new`). Move with `git mv` to change
  status.
- **Mirror a code repo:** set `codeRepo` + `key` in `blaze.config.json`; `npm run
  reconcile` (or `/blaze-reconcile`) drives `in-progress → in-review → done` from branch
  + PR state. The `<key>-<n>` in a branch name is the only link.
- **Groom:** `npm run groom` (or `/blaze-groom`) runs the agentic board-keeper over the
  backlog per `AGENTS.md` → "Grooming rules", auto-committing each change.
- **Run the app:** `npm start` boots the supervisor — the board, a live activity feed,
  and loop controls — at http://localhost:4321.

Never hand-move a ticket through the reconcile-owned columns; let reconcile do it.
```

- [ ] **Step 3: Verify the structure**

Run: `ls .claude/commands/ && ls .claude/skills/blaze/`
Expected: the four command files and `SKILL.md` are present.

- [ ] **Step 4: Commit**

```bash
git add .claude
git commit -m "feat(plugin): Claude Code commands + skill for driving the board"
```

---

## Done criteria (Plan 2)

- `blaze` (or `npm start`) boots the app: the brand-styled board, a live activity feed
  (reconcile moves + groom commits stream in), and start/stop/run controls + per-commit
  revert.
- The groomer drives `config.agentCommand` over the backlog and auto-commits each change
  as `chore(groom): <id> …`; reconcile mirrors git/PR state (no-op standalone).
- `node --test` passes with zero dependencies.
- The `.claude/` plugin exposes `/blaze-new`, `/blaze-board`, `/blaze-reconcile`,
  `/blaze-groom` and the `blaze` skill.

**Blaze is feature-complete** against `docs/design.md`. Remaining optional follow-ups
(all deferred by YAGNI in the spec): code-writing worker loops, an embedded-SDK agent
provider, a GitLab/Forgejo reconcile provider, and an MCP server.
```
