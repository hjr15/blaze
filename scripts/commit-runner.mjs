// scripts/commit-runner.mjs — `blaze commit`: drain the caller's OWN pending
// queue (session-keyed via BLAZE_SESSION, or auto-derived from the harness's
// own session id when unset) into ONE commit, staging only recorded files.
// `--all` sweeps every queue plus the legacy shared fallback (the bundler /
// end-of-day CronJob path). With no session identity at all (neither
// BLAZE_SESSION nor a harness id), the caller's "own queue" IS the shared
// fallback — refuse to drain it silently unless `--all` or `--shared` says
// so, since it may hold another session's work. A failed flush keeps the
// queue files.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
  readForDrain, clearLedger, listQueues, sessionId, readEntries, outstandingFiles,
  queueRoot, strandedQueues, belongsHere, worktreeBranchOwners, listQueuesResult,
} from "./pending-ledger.mjs";
import { resolveRoots } from "./config.mjs";
import { acquireLock, releaseLock } from "./commit-lock.mjs";
import { assertWritable } from "./readonly.mjs";
import { checkBranch, currentBranch } from "./branch-guard.mjs";
import { summarizeEntries, renderQueueStatus } from "./commit-summary.mjs";

const { dataRoot } = resolveRoots();
const argv = process.argv.slice(2);
let all = false;
let shared = false;
let branchOk = false;
let status = false;
for (const a of argv) {
  switch (a) {
    case "--all": all = true; break;
    case "--shared": shared = true; break;
    case "--branch-ok": branchOk = true; break;
    case "--status": status = true; break;
    case "--help": case "-h":
      console.log("usage: blaze commit [--all] [--shared] [--branch-ok] [--status]  (--shared drains ONLY the shared fallback queue, never the caller's own; --branch-ok overrides the INF-673 foreign-branch refusal; --status REPORTS every queue and flushes nothing)");
      process.exit(0);
    default:
      console.error(`unknown flag: ${a}`);
      process.exit(1);
  }
}

// BLZ-556 / ADR-0033: the ONE store, and this working tree's identity within it.
//
// `store` is the repository's shared queue store — `.blaze/` beside the common `.git`, the
// same directory for every worktree of this repo. `here` is which working tree THIS run is,
// which decides what it may commit: an op's files exist in the checkout that queued it and
// nowhere else. `stranded` is the pre-migration leftovers in this working copy's own
// `.blaze/`, which the store no longer reads — counted and reported, never touched.
const store = queueRoot(dataRoot);
const here = {
  worktree: relative(store, dataRoot),
  branch: currentBranch(dataRoot),
  // Which branches OTHER worktrees hold. An op whose branch is one of those is another
  // checkout's work; an op whose branch is merely different is INF-673's incident and is
  // left for `checkBranch` below to refuse as a batch.
  branchOwner: worktreeBranchOwners(dataRoot),
};
const stranded = strandedQueues(dataRoot);
// The SHARED store's own directory listing. Separate from `stranded` because it is the store
// every worktree drains, not a leftover: if it cannot be listed, this run does not know what is
// queued anywhere, and must not report success.
const storeListing = listQueuesResult(dataRoot);
// Sums only the queues that were actually READ. An unreadable one carries `count: null` and is
// reported through `strandedUnreadable` instead, so the total is never quietly inflated by a
// queue nobody opened.
//
// UNPINNABLE, and said so rather than left looking pinned: `count` is only ever a number or
// `null`, and `null` already coerces to 0 in `+`, so reverting `?? 0` to a bare `q.count`
// changes no output and reddens nothing. It is kept for the reader and against a future
// `undefined` (which WOULD make this NaN), not because a test holds it in place. What IS pinned
// is the reporting property either side of it — that an unreadable queue is counted separately
// and named, never folded into the number.
const strandedOps = stranded.reduce((n, q) => n + (q.count ?? 0), 0);
const strandedUnreadable = stranded.filter((q) => q.count === null);

