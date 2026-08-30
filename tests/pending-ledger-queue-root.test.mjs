// tests/pending-ledger-queue-root.test.mjs — BLZ-556: ONE queue store per REPOSITORY,
// not one per working copy.
//
// The bug: `.blaze/pending/` was resolved against whichever working copy the process
// ran in, so an op was queued into the worktree the agent happened to be standing in.
// Measured on the operator's board on 2026-08-30: 19 ops in the main checkout, 185 in
// the `v4-spine` worktree, 6 in `v3-phase0`, 0 in `board-main` — 210 total, of which the
// nightly flush mounts and drains exactly one store and reports `outcome=published`.
//
// The fix: resolve the store to `dirname(git rev-parse --git-common-dir)`. Every worktree
// of one repo shares that `.git`, so `.blaze/` beside it is a single canonical location,
// and the store the flush ALREADY mounts becomes the only one there is.
//
// These tests are constructed against real git repositories, not mocked, because the
// question "does --git-common-dir mean what I think it means" is only answerable by
// construction. The four hostile layouts below (bare, submodule, GIT_DIR override,
// non-repo) each resolve `--git-common-dir` to something whose PARENT is not a working
// tree of this repo, and each would silently relocate the queue store outside the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, accessSync, readdirSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import {
  queueRoot, ledgerPath, listQueues, appendEntry, readEntries, readForDrain,
  clearLedger, strandedQueues, belongsHere, worktreeBranchOwners, listQueuesResult, appendEntry as _ae,
} from "../scripts/pending-ledger.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A board-shaped git repo: `projects/` (what makes a directory a board) and one commit.
 *  The mkdtempSync prefix is a LITERAL at the call site (BLZ-491). */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-queueroot-"));
  mkdirSync(join(root, "projects", "ZZZ"), { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "projects", "ZZZ", "seed"), "seed");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return root;
}

/** A linked worktree of `main`, itself carrying a `projects/` dir (it is the same repo,
 *  so `projects/` is tracked and checked out there too). */
