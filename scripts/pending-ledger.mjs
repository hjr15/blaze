// scripts/pending-ledger.mjs — append-only JSONL ledgers of pending board ops
// for batch commit mode. One queue per session (keyed by BLAZE_SESSION) under
// .blaze/pending/, plus the legacy shared fallback .blaze/pending-commit.jsonl
// for callers with no session set. All gitignored; drained by `blaze commit`.
//
// BLZ-556 / ADR-0033: the store is one per REPOSITORY, not one per working copy.
// See `queueRoot` below.
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, relative, isAbsolute, resolve } from "node:path";
import { assertWritable } from "./readonly.mjs";
// BLZ-493 / ADR-0031. `readFileSync` OPENS whatever the path names, and opening a FIFO with no
// writer blocks forever — no error, no timeout, no exit. The ledger was never in BLZ-493's
// sweep, and BLZ-556 widens the exposure: one store means a FIFO named `<session>.jsonl`
// wedges `blaze commit` in EVERY worktree of the repo and the unattended flush CronJob, not
// just the checkout it was planted in. Found by running the migration runbook against a
// fixture, where `mkfifo` hung the whole harness rather than being refused.
import { readRegularFileSync, writeRegularFileSync, appendRegularFileSync } from "./model/regular-file.mjs";

// Sanitized BLAZE_SESSION, else an id derived from the agent harness's own
// session id — stable across invocations and inherited by every descendant,
// unlike process.ppid (a fresh shell per command => a fresh pid). null when
// neither exists: no reliable identity, so `blaze commit` refuses to drain the
// shared fallback without --shared rather than risk taking a foreign session's ops.
export function sessionId(env = process.env) {
  const clean = (v) => (v || "").replace(/[^A-Za-z0-9._-]/g, "");
  const explicit = clean(env.BLAZE_SESSION);
  if (explicit !== "") return explicit;
  const harness = clean(env.CLAUDE_CODE_SESSION_ID);
  if (harness !== "") return `auto-${harness}`;
  return null;
}


// --- BLZ-556: ONE queue store per repository ---------------------------------
// `.blaze/pending/` used to be resolved against whichever working copy the process
// ran in, so an op was queued into the worktree the agent happened to be standing
// in. On the operator's board that scattered 210 ops across four working copies
// (19 / 185 / 6 / 0), and the nightly flush — which mounts exactly one of them —
// drained 19 and reported `outcome=published`.
//
// `git rev-parse --git-common-dir` names the shared `.git` for any worktree of one
// repo (a linked worktree's own `.git` is a FILE pointing there), so `.blaze/`
// beside it is a single canonical location for all of them. The store the flush
// already mounts becomes the only store there is — no new mounts, and the cause is
// fixed rather than the symptoms enumerated.
//
// REFUTED ALTERNATIVE, recorded so it is not retried: repointing the flush at the
// `board-main` worktree. It holds 0 ops, so the Job would exit 0 green every night
// having flushed nothing while the ops accumulated elsewhere.
//
// Three layouts resolve `--git-common-dir` to something whose parent is NOT a
// working tree of this repo, and each would silently relocate the store outside the
// board. All three are verified by construction in
// tests/pending-ledger-queue-root.test.mjs, not reasoned about:
//   - a BARE repo      -> ".", so the parent is the directory CONTAINING the repo
//   - a SUBMODULE      -> "<super>/.git/modules/<name>", inside the superproject
//   - an ambient GIT_DIR / GIT_COMMON_DIR -> an entirely unrelated repository.
//     Reachable, not theoretical: every git hook runs with GIT_DIR exported, so a
//     blaze verb invoked from a hook inherits it. `git -C` obeys it.
//
// Hence: scrub the git env vars from the child, and require the candidate to be a
// working tree whose OWN top level is that candidate (which is false for a bare
// repo's parent and for `.git/modules/`), and to look like a board. Anything else
// falls through to the invoking root rather than guessing.
//
// config.mjs's `mainWorktreeFor` (INF-763) answers a similar question for relative
// `codeRepos`. It is deliberately NOT reused: a wrong answer there makes reconcile
// fail loudly, whereas a wrong answer here silently writes ops somewhere nothing
// drains. Unifying them behind this hardened resolver is filed separately.
const GIT_ENV_OVERRIDES = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
function gitQuery(cwd, args) {
  const env = { ...process.env };
  for (const k of GIT_ENV_OVERRIDES) delete env[k];
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env });
}