// Both the report and the flush say the same things about unreached work, in the same
// words, so the operator reading `--status` and the operator reading a red CronJob log are
// looking at one fact. `foreign` is filled in by the flush path below; `--status` renders
// the stranded half only, because it drains nothing and so strands nothing.
const foreign = [];
function unreachedLines() {
  const out = [];
  if (foreign.length > 0) {
    // Named with the SAME precedence `belongsHere` decides by, so the message can never
    // attribute an op to somewhere other than the reason it was held back.
    //
    // The empty string is spelled out. It is a WRITTEN value (BLZ-556 records the main
    // working tree as ""), so `??` did not fall through to the branch arm — it coalesced to
    // `""` and printed `1 op(s) queued in ` with nothing after it. That lands on exactly the
    // detached-main path the unconditional stamp exists to protect: the op is safe, and the
    // operator is told to go and run `blaze commit` in a working tree the message declines
    // to name.
    const label = (e) => {
      if (e.worktree !== undefined && e.worktree !== null) {
        const where = e.worktree === "" ? "the main working tree" : e.worktree;
        return e.branch ? `${where} (branch '${e.branch}')` : where;
      }
      // UNREACHABLE with no branch, and unreachable with a branch nobody owns: an entry with
      // no `worktree` reaches `foreign` only through `belongsHere`'s branch fallback, which
      // fires only when `branchOwner` HAS that branch. Both of the arms that used to stand
      // here for those cases were dead code and are deleted rather than left looking live.
      return `${here.branchOwner.get(e.branch)} (branch '${e.branch}')`;
    };
    const by = new Map();
    for (const e of foreign) by.set(label(e), (by.get(label(e)) ?? 0) + 1);
    out.push(`blaze commit: ${foreign.length} op(s) in the shared queue store belong to ANOTHER working tree and were not flushed:`);
    for (const [k, n] of [...by].sort()) out.push(`    ${n} op(s) queued in ${k}`);
    out.push("  Their files exist only in that checkout, so committing them here would stage nothing");
    out.push("  and then clear the queue. Run `blaze commit` from that working tree.");
  }
  if (storeListing.unreadable.length > 0) {
    for (const u of storeListing.unreadable) {
      out.push(`blaze commit: the queue store's own directory could not be listed — ${u.dir}`);
      out.push(`    ${u.error}`);
      out.push("  Nothing here knows what is queued in it, so this run cannot report the board flushed.");
    }
  }
  if (stranded.length > 0) {
    const howMany = strandedUnreadable.length > 0
      ? `${strandedOps} op(s), plus ${strandedUnreadable.length} queue(s) that could not be read,`
      : `${strandedOps} op(s)`;
    out.push(`blaze commit: ${howMany} still sit in this working copy's OWN .blaze/, which is no longer`);
    out.push("  the queue store (BLZ-556 moved it beside the repository's shared .git):");
    for (const q of stranded) {
      const what = q.count === null ? `UNREADABLE (${q.error}) — op count unknown` : `${q.count} op(s)`;
      const which = q.dir ? "queue directory" : q.session === null ? "legacy fallback" : `queue ${q.session}`;
      out.push(`    ${what} — ${which} — ${q.path}`);
    }
    out.push("  Nothing has been moved, merged or deleted. Migrate them with the procedure in");
    out.push("  docs/operations/queue-store-migration.md, then re-run.");
  }
  return out;
}
// Exit 3, and not 0, is the whole point of BLZ-556: `outcome=published` must not be true
// while ops remain queued somewhere this run does not reach. 1 is the verb's refusals
// (nothing happened at all) and 2 is `--status` reporting incompletely; 3 is new and means
// "what this working tree could reach is flushed, and there is more that it cannot".
const UNREACHED_EXIT = 3;