function worktree(main, name) {
  const wt = join(dirname(main), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  git(main, "worktree", "add", "-q", "-b", name, wt);
  return wt;
}

const cleanup = (...paths) => { for (const p of paths) rmSync(p, { recursive: true, force: true }); };

// ---------------------------------------------------------------------------
// T1 — THE FIX. The property: two worktrees of one repo resolve to ONE store.
// Pins pending-ledger.mjs's queueRoot redirect. Reverting it (queueRoot => root)
// makes this fail on the shared-path assertion, which is the property named.
// ---------------------------------------------------------------------------
test("BLZ-556: every worktree of one repo resolves to ONE queue store — the main working tree's", () => {
  const main = repo();
  const a = worktree(main, "lane-a");
  const b = worktree(main, "lane-b");
  try {
    assert.equal(queueRoot(main), main, "the main working tree is its own queue root");
    assert.equal(queueRoot(a), main, "a linked worktree resolves to the main working tree");
    assert.equal(queueRoot(b), main, "a second linked worktree resolves to the same place");

    // Not just the resolver — every path function must agree, or an op is written to one
    // place and read from another. That is the shape of the 210-op scatter itself.
    assert.equal(ledgerPath(a, "s1"), ledgerPath(main, "s1"));
    assert.equal(ledgerPath(b, null), ledgerPath(main, null));

    // Constructed: queue from worktree A, read it from worktree B and from the main tree.
    const e = { id: "ZZZ-1", op: "new", message: "ZZZ-1: x", files: ["projects/ZZZ/seed"], ts: "t" };
    appendEntry(a, e, "s1");
    assert.deepEqual(readEntries(b, "s1"), [e], "worktree B sees the op worktree A queued");
    assert.deepEqual(readEntries(main, "s1"), [e], "the main tree sees it too");
    assert.ok(existsSync(join(main, ".blaze", "pending", "s1.jsonl")), "it lives in the main tree's store");
    assert.ok(!existsSync(join(a, ".blaze")), "and NOT in the worktree it was queued from");

    assert.deepEqual(listQueues(a).map((q) => q.session), ["s1"]);
    assert.deepEqual(listQueues(main).map((q) => q.session), ["s1"]);
  } finally { cleanup(main, a, b); }
});

// ---------------------------------------------------------------------------
// T2 — THE FOUR HOSTILE LAYOUTS. Each verified by construction to resolve
// `--git-common-dir` somewhere whose parent is NOT a working tree of this repo.
// Pins the two guards (a working-tree probe on the candidate, and the `projects/`
// board check). Reverting either guard sends the store outside the board.
// ---------------------------------------------------------------------------
test("BLZ-556: a bare repo does not relocate the queue store to its parent directory", () => {
  const main = repo();
  const bare = join(dirname(main), `blaze-bare-${Date.now()}.git`);
  try {
    execFileSync("git", ["clone", "-q", "--bare", main, bare]);
    // Constructed proof of the hazard: --git-common-dir is "." in a bare repo, so
    // dirname(resolve(root, ".")) is the directory CONTAINING the repo.
    assert.equal(git(bare, "rev-parse", "--git-common-dir"), ".");
    assert.equal(queueRoot(bare), bare, "a bare repo is its own queue root, never its parent");
  } finally { cleanup(main, bare); }
});

test("BLZ-556: a submodule does not relocate the queue store into the superproject's .git/modules", () => {
  const sub = repo();
  const sup = mkdtempSync(join(tmpdir(), "blaze-queueroot-super-"));
  try {
    git(sup, "init", "-q", "-b", "main");
    git(sup, "config", "user.email", "t@t.t");
    git(sup, "config", "user.name", "t");
    writeFileSync(join(sup, "s.txt"), "s");
    git(sup, "add", "-A");
    git(sup, "commit", "-q", "-m", "i");
    git(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    git(sup, "commit", "-q", "-m", "addsub");
    const inner = join(sup, "sub");
    // Constructed proof of the hazard: the common dir is inside the SUPERPROJECT's .git.
    assert.match(git(inner, "rev-parse", "--git-common-dir"), /\.git\/modules\/sub$/);
    assert.equal(queueRoot(inner), inner, "a submodule keeps its own store, not .git/modules/");
  } finally { cleanup(sub, sup); }
});

// The two guards above (a working-tree probe on the candidate, and the `projects/` board
// check) OVERLAP on the ordinary bare and submodule layouts — either one alone sends both
// back to the invoking root, so those two tests pin the pair, not each guard. This one
// isolates the working-tree probe: a bare repo whose CONTAINING directory happens to hold a
// `projects/` dir passes the board check, and only the probe stops the queue store from
// being placed outside the repository entirely. Constructible, and the layout is not exotic
// — a directory holding both a board and a bare mirror of it is an ordinary way to keep one.
test("BLZ-556: a bare repo beside a projects/ dir still does not escape — the board check alone is not enough", () => {
  const holder = mkdtempSync(join(tmpdir(), "blaze-queueroot-holder-"));
  const src = repo();
  try {
    mkdirSync(join(holder, "projects"), { recursive: true });
    const bare = join(holder, "mirror.git");
    execFileSync("git", ["clone", "-q", "--bare", src, bare]);
    // The board check passes here — the parent really does contain projects/ — so if it
    // were the only guard the store would land in `holder`, outside the repository.
    assert.ok(existsSync(join(dirname(bare), "projects")));
    assert.equal(queueRoot(bare), bare, "the candidate is not a working tree, so nothing is relocated");
  } finally { cleanup(holder, src); }
});

test("BLZ-556: an ambient GIT_DIR cannot hijack the queue store into an unrelated repo", () => {
  const main = repo();
  const other = repo();
  const wt = worktree(main, "lane-c");
  const saved = process.env.GIT_DIR;
  try {
    // Reachable, not theoretical: every git hook runs with GIT_DIR exported, so a blaze
    // verb invoked from a hook inherits it. Verified by construction that plain `git -C`
    // DOES obey it — the child env must be scrubbed or the store follows the wrong repo.
    assert.equal(
      execFileSync("git", ["-C", wt, "rev-parse", "--git-common-dir"],
        { encoding: "utf8", env: { ...process.env, GIT_DIR: join(other, ".git") } }).trim(),
      join(other, ".git"),
      "git -C really does obey an ambient GIT_DIR — this is the hazard being guarded",
    );
    process.env.GIT_DIR = join(other, ".git");
    assert.equal(queueRoot(wt), main, "queueRoot ignores GIT_DIR and follows the real worktree");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    cleanup(main, other, wt);
  }
});

test("BLZ-556: a directory that is not a git repo is its own queue store", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-queueroot-plain-"));
  try {
    assert.equal(queueRoot(root), root);
    appendEntry(root, { id: "X-1", op: "new", message: "m", files: ["f"], ts: "t" }, "s");
    assert.ok(existsSync(join(root, ".blaze", "pending", "s.jsonl")));
  } finally { cleanup(root); }
});

test("BLZ-556: a worktree whose main tree is not a board keeps its own store", () => {
  // The redirect is only correct when the candidate really is the board. A repo with no
  // projects/ at its main tree is not one, so nothing is relocated.
  const main = mkdtempSync(join(tmpdir(), "blaze-queueroot-noboard-"));
  let wt;
  try {
    git(main, "init", "-q", "-b", "main");
    git(main, "config", "user.email", "t@t.t");
    git(main, "config", "user.name", "t");
    writeFileSync(join(main, "f"), "f");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "i");
    wt = worktree(main, "lane-d");
    assert.equal(queueRoot(wt), wt, "no projects/ at the main tree — no redirect");
  } finally { cleanup(main, wt); }
});