const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };

function resolveQueueRoot(root) {
  const r = gitQuery(root, ["rev-parse", "--git-common-dir"]);
  if (r.status !== 0) return root; // not a repo, or no git at all: the invoking root is the store
  const raw = (r.stdout || "").trim();
  if (raw === "") return root;
  const parent = dirname(isAbsolute(raw) ? raw : resolve(root, raw));
  // Returns `root` VERBATIM, never a normalised twin: `commit-runner.mjs` compares
  // `store === dataRoot` as exact strings to decide one lock or two. Measured, so the claim
  // is not overstated: deleting this line leaves every flush test green, because a
  // normalised root still string-matches itself — the answer changes only for a
  // NON-normalised spelling (`<root>/.`, a trailing slash), which `resolveRoots` cannot
  // produce. It is therefore a fast path in production (one fewer git spawn) and a
  // spelling-preserving contract for direct API callers, pinned as the latter.
  if (realOrSelf(parent) === realOrSelf(root)) return root; // main working tree / plain clone
  // The candidate must be a working tree that IS itself — false for a bare repo's
  // containing directory and for a superproject's .git/modules.
  const top = gitQuery(parent, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return root;
  const topPath = (top.stdout || "").trim();
  if (topPath === "" || realOrSelf(topPath) !== realOrSelf(parent)) return root;
  // ...and it must look like a board. An unusual layout keeps its own store rather
  // than having its ops written somewhere no flush is pointed at.
  if (!existsSync(join(parent, "projects"))) return root;
  return parent;
}

// Memoised: this is on the path of every queued op, and a repo's worktree layout
// does not change within a process (the same reasoning as config.mjs's INF-763 cache).
const _queueRootCache = new Map();
export function queueRoot(root) {
  if (!_queueRootCache.has(root)) _queueRootCache.set(root, resolveQueueRoot(root));
  return _queueRootCache.get(root);
}

export function ledgerPath(root, session = null) {
  const store = queueRoot(root);
  return session
    ? join(store, ".blaze", "pending", `${session}.jsonl`)
    : join(store, ".blaze", "pending-commit.jsonl");
}

export function appendEntry(root, entry, session = null) {
  // BLZ-121 defence-in-depth (see commit-or-queue.mjs's guard for the
  // rationale) — this is currently commitOrQueue's only caller, but guarding
  // here too covers any future direct caller without relying on that.
  assertWritable("append to the pending ledger");
  const path = ledgerPath(root, session);
  mkdirSync(dirname(path), { recursive: true });
  // ADR-0031's APPEND primitive, not `appendFileSync`. Its docstring measured the hazard:
  // `appendFileSync` opens the path, and opening a FIFO with no reader blocks in `open(2)`
  // forever — a `try/catch` around a blocking call catches nothing. A FIFO planted at the
  // caller's OWN queue file (`<store>/.blaze/pending/<session>.jsonl`) wedged every `blaze new`,
  // `move`, `edit`, `log` and `resolve` on the board, not just a flush. `O_NONBLOCK` turns that
  // into an immediate ENXIO. The read side alone was not a sweep: BLZ-556 puts ONE store behind
  // every worktree, so one such FIFO wedges every worktree's queueing path and the unattended
  // CronJob alike. O_APPEND also keeps the small single-line writes atomic between processes,
  // which is what `appendFileSync`'s append mode was relied on for here.
  appendRegularFileSync(path, JSON.stringify(entry) + "\n");
}

// Returns [{ entry, line }]. The RAW line travels with the parsed entry because a
// drain that keeps some ops back (BLZ-556: an op belonging to another working tree)
// must rewrite those ops byte-for-byte. Re-serialising a parsed entry would normalise
// anything this engine did not write, and the ledger is append-only evidence.
function parseRecords(text, { quiet = false } = {}) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push({ entry: JSON.parse(line), line });
    } catch {
      // A partial final line (process killed mid-append) or a corrupt line:
      // skip rather than throw so a good ledger still drains. Warn so the drop is visible.
      if (!quiet) process.stderr.write("blaze: skipping unparseable pending-commit ledger line\n");
    }
  }
  return out;
}