// BLZ-499 / ADR-0032: the read. Placed HERE — after flag parsing, before the
// BLZ-121 write gate, before `checkBranch`, before `acquireLock`, and before the
// `git add`/`git commit` — for the same reason `checkBranch` sits where it does: a
// path that writes nothing must leave nothing half-made, and must not be refused by
// a gate on a write it never performs. It reports EVERY queue, deliberately: the
// measurement behind ADR-0032 found 185 ops stranded across 8 sessions, none of them
// the caller's own, and a report scoped to `mySession` would have shown a clean board
// on every one of the five days they sat there.
if (status) {
  // BLZ-518: PER QUEUE. Before this, all three of the shapes below threw out of this
  // expression and took the ENTIRE report with them — on the live board, eight queues'
  // worth of state lost to one bad line, and BLZ-498's orphaned-queue condition is exactly
  // where an old malformed entry is most likely to be sitting. A *status* verb that aborts
  // is reporting nothing, which is the one thing it exists not to do.
  //
  //   - an entry with no `files` list  -> `path.join(root, undefined)` (ERR_INVALID_ARG_TYPE)
  //   - a queue file that is a DIRECTORY or a FIFO -> refused by ADR-0031's regular-file guard
  //   - a recorded path outside the board -> `outstandingFiles`'s BLZ-394 refusal
  //
  // The third refusal is CORRECT and is deliberately still raised: this verb must not
  // report on a path outside the board. What changes is only its blast radius. Caught here
  // rather than pushed down into `outstandingFiles`, because that function's contract —
  // "never report a queue as settled on a probe that did not run" (ADR-0030) — is the
  // reason the refusal exists, and softening it there would weaken every other caller.
  const queues = storeListing.queues.map((q) => {
    try {
      const entries = readEntries(dataRoot, q.session);
      // Named per entry, so the operator can find the bad line rather than being told the
      // queue is "invalid". `files` is the one field every queued op must carry.
      const paths = entries.flatMap((e, i) => {
        if (!Array.isArray(e.files)) {
          throw new Error(`entry ${i + 1} (id ${e.id ?? "?"}, op ${e.op ?? "?"}) has no \`files\` list`);
        }
        return e.files;
      });
      return { session: q.session, entries, files: outstandingFiles(dataRoot, paths) };
    } catch (e) {
      // `files: null` is the ADR-0030 marker: this queue was NOT looked at, so it carries
      // no buckets to be summed into a total or mistaken for zeroes.
      return { session: q.session, entries: [], files: null, error: e.message };
    }
  });
  // Name the resolved store. Before BLZ-556 the operator had no way to tell, from any
  // output blaze produced, WHICH `.blaze/` a given invocation was reading — which is how
  // 210 ops came to sit in four of them without anyone noticing.
  console.log(`blaze commit --status: queue store ${store}`
    + (store === dataRoot ? " (this working copy)" : ` — shared, this working copy is ${dataRoot}`));
  console.log(renderQueueStatus(queues, sessionId()));
  if (stranded.length > 0 || storeListing.unreadable.length > 0) console.error(unreachedLines().join("\n"));
  // Exit 2, not 0: the report is INCOMPLETE. A caller scripting on `blaze commit --status`
  // must be able to tell "I looked at every queue and here is the state" from "part of the
  // board is unreadable" — the exit-code seam of the same rule the output obeys. 1 is
  // already taken by the verb's own refusals (unknown flag, read-only, no identity, lock,
  // branch guard), which are a different thing: those are runs that never reported at all.
  // 2 also when a STRANDED queue could not be read: the report is incomplete in exactly the
  // same way, and the caller scripting on this must not read "I looked at everything" from a run
  // that could not open part of the board.
  process.exit(
    queues.some((q) => q.error) || strandedUnreadable.length > 0 || storeListing.unreadable.length > 0
      ? 2 : 0);
}

