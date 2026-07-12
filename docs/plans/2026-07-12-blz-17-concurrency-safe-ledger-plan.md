# BLZ-17 Concurrency-Safe Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallel sessions driving one blaze board stop bundling each other's WIP and stop racing the git index — per-session pending queues, own-queue-only `blaze commit` (+ `--all`), an advisory mkdir commit lock, and a no-network staleness warning.

**Architecture:** Plain-file coordination in the engine (`@hjr15/blaze-board` v0.4.0), per the approved design (`blaze-pm/docs/plans/2026-07-12-blz-17-concurrency-safe-ledger-design.md`) and ADR-0009 (`blaze-pm/docs/decisions/0009-concurrency-safe-ledger-plain-file-coordination.md`). Queues are `.blaze/pending/<session>.jsonl` keyed by `BLAZE_SESSION` with the legacy `.blaze/pending-commit.jsonl` as shared fallback; the lock is an atomically-`mkdir`ed `.blaze/commit.lock/` wrapping the two git-write surfaces. Divergence handling stays at the push seam (daily bundler in `claude-config`) — the engine never pushes.

**Tech Stack:** Node 20 built-ins only (`node:fs`, `node:child_process`, `node:test`), zero runtime dependencies, c8 coverage.

**Board mapping:** Tasks 1–9 = blaze tickets **BLZ-74…BLZ-82** (parent epic BLZ-17, board in `~/Documents/Code/blaze-pm`). Commit messages use the task's ticket key.

## Global Constraints

- Engine repo: `~/Documents/Code/blaze` (`hjr15/blaze`). Branch: `BLZ-17-concurrency-safe-ledger`; one PR for the epic. Prefer an isolated git worktree for execution.
- Node `>=20`, **zero runtime dependencies** — Node built-ins only (ADR-0001).
- `BLAZE_SESSION` **unset ⇒ behavior identical to v0.3.0** (shared fallback queue, same path). Existing tests must pass unchanged.
- Never `git add -A` / never stage beyond recorded files; the engine **never pushes**.
- Tests: `npm test` (`node --test`). Coverage gate: `npm run test:coverage` (c8: statements 91, branches 77, functions 93, lines 91). `scripts/cli.mjs` and `scripts/*-runner.mjs` are coverage-excluded; runner behavior is proven by spawning it (existing idiom in `tests/commit-runner.test.mjs`).
- TDD, vertical slices: failing test → minimal impl → pass → commit. One commit per task, message `BLZ-<n>: <description>`.
- Session id sanitization: keep `[A-Za-z0-9._-]`, strip the rest; empty-after-sanitize = unset.

---

### Task 1 (BLZ-74): Per-session queues in pending-ledger

**Files:**
- Modify: `scripts/pending-ledger.mjs`
- Test: `tests/pending-ledger.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact signatures):
  - `sessionId(env = process.env) → string | null`
  - `ledgerPath(root, session = null) → string`
  - `appendEntry(root, entry, session = null) → void`
  - `readEntries(root, session = null) → object[]`
  - `clearLedger(root, session = null) → void`
  - `listQueues(root) → Array<{session: string|null, path: string}>` (fallback first, then session queues sorted by name)

- [ ] **Step 1: Write the failing tests** — append to `tests/pending-ledger.test.mjs`:

```js
import { sessionId, listQueues } from "../scripts/pending-ledger.mjs";

test("sessionId: set, dirty, empty, unset", () => {
  assert.equal(sessionId({ BLAZE_SESSION: "alpha-1" }), "alpha-1");
  assert.equal(sessionId({ BLAZE_SESSION: "a b/c$!" }), "abc");
  assert.equal(sessionId({ BLAZE_SESSION: "$$/ " }), null);
  assert.equal(sessionId({}), null);
});

test("ledgerPath: session-keyed vs legacy fallback", () => {
  assert.match(ledgerPath("/r"), /\.blaze\/pending-commit\.jsonl$/);
  assert.match(ledgerPath("/r", "alpha"), /\.blaze\/pending\/alpha\.jsonl$/);
});