function parseLines(text) {
  return parseRecords(text).map((r) => r.entry);
}

export function readEntries(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return [];
  return parseLines(readRegularFileSync(path, "utf8"));
}

// Read a queue for draining: entries plus the byte length consumed, so the
// drainer can clear exactly what it read and preserve ops appended meanwhile.
// bytes is measured on the RAW buffer — the same offset space clearLedger
// subarrays. Measuring the decoded string would inflate the offset when the
// file ends in a partial multibyte char (process killed mid-append): the
// invalid byte decodes to U+FFFD, which re-encodes at 3 bytes.
export function readForDrain(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return { entries: [], bytes: 0, lines: [] };
  const buf = readRegularFileSync(path, null);
  const records = parseRecords(buf.toString("utf8"));
  // `lines[i]` is the raw text of `entries[i]`'s line — index-aligned, so a caller that
  // decides per entry can hand exactly the corresponding raw lines back to clearLedger.
  return { entries: records.map((r) => r.entry), bytes: buf.length, lines: records.map((r) => r.line) };
}

// BLZ-498: a queue with NOTHING left in it is removed, not truncated to a zero-byte
// file. The ticket's title is literal — "every abandoned session leaks one forever" —
// and the leak is the file: `.blaze/pending/` grew by one entry per session that had
// ever run and never shrank (28 queues holding 19 ops in the operator's `blaze-pm`
// checkout, 14 holding 185 in the v4-spine worktree; see
// docs/reports/2026-08-30-blz-500-ledger-capture.md §1 and §4). An emptied queue is not
// evidence of anything — its ops are in `git log` — so keeping it only inflates every
// count taken over `listQueues`, which is how "8 of 14 queues" reads as a board in worse
// shape than it is. Removal is safe in both directions: `appendEntry` recreates the file
// (and its directory) on the next queued op, and every reader goes through
// `existsSync`. The unlink is CONDITIONAL on the remainder being empty — a drain-exact
// clear that preserves a mid-commit append must preserve its file too, or that op is
// destroyed by the very mechanism written to save it.
const clearOrRemove = (path, remainder) => {
  if (remainder.length === 0) { rmSync(path, { force: true }); return; }
  // ADR-0031's write primitive, for the same reason as the append: `writeFileSync` blocks on a
  // FIFO exactly as the read and the append do, and this runs at the END of a flush that has
  // already committed — hanging here would strand the ledger with the commit made and never
  // return, which for the unattended CronJob is a job that never finishes.
  //
  // UNPINNABLE, said plainly rather than counted as a guard: every path that reaches this write
  // goes through `clearLedger`'s `readRegularFileSync` on the SAME path a few lines above, which
  // refuses a FIFO first — and the one branch that skips that read (`consumedBytes === null`)
  // passes an empty remainder, so it unlinks rather than writes. Reverting this line to
  // `writeFileSync` reddens nothing. It is kept for the reason ADR-0031 keeps the `isFile()`
  // check in its own `appendRegularFileSync`: the sibling calls have it, a future caller that
  // does not read first would need it, and the only window it could ever close — the path being
  // swapped for a FIFO between that read and this write — is the read-rewrite window this file
  // already documents rather than a new one.
  writeRegularFileSync(path, remainder);
};

