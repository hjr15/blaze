# Three-Layer ID Allocator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a duplicate ticket id impossible to create silently and impossible to survive an index build.

**Architecture:** `nextId = max(disk, claims, reservations, remoteClaims) + 1`, then atomically reserved with `O_EXCL`. Reservations live in the shared git common dir (covers worktrees on one machine, never committed). Claims are committed one-file-per-id at a slug-free path (turns a cross-machine collision into an add/add conflict). Disk scan is retained so no backfill is needed. A ticket without a claim is an index error, which is what makes the guarantee hold even when a merge strategy auto-resolves the conflict away.

**Tech Stack:** Node ≥20, zero runtime dependencies, `node:test`, ESM (`.mjs`).

**Decision of record:** [ADR-0005](../../decisions/0005-three-layer-id-allocator.md).

## Global Constraints

- Zero new runtime dependencies. Node built-ins only (`node:fs`, `node:path`, `node:child_process`).
- Node floor is `>=20` (`package.json` engines). No syntax newer than Node 20.
- ESM only, `.mjs`, named exports. Match surrounding style: 2-space indent, double quotes, semicolons.
- **This is a public repo.** No absolute `/home/...` paths anywhere in a diff — CI's `scripts/ci/hygiene-check.mjs` rejects them. No private board content: use `PROJ` / `ACME` as fixture project keys, never `INF`/`OBA`/`CRP`.
- Claims are **append-only tombstones**. No code path may delete a file under `projects/<KEY>/.ids/`.
- Every task ends green: `node --test` must pass in full before commit.
- Commit subjects are `BLZ-136: <description>`.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/model/ids.mjs` (modify) | The allocator. Gains claim/reservation/remote layers and `claimPath`. Stays the single place ids are computed. |
| `scripts/model/claims.mjs` (create) | Claim-file read/write + the ticket↔claim reconciliation used by the index. Separate from `ids.mjs` because the index needs claim knowledge without pulling in allocation. |
| `scripts/model/git-common.mjs` (create) | Resolves the shared git common dir for a dataRoot, with the containment assertion. Isolated because it is the one piece that shells out to git and has its own failure modes. |
| `scripts/model/index.mjs` (modify) | Adds the ticket-without-claim error; excludes dot-dirs from the walk. |
| `scripts/new.mjs` (modify) | Writes the claim beside the ticket; returns its path. |
| `scripts/new-runner.mjs` (modify) | Records the claim path in the ledger entry so batch mode commits both atomically. |
| `scripts/migrate/jira-import.mjs` (modify) | Excludes dot-dirs in `removeExisting` (the one walker that deletes). |
| `tests/ids-allocator.test.mjs` (create) | Acceptance criteria ①–⑤. |
| `tests/ids-rollback.test.mjs` (create) | The three rollback tests — each must be red before its guard lands. |

---

### Task 1: Exclude dot-directories from every walker

Precondition for everything else: three walkers treat any subdirectory of `projects/<KEY>/` as a status dir and are saved from claim files only by the `.md` extension accident. `removeExisting` is the one that deletes.

**Files:**
- Modify: `scripts/model/index.mjs` (`walkTickets`, ~line 28)
- Modify: `scripts/model/ids.mjs` (`walkFiles`, ~line 7)
- Modify: `scripts/migrate/jira-import.mjs` (`removeExisting`, ~line 58)
- Test: `tests/ids-allocator.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: the guarantee that `projects/<KEY>/.ids/` is invisible to ticket walkers. Later tasks rely on it.

- [ ] **Step 1: Write the failing test**

Create `tests/ids-allocator.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../scripts/model/index.mjs";
import { maxId } from "../scripts/model/ids.mjs";

function board() {
  const root = mkdtempSync(join(tmpdir(), "blaze-alloc-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ", "defined"), { recursive: true });
  mkdirSync(join(projects, "PROJ", ".ids"), { recursive: true });
  return { root, projects };
}
function ticket(projects, status, name, id) {
  const dir = join(projects, "PROJ", status);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name),
    `---\nid: ${id}\ntitle: t\ntype: task\nproject: PROJ\npriority: medium\n---\nbody\n`);
}

// A claim file that ever gains a .md suffix must still not be walked as a ticket.
test("BLZ-136: dot-directories are excluded from the ticket walk explicitly", () => {
  const { root, projects } = board();
  ticket(projects, "defined", "PROJ-1-real.md", "PROJ-1");
  // Deliberately .md — proves the guard is the dot-dir rule, not the extension.
  writeFileSync(join(projects, "PROJ", ".ids", "2.md"), "not a ticket\n");
  const idx = buildIndex(projects);
  assert.equal(idx.count(), 1, "only the real ticket may be indexed");
  assert.deepEqual(idx.rows.map((r) => r.id), ["PROJ-1"]);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: maxId ignores dot-directories", () => {
  const { root, projects } = board();
  ticket(projects, "defined", "PROJ-3-real.md", "PROJ-3");
  writeFileSync(join(projects, "PROJ", ".ids", "PROJ-99.md"), "decoy\n");
  assert.equal(maxId(projects, "PROJ"), 3, "a dot-dir decoy must not raise the max");
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: FAIL — both tests. The index counts 2 tickets; `maxId` returns 99.

- [ ] **Step 3: Write minimal implementation**

In `scripts/model/index.mjs`, inside `walkTickets`, after `const statusPath = join(projPath, status);`:

```javascript
      // BLZ-136: `.ids/` (and any future dot-dir) holds allocator state, not
      // tickets. Previously these were skipped only because claim files have no
      // .md extension — an accident, not a guard.
      if (status.startsWith(".")) continue;