// ---------------------------------------------------------------------------
// T3 — MIGRATION, both directions. The 210 ops already on disk sit in four stores.
// The code must be correct BEFORE the operator moves them and AFTER, and must never
// move them itself.
// ---------------------------------------------------------------------------
test("BLZ-556: a not-yet-migrated worktree store is REPORTED, never read and never drained", () => {
  const main = repo();
  const a = worktree(main, "lane-e");
  try {
    // Simulate the pre-migration state: ops sitting in the worktree's OWN .blaze/.
    mkdirSync(join(a, ".blaze", "pending"), { recursive: true });
    const line = JSON.stringify({ id: "ZZZ-9", op: "new", message: "m", files: ["projects/ZZZ/seed"], ts: "t" });
    writeFileSync(join(a, ".blaze", "pending", "old.jsonl"), `${line}\n${line}\n`);
    writeFileSync(join(a, ".blaze", "pending-commit.jsonl"), `${line}\n`);

    const stranded = strandedQueues(a);
    assert.deepEqual(
      stranded.map((q) => ({ session: q.session, count: q.count })),
      [{ session: null, count: 1 }, { session: "old", count: 2 }],
      "both the legacy fallback and the session queue are named, with their op counts",
    );
    // The whole point: reporting must not be draining.
    assert.ok(existsSync(join(a, ".blaze", "pending", "old.jsonl")), "the stranded file is left alone");
    assert.equal(readFileSync(join(a, ".blaze", "pending", "old.jsonl"), "utf8"), `${line}\n${line}\n`);
    assert.deepEqual(listQueues(a), [], "and it is NOT presented as a queue to drain");
  } finally { cleanup(main, a); }
});

test("BLZ-556: an already-migrated worktree reports nothing stranded, and the main tree never does", () => {
  const main = repo();
  const a = worktree(main, "lane-f");
  try {
    assert.deepEqual(strandedQueues(a), [], "no local .blaze at all");
    mkdirSync(join(a, ".blaze", "pending"), { recursive: true });
    writeFileSync(join(a, ".blaze", "pending", "drained.jsonl"), "");
    assert.deepEqual(strandedQueues(a), [], "an EMPTY leftover file is not stranded work");
    // The main working tree's own store IS the shared store, so it can never be stranded
    // — reporting it would tell the operator to migrate the destination onto itself.
    appendEntry(main, { id: "ZZZ-1", op: "new", message: "m", files: ["projects/ZZZ/seed"], ts: "t" }, "s");
    assert.deepEqual(strandedQueues(main), []);
  } finally { cleanup(main, a); }
});