/** `keepLines` (BLZ-556) are raw lines from the consumed prefix that must SURVIVE the
 *  drain — the ops this working tree may not commit, because their files live in the
 *  worktree that queued them. They are written back ahead of the post-drain tail, so a
 *  partial drain and a mid-commit append compose: neither destroys the other. Defaulting
 *  to [] leaves every pre-existing call site byte-identical in behaviour. */
export function clearLedger(root, session = null, consumedBytes = null, keepLines = []) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return;
  // REACHABILITY, stated plainly rather than implied. This branch has NO production caller:
  // the only production call site, `commit-runner.mjs`'s drain loop, always passes
  // `q.bytes`. It is reached solely by `tests/pending-ledger.test.mjs`, which pins its
  // back-compat shape. It therefore cannot be killed by any mutation of production
  // behaviour — reverting it to the pre-BLZ-498 `writeFileSync(path, "")` leaves the full
  // suite green — and it must not be described as pinned by the revert rule. Keep-vs-remove
  // is being decided on its own ticket; it is deliberately not settled here.
  if (consumedBytes === null) {
    clearOrRemove(path, Buffer.alloc(0)); // back-compat: nothing is kept, so nothing is left
    return;
  }
  // Drain-exact clear: keep only bytes appended AFTER the drain read, so an op
  // queued by another session mid-commit isn't lost. A microsecond
  // read-rewrite window remains between the readFileSync and writeFileSync
  // below (an append landing in that gap is overwritten by the rewrite) —
  // acceptable for this advisory, single-host design; not distributed-safe.
  const buf = readRegularFileSync(path, null);
  const tail = buf.subarray(consumedBytes);
  if (keepLines.length === 0) { clearOrRemove(path, tail); return; }
  clearOrRemove(path, Buffer.concat([Buffer.from(keepLines.map((l) => `${l}\n`).join(""), "utf8"), tail]));
}

// Every queue that exists: the shared fallback first (session: null), then
// each .blaze/pending/<session>.jsonl sorted by session name.
export function listQueues(root) {
  return listQueuesResult(root).queues;
}

/** `listQueues` plus what it could NOT enumerate.
 *
 *  BLZ-556. Wrapping the per-file READ and leaving the directory LISTING bare covered the case
 *  the tests drove and missed its sibling: a `.blaze/pending` directory at mode 000 with a
 *  perfectly readable queue inside still threw `EACCES: scandir` out of module top level and
 *  killed `blaze commit` and `blaze commit --status` on a raw stack trace — same function, same
 *  errno, one character of permission away from the case that was fixed.
 *
 *  It matters more here than anywhere else: this listing is over the SHARED store, the one
 *  directory BLZ-556 puts behind every worktree. `unreadable` is separate from `queues` so a
 *  caller cannot mistake "there are no queues" for "I could not look" — ADR-0030 — and the
 *  flush refuses to report success while it is non-empty. */
export function listQueuesResult(root) {
  const queues = [];
  const unreadable = [];
  if (existsSync(ledgerPath(root))) queues.push({ session: null, path: ledgerPath(root) });
  // BLZ-556: the SHARED store, so this enumerates every worktree's queues, not just the
  // ones the invoking working copy happens to hold. That is what makes `blaze commit
  // --status` count 210 instead of 19.
  const dir = join(queueRoot(root), ".blaze", "pending");
  if (existsSync(dir)) {
    try {
      // Sort by session NAME, not filename: "main-2.jsonl" < "main.jsonl" as
      // filenames ('-' < '.'), but "main" < "main-2" as names.
      const sessions = readdirSync(dir)
        .filter((n) => n.endsWith(".jsonl"))
        .map((n) => n.slice(0, -".jsonl".length))
        .sort();
      for (const s of sessions) queues.push({ session: s, path: join(dir, `${s}.jsonl`) });
    } catch (e) {
      unreadable.push({ dir, error: e.message });
    }
  }
  return { queues, unreadable };
}