```

In `scripts/model/ids.mjs`, in `walkFiles`, replace the recursion branch:

```javascript
    if (s.isDirectory()) {
      if (e.startsWith(".")) continue; // BLZ-136: allocator state, not tickets
      yield* walkFiles(p);
    }
```

In `scripts/migrate/jira-import.mjs`, in `removeExisting`, after `for (const st of statuses) {`:

```javascript
    if (st.startsWith(".")) continue; // BLZ-136: never delete allocator state
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: PASS (2/2)
Then: `node --test` — full suite must stay green.

- [ ] **Step 5: Commit**

```bash
git add tests/ids-allocator.test.mjs scripts/model/index.mjs scripts/model/ids.mjs scripts/migrate/jira-import.mjs
git commit -m "BLZ-136: exclude dot-directories from ticket walkers explicitly"
```

---

### Task 2: Resolve the shared git common dir safely

**Files:**
- Create: `scripts/model/git-common.mjs`
- Test: `tests/ids-allocator.test.mjs` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: `commonDirFor(dataRoot) -> string` (absolute path to the shared `.git`). Throws `Error` with a message starting `blaze: ` when `dataRoot` is not inside a git worktree, or is inside one that does not contain it.

- [ ] **Step 1: Write the failing test**

Append to `tests/ids-allocator.test.mjs`:

```javascript
import { execFileSync } from "node:child_process";
import { commonDirFor } from "../scripts/model/git-common.mjs";

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "seed"), "s");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "seed"]);
  return dir;
}

test("BLZ-136: commonDirFor returns an absolute shared .git for a repo", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "blaze-gc-")));
  const cd = commonDirFor(repo);
  assert.ok(cd.startsWith("/"), `expected absolute path, got ${cd}`);
  assert.equal(existsSync(cd), true);
  rmSync(repo, { recursive: true, force: true });
});

test("BLZ-136: a linked worktree resolves to the SAME common dir as its main checkout", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "blaze-gc-")));
  const wt = join(repo, "..", `wt-${Date.now()}`);
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt, "-b", "feat"]);
  assert.equal(commonDirFor(wt), commonDirFor(repo),
    "worktree and main checkout must share one reservation namespace");
  rmSync(repo, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

// The silent-misresolution hole: a non-repo dataRoot nested under an unrelated
// repo makes `git rev-parse` return the ANCESTOR's .git with exit 0. Two
// sessions would then reserve in different namespaces and never contend.
test("BLZ-136: a non-repo dataRoot under an unrelated repo FAILS LOUD, not silently", () => {
  const outer = initRepo(mkdtempSync(join(tmpdir(), "blaze-gc-outer-")));
  const nested = join(outer, "unrelated", "board");
  mkdirSync(nested, { recursive: true });
  assert.throws(() => commonDirFor(nested), /blaze: .*not (a|inside a) git/i);
  rmSync(outer, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/model/git-common.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/model/git-common.mjs`:

```javascript
// scripts/model/git-common.mjs — resolve the git common dir shared by every
// worktree of one clone. This is the seam the ID reservation layer relies on
// (BLZ-136 / ADR-0005): worktrees have their own .git FILE but share one
// common dir, so a reservation written there serialises allocation across all
// of them without ever being committed.
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

function git(dataRoot, ...args) {
  const r = spawnSync("git", ["-C", dataRoot, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Throws rather than degrading. A silently-unshared reservation is worse than
// no reservation: it looks like the layer is working while two sessions
// allocate into separate namespaces and collide on one machine.
export function commonDirFor(dataRoot) {
  const common = git(dataRoot, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) {
    throw new Error(`blaze: ${dataRoot} is not inside a git worktree — cannot reserve ticket ids safely`);
  }
  // `git -C <dir> rev-parse` succeeds for ANY ancestor repo, so a dataRoot that
  // is merely nested under an unrelated repo resolves that repo's .git with
  // exit 0. Assert the resolved worktree actually contains dataRoot.
  const top = git(dataRoot, "rev-parse", "--show-toplevel");
  if (!top) {
    throw new Error(`blaze: ${dataRoot} is not inside a git worktree — cannot reserve ticket ids safely`);
  }
  const real = realpathSync(dataRoot);
  const realTop = realpathSync(top);
  if (real !== realTop && !real.startsWith(realTop.endsWith("/") ? realTop : realTop + "/")) {
    throw new Error(`blaze: ${dataRoot} is not inside a git worktree — resolved repo ${realTop} does not contain it`);
  }
  return common;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: PASS.

Note: the third test asserts the *nested non-repo* case throws. `git -C <nested> rev-parse --show-toplevel` returns the OUTER repo root, which **does** contain `nested` — so containment alone does not catch it. Make it fail by requiring dataRoot to be a board root: if `<dataRoot>/projects` does not exist AND dataRoot !== realTop, throw. If Step 3's implementation passes the first two tests but not the third, add to `commonDirFor`, before the return:

```javascript
  // A board's dataRoot is either the repo root itself or a directory that
  // holds projects/. Anything else is an accidental ancestor match.
  if (real !== realTop && !existsSync(join(real, "projects"))) {
    throw new Error(`blaze: ${dataRoot} is not a board root inside ${realTop} — refusing to reserve ids there`);
  }
```

with `import { existsSync } from "node:fs";` and `import { join } from "node:path";` added.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/git-common.mjs tests/ids-allocator.test.mjs
git commit -m "BLZ-136: resolve the shared git common dir, failing loud on a non-board root"
```

---

### Task 3: Claim files — read, write, path

**Files:**
- Create: `scripts/model/claims.mjs`
- Test: `tests/ids-allocator.test.mjs` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `claimDir(projectsDir, key) -> string` — `<projectsDir>/<key>/.ids`
  - `claimPath(projectsDir, key, n) -> string` — `<claimDir>/<n>`
  - `writeClaim(projectsDir, key, n, slug, { provisional = false }) -> string` (returns the path written)
  - `maxClaim(projectsDir, key) -> number` (0 when none)
  - `claimedNumbers(projectsDir, key) -> Set<number>`

- [ ] **Step 1: Write the failing test**

Append to `tests/ids-allocator.test.mjs`:

```javascript
import { readFileSync } from "node:fs";
import { claimPath, writeClaim, maxClaim, claimedNumbers } from "../scripts/model/claims.mjs";

test("BLZ-136: writeClaim writes id + slug so a same-id collision differs in content", () => {
  const { root, projects } = board();
  const p = writeClaim(projects, "PROJ", 7, "wire-the-gateway");
  assert.equal(p, claimPath(projects, "PROJ", 7));
  const body = readFileSync(p, "utf8");
  assert.match(body, /PROJ-7/);
  assert.match(body, /wire-the-gateway/);
  assert.doesNotMatch(body, /provisional/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: a provisional claim is marked, so a stale-view allocation is identifiable", () => {
  const { root, projects } = board();
  const p = writeClaim(projects, "PROJ", 8, "slug", { provisional: true });
  assert.match(readFileSync(p, "utf8"), /provisional/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: maxClaim and claimedNumbers read the claim set", () => {
  const { root, projects } = board();
  assert.equal(maxClaim(projects, "PROJ"), 0, "empty claim set is 0");
  writeClaim(projects, "PROJ", 3, "a");
  writeClaim(projects, "PROJ", 11, "b");
  assert.equal(maxClaim(projects, "PROJ"), 11);
  assert.deepEqual([...claimedNumbers(projects, "PROJ")].sort((x, y) => x - y), [3, 11]);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/model/claims.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/model/claims.mjs`:

```javascript
// scripts/model/claims.mjs — the committed allocation ledger (BLZ-136 /
// ADR-0005). One file per issued id at a SLUG-FREE path, so two machines
// issuing the same id write the same path and git raises an add/add conflict
// instead of merging two differently-named ticket files. Different ids write
// different paths, so this is a per-id conflict surface, not a global one.
//
// Claims are append-only TOMBSTONES: never deleted, not on renumber, not on
// ticket deletion. A claim asserts "this id was issued", which never stops
// being true. Deleting one re-arms the duplicate-id bug.
import { mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function claimDir(projectsDir, key) {
  return join(projectsDir, key, ".ids");
}

export function claimPath(projectsDir, key, n) {
  return join(claimDir(projectsDir, key), String(n));
}

// Content carries the slug because git auto-merges byte-identical adds: two
// machines writing the SAME bytes at the same path would merge cleanly and the
// collision would stay silent. The slug is what makes the blobs differ.
export function writeClaim(projectsDir, key, n, slug, { provisional = false } = {}) {
  const dir = claimDir(projectsDir, key);
  mkdirSync(dir, { recursive: true });
  const p = claimPath(projectsDir, key, n);
  writeFileSync(p, `${key}-${n} ${slug}${provisional ? " provisional" : ""}\n`);
  return p;
}

export function claimedNumbers(projectsDir, key) {
  const out = new Set();
  let entries = [];
  try { entries = readdirSync(claimDir(projectsDir, key)); } catch { return out; }
  for (const e of entries) if (/^\d+$/.test(e)) out.add(Number(e));
  return out;
}

export function maxClaim(projectsDir, key) {
  let max = 0;
  for (const n of claimedNumbers(projectsDir, key)) max = Math.max(max, n);
  return max;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/claims.mjs tests/ids-allocator.test.mjs
git commit -m "BLZ-136: add the committed per-id claim ledger"
```

---

### Task 4: The allocator — reserve with O_EXCL across all layers

**Files:**
- Modify: `scripts/model/ids.mjs`
- Test: `tests/ids-allocator.test.mjs` (append)

**Interfaces:**
- Consumes: `commonDirFor` (Task 2); `maxClaim`, `claimedNumbers` (Task 3).
- Produces: `allocateId(projectsDir, key, { dataRoot, remoteMax = 0 }) -> { id, n }`. Reserves atomically. `nextId(projectsDir, key)` is retained unchanged for callers that only want a peek.

- [ ] **Step 1: Write the failing test**

Append to `tests/ids-allocator.test.mjs`:

```javascript
import { allocateId } from "../scripts/model/ids.mjs";

function boardRepo() {
  const root = initRepo(mkdtempSync(join(tmpdir(), "blaze-alloc-repo-")));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ", "defined"), { recursive: true });
  return { root, projects };
}

// AC ①: a fresh clone must allocate above the true disk max.
test("BLZ-136 AC1: allocation is above the highest id on disk", () => {
  const { root, projects } = boardRepo();
  ticket(projects, "defined", "PROJ-700-existing.md", "PROJ-700");
  const { id, n } = allocateId(projects, "PROJ", { dataRoot: root });
  assert.equal(n, 701);
  assert.equal(id, "PROJ-701");
  rmSync(root, { recursive: true, force: true });
});

// AC ②: sequential allocations never repeat, because each RESERVES.
test("BLZ-136 AC2: repeated allocation never repeats an id (reservation, not just a scan)", () => {
  const { root, projects } = boardRepo();
  const seen = new Set();
  for (let i = 0; i < 25; i++) seen.add(allocateId(projects, "PROJ", { dataRoot: root }).n);
  assert.equal(seen.size, 25, "every allocation must be distinct with nothing committed");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: claims raise the floor even when the ticket file is absent (tombstone)", () => {
  const { root, projects } = boardRepo();
  writeClaim(projects, "PROJ", 900, "retired-and-deleted");
  assert.equal(allocateId(projects, "PROJ", { dataRoot: root }).n, 901);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: remoteMax participates so a published id is never re-issued", () => {
  const { root, projects } = boardRepo();
  assert.equal(allocateId(projects, "PROJ", { dataRoot: root, remoteMax: 5000 }).n, 5001);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: FAIL — `allocateId is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `scripts/model/ids.mjs`, add imports and the new export (keep `maxId`/`nextId` as they are):

```javascript
import { openSync, closeSync, mkdirSync } from "node:fs";
import { commonDirFor } from "./git-common.mjs";
import { maxClaim, claimedNumbers } from "./claims.mjs";

function reservationDir(dataRoot, key) {
  return join(commonDirFor(dataRoot), "blaze", "ids", key);
}

function maxReserved(dir) {
  let max = 0;
  let entries = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const e of entries) if (/^\d+$/.test(e)) max = Math.max(max, Number(e));
  return max;
}

// BLZ-136 / ADR-0005. Reserve an id atomically across every worktree of this
// clone. O_EXCL is the entire concurrency primitive: the first writer to create
// <common>/blaze/ids/<KEY>/<N> owns N; a loser gets EEXIST, bumps and retries.
// No lockfile, no counter file (which ADR-0013 killed as a hot conflict
// surface), no daemon.
export function allocateId(projectsDir, key, { dataRoot, remoteMax = 0 } = {}) {
  const resDir = reservationDir(dataRoot, key);
  mkdirSync(resDir, { recursive: true });
  let n = Math.max(
    maxId(projectsDir, key),
    maxClaim(projectsDir, key),
    maxReserved(resDir),
    Number(remoteMax) || 0,
  ) + 1;
  const claimed = claimedNumbers(projectsDir, key);
  for (;;) {
    if (claimed.has(n)) { n++; continue; }
    try {
      closeSync(openSync(join(resDir, String(n)), "wx"));
      return { id: `${key}-${n}`, n };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      n++;
    }
  }
}
```

Add `readdirSync` to the existing `node:fs` import if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/ids.mjs tests/ids-allocator.test.mjs
git commit -m "BLZ-136: allocate ids by atomic O_EXCL reservation across all layers"
```

---

### Task 5: AC ② under real concurrency, and AC ③/④ as git behaviour

**Files:**
- Test: `tests/ids-allocator.test.mjs` (append)

**Interfaces:**
- Consumes: `allocateId` (Task 4), `writeClaim` (Task 3).
- Produces: nothing — this task is pure verification of the acceptance criteria that only manifest across processes and merges.

- [ ] **Step 1: Write the test**

Append to `tests/ids-allocator.test.mjs`:

```javascript
import { spawnSync as spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// AC ②, the real one: two worktrees, concurrent processes, batch mode (nothing
// committed). This is the case that produced the production collisions.
test("BLZ-136 AC2: concurrent allocations across two worktrees are all distinct", () => {
  const { root, projects } = boardRepo();
  writeFileSync(join(root, "seed2"), "s");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "board"]);
  const wt = join(root, "..", `wt-alloc-${process.pid}`);
  execFileSync("git", ["-C", root, "worktree", "add", "-q", wt, "-b", "alloc-b"]);

  const oneLiner = (dr, pd) =>
    `import{allocateId}from ${JSON.stringify(join(REPO, "scripts/model/ids.mjs"))};` +
    `console.log(allocateId(${JSON.stringify(pd)},"PROJ",{dataRoot:${JSON.stringify(dr)}}).n)`;

  const procs = [];
  for (let i = 0; i < 10; i++) {
    procs.push([root, projects], [wt, join(wt, "projects")]);
  }
  const got = procs.map(([dr, pd]) =>
    spawn(process.execPath, ["--input-type=module", "-e", oneLiner(dr, pd)], { encoding: "utf8" }).stdout.trim());

  const nums = got.filter(Boolean).map(Number);
  assert.equal(nums.length, procs.length, `every process must allocate; got ${JSON.stringify(got)}`);
  assert.equal(new Set(nums).size, nums.length, `ids must be distinct, got ${nums.sort((a, b) => a - b)}`);

  rmSync(root, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

// AC ③: the whole point of the slug-free claim path.
test("BLZ-136 AC3: two machines claiming one id CONFLICT; different ids do not", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "blaze-merge-")));
  const pd = join(repo, "projects");
  // Branch off main, write one claim, commit. Always starts from main so the
  // two colliding branches are true siblings.
  const branchWithClaim = (branch, n, slug) => {
    execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", branch]);
    writeClaim(pd, "PROJ", n, slug);
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", `${branch}:${n}`]);
  };
  branchWithClaim("m1", 700, "alpha");
  branchWithClaim("m2", 700, "beta");
  execFileSync("git", ["-C", repo, "checkout", "-q", "m1"]);
  const same = spawn("git", ["-C", repo, "merge", "--no-edit", "m2"], { encoding: "utf8" });
  assert.notEqual(same.status, 0, "same id from two branches MUST conflict");

  spawn("git", ["-C", repo, "merge", "--abort"], { encoding: "utf8" });
  branchWithClaim("m3", 701, "gamma");
  execFileSync("git", ["-C", repo, "checkout", "-q", "m1"]);
  const diff = spawn("git", ["-C", repo, "merge", "--no-edit", "m3"], { encoding: "utf8" });
  assert.equal(diff.status, 0, "different ids must NOT conflict — the surface is per-id, not global");
  rmSync(repo, { recursive: true, force: true });
});