test("session queues are isolated from each other and the fallback", () => {
  const root = tmp();
  const mk = (id, session) => ({ id, op: "new", message: `${id}: create`, files: [`projects/X/backlog/${id}.md`], ts: "t", ...(session ? { session } : {}) });
  appendEntry(root, mk("X-1", "a"), "a");
  appendEntry(root, mk("X-2", "b"), "b");
  appendEntry(root, mk("X-3", null));
  assert.equal(readEntries(root, "a").length, 1);
  assert.equal(readEntries(root, "a")[0].id, "X-1");
  assert.equal(readEntries(root, "b")[0].id, "X-2");
  assert.equal(readEntries(root)[0].id, "X-3");
  clearLedger(root, "a");
  assert.deepEqual(readEntries(root, "a"), []);
  assert.equal(readEntries(root, "b").length, 1);
  assert.equal(readEntries(root).length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("listQueues: fallback first, then session queues sorted", () => {
  const root = tmp();
  assert.deepEqual(listQueues(root), []);
  appendEntry(root, { id: "X-2", op: "new", message: "m", files: [], ts: "t", session: "beta" }, "beta");
  appendEntry(root, { id: "X-1", op: "new", message: "m", files: [], ts: "t", session: "alpha" }, "alpha");
  appendEntry(root, { id: "X-3", op: "new", message: "m", files: [], ts: "t" });
  const qs = listQueues(root);
  assert.deepEqual(qs.map((q) => q.session), [null, "alpha", "beta"]);
  assert.ok(qs.every((q) => q.path.endsWith(".jsonl")));
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Documents/Code/blaze && node --test tests/pending-ledger.test.mjs`
Expected: FAIL — `sessionId`/`listQueues` are not exported.

- [ ] **Step 3: Implement** — replace `scripts/pending-ledger.mjs` with:

```js
// scripts/pending-ledger.mjs — append-only JSONL ledgers of pending board ops
// for batch commit mode. One queue per session (keyed by BLAZE_SESSION) under
// .blaze/pending/, plus the legacy shared fallback .blaze/pending-commit.jsonl
// for callers with no session set. All gitignored; drained by `blaze commit`.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

// Sanitized BLAZE_SESSION, or null when unset/empty-after-sanitize.
export function sessionId(env = process.env) {
  const clean = (env.BLAZE_SESSION || "").replace(/[^A-Za-z0-9._-]/g, "");
  return clean === "" ? null : clean;
}

export function ledgerPath(root, session = null) {
  return session
    ? join(root, ".blaze", "pending", `${session}.jsonl`)
    : join(root, ".blaze", "pending-commit.jsonl");
}

export function appendEntry(root, entry, session = null) {
  const path = ledgerPath(root, session);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n"); // append-mode: atomic for the small single-line writes this ledger produces
}

export function readEntries(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partial final line (process killed mid-append) or a corrupt line:
      // skip rather than throw so a good ledger still drains. Warn so the drop is visible.
      process.stderr.write("blaze: skipping unparseable pending-commit ledger line\n");
    }
  }
  return out;
}

export function clearLedger(root, session = null) {
  const path = ledgerPath(root, session);
  if (existsSync(path)) writeFileSync(path, "");
}

// Every queue that exists: the shared fallback first (session: null), then
// each .blaze/pending/<session>.jsonl sorted by session name.
export function listQueues(root) {
  const queues = [];
  if (existsSync(ledgerPath(root))) queues.push({ session: null, path: ledgerPath(root) });
  const dir = join(root, ".blaze", "pending");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      queues.push({ session: f.slice(0, -".jsonl".length), path: join(dir, f) });
    }
  }
  return queues;
}
```

- [ ] **Step 4: Run tests to verify they pass** (and old tests still pass)

Run: `node --test tests/pending-ledger.test.mjs`
Expected: PASS, including the four pre-existing tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/pending-ledger.mjs tests/pending-ledger.test.mjs
git commit -m "BLZ-74: per-session pending queues in pending-ledger" -- scripts/pending-ledger.mjs tests/pending-ledger.test.mjs
```

---

### Task 2 (BLZ-75): Session stamping in commit-or-queue

**Files:**
- Modify: `scripts/commit-or-queue.mjs`
- Test: `tests/commit-or-queue.test.mjs`

**Interfaces:**
- Consumes: `sessionId()`, `appendEntry(root, entry, session)` from Task 1.
- Produces: batch-mode queue entries carry a `session` field when `BLAZE_SESSION` is set and land in that session's queue file; unset-env behavior byte-identical to v0.3.0.

- [ ] **Step 1: Write the failing test** — append to `tests/commit-or-queue.test.mjs` (match the file's existing imports/helpers; add these tests using a temp dir helper like the ledger tests):

```js
import { readEntries } from "../scripts/pending-ledger.mjs";

test("batch mode routes to the session queue and stamps session", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  const prev = process.env.BLAZE_SESSION;
  process.env.BLAZE_SESSION = "alpha";
  try {
    commitOrQueue({ root, mode: "batch", op: "new", id: "X-1", message: "X-1: create", files: [join(root, "projects/X/backlog/X-1.md")] });
  } finally {
    if (prev === undefined) delete process.env.BLAZE_SESSION; else process.env.BLAZE_SESSION = prev;
  }
  assert.deepEqual(readEntries(root), []); // fallback untouched
  const entries = readEntries(root, "alpha");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].session, "alpha");
  assert.equal(entries[0].id, "X-1");
  rmSync(root, { recursive: true, force: true });
});

test("batch mode without BLAZE_SESSION keeps the legacy queue with no session field", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-coq-"));
  const prev = process.env.BLAZE_SESSION;
  delete process.env.BLAZE_SESSION;
  try {
    commitOrQueue({ root, mode: "batch", op: "new", id: "X-2", message: "X-2: create", files: [join(root, "projects/X/backlog/X-2.md")] });
  } finally {
    if (prev !== undefined) process.env.BLAZE_SESSION = prev;
  }
  const entries = readEntries(root);
  assert.equal(entries.length, 1);
  assert.equal("session" in entries[0], false);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/commit-or-queue.test.mjs`
Expected: FAIL — entry lands in the fallback queue / no `session` field.

- [ ] **Step 3: Implement** — in `scripts/commit-or-queue.mjs`, change the import and the batch branch:

```js
import { appendEntry, sessionId } from "./pending-ledger.mjs";
```

and inside `commitOrQueue`:

```js
  if (mode === "batch") {
    const session = sessionId();
    appendEntry(root, {
      id,
      op,
      message,
      files: unique.map((f) => relative(root, f)),
      ts: new Date().toISOString(),
      ...(session ? { session } : {}),
    }, session);
    return { ok: true, queued: true };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/commit-or-queue.test.mjs tests/runner-batch.test.mjs`
Expected: PASS (runner-batch proves unset-env back-compat end to end).

- [ ] **Step 5: Commit**

```bash
git add scripts/commit-or-queue.mjs tests/commit-or-queue.test.mjs
git commit -m "BLZ-75: batch ops queue to the caller's session ledger" -- scripts/commit-or-queue.mjs tests/commit-or-queue.test.mjs
```

---

### Task 3 (BLZ-76): `blaze commit` drains own queue only; `--all` sweeps (repro-first)

**Files:**
- Modify: `scripts/commit-runner.mjs`
- Test: `tests/commit-runner.test.mjs`

**Interfaces:**
- Consumes: `readEntries/clearLedger/listQueues/sessionId` from Task 1.
- Produces: `blaze commit` (no args) drains the caller's queue only; `blaze commit --all` drains every queue + fallback; body lines for session-owned ops end with ` [<session>]`. Task 5 wraps this same runner in the lock.

- [ ] **Step 1: Extend the `runCommit` helper** in `tests/commit-runner.test.mjs` to control env (BLAZE_SESSION stripped unless provided) and args, capturing stderr:

```js
function runCommit(root, cwdSub, { session, args = [] } = {}) {
  const runner = join(root, "scripts", "commit-runner.mjs");
  const cwd = cwdSub ? join(root, cwdSub) : root;
  const env = { ...process.env, ...(session ? { BLAZE_SESSION: session } : {}) };
  if (!session) delete env.BLAZE_SESSION;
  const r = spawnSync(process.execPath, [runner, ...args], { cwd, env, encoding: "utf8" });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
```

Update the two existing call sites: `runCommit(root)` → `runCommit(root).stdout` where the return value is matched, and `runCommit(root, "projects/OBA")` stays valid (returns the object, result unused). Add `spawnSync` to the imports from `node:child_process`.

- [ ] **Step 2: Write the failing repro test** — this is the 2026-07-11 incident, asserted as *fixed* behavior (red on current code):

```js
test("REPRO OBA-484: default flush does NOT bundle a foreign session's queued ops", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-1.md"), "mine");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-2.md"), "foreign wip");
  appendEntry(root, { id: "OBA-1", op: "new", message: "OBA-1: mine", files: ["projects/OBA/backlog/OBA-1.md"], ts: "t", session: "me" }, "me");
  appendEntry(root, { id: "OBA-2", op: "new", message: "OBA-2: foreign", files: ["projects/OBA/backlog/OBA-2.md"], ts: "t", session: "sister" }, "sister");

  runCommit(root, null, { session: "me" });

  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(body, /OBA-1: mine \[me\]/);
  assert.doesNotMatch(body, /OBA-2/);
  const shown = execFileSync("git", ["-C", root, "show", "--stat", "--format=", "HEAD"], { encoding: "utf8" });
  assert.doesNotMatch(shown, /OBA-2\.md/);
  assert.equal(readEntries(root, "sister").length, 1); // sister's WIP still queued
  assert.deepEqual(readEntries(root, "me"), []);       // mine drained
  rmSync(root, { recursive: true, force: true });
});

test("unset session drains only the shared fallback queue", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-3.md"), "legacy");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-4.md"), "sessioned");
  appendEntry(root, { id: "OBA-3", op: "new", message: "OBA-3: legacy", files: ["projects/OBA/backlog/OBA-3.md"], ts: "t" });
  appendEntry(root, { id: "OBA-4", op: "new", message: "OBA-4: sessioned", files: ["projects/OBA/backlog/OBA-4.md"], ts: "t", session: "s1" }, "s1");
  runCommit(root);
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(body, /OBA-3: legacy/);
  assert.doesNotMatch(body, /OBA-4/);
  assert.equal(readEntries(root, "s1").length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("--all sweeps every queue + fallback into one commit with session-tagged body", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  for (const n of ["OBA-5", "OBA-6", "OBA-7"]) writeFileSync(join(root, "projects", "OBA", "backlog", `${n}.md`), n);
  appendEntry(root, { id: "OBA-5", op: "new", message: "OBA-5: a", files: ["projects/OBA/backlog/OBA-5.md"], ts: "t", session: "a" }, "a");
  appendEntry(root, { id: "OBA-6", op: "new", message: "OBA-6: b", files: ["projects/OBA/backlog/OBA-6.md"], ts: "t", session: "b" }, "b");
  appendEntry(root, { id: "OBA-7", op: "new", message: "OBA-7: legacy", files: ["projects/OBA/backlog/OBA-7.md"], ts: "t" });
  runCommit(root, null, { args: ["--all"] });
  const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  const body = execFileSync("git", ["-C", root, "log", "-1", "--format=%b"], { encoding: "utf8" });
  assert.match(subject, /\(3 new\)$/);
  assert.match(body, /OBA-5: a \[a\]/);
  assert.match(body, /OBA-6: b \[b\]/);
  assert.match(body, /- OBA-7: legacy(?!.*\[)/m);
  assert.deepEqual(readEntries(root, "a"), []);
  assert.deepEqual(readEntries(root, "b"), []);
  assert.deepEqual(readEntries(root), []);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `node --test tests/commit-runner.test.mjs`
Expected: repro test FAILS on current code (foreign ops get bundled — exactly the incident); `--all` test fails (unknown flag ignored + fallback-only drain).

- [ ] **Step 4: Implement** — replace `scripts/commit-runner.mjs` with:

```js
// scripts/commit-runner.mjs — `blaze commit`: drain the caller's OWN pending
// queue (session-keyed via BLAZE_SESSION, else the shared fallback) into ONE
// commit, staging only recorded files. `--all` sweeps every queue + fallback
// (the bundler / end-of-day path). A failed flush keeps the queue files.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readEntries, clearLedger, listQueues, sessionId } from "./pending-ledger.mjs";
import { resolveRoots } from "./config.mjs";

const { dataRoot } = resolveRoots();
const all = process.argv.slice(2).includes("--all");

// Which queues to drain: every existing queue with --all, else only the caller's own.
const targets = all ? listQueues(dataRoot) : [{ session: sessionId() }];
const drained = targets
  .map((q) => ({ session: q.session, entries: readEntries(dataRoot, q.session) }))
  .filter((q) => q.entries.length > 0);
const entries = drained.flatMap((q) => q.entries.map((e) => ({ ...e, session: q.session })));

if (entries.length === 0) {
  console.log("blaze commit: nothing to flush");
  process.exit(0);
}

// Counts by op → "2 new, 3 logged, 1 moved, 1 resolved"
const LABEL = { new: "new", log: "logged", move: "moved", resolve: "resolved" };
const counts = {};
for (const e of entries) counts[e.op] = (counts[e.op] || 0) + 1;
const summary = Object.entries(counts)
  .map(([op, n]) => `${n} ${LABEL[op] || op}`)
  .join(", ");

const date = new Date().toISOString().slice(0, 10);
const subject = `blaze: ${date} board update (${summary})`;
const body = entries.map((e) => `- ${e.message}${e.session ? ` [${e.session}]` : ""}`).join("\n");

// A path created then relocated again within one batch (e.g. a ticket moved
// twice) is neither on disk nor in HEAD by the time the batch drains — drop
// it, there is nothing to stage for it.
const isTracked = (f) =>
  spawnSync("git", ["-C", dataRoot, "ls-files", "--error-unmatch", "--", f], { stdio: "ignore" }).status === 0;
const files = [...new Set(entries.flatMap((e) => e.files))].filter(
  (f) => existsSync(join(dataRoot, f)) || isTracked(f),
);

const add = spawnSync("git", ["-C", dataRoot, "add", "--", ...files], { stdio: "ignore" });
if (add.status !== 0) {
  console.error(`blaze commit: git add failed (status ${add.status}) — ledger kept, resolve manually`);
  process.exit(1);
}
const commit = spawnSync("git", ["-C", dataRoot, "commit", "-m", subject, "-m", body, "--", ...files], { stdio: "inherit" });
if (commit.status !== 0) {
  console.error(`blaze commit: git commit failed (status ${commit.status}) — ledger kept, resolve manually`);
  process.exit(1);
}
for (const q of drained) clearLedger(dataRoot, q.session);
console.log(`blaze commit: flushed ${entries.length} op(s) → ${subject}`);
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — including the two pre-existing commit-runner tests (they queue to the fallback with no session, and the runner with no session drains exactly that).

- [ ] **Step 6: Commit**

```bash
git add scripts/commit-runner.mjs tests/commit-runner.test.mjs
git commit -m "BLZ-76: blaze commit drains own session queue only; --all sweeps every queue" -- scripts/commit-runner.mjs tests/commit-runner.test.mjs
```

---

### Task 4 (BLZ-77): Advisory commit lock module

**Files:**
- Create: `scripts/commit-lock.mjs`
- Test: `tests/commit-lock.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 5 relies on these exact signatures):
  - `lockPath(root) → string` (= `<root>/.blaze/commit.lock`)
  - `acquireLock(root, {session=null, pid=process.pid, retries=10, delayMs=200, staleMs=60000, now=Date.now} = {}) → {ok: true} | {ok: false, owner: object|null}`
  - `releaseLock(root) → void`

- [ ] **Step 1: Write the failing tests** — create `tests/commit-lock.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPath, acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "blaze-lock-")); }
const FAST = { retries: 2, delayMs: 10 };