/** Ops left behind in THIS working copy's own `.blaze/`, which the shared store no
 *  longer reads — the pre-migration state, named so it cannot be silent.
 *
 *  BLZ-556. 210 ops were already on disk in four stores when the store moved. Draining,
 *  moving or merging them is a data operation on the operator's live board, and this code
 *  does NONE of it: it counts and it reports. `listQueues` deliberately does not include
 *  them, so nothing downstream can drain a stranded queue by accident; `blaze commit`
 *  refuses to report success while any exist.
 *
 *  Empty only in the two states that are actually fine: a working copy that IS the shared
 *  store (the main working tree — reporting it would tell the operator to migrate the
 *  destination onto itself), and a worktree whose leftover files hold no ops. So a green
 *  report means migrated-or-nothing-to-migrate, never not-looked. */
export function strandedQueues(root) {
  const shared = queueRoot(root);
  if (realOrSelf(shared) === realOrSelf(root)) return [];
  const out = [];
  // ADR-0030, and BLZ-518's lesson applied to this reader: a queue file that could not be READ
  // is not a queue file with nothing in it. An unreadable one threw straight out of here and
  // took the WHOLE verb with it — `blaze commit` and `blaze commit --status` both died on a raw
  // EACCES stack trace, so the one surface that reports stranded work reported nothing at all.
  // Caught per file: `count: null` is the marker that this queue was not looked at, so no caller
  // can sum it into a total or mistake it for zero, and it is always REPORTED (never filtered
  // out the way an empty queue is) because "I could not read it" is the finding.
  const add = (session, path) => {
    try {
      const n = parseRecords(readRegularFileSync(path, "utf8"), { quiet: true }).length;
      if (n > 0) out.push({ session, path, count: n });
    } catch (e) {
      out.push({ session, path, count: null, error: e.message });
    }
  };
  const legacy = join(root, ".blaze", "pending-commit.jsonl");
  if (existsSync(legacy)) add(null, legacy);
  const dir = join(root, ".blaze", "pending");
  if (existsSync(dir)) {
    try {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
        add(name.slice(0, -".jsonl".length), join(dir, name));
      }
    } catch (e) {
      // The DIRECTORY could not be listed (mode 000, or replaced by something unlistable).
      // Reported as one unreadable entry with an unknown count, exactly like an unreadable
      // file: the listing is the same kind of probe, and it failed the same way.
      out.push({ session: null, path: dir, count: null, error: e.message, dir: true });
    }
  }
  return out;
}

/** Which branches are checked out in OTHER worktrees of this repo, and by which one.
 *
 *  BLZ-556. This is the fact that separates the two ways an op's recorded branch can differ
 *  from the branch in front of you, which look identical in the ledger and need opposite
 *  handling:
 *
 *    - another WORKTREE has that branch checked out. The op's files are in that checkout
 *      and not in this one. Hold it back. (BLZ-556)
 *    - nobody has it checked out — this same working copy was on that branch when the op
 *      was queued and has since moved. The files ARE here; the batch is INF-673's
 *      foreign-branch incident and must be refused wholesale, with its recovery
 *      instructions, not silently filtered.
 *
 *  git answers it directly, and keeps answering after the other worktree's directory is
 *  gone — a removed worktree is still listed, marked `prunable`. That matters: the flush
 *  CronJob mounts only the main checkout, so the sibling worktrees do not exist inside its
 *  container, and a probe that needed them on disk would report every stranded op as this
 *  container's own and destroy it. Verified by construction.
 *
 *  Memoised for the same reason as queueRoot. */