// AC ④: the case that killed the git-history high-water-mark mechanism.
test("BLZ-136 AC4: claims survive squash-merge + branch delete, so no id is re-issued", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "blaze-squash-")));
  const pd = join(repo, "projects");
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "work"]);
  for (const n of [700, 701, 702]) writeClaim(pd, "PROJ", n, `s${n}`);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "work"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
  execFileSync("git", ["-C", repo, "merge", "-q", "--squash", "work"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "squashed"]);
  execFileSync("git", ["-C", repo, "branch", "-qD", "work"]);

  const clone = mkdtempSync(join(tmpdir(), "blaze-clone-"));
  rmSync(clone, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", repo, clone]);
  assert.equal(allocateId(join(clone, "projects"), "PROJ", { dataRoot: clone }).n, 703,
    "a fresh clone with no reservations must still not re-issue a squashed-away id");
  rmSync(repo, { recursive: true, force: true });
  rmSync(clone, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run to verify**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: PASS. If AC2's concurrency test is flaky, that is a real defect in the reservation layer — do not add retries or sleeps to mask it.

- [ ] **Step 3: Commit**

```bash
git add tests/ids-allocator.test.mjs
git commit -m "BLZ-136: pin acceptance criteria 2-4 (concurrency, merge conflict, squash monotonicity)"
```

---

### Task 6: Wire the allocator into `blaze new`

**Files:**
- Modify: `scripts/new.mjs`
- Modify: `scripts/new-runner.mjs`
- Test: `tests/new.test.mjs` (append)

**Interfaces:**
- Consumes: `allocateId` (Task 4), `writeClaim` (Task 3).
- Produces: `applyNew(...)` return value gains `claimFile: string`. `new-runner.mjs` passes `files: [r.file, r.claimFile]` to `commitOrQueue`.

- [ ] **Step 1: Write the failing test**

Append to `tests/new.test.mjs`:

```javascript
test("BLZ-136: applyNew writes a claim beside the ticket and returns its path", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, readFileSync } = await import("node:fs");
  const r0 = root();
  execFileSync("git", ["-C", r0, "init", "-q", "-b", "main"]);
  const projects = join(r0, "projects");
  const res = applyNew(projects, { project: "PROJ", type: "task", title: "Wire the gateway",
    today: "2026-06-29", extra: { estimate: 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.ok(res.claimFile, "applyNew must return the claim path so the ledger can stage it");
  assert.equal(existsSync(res.claimFile), true);
  const n = res.id.split("-")[1];
  assert.equal(res.claimFile, join(projects, "PROJ", ".ids", n));
  assert.match(readFileSync(res.claimFile, "utf8"), new RegExp(res.id));
  rmSync(r0, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/new.test.mjs`
Expected: FAIL — `res.claimFile` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `scripts/new.mjs`, replace `const id = nextId(projectsDir, project);` with:

```javascript
  // BLZ-136: allocate + reserve, then record the claim. dataRoot is the parent
  // of projectsDir, matching BLAZE_PROJECTS_DIR's semantics elsewhere.
  const dataRoot = dirname(projectsDir);
  const { id, n } = allocateId(projectsDir, project, { dataRoot });
```

and change the import from `nextId` to `allocateId`, adding:

```javascript
import { writeClaim } from "./model/claims.mjs";
```

Then, immediately after the ticket file is written (after `writeFileSync(file, serializeTicket({ frontmatter, body }));`):

```javascript
  // The claim must land with the ticket: a ticket that reaches upstream without
  // its claim merges exactly as silently as before this change.
  const claimFile = writeClaim(projectsDir, project, n, slugify(title));
```

and add `claimFile` to the success return:

```javascript
  return { ok: true, id, type, project, status, file, claimFile, warnings };
```

In `scripts/new-runner.mjs` line 65, change `files: [r.file]` to:

```javascript
files: [r.file, r.claimFile],
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/new.test.mjs` then `node --test`
Expected: PASS. Existing `applyNew` tests must still pass — they call `applyNew` with a `projects` dir inside a temp dir; `allocateId` needs `dataRoot` to be a git repo, so those fixtures now need `git init`. If any fail with `not inside a git worktree`, add `execFileSync("git", ["-C", r, "init", "-q"])` to that test's `root()` fixture — do **not** weaken `commonDirFor`.

- [ ] **Step 5: Commit**

```bash
git add scripts/new.mjs scripts/new-runner.mjs tests/new.test.mjs
git commit -m "BLZ-136: allocate via reservation in blaze new and stage the claim with the ticket"
```

---

### Task 7: Ticket-without-claim is an index error

The invariant that makes the guarantee hold when a merge strategy auto-resolves the claim conflict away.

**Files:**
- Modify: `scripts/model/index.mjs`
- Test: `tests/ids-rollback.test.mjs` (create)

**Interfaces:**
- Consumes: `claimedNumbers` (Task 3), the `errors` channel added by BLZ-134.
- Produces: `buildIndex(...).errors` gains entries of the form `ticket <ID> has no claim (<path>) — ...`.

- [ ] **Step 1: Write the failing test**

Create `tests/ids-rollback.test.mjs`:

```javascript
// tests/ids-rollback.test.mjs — BLZ-136 rollback tests.
//
// These do not ask "does the feature work". They ask "does it still FAIL when
// it should". Each corresponds to a hole an adversarial pass found in the
// design: every one must be red before its guard lands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../scripts/model/index.mjs";
import { writeClaim } from "../scripts/model/claims.mjs";

function boardWith(tickets, claims) {
  const root = mkdtempSync(join(tmpdir(), "blaze-rb-"));
  const projects = join(root, "projects");
  for (const [status, name, id] of tickets) {
    const dir = join(projects, "PROJ", status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name),
      `---\nid: ${id}\ntitle: t\ntype: task\nproject: PROJ\npriority: medium\n---\nbody\n`);
  }
  for (const n of claims) writeClaim(projects, "PROJ", n, `slug${n}`);
  return { root, projects };
}

// Hole: a ticket committed without its claim merges as silently as before.
test("BLZ-136 rollback: a ticket with no claim is an index ERROR", () => {
  const { root, projects } = boardWith([["defined", "PROJ-5-x.md", "PROJ-5"]], []);
  const idx = buildIndex(projects);
  assert.equal(idx.errors.length, 1, `expected one error, got ${JSON.stringify(idx.errors)}`);
  assert.match(idx.errors[0], /PROJ-5/);
  assert.match(idx.errors[0], /claim/i);
  rmSync(root, { recursive: true, force: true });
});

// Hole: `git merge -X theirs` auto-resolves the claim conflict, leaving BOTH
// ticket files. The claim survives on one side only — so the duplicate must
// still be caught, by the duplicate-id error (BLZ-134).
test("BLZ-136 rollback: an auto-resolved claim conflict still leaves a loud duplicate id", () => {
  const { root, projects } = boardWith(
    [["defined", "PROJ-9-alpha.md", "PROJ-9"], ["done", "PROJ-9-beta.md", "PROJ-9"]],
    [9], // only one claim survived the -X theirs resolution
  );
  const idx = buildIndex(projects);
  assert.ok(idx.errors.some((e) => /duplicate id PROJ-9/.test(e)),
    `duplicate must still be reported, got ${JSON.stringify(idx.errors)}`);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: a well-formed board with matching claims has no errors", () => {
  const { root, projects } = boardWith([["defined", "PROJ-1-x.md", "PROJ-1"]], [1]);
  assert.deepEqual(buildIndex(projects).errors, []);
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ids-rollback.test.mjs`
Expected: FAIL — test 1 gets 0 errors (no claim check yet). Test 2 should already PASS (BLZ-134 covers it) — confirming the backstop genuinely exists rather than being assumed.

- [ ] **Step 3: Write minimal implementation**

In `scripts/model/index.mjs`, add the import and a new checker, then include it in the errors passed to `makeIndex`:

```javascript
import { claimedNumbers } from "./claims.mjs";

// BLZ-136 / ADR-0005. A ticket whose id has no claim file reached the board
// without its allocation record — either committed by hand, or through a merge
// strategy that auto-resolved the claim conflict away (`-X ours/theirs` merges
// a colliding claim cleanly, which layer 2 alone cannot prevent). Either way
// the id is no longer provably unique, so it is an error, not a warning.
function missingClaimErrors(projectsDir, rows) {
  const byKey = new Map();
  const errors = [];
  for (const r of rows) {
    if (!r.project || !r.id) continue;
    if (!byKey.has(r.project)) byKey.set(r.project, claimedNumbers(projectsDir, r.project));
    const n = Number(String(r.id).split("-").pop());
    if (!Number.isFinite(n) || byKey.get(r.project).has(n)) continue;
    errors.push(`ticket ${r.id} has no claim (${claimPathFor(projectsDir, r.project, n)}) — its id is not provably unique; run \`blaze reindex\` after restoring or re-creating the claim`);
  }
  return errors;
}
```

with `import { claimedNumbers, claimPath as claimPathFor } from "./claims.mjs";` and, at the end of `buildIndex`:

```javascript
  return makeIndex(rows, links, warnings, [
    ...duplicateIdErrors(rows),
    ...missingClaimErrors(projectsDir, rows),
  ]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ids-rollback.test.mjs` then `node --test`
Expected: PASS.

**The cutover rule.** A board that predates claims has thousands of tickets and zero claim
files, so a naive check flags every one — and ADR-0005 explicitly promises "no backfill
required". Those two only reconcile one way: **the invariant applies only to ids issued after
claims existed.**

Implement it as a per-project cutover marker rather than a config flag or a mass backfill:

- On first allocation for a key, if `projects/<KEY>/.ids/` has no `.cutover` file, write one
  containing the current `maxId(projectsDir, key)`.
- `missingClaimErrors` skips any ticket whose numeric id is `<=` that cutover value.

This needs no backfill, no flag to forget to flip, and is self-describing on disk. Pre-existing
tickets are grandfathered exactly once; everything issued afterwards is held to the invariant.

Add to `scripts/model/claims.mjs`:

```javascript
import { readFileSync, existsSync } from "node:fs";

// BLZ-136. Tickets that predate the claim ledger cannot have claims and must not
// be reported as errors — but every id issued AFTER cutover must. Written once,
// on the first allocation for a key, and never updated: raising it later would
// silently forgive real missing claims.
export function cutoverPath(projectsDir, key) {
  return join(claimDir(projectsDir, key), ".cutover");
}

export function readCutover(projectsDir, key) {
  try { return Number(readFileSync(cutoverPath(projectsDir, key), "utf8").trim()) || 0; }
  catch { return 0; }
}

export function ensureCutover(projectsDir, key, currentMax) {
  const p = cutoverPath(projectsDir, key);
  if (existsSync(p)) return readCutover(projectsDir, key);
  mkdirSync(claimDir(projectsDir, key), { recursive: true });
  writeFileSync(p, `${currentMax}\n`);
  return currentMax;
}
```

Call `ensureCutover(projectsDir, key, maxId(projectsDir, key))` in `allocateId` (Task 4) before
reserving, and have `missingClaimErrors` skip ids `<= readCutover(...)`.

Add this test to `tests/ids-rollback.test.mjs`:

```javascript
import { ensureCutover } from "../scripts/model/claims.mjs";

test("BLZ-136: tickets predating the claim ledger are grandfathered by the cutover", () => {
  const { root, projects } = boardWith([["defined", "PROJ-5-x.md", "PROJ-5"]], []);
  ensureCutover(projects, "PROJ", 5);           // claims introduced when max was 5
  assert.deepEqual(buildIndex(projects).errors, [], "pre-cutover tickets must not error");
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-136: a ticket issued AFTER cutover still errors without a claim", () => {
  const { root, projects } = boardWith([["defined", "PROJ-6-x.md", "PROJ-6"]], []);
  ensureCutover(projects, "PROJ", 5);
  const errs = buildIndex(projects).errors;
  assert.equal(errs.length, 1, `expected one error, got ${JSON.stringify(errs)}`);
  assert.match(errs[0], /PROJ-6/);
  rmSync(root, { recursive: true, force: true });
});
```

The `.cutover` file starts with a dot, so Task 1's dot-dir exclusion and `claimedNumbers`'s
`^\d+$` filter both already ignore it.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/index.mjs tests/ids-rollback.test.mjs
git commit -m "BLZ-136: a ticket without a claim is an index error"
```

---

### Task 8: Remote claims and the provisional lifecycle

**Files:**
- Modify: `scripts/model/claims.mjs`
- Modify: `scripts/new.mjs`
- Test: `tests/ids-allocator.test.mjs` (append)

**Interfaces:**
- Consumes: `commonDirFor` (Task 2).
- Produces: `remoteMaxClaim(dataRoot, key, { remote = "origin", branch = "main" }) -> number` (0 on any failure — never throws). `applyNew` passes it to `allocateId` and marks the claim provisional when the fetch failed.

- [ ] **Step 1: Write the failing test**

Append to `tests/ids-allocator.test.mjs`:

```javascript
import { remoteMaxClaim } from "../scripts/model/claims.mjs";

test("BLZ-136 AC5: remoteMaxClaim reads claims published on the remote", () => {
  const origin = initRepo(mkdtempSync(join(tmpdir(), "blaze-origin-")));
  writeClaim(join(origin, "projects"), "PROJ", 4242, "published");
  execFileSync("git", ["-C", origin, "add", "-A"]);
  execFileSync("git", ["-C", origin, "commit", "-qm", "publish claim"]);

  const clone = mkdtempSync(join(tmpdir(), "blaze-cl-"));
  rmSync(clone, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", origin, clone]);
  assert.equal(remoteMaxClaim(clone, "PROJ"), 4242);
  rmSync(origin, { recursive: true, force: true });
  rmSync(clone, { recursive: true, force: true });
});

test("BLZ-136 AC5: offline (no reachable remote) returns 0 rather than throwing", () => {
  const repo = initRepo(mkdtempSync(join(tmpdir(), "blaze-off-")));
  assert.equal(remoteMaxClaim(repo, "PROJ"), 0, "a fetch failure must degrade, not crash");
  rmSync(repo, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ids-allocator.test.mjs`
Expected: FAIL — `remoteMaxClaim is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/model/claims.mjs`:

```javascript
import { spawnSync } from "node:child_process";

// BLZ-136 / ADR-0005 layer 2b. Reading the remote's claim set is what makes the
// allocator AVOID most cross-machine collisions rather than merely detect them:
// an id another machine has already published is visible before the next one is
// issued. Tree read only — no working tree touched, no merge.
//
// Returns 0 on ANY failure (offline, no remote, no such branch). The caller
// marks the resulting claim provisional; it must never crash ticket creation,
// because refusing to create tickets without a network is a worse regression
// than a collision that is caught loudly at merge.
export function remoteMaxClaim(dataRoot, key, { remote = "origin", branch = "main" } = {}) {
  const fetched = spawnSync("git", ["-C", dataRoot, "fetch", "--quiet", remote, branch], { encoding: "utf8" });
  if (fetched.status !== 0) return 0;
  const ls = spawnSync("git",
    ["-C", dataRoot, "ls-tree", "--name-only", "FETCH_HEAD", "--", `projects/${key}/.ids/`],
    { encoding: "utf8" });
  if (ls.status !== 0) return 0;
  let max = 0;
  for (const line of ls.stdout.split("\n")) {
    const m = /\/(\d+)$/.exec(line.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
```

In `scripts/new.mjs`, use it:

```javascript
  const dataRoot = dirname(projectsDir);
  const remoteMax = remoteMaxClaim(dataRoot, project);
  const { id, n } = allocateId(projectsDir, project, { dataRoot, remoteMax });
```

and mark the claim provisional when the remote could not be read:

```javascript
  const claimFile = writeClaim(projectsDir, project, n, slugify(title), { provisional: remoteMax === 0 });
```

Add `remoteMaxClaim` to the `./model/claims.mjs` import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ids-allocator.test.mjs` then `node --test`
Expected: PASS.

Note: `remoteMax === 0` also holds for a genuinely empty remote claim set, which would mark a legitimately-online allocation provisional. That is a false positive in the safe direction (it over-marks, never under-marks). If it proves noisy, return `null` for failure and `0` for empty and branch on `null` — but only after seeing it be noisy.

- [ ] **Step 5: Commit**

```bash
git add scripts/model/claims.mjs scripts/new.mjs tests/ids-allocator.test.mjs
git commit -m "BLZ-136: read remote claims before allocating; mark offline claims provisional"
```

---

### Task 9: Update the ADR and close the loop

**Files:**
- Modify: `docs/decisions/0005-three-layer-id-allocator.md`

- [ ] **Step 1: Flip status and record what shipped**

Change `## Status` from `Proposed (BLZ-136)` to `Accepted (BLZ-136)`.

Replace the Validation section's "design evidence, not tests" caveat with the actual test names now covering each criterion, and record the backfill decision made in Task 7.

- [ ] **Step 2: Verify the whole suite and the public-repo gates**

```bash
node --test
node scripts/ci/hygiene-check.mjs origin/main
grep -rnE "/home/|\b(INF|OBA|CRP)-[0-9]+" docs/decisions/0005-three-layer-id-allocator.md scripts/model/ tests/ids-*.test.mjs
```
Expected: suite green; hygiene clean; grep returns nothing.

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/0005-three-layer-id-allocator.md
git commit -m "BLZ-136: mark ADR-0005 accepted and record the shipped validation"
```

---

## Notes for the reviewer

- **No operator decision is outstanding.** The one that looked like it — how the
  ticket-without-claim invariant treats a board that predates claims — is resolved by the
  cutover rule in Task 7, which needs neither a backfill nor a flag.
- **Live-board impact.** Once merged and installed, `blaze new` requires `dataRoot` to be a
  real git worktree (Task 2 fails loud otherwise). This is intended and matches BLZ-133's
  direction, but it means the engine can no longer allocate from a non-repo scratch directory.
- **Ordering.** Task 1 must land first: it is what stops `.ids/` being walked as a status dir,
  and `removeExisting` would otherwise be one filename convention away from deleting claims.