// BLZ-121 defence-in-depth, hoisted here for the same reason as
// move-runner.mjs: this runner talks to git directly and never goes through
// commitOrQueue/appendEntry, so it carries none of their guards — without its
// own check here, `BLAZE_READONLY=1 node scripts/commit-runner.mjs` would
// reach the git add/commit calls below and actually commit. cli.mjs is the
// primary gate for the normal `blaze commit` path; this only matters for a
// direct invocation. Hoisted AFTER flag parsing so `--help`/`-h` (a read)
// still works under BLAZE_READONLY. Caught locally so the refusal reads as a
// deliberate `blaze: …` line, not a raw stack trace an agent may misread as a crash.
try {
  assertWritable("flush the pending queue");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const mySession = sessionId();

// No BLAZE_SESSION and no harness id: mySession is null, so the caller's own
// queue is the shared fallback file — the same one every other no-identity
// caller reads and writes. Draining it here without --shared risks taking a
// foreign session's queued work as if it were this caller's own. --all (the
// CronJob's sole-committer path, which sweeps the fallback by design) and
// --shared (an explicit, deliberate drain) both bypass this.
if (!all && !shared && mySession === null) {
  const fallback = readForDrain(dataRoot, null);
  if (fallback.entries.length > 0) {
    console.error(
      `blaze commit: no session identity (BLAZE_SESSION unset) — refusing to drain the shared fallback queue (${fallback.entries.length} op(s)); it may hold another session's work. Set BLAZE_SESSION, or pass --shared to drain it deliberately.`,
    );
    process.exit(1);
  }
}

// Which queues to drain: every existing queue with --all; else, with --shared,
// ONLY the shared fallback (session: null) — the flag names the fallback
// itself, not "my own queue, whichever one that resolves to", so it drains
// the fallback regardless of whether the caller also has a session identity
// of its own (that queue is left untouched); else the caller's own queue.
const targets = all ? storeListing.queues : [{ session: shared ? null : mySession }];
const drained = targets
  .map((q) => ({ session: q.session, ...readForDrain(dataRoot, q.session) }))
  .filter((q) => q.entries.length > 0);

// BLZ-556: partition each queue by PROVENANCE before anything is staged. One store means
// this run can now see every worktree's ops — the fix — and could therefore commit ops
// whose files are not in this checkout. On the live board that was 191 of 210 ops: they
// would be dropped by the `existsSync || isTracked` filter below and then cleared by
// `clearLedger`. INF-673's `checkBranch` does not stop it; that guard returns ok as soon
// as the checkout is on the default branch, without reading an entry's provenance.
//
// `keep` carries the RAW lines of the ops held back, so they are rewritten byte-for-byte
// and compose with the drain-exact clear that preserves a mid-commit append.
for (const q of drained) {
  q.mine = [];
  q.keep = [];
  q.entries.forEach((e, i) => {
    if (belongsHere(e, here)) q.mine.push(e);
    else { q.keep.push(q.lines[i]); foreign.push(e); }
  });
}
const entries = drained.flatMap((q) => q.mine.map((e) => ({ ...e, session: q.session })));

if (entries.length === 0) {
  // Ops this run cannot reach are NOT "nothing to flush". Saying so, and exiting 0, is
  // precisely the false green BLZ-556 exists to remove.
  if (foreign.length > 0 || stranded.length > 0 || storeListing.unreadable.length > 0) {
    console.error(unreachedLines().join("\n"));
    process.exit(UNREACHED_EXIT);
  }
  // Signpost the orphan case: a session id that no longer resolves to the
  // same queue (e.g. BLAZE_SESSION changed between runs) silently abandons
  // whatever was queued under the old name. Without this hint "nothing to
  // flush" reads as "nothing was ever queued" — name what's actually sitting
  // there so it isn't mystifying.
  if (!all) {
    const own = targets[0].session;
    const others = storeListing.queues
      .filter((q) => q.session !== own)
      .map((q) => ({ session: q.session, count: readForDrain(dataRoot, q.session).entries.length }))
      .filter((q) => q.count > 0);
    if (others.length > 0) {
      const total = others.reduce((n, q) => n + q.count, 0);
      const names = others.map((q) => (q.session === null ? "legacy" : q.session)).join(", ");
      const ownLabel = own === null ? "the shared queue (no session identity)" : `session ${own}`;
      console.error(`blaze commit: nothing to flush for ${ownLabel} — ${total} op(s) queued in other sessions (${names}); use --all to sweep them`);
    }
  }
  console.log("blaze commit: nothing to flush");
  process.exit(0);
}

// INF-673: refuse before anything is staged or committed, so a refusal leaves
// no half-made commit to clean off the foreign branch. Placed after the queues
// are read (the message names the stranded tickets) but before the lock, the
// `git add` and the `git commit` — the queue is left fully intact, so the
// caller just re-runs from a checkout on the default branch.
const guard = checkBranch(dataRoot, entries, { override: branchOk });
if (!guard.ok) {
  console.error(guard.message);
  process.exit(1);
}

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

// Counts by op → "2 new, 3 logged, 1 moved, 1 resolved". BLZ-427: composed in
// commit-summary.mjs, which is importable — this file is a script with top-level
// side effects, so nothing here could ever be reached by a test.
const summary = summarizeEntries(entries);

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

// BLZ-556: TWO locks, because there are now two shared resources with different extents,
// and one lock cannot cover both.
//
//   * the LEDGER is shared by every worktree of the repo. `clearLedger` does byte-offset
//     arithmetic (`buf.subarray(consumedBytes)`) against a file it read before the commit
//     ran, so two flushes overlapping in different worktrees resurrect one op (already
//     committed, back in the queue, commits twice) and shred another into an unparseable
//     fragment — a shape this codebase has no recovery path for. Before one store this was
//     impossible: the queues were different files. So the ledger lock must be on the STORE.
//   * the GIT INDEX is per-worktree. `serve-commit.mjs` locks the invoking root, so keeping
//     a lock there is what still excludes a per-op commit in THIS checkout.
//
// Taking both is not a compromise between them, it is both properties: no trade to decide.
// The store lock is always taken FIRST, so the acquisition order is global and two runs can
// never hold one lock each waiting on the other. `acquireLock` does NOT fail fast — it
// retries 10 times at 200 ms, so it blocks for up to ~2 s before giving up — but the wait is
// bounded and it then returns `{ok:false}` rather than parking forever, and the only other
// holder, `serve-commit.mjs`, takes exactly one lock and releases it in a `finally`. So no
// cycle exists to deadlock on, which is the conclusion; the bounded retry, not a fail-fast
// acquire, is the reason.
//
// NOT an exclusion this lock actually provides: `acquireLock`'s 60 s `staleMs` steals the
// lock from a LIVE owner (deliberately — `tests/commit-lock.test.mjs` pins it), so a flush
// that runs longer than 60 s has its store lock taken by another worktree and the
// resurrect/shred window reopens. That was benign while the queues were separate files per
// working copy and is not now. Filed separately; the lease is not redesigned here.
//
// `store === dataRoot` is an exact string comparison, and is sound because `queueRoot`
// returns the root it was handed VERBATIM when the candidate resolves to the same directory
// (see its parent===root early return). Were that not so, the main checkout would try to
// lock one directory twice under two spellings and refuse to flush at all.
const storeLock = acquireLock(store, { session: mySession });
if (!storeLock.ok) {
  console.error(`blaze commit: queue-store commit.lock held by pid ${storeLock.owner?.pid ?? "?"} (session ${storeLock.owner?.session ?? "?"}) at ${store} — another worktree of this repo is flushing; try again shortly; ledger kept`);
  process.exit(1);
}
const treeLock = store === dataRoot ? { ok: true } : acquireLock(dataRoot, { session: mySession });
if (!treeLock.ok) {
  releaseLock(store);
  console.error(`blaze commit: commit.lock held by pid ${treeLock.owner?.pid ?? "?"} (session ${treeLock.owner?.session ?? "?"}) — try again shortly; ledger kept`);
  process.exit(1);
}
const unlock = () => {
  if (store !== dataRoot) releaseLock(dataRoot);
  releaseLock(store);
};
const bail = (msg) => {
  console.error(msg);
  unlock();
  process.exit(1);
};
const add = spawnSync("git", ["-C", dataRoot, "add", "--", ...files], { stdio: "ignore" });
if (add.status !== 0) bail(`blaze commit: git add failed (status ${add.status}) — ledger kept, resolve manually`);
const commit = spawnSync("git", ["-C", dataRoot, "commit", "-m", subject, "-m", body, "--", ...files], { stdio: "inherit" });
if (commit.status !== 0) bail(`blaze commit: git commit failed (status ${commit.status}) — ledger kept, resolve manually`);
for (const q of drained) clearLedger(dataRoot, q.session, q.bytes, q.keep);
unlock();
console.log(`blaze commit: flushed ${entries.length} op(s) → ${subject}`);
// The commit succeeded; the QUEUE did not empty. Report and exit non-zero, so no caller
// can read this run as "the board is flushed".
if (foreign.length > 0 || stranded.length > 0 || storeListing.unreadable.length > 0) {
  console.error(unreachedLines().join("\n"));
  process.exit(UNREACHED_EXIT);
}