// ---------------------------------------------------------------------------
// T4 — PROVENANCE. One store means ops from every worktree are now visible to every
// worktree — including the flush. That is the fix, and it is also a new hazard: an op
// queued in worktree W describes files that exist in W's checkout and nowhere else
// (measured on the live board: of v4-spine's 186 recorded paths, 4 exist in the main
// checkout; of v3-phase0's 2, none do). Committing those from the main tree stages
// almost nothing and then clears the ledger — silent destruction of 191 ops.
// ---------------------------------------------------------------------------
test("BLZ-556: an op belongs to the working tree that queued it, identified by worktree then branch OWNER", () => {
  // `branchOwner` is git's own branch -> other-worktree map. It is what separates the two
  // ways a recorded branch can differ from the branch in front of you: another worktree
  // holds it (BLZ-556 — the files are over there) versus nobody holds it (INF-673 — this
  // same checkout moved underneath the ops, and the whole batch must be refused with its
  // recovery steps rather than quietly filtered).
  const owner = new Map([["BLZ-305-v4-spine", "/w/v4-spine"]]);
  const here = { worktree: "", branch: "main", branchOwner: owner };
  // Recorded worktree wins when present — the direct fact.
  assert.equal(belongsHere({ worktree: "", branch: "anything" }, here), true);
  assert.equal(belongsHere({ worktree: "../lane-a", branch: "main" }, here), false,
    "a recorded foreign worktree is foreign even when the branch matches");
  // Falls back to branch for the 210 ops already on disk, none of which carry a worktree.
  assert.equal(belongsHere({ branch: "main" }, here), true);
  assert.equal(belongsHere({ branch: "BLZ-305-v4-spine" }, here), false,
    "another worktree holds that branch, so its ops are not this tree's to commit");
  // THE DISTINCTION. Same spelling of difference, opposite handling.
  assert.equal(belongsHere({ branch: "some-lane" }, here), true,
    "a branch NO other worktree holds is INF-673's case — left for checkBranch to refuse");
  assert.equal(belongsHere({ branch: "main" }, { worktree: "", branch: null, branchOwner: new Map() }), true,
    "detached HEAD is not a foreign-worktree signal (INF-673 leaves detached HEAD alone)");
  // Pre-INF-673 ops record neither. Unchanged behaviour: drainable here.
  assert.equal(belongsHere({ id: "X-1" }, here), true);
});

test("BLZ-556: clearLedger keeps the raw lines it is told to keep, plus anything appended after the drain", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-queueroot-keep-"));
  try {
    const mine = { id: "A", op: "new", message: "m", files: ["f"], ts: "t", branch: "main" };
    const theirs = { id: "B", op: "new", message: "m", files: ["f"], ts: "t", branch: "lane" };
    appendEntry(root, mine, "s");
    appendEntry(root, theirs, "s");
    const q = readForDrain(root, "s");
    assert.deepEqual(q.entries, [mine, theirs]);
    assert.deepEqual(q.lines, [JSON.stringify(mine), JSON.stringify(theirs)],
      "the RAW line is carried alongside each entry so a kept op is rewritten byte-for-byte");
    // An op appended by another session while the commit ran.
    const late = { id: "C", op: "new", message: "m", files: ["f"], ts: "t", branch: "main" };
    appendEntry(root, late, "s");
    clearLedger(root, "s", q.bytes, [q.lines[1]]); // commit A, keep B
    assert.deepEqual(readEntries(root, "s"), [theirs, late],
      "the foreign op survives the drain, and so does the one appended mid-commit");
  } finally { cleanup(root); }
});