const _ownersCache = new Map();
export function worktreeBranchOwners(root) {
  if (_ownersCache.has(root)) return _ownersCache.get(root);
  const owners = new Map();
  const r = gitQuery(root, ["worktree", "list", "--porcelain"]);
  if (r.status === 0) {
    const me = realOrSelf(root);
    let path = null;
    for (const line of (r.stdout || "").split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch ") && path !== null && realOrSelf(path) !== me) {
        owners.set(line.slice("branch ".length).replace(/^refs\/heads\//, ""), path);
      }
    }
  }
  _ownersCache.set(root, owners);
  return owners;
}

/** May `entry` be committed from the working tree described by `here`?
 *
 *  BLZ-556. One store makes every worktree's ops visible to every worktree — which is the
 *  fix, and also a new hazard. An op queued in worktree W records paths that exist in W's
 *  checkout and nowhere else. Measured on the live board: of the 186 distinct paths
 *  recorded by v4-spine's 185 ops, 4 exist in the main checkout; of v3-phase0's 2, none
 *  do. Committing those from the main tree would stage almost nothing — `commit-runner`
 *  drops a path that is neither on disk nor tracked — and then clear the ledger. 191 ops
 *  destroyed by the mechanism written to save them. INF-673's `checkBranch` does not catch
 *  it: that guard returns ok as soon as the checkout is on the DEFAULT branch, without
 *  ever reading an entry's provenance.
 *
 *  `worktree` is the direct fact and wins when recorded. `branch` is the fallback that makes
 *  the 210 ops already on disk safe with no migration-time rewriting — none of them carries
 *  a `worktree`, all of them carry a `branch` — but ONLY when `here.branchOwner` shows the
 *  branch belongs to a different worktree. A differing branch that nobody else owns is
 *  INF-673's incident, not this one, and is deliberately left to `checkBranch` to refuse as
 *  a whole batch; filtering it here would swallow that refusal and its recovery steps.
 *
 *  An entry with NEITHER field is a pre-INF-673 op: treated as this tree's, which is exactly
 *  the behaviour it has today. */
export function belongsHere(entry, here) {
  if (entry.worktree !== undefined && entry.worktree !== null) return entry.worktree === here.worktree;
  if (entry.branch !== undefined && entry.branch !== null && here.branchOwner?.has(entry.branch)) return false;
  return true;
}

/** Which of these ledger-recorded paths still carry work that git has not filed.
 *
 *  BLZ-499 / ADR-0032. BLZ-404 rounds 2-4 each asked GIT what the working tree looks
 *  like, and that question has no useful answer: a dirty ticket file looks identical
 *  whether a verb wrote it, a verb wrote it and failed to commit, or a person wrote it.
 *  This asks a different question — WHAT DID BLAZE RECORD THAT IT WROTE? — of blaze's own
 *  ledger, and then asks git only whether each recorded path is still outstanding.
 *
 *  `paths` are repo-relative, exactly as `commitOrQueue` recorded them
 *  (`files: unique.map((f) => relative(root, f))`). They are passed to git as ARGUMENTS,
 *  after `--`, and only an EXIT CODE is read back. Nothing parses a path out of git's
 *  output, so the porcelain path parser BLZ-347 deliberately deleted is not reintroduced
 *  and a filename with a space or a non-ASCII character cannot mangle the answer. Nothing
 *  walks `projects/` either, so a symlinked `projects/` cannot silence this the way it
 *  silenced round 3/4's `git status --porcelain -- <projectsDir>` detector.
 *
 *  Three buckets, because two would lie:
 *    - `outstanding` — the recorded write is still not in HEAD. Real work.
 *    - `settled`     — the file already matches HEAD. The write was filed by SOMETHING
 *                      ELSE (on blaze-pm at 70197405, 118 of these had been filed by 61
 *                      hand-written commits) and the ledger entry is a leftover.
 *    - `absent`      — neither on disk nor tracked. A path created and relocated again
 *                      inside one batch: `commit-runner.mjs` drops exactly these when it
 *                      stages, so counting them as outstanding would invent work.
 *
 *  `git diff --quiet HEAD` alone is NOT sufficient and the tracked/exists check is not
 *  decoration: it is BLIND to an untracked file, so a `blaze new` op's brand-new ticket —
 *  written, queued, never committed — would come back "settled". That is the common case,
 *  not an edge one.
 *
 *  A probe that could not be run is never read as "settled" (ADR-0030): git exiting
 *  anything other than 0 or 1, or failing to spawn at all, throws. Reachable — an absent
 *  or unforkable `git` is an ordinary environment state, not a theoretical branch. */
/** The path GIT knows a ledger-recorded path by.
 *
 *  BLZ-499 review round 1. `commitOrQueue` records `relative(root, f)` and nothing in
 *  `config.mjs` calls `realpath`, so on a board whose `projects/` is a SYMLINK the ledger
 *  holds the through-symlink path (`projects/ZZZ/…`) while git's index holds the real one
 *  (`real/projects/ZZZ/…`). `ls-files --error-unmatch` then never matches, the file reports
 *  untracked-but-present, and EVERY op on that board is reported `outstanding` forever —
 *  including the already-filed ones this verb exists to find. That is the over-fire twin of
 *  the under-fire that killed BLZ-404 round 3/4, on the same fixture, and it corrupts the
 *  one distinction the verb is for.
 *
 *  Resolving the LONGEST EXISTING PREFIX and re-appending the remainder, rather than
 *  `realpathSync` on the whole path, is what makes this work for a move's old path: that
 *  file is already gone, so the full realpath throws, but its parent directory still
 *  resolves and the answer is still the one git indexed it under.
 *
 *  A recorded path that is absolute, or that resolves OUTSIDE the board, is returned
 *  unchanged. Out-of-board paths are BLZ-503's problem; this must not quietly widen what
 *  the probe reaches while fixing something else. */
function gitPath(root, rel) {
  if (isAbsolute(rel)) return rel;
  let realRoot;
  try { realRoot = realpathSync(root); } catch { return rel; }
  const segs = rel.split("/").filter((s) => s !== "" && s !== ".");
  for (let i = segs.length; i >= 0; i -= 1) {
    let head;
    try { head = realpathSync(join(root, ...segs.slice(0, i))); } catch { continue; }
    const full = i === segs.length ? head : join(head, ...segs.slice(i));
    const out = relative(realRoot, full);
    if (out === "" || out.startsWith("..") || isAbsolute(out)) return rel;
    return out;
  }
  return rel;
}

export function outstandingFiles(root, paths, { gitBin = "git" } = {}) {
  // ADR-0030: a probe that could not look does not report what a probe that looked
  // reports. BOTH probes below are two-valued by contract, so any third answer — and a
  // spawn that never ran (`status === null`) — is an absence of evidence, never evidence
  // of a settled queue. Applied to `ls-files` as well as `diff`, because a `git` that
  // cannot answer the first question cannot be trusted on the second either.
  const ask = (rel, args, what) => {
    const r = spawnSync(gitBin, ["-C", root, ...args], { stdio: "ignore" });
    if (r.status === 0 || r.status === 1) return r.status;
    const why = r.status === null ? (r.error?.code ?? "the process never ran") : `exit ${r.status}`;
    throw new Error(
      `blaze: git could not answer whether "${rel}" ${what} (${args[0]} ${args[1]}: ${why}) `
      + "— refusing to report a queue as settled on a probe that did not run");
  };
  const out = { outstanding: [], settled: [], absent: [] };
  for (const rel of [...new Set(paths)]) {
    // Ask git about the path GIT indexed, not the one the ledger happens to spell.
    // Report under the RECORDED spelling, which is what the operator has on disk.
    const probe = gitPath(root, rel);
    const onDisk = existsSync(join(root, rel));
    const tracked = ask(rel, ["ls-files", "--error-unmatch", "--", probe], "is tracked") === 0;
    if (!onDisk && !tracked) { out.absent.push(rel); continue; }
    // Written but never committed (a `new` op): git diff cannot see it, so decide here.
    if (onDisk && !tracked) { out.outstanding.push(rel); continue; }
    if (ask(rel, ["diff", "--quiet", "HEAD", "--", probe], "is committed") === 1) out.outstanding.push(rel);
    else out.settled.push(rel);
  }
  return out;
}