test("acquire → release round-trip", () => {
  const root = tmp();
  assert.deepEqual(acquireLock(root, FAST), { ok: true });
  assert.ok(existsSync(join(lockPath(root), "owner.json")));
  releaseLock(root);
  assert.ok(!existsSync(lockPath(root)));
  rmSync(root, { recursive: true, force: true });
});

test("held by a live owner → bounded retry then ok:false with owner info", () => {
  const root = tmp();
  assert.equal(acquireLock(root, { ...FAST, session: "holder" }).ok, true);
  const r = acquireLock(root, FAST); // same live pid holds it
  assert.equal(r.ok, false);
  assert.equal(r.owner.session, "holder");
  assert.equal(r.owner.pid, process.pid);
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("stale: dead-pid owner is stolen", () => {
  const root = tmp();
  mkdirSync(lockPath(root), { recursive: true });
  writeFileSync(join(lockPath(root), "owner.json"), JSON.stringify({ pid: 999999999, session: "ghost", ts: new Date().toISOString() }));
  assert.equal(acquireLock(root, FAST).ok, true);
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("stale: aged-out live owner is stolen", () => {
  const root = tmp();
  const old = new Date(Date.now() - 120_000).toISOString();
  mkdirSync(lockPath(root), { recursive: true });
  writeFileSync(join(lockPath(root), "owner.json"), JSON.stringify({ pid: process.pid, session: "slow", ts: old }));
  assert.equal(acquireLock(root, { ...FAST, staleMs: 60_000 }).ok, true);
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("ownerless lock dir: fresh is respected, old is stolen", () => {
  const root = tmp();
  mkdirSync(lockPath(root), { recursive: true }); // no owner.json — acquirer mid-write
  assert.equal(acquireLock(root, FAST).ok, false); // fresh: treated as held
  const past = (Date.now() - 10_000) / 1000;
  utimesSync(lockPath(root), past, past);
  assert.equal(acquireLock(root, FAST).ok, true); // old ownerless: stolen
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/commit-lock.test.mjs`
Expected: FAIL — `scripts/commit-lock.mjs` does not exist.

- [ ] **Step 3: Implement** — create `scripts/commit-lock.mjs`:

```js
// scripts/commit-lock.mjs — advisory lock serializing board git writes.
// Plain-file: an atomically-mkdir'ed .blaze/commit.lock/ directory holding
// owner.json {pid, session, ts}. Bounded retry; stale locks (dead owner PID,
// aged out, or long-ownerless) are stolen with a warning. Zero-dependency.
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export function lockPath(root) {
  return join(root, ".blaze", "commit.lock");
}

function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function ownerAlive(owner) {
  if (!owner || typeof owner.pid !== "number") return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Sync sleep without spinning: Atomics.wait on a throwaway buffer.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// An EEXIST lock with no owner.json is an acquirer between mkdir and write —
// respect it briefly; steal only once the dir itself is clearly abandoned.
const OWNERLESS_GRACE_MS = 2_000;

export function acquireLock(root, {
  session = null,
  pid = process.pid,
  retries = 10,
  delayMs = 200,
  staleMs = 60_000,
  now = Date.now,
} = {}) {
  const dir = lockPath(root);
  mkdirSync(dirname(dir), { recursive: true }); // ensure .blaze/ exists
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      mkdirSync(dir); // atomic: throws EEXIST while held
      writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid, session, ts: new Date(now()).toISOString() }));
      return { ok: true };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = readOwner(dir);
      let stale;
      if (owner === null) {
        let dirAgeMs = 0;
        try { dirAgeMs = now() - statSync(dir).mtimeMs; } catch { /* vanished: retry */ }
        stale = dirAgeMs > OWNERLESS_GRACE_MS;
      } else {
        stale = !ownerAlive(owner) || now() - Date.parse(owner.ts) > staleMs;
      }
      if (stale) {
        process.stderr.write(`blaze: stealing stale commit.lock (owner pid ${owner?.pid ?? "unknown"})\n`);
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (attempt < retries) sleep(delayMs);
    }
  }
  return { ok: false, owner: readOwner(lockPath(root)) };
}

export function releaseLock(root) {
  rmSync(lockPath(root), { recursive: true, force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/commit-lock.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/commit-lock.mjs tests/commit-lock.test.mjs
git commit -m "BLZ-77: advisory mkdir commit lock with stale-steal" -- scripts/commit-lock.mjs tests/commit-lock.test.mjs
```

---

### Task 5 (BLZ-78): Serialize the git-write surfaces + concurrency proof

**Files:**
- Modify: `scripts/commit-runner.mjs`, `scripts/serve-commit.mjs`
- Test: `tests/commit-runner.test.mjs`, `tests/serve-commit.test.mjs`

**Interfaces:**
- Consumes: `acquireLock/releaseLock` (Task 4); Task 3's runner shape.
- Produces: `commitFile(root, file, message, extraFiles = [], lockOpts = {})` — new optional `lockOpts` forwarded to `acquireLock`; locked failure returns `{ ok: false, locked: true, status: -1 }`. Runner exits 1 with "commit.lock held" and keeps queues when locked out.

- [ ] **Step 1: Write the failing tests**

Append to `tests/serve-commit.test.mjs`:

```js
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

test("commitFile refuses instead of racing when the lock is held by a live owner", () => {
  const root = gitRepo(); // reuse this file's existing repo helper name — adapt if it differs
  assert.equal(acquireLock(root, { session: "other" }).ok, true);
  writeFileSync(join(root, "f.md"), "x");
  const r = commitFile(root, "f.md", "msg", [], { retries: 1, delayMs: 10 });
  assert.deepEqual(r, { ok: false, locked: true, status: -1 });
  releaseLock(root);
  const r2 = commitFile(root, "f.md", "msg");
  assert.equal(r2.ok, true);
  assert.ok(!existsSync(join(root, ".blaze", "commit.lock"))); // released after commit
  rmSync(root, { recursive: true, force: true });
});
```

Append to `tests/commit-runner.test.mjs`:

```js
import { execFile } from "node:child_process";
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

test("runner exits 1 and keeps the queue when the lock is held", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-8.md"), "x");
  appendEntry(root, { id: "OBA-8", op: "new", message: "OBA-8: x", files: ["projects/OBA/backlog/OBA-8.md"], ts: "t" });
  assert.equal(acquireLock(root, { session: "other" }).ok, true);
  const r = runCommit(root); // waits out the bounded retry (~2 s), then fails
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commit\.lock held/);
  assert.equal(readEntries(root).length, 1); // queue kept
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("two concurrent session flushes serialize: two clean commits, nothing lost", async () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-A.md"), "a");
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-B.md"), "b");
  appendEntry(root, { id: "OBA-A", op: "new", message: "OBA-A: a", files: ["projects/OBA/backlog/OBA-A.md"], ts: "t", session: "a" }, "a");
  appendEntry(root, { id: "OBA-B", op: "new", message: "OBA-B: b", files: ["projects/OBA/backlog/OBA-B.md"], ts: "t", session: "b" }, "b");
  const run = (session) => new Promise((res, rej) => {
    const env = { ...process.env, BLAZE_SESSION: session };
    execFile(process.execPath, [join(root, "scripts", "commit-runner.mjs")], { cwd: root, env, encoding: "utf8" },
      (err, stdout, stderr) => (err ? rej(Object.assign(err, { stdout, stderr })) : res({ stdout, stderr })));
  });
  await Promise.all([run("a"), run("b")]);
  const count = execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(count, "3"); // seed + one commit per session
  const log = execFileSync("git", ["-C", root, "log", "--format=%b", "-2"], { encoding: "utf8" });
  assert.match(log, /OBA-A: a \[a\]/);
  assert.match(log, /OBA-B: b \[b\]/);
  assert.deepEqual(readEntries(root, "a"), []);
  assert.deepEqual(readEntries(root, "b"), []);
  assert.ok(!existsSync(join(root, ".blaze", "commit.lock")));
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/commit-runner.test.mjs tests/serve-commit.test.mjs`
Expected: new tests FAIL (`commitFile` has no lock handling; runner never mentions commit.lock).

- [ ] **Step 3: Implement**

`scripts/serve-commit.mjs` — full replacement:

```js
// scripts/serve-commit.mjs — commit exactly one file, locally, never push.
// The board's only per-op git surface. Deliberately NOT `git add -A` (that
// would sweep unrelated working-tree changes on the real 765-ticket tree).
// Serialized against concurrent flushes via the advisory commit lock.
import { spawnSync } from "node:child_process";
import { acquireLock, releaseLock } from "./commit-lock.mjs";

export function commitFile(root, file, message, extraFiles = [], lockOpts = {}) {
  const lock = acquireLock(root, lockOpts);
  if (!lock.ok) return { ok: false, locked: true, status: -1 };
  try {
    const filesToAdd = [file, ...extraFiles];
    const add = spawnSync("git", ["-C", root, "add", ...filesToAdd], { stdio: "ignore" });
    if (add.status !== 0) return { ok: false, status: add.status };
    const commit = spawnSync("git", ["-C", root, "commit", "-m", message, "--", ...filesToAdd], { stdio: "ignore" });
    // status 1 with nothing to commit is a benign no-op (idempotent re-write).
    if (commit.status !== 0) {
      const clean = spawnSync("git", ["-C", root, "diff", "--cached", "--quiet"], { stdio: "ignore" });
      if (clean.status === 0) return { ok: true, status: 0 };
      return { ok: false, status: commit.status };
    }
    return { ok: true, status: 0 };
  } finally {
    releaseLock(root);
  }
}
```

`scripts/commit-runner.mjs` — add the import and wrap the git section (after the `files` computation from Task 3):

```js
import { acquireLock, releaseLock } from "./commit-lock.mjs";
```

```js
const lock = acquireLock(dataRoot, { session: sessionId() });
if (!lock.ok) {
  console.error(`blaze commit: commit.lock held by pid ${lock.owner?.pid ?? "?"} (session ${lock.owner?.session ?? "?"}) — try again shortly; ledger kept`);
  process.exit(1);
}
try {
  const add = spawnSync("git", ["-C", dataRoot, "add", "--", ...files], { stdio: "ignore" });
  if (add.status !== 0) {
    console.error(`blaze commit: git add failed (status ${add.status}) — ledger kept, resolve manually`);
    process.exit(1);
  }
  const commit = spawnSync("git", ["-C", dataRoot, "commit", "-m", subject, "-m", body, "--", ...files], { stdio: "inherit" });
  if (commit.status !== 0) {
    console.error(`blaze commit: git commit failed (status ${commit.status}) — ledger kept, resolve manually`);
    process.exit(1);
  }
  for (const q of drained) clearLedger(dataRoot, q.session);
  console.log(`blaze commit: flushed ${entries.length} op(s) → ${subject}`);
} finally {
  releaseLock(dataRoot);
}
```

(Note `process.exit` inside `try` still runs nothing after — the `finally` releases the lock before the process dies because V8 runs finally on exit? It does NOT. Use explicit release before each `process.exit(1)` instead of relying on `finally`:)

```js
const bail = (msg) => {
  console.error(msg);
  releaseLock(dataRoot);
  process.exit(1);
};
const add = spawnSync("git", ["-C", dataRoot, "add", "--", ...files], { stdio: "ignore" });
if (add.status !== 0) bail(`blaze commit: git add failed (status ${add.status}) — ledger kept, resolve manually`);
const commit = spawnSync("git", ["-C", dataRoot, "commit", "-m", subject, "-m", body, "--", ...files], { stdio: "inherit" });
if (commit.status !== 0) bail(`blaze commit: git commit failed (status ${commit.status}) — ledger kept, resolve manually`);
for (const q of drained) clearLedger(dataRoot, q.session);
releaseLock(dataRoot);
console.log(`blaze commit: flushed ${entries.length} op(s) → ${subject}`);
```

Use the `bail` form (no try/finally) — it is exit-safe and simpler.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS, including the concurrency test.

- [ ] **Step 5: Commit**

```bash
git add scripts/commit-runner.mjs scripts/serve-commit.mjs tests/commit-runner.test.mjs tests/serve-commit.test.mjs
git commit -m "BLZ-78: serialize git-write surfaces with the commit lock" -- scripts/commit-runner.mjs scripts/serve-commit.mjs tests/commit-runner.test.mjs tests/serve-commit.test.mjs
```

---

### Task 6 (BLZ-79): Staleness warning when origin/main is ahead

**Files:**
- Modify: `scripts/commit-runner.mjs`
- Test: `tests/commit-runner.test.mjs`

**Interfaces:**
- Consumes: Task 3/5 runner shape.
- Produces: stderr warning `blaze commit: warning — N commit(s) behind origin/main (no fetch run); rebase before publishing` when the already-fetched `origin/main` ref is ahead; the commit still happens; exit stays 0.

- [ ] **Step 1: Write the failing test** — append to `tests/commit-runner.test.mjs`:

```js
test("warns (stderr) when origin/main is ahead, and still commits", () => {
  const root = gitRepo();
  // Fabricate an already-fetched origin/main one commit ahead of HEAD.
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-q", "-m", "remote-only"]);
  execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
  execFileSync("git", ["-C", root, "reset", "-q", "--hard", "HEAD~1"]);
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-9.md"), "x");
  appendEntry(root, { id: "OBA-9", op: "new", message: "OBA-9: x", files: ["projects/OBA/backlog/OBA-9.md"], ts: "t" });
  const r = runCommit(root);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /1 commit\(s\) behind origin\/main/);
  assert.match(r.stdout, /flushed 1 op/);
  rmSync(root, { recursive: true, force: true });
});

test("no warning when origin/main is absent", () => {
  const root = gitRepo();
  mkdirSync(join(root, "projects", "OBA", "backlog"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "backlog", "OBA-10.md"), "x");
  appendEntry(root, { id: "OBA-10", op: "new", message: "OBA-10: x", files: ["projects/OBA/backlog/OBA-10.md"], ts: "t" });
  const r = runCommit(root);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /behind origin\/main/);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify the first fails**

Run: `node --test tests/commit-runner.test.mjs`
Expected: first new test FAILS (no warning emitted).

- [ ] **Step 3: Implement** — in `scripts/commit-runner.mjs`, insert after the `entries.length === 0` early-exit and before the lock acquisition:

```js
// Cheap divergence signal against already-fetched refs — no network, so the
// verb stays fast and offline-safe. Publishing handles the real rebase.
const hasUpstream = spawnSync("git", ["-C", dataRoot, "rev-parse", "--verify", "-q", "refs/remotes/origin/main"], { stdio: "ignore" });
if (hasUpstream.status === 0) {
  const behind = spawnSync("git", ["-C", dataRoot, "rev-list", "--count", "HEAD..origin/main"], { encoding: "utf8" });
  const n = Number((behind.stdout || "").trim());
  if (behind.status === 0 && n > 0) {
    console.error(`blaze commit: warning — ${n} commit(s) behind origin/main (no fetch run); rebase before publishing`);
  }
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/commit-runner.mjs tests/commit-runner.test.mjs
git commit -m "BLZ-79: warn when flushing behind an already-fetched origin/main" -- scripts/commit-runner.mjs tests/commit-runner.test.mjs
```

---

### Task 7 (BLZ-80): Engine docs + v0.4.0

**Files:**
- Modify: `package.json` (version only), `AGENTS.md` (Commit modes section)

**Interfaces:**
- Consumes: final behavior from Tasks 1–6.
- Produces: v0.4.0, documented. (Coverage gate must be green here — this is the pre-PR checkpoint.)

- [ ] **Step 1: Bump version** — in `package.json`: `"version": "0.3.0"` → `"version": "0.4.0"`.

- [ ] **Step 2: Replace the `## Commit modes` section of `AGENTS.md`** (everything between `## Commit modes` and `## Querying the board`) with:

```markdown
## Commit modes

`blaze.config.json`'s `commitMode` decides how CLI verbs commit:

- `per-op` (default) — each `new`/`move`/`log`/`resolve`/`edit` commits immediately,
  scoped to exactly the file(s) it touched (never a broad `git add -A`).
- `batch` — the op is appended to a pending queue instead; run `blaze commit` to
  flush your queue into one commit (subject = a per-op count summary, body = one
  line per queued op).

### Sessions (parallel agents on one board)

Export a unique `BLAZE_SESSION` (letters, digits, `._-`) at session start — e.g.
your harness session UUID. Batch ops then queue to your own
`.blaze/pending/<session>.jsonl`, and:

- `blaze commit` flushes **only your queue** — a parallel session's queued WIP
  never rides your commit.
- `blaze commit --all` sweeps every session queue plus the shared fallback
  (end-of-day / bundler path); body lines are tagged `[<session>]`.
- No `BLAZE_SESSION` → the shared `.blaze/pending-commit.jsonl` fallback, exactly
  the pre-0.4 behavior.

Concurrent commits serialize on an advisory `.blaze/commit.lock/` (stale locks
from dead processes are stolen automatically). If your flush is behind an
already-fetched `origin/main`, `blaze commit` warns — rebase before publishing;
the engine itself never pushes.

Working-tree cross-talk is tolerated by design: sessions sharing one checkout
see each other's on-disk ticket moves in `git status` until the owning session
flushes. Use a git worktree per session when you need hard isolation.
```

- [ ] **Step 3: Run the coverage gate**

Run: `npm run test:coverage`
Expected: PASS with thresholds met (statements ≥91, branches ≥77, functions ≥93, lines ≥91). If branches dip, the uncovered branch will be named in the c8 output — cover it with a targeted test rather than lowering the gate.

- [ ] **Step 4: Commit**

```bash
git add package.json AGENTS.md
git commit -m "BLZ-80: v0.4.0 — document per-session queues, --all, commit lock" -- package.json AGENTS.md
```

---

### Task 8 (BLZ-81): Bundler push retry + blaze skill docs

**Files:**
- Modify: `~/Documents/Code/claude-config/scripts/blaze-bundle-push.sh` (lines 84–86)
- Modify: `~/Documents/Code/blaze-pm/.claude/skills/blaze/SKILL.md`

**Interfaces:**
- Consumes: engine behavior (Tasks 1–7) for accurate docs.
- Produces: bundler survives origin advancing mid-run (≤3 retries, still never force-pushes); skill documents `BLAZE_SESSION`.

- [ ] **Step 1: Bundler retry** — in `claude-config/scripts/blaze-bundle-push.sh`, replace:

```bash
git reset --hard "$NEW" -q
git push origin main            # plain push: git rejects anything that isn't a fast-forward (never --force)
echo "published: origin/main → $(git rev-parse --short HEAD) (bundled daily, fast-forward — no force-push)"
```

with:

```bash
git reset --hard "$NEW" -q
pushed=0
for attempt in 1 2 3; do
  # plain push: git rejects anything that isn't a fast-forward (never --force)
  if git push origin main 2>/tmp/blaze-push.err; then pushed=1; break; fi
  echo "push rejected (attempt $attempt/3) — origin advanced mid-run; re-rebasing"
  git fetch -q origin
  if ! git rebase origin/main -q 2>>/tmp/blaze-push.err; then
    git rebase --abort 2>/dev/null || true
    echo "REBASE CONFLICT during push retry — manual work needed"
    sed 's/^/  /' /tmp/blaze-push.err; exit 1
  fi
  git merge-base --is-ancestor origin/main HEAD || { echo "ABORT: retry result is not a fast-forward of origin/main"; exit 1; }
done
if [ "$pushed" != "1" ]; then
  echo "push failed after 3 attempts"; sed 's/^/  /' /tmp/blaze-push.err; exit 1
fi
echo "published: origin/main → $(git rev-parse --short HEAD) (bundled daily, fast-forward — no force-push)"
```

- [ ] **Step 2: Sanity-check the script parses**

Run: `bash -n ~/Documents/Code/claude-config/scripts/blaze-bundle-push.sh`
Expected: no output, exit 0. Then a behavior smoke: `cd ~/Documents/Code/blaze-pm && DRY_RUN=1 bash ~/Documents/Code/claude-config/scripts/blaze-bundle-push.sh` — expected: normal dry-run output (retry path untouched by DRY_RUN).

- [ ] **Step 3: Blaze skill docs** — in `blaze-pm/.claude/skills/blaze/SKILL.md`, add a `## Parallel sessions (BLAZE_SESSION)` section documenting: export a unique `BLAZE_SESSION` at session start (e.g. the harness session UUID, sanitized to letters/digits/`._-`); own-queue vs `--all` flush semantics; the advisory commit lock; the shared-fallback degradation when unset; tolerated working-tree cross-talk with worktrees as the escape hatch. Mirror the AGENTS.md text from Task 7 — same facts, skill-toned.

- [ ] **Step 4: Commit (two repos, separate commits)**

```bash
cd ~/Documents/Code/claude-config && git add scripts/blaze-bundle-push.sh && git commit -m "BLZ-81: bundler retries a rejected ff-push (origin advanced mid-run)" -- scripts/blaze-bundle-push.sh
cd ~/Documents/Code/blaze-pm && git add .claude/skills/blaze/SKILL.md && git commit -m "BLZ-81: blaze skill documents BLAZE_SESSION + own-queue flush" -- .claude/skills/blaze/SKILL.md
```

---

### Task 9 (BLZ-82): Consume v0.4.0 in blaze-pm + end-to-end verification + close-out

**Files:**
- Modify: `~/Documents/Code/blaze-pm/package.json` (+ lockfile via npm)

**Interfaces:**
- Consumes: everything above; engine PR merged and v0.4.0 published.
- Produces: the epic's ACs verified end to end; BLZ-17 closable.

- [ ] **Step 1: Engine PR + release (operator checkpoint)**

Open the epic PR: branch `BLZ-17-concurrency-safe-ledger` → `hjr15/blaze` main, title `BLZ-17: concurrency-safe ledger (per-session queues + commit lock)`, body = summary + link to design/ADR + code-review report. **Manual console steps (batch for operator):** merge approval if required, and `npm publish` for `@hjr15/blaze-board@0.4.0` (needs the operator's npm TOTP — a WebAuthn key won't work for CLI `--otp`).

- [ ] **Step 2: Consume in blaze-pm**

```bash
cd ~/Documents/Code/blaze-pm && npm install @hjr15/blaze-board@^0.4.0
node_modules/.bin/blaze reindex   # proves the engine loads against the live tree
```

- [ ] **Step 3: End-to-end two-session drill on a throwaway clone** (never on the live board):

```bash
tmp=$(mktemp -d) && git clone --quiet ~/Documents/Code/blaze-pm "$tmp/board" && cd "$tmp/board" && npm install --silent
export BLAZE_COMMIT_MODE=batch
BLAZE_SESSION=lane-a node_modules/.bin/blaze new --project BLZ --type task --parent BLZ-17 --estimate 60 "e2e drill A"
BLAZE_SESSION=lane-b node_modules/.bin/blaze new --project BLZ --type task --parent BLZ-17 --estimate 60 "e2e drill B"
ls .blaze/pending/            # expect: lane-a.jsonl lane-b.jsonl
BLAZE_SESSION=lane-a node_modules/.bin/blaze commit & BLAZE_SESSION=lane-b node_modules/.bin/blaze commit & wait
git log --format='%s %b' -2   # expect: two board-update commits, [lane-a] and [lane-b] tags, no cross-bundling
cat .blaze/pending/lane-a.jsonl .blaze/pending/lane-b.jsonl   # expect: both empty
# rollback check — unset env reproduces v0.3.0 shared-fallback behavior:
node_modules/.bin/blaze new --project BLZ --type task --parent BLZ-17 --estimate 60 "e2e drill legacy"
cat .blaze/pending-commit.jsonl   # expect: the op queued in the legacy shared file
node_modules/.bin/blaze commit    # expect: drains exactly that file
```

Assert the positive outcomes above (not just absence of errors). Then `rm -rf "$tmp"`.

- [ ] **Step 4: Board close-out** — on the live board (`~/Documents/Code/blaze-pm`): verify each of BLZ-74…82's ACs against the merged code, `blaze log <id> <minutes>` per ticket, move each to done, verify the epic BLZ-17's ACs (they mirror the design doc's), log epic time, move BLZ-17 to done. Flush with `blaze commit` (own queue). Update the two memory cards that describe v0.3.0 flush behavior if their facts changed.

---

## Self-review notes

- Spec coverage: design §1 → Tasks 1–2; §2 → Task 3; §3 → Tasks 4–5; §4 → Tasks 6 + 8; §5 → Tasks 7–9; §6 (tolerated cross-talk) → docs in Tasks 7–8. Epic ACs each map to a test or drill step.
- Type consistency: `sessionId/ledgerPath/appendEntry/readEntries/clearLedger/listQueues` signatures identical across Tasks 1, 2, 3, 5; `acquireLock/releaseLock/lockPath` identical across Tasks 4, 5; `commitFile` 5-arg shape defined once (Task 5).
- Known judgment calls for implementers: exact placement of the staleness block is "after early-exit, before lock"; the `bail()` no-try/finally form in Task 5 is deliberate (`process.exit` skips `finally`).