test("BLZ-556: a queue with nothing kept and nothing appended is still REMOVED, not truncated", () => {
  // BLZ-498's property, re-pinned because clearLedger's writeback now has a keep path
  // that could easily resurrect a zero-byte file.
  const root = mkdtempSync(join(tmpdir(), "blaze-queueroot-rm-"));
  try {
    appendEntry(root, { id: "A", op: "new", message: "m", files: ["f"], ts: "t" }, "s");
    const q = readForDrain(root, "s");
    clearLedger(root, "s", q.bytes, []);
    assert.ok(!existsSync(ledgerPath(root, "s")), "an emptied queue file is unlinked");
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------------------
// T5 — THE PRUNABLE WORKTREE. The CronJob's entire provenance fallback rests on this and it
// was asserted rather than constructed.
//
// The flush container mounts only the main checkout, so the sibling worktrees do not exist
// on its filesystem. `worktreeBranchOwners` must still know which branches they hold, or
// every op queued in a lane looks like the container's own and is drained, staged as
// nothing, and deleted. git keeps listing a worktree whose directory is gone, marked
// `prunable` — that is the load-bearing fact, and this constructs it.
// ---------------------------------------------------------------------------
test("BLZ-556: a worktree whose directory is DELETED still identifies its branch — the flush container depends on it", () => {
  const main = repo();
  const gone = worktree(main, "vanished-lane");
  try {
    // NOT called before the deletion: `worktreeBranchOwners` memoises per root, so a probe
    // taken while the directory still existed would serve a CACHED map afterwards and this
    // test would pass without ever exercising the case it is named for. (It did, before this
    // line was written this way — the revert of the guard left it green.)
    rmSync(gone, { recursive: true, force: true });   // the container's view: the path is not there

    const porcelain = execFileSync("git", ["-C", main, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    assert.match(porcelain, /^prunable /m, "git marks the missing worktree prunable, and still lists it");
    assert.match(porcelain, /^branch refs\/heads\/vanished-lane$/m, "including its branch line");

    // The property that matters: an op queued in that lane is still NOT this tree's.
    const owners = worktreeBranchOwners(main);
    assert.equal(owners.get("vanished-lane"), gone, "still attributed, by its recorded path");
    const here = { worktree: "", branch: "main", branchOwner: owners };
    assert.equal(belongsHere({ branch: "vanished-lane" }, here), false,
      "so the flush container holds it back instead of destroying it");
  } finally { cleanup(main, gone); }
});

// ---------------------------------------------------------------------------
// T6 — REACHABILITY, stated plainly. The `parent === root` early return in
// resolveQueueRoot.
//
// For every root PRODUCTION can hand it, this branch is a pure fast path: `resolveRoots`
// only ever yields normalised absolute paths, and from a main working tree
// `--git-common-dir` is the relative `.git`, so `dirname(resolve(root, ".git"))` is already
// `root` character-for-character and the two guards below would re-derive the same answer at
// the cost of one extra git spawn. It CHANGES the answer only for a non-normalised spelling
// — `<root>/.` or a trailing slash — which reaches this function only through a direct API
// call, never through `resolveRoots`. Verified by construction across seven layouts.
//
// It is therefore pinned at the API contract, which is where it is reachable, and the
// contract is load-bearing rather than cosmetic: `commit-runner.mjs` compares
// `store === dataRoot` as exact strings to decide whether the queue store and the working
// tree are one lock or two. A resolver that normalised its answer would make the main
// checkout try to lock one directory twice under two spellings and refuse to flush at all.
// ---------------------------------------------------------------------------
test("BLZ-556: queueRoot returns the root it was handed VERBATIM when that root is already the store", () => {
  const main = repo();
  try {
    for (const spelling of [main, `${main}/.`, `${main}/`]) {
      assert.equal(queueRoot(spelling), spelling,
        `queueRoot(${JSON.stringify(spelling)}) must echo its argument, not a normalised twin`);
    }
    // The consequence the runner relies on: same directory, same string, therefore one lock.
    assert.equal(queueRoot(main) === main, true, "so `store === dataRoot` holds in the main checkout");
  } finally { cleanup(main); }
});

// ---------------------------------------------------------------------------
// T7 — AN UNREADABLE STRANDED QUEUE. Found by executing the migration runbook against a
// fixture rather than by reading the code: `strandedQueues` read every file it listed with no
// guard, so one `chmod 000` queue threw EACCES straight out of module top level and killed
// BOTH `blaze commit` and `blaze commit --status` with a raw stack trace. The single surface
// that reports stranded work reported nothing at all, on the one board state where an operator
// most needs it.
//
// ADR-0030, and BLZ-518's lesson applied to this reader: a file that could not be read is not a
// file with nothing in it. `count: null` is the marker, and such a queue is ALWAYS listed —
// unlike an empty one, which is correctly filtered out — because "I could not read it" is the
// finding.
// ---------------------------------------------------------------------------
test("BLZ-556: an unreadable stranded queue is REPORTED with an unknown count, never thrown and never counted as zero", (t) => {
  const main = repo();
  const wt = worktree(main, "lane-eacces");
  try {
    mkdirSync(join(wt, ".blaze", "pending"), { recursive: true });
    const good = join(wt, ".blaze", "pending", "good.jsonl");
    const bad = join(wt, ".blaze", "pending", "bad.jsonl");
    writeFileSync(good, `${JSON.stringify({ id: "ZZZ-1", files: ["f"] })}\n`);
    writeFileSync(bad, `${JSON.stringify({ id: "ZZZ-2", files: ["f"] })}\n`);
    chmodSync(bad, 0o000);
    try { accessSync(bad, constants.R_OK); t.skip("running as root — chmod 000 is not a read barrier here"); return; } catch { /* genuinely unreadable */ }

    const stranded = strandedQueues(wt);           // must not throw
    const byName = Object.fromEntries(stranded.map((q) => [q.session, q]));
    assert.equal(byName.good.count, 1, "the readable queue still reports its real count");
    assert.equal(byName.bad.count, null, "the unreadable one reports an UNKNOWN count, not 0");
    assert.match(byName.bad.error, /EACCES/, "and says why it could not be read");
    assert.equal(stranded.reduce((n, q) => n + (q.count ?? 0), 0), 1,
      "a total over these can only be built from the queues that were actually read");
  } finally {
    try { chmodSync(join(wt, ".blaze", "pending", "bad.jsonl"), 0o644); } catch { /* already gone */ }
    cleanup(main, wt);
  }
});

// ---------------------------------------------------------------------------
// T8 — THE DIRECTORY LISTING, at BOTH sites, pinned separately.
//
// The per-file read was wrapped and the `readdirSync` above it was left bare — the partial
// sweep. A `.blaze/pending` directory at mode 000 with a perfectly readable queue inside still
// threw `EACCES: scandir` from module top level and killed both verbs: same function, same
// errno, one character of permission away from the case that had just been fixed.
//
// Two sites, two tests, because they are two guards and a single test would let either one be
// deleted while looking pinned:
//   * `listQueuesResult` — the SHARED store, the directory BLZ-556 puts behind every worktree
//   * `strandedQueues`   — a not-yet-migrated working copy's own directory
// ---------------------------------------------------------------------------
const unreadableDirOr = (t, dir) => {
  chmodSync(dir, 0o000);
  try { readdirSync(dir); chmodSync(dir, 0o755); t.skip("running as root — chmod 000 is not a listing barrier"); return false; }
  catch { return true; }
};

test("BLZ-556: the SHARED store's directory being unlistable is reported, not thrown (listQueuesResult)", (t) => {
  const main = repo();
  const wt = worktree(main, "lane-scandir-store");
  const dir = join(main, ".blaze", "pending");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), `${JSON.stringify({ id: "ZZZ-1", files: ["f"] })}\n`);
    if (!unreadableDirOr(t, dir)) return;

    const r = listQueuesResult(wt);                 // must not throw
    assert.equal(r.queues.length, 0, "nothing could be enumerated");
    assert.equal(r.unreadable.length, 1, "and that is reported, so it cannot read as `no queues`");
    assert.equal(r.unreadable[0].dir, dir);
    assert.match(r.unreadable[0].error, /EACCES/);
  } finally { try { chmodSync(dir, 0o755); } catch { /* gone */ } cleanup(main, wt); }
});

test("BLZ-556: a stranded working copy's directory being unlistable is reported, not thrown (strandedQueues)", (t) => {
  const main = repo();
  const wt = worktree(main, "lane-scandir-stranded");
  const dir = join(wt, ".blaze", "pending");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "old.jsonl"), `${JSON.stringify({ id: "ZZZ-1", files: ["f"] })}\n`);
    if (!unreadableDirOr(t, dir)) return;

    const stranded = strandedQueues(wt);            // must not throw
    assert.equal(stranded.length, 1);
    assert.equal(stranded[0].count, null, "an unknown count, never 0");
    assert.equal(stranded[0].dir, true, "and marked as the DIRECTORY, so the message can say so");
    assert.equal(stranded[0].path, dir);
    assert.match(stranded[0].error, /EACCES/);
  } finally { try { chmodSync(dir, 0o755); } catch { /* gone */ } cleanup(main, wt); }
});
