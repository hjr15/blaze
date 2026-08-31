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
import { checkBranch, currentBranch, defaultBranch } from "./branch-guard.mjs";
import { summarizeEntries, renderQueueStatus, entryIds } from "./commit-summary.mjs";

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
// Does the op's OWN record say it was queued in this checkout? BLZ-590: this is the fact
// that decides whether this run may reach ANY verdict about it.
//
// The local filesystem cannot answer that question. `belongsHere` holds a branch-recorded
// op back only while some OTHER worktree currently has that branch checked out, and
// `checkBranch` returns ok unconditionally on the default branch (branch-guard.mjs) — so a
// checkout on `main` has no second guard, and every one of the 210 live ops is exactly
// that shape: `branch` recorded, `worktree` not. The moment a lane finishes and its
// worktree moves off its branch, this run would see its ops with none of their files
// present and, before this guard, clear them at exit 0 — unattended, since
// `blaze publish` runs `commit-runner --all`.
//
// "No later run can stage it" was checkout-local reasoning about a store BLZ-556 made
// repo-GLOBAL. A run in the other checkout can stage it; `git checkout HEAD -- <path>`
// restores the `git rm` one.
//
// No provenance recorded at all is a pre-INF-673 op. Refusing it everywhere is not the safe
// direction — nothing else would ever claim it either, so it would sit in the queue forever,
// BLZ-590's own bug class of a queue that cannot empty. Claiming it EVERYWHERE is not safe
// either: round 4's review found that a detached worktree (where `checkBranch` is explicitly
// ok) would then judge such an op, call it absent, and clear it at exit 0, destroying the
// record while the real file sat uncommitted in the main tree.
//
// So exactly one checkout claims them, and it is the store's own tree: `here.worktree` is
// `relative(store, dataRoot)`, which is "" for exactly that tree and non-empty everywhere
// else. Round 5's review verified there is exactly one such tree per shared store across
// linked, detached, nested, symlinked, bare and submodule layouts, and that none of them
// leaves a shared store with no claimant.
//
// It is the tree that PROBABLY queued them, not the one that must have: before BLZ-556 the
// store was each working copy's own `.blaze/`, so a no-provenance op left in a LANE's store
// and later merged in by docs/operations/queue-store-migration.md — which appends lines
// byte-verbatim and stamps nothing — would be claimed here and cleared, while the lane's
// file sat uncommitted. Measured as reachable-in-principle and unreachable-in-fact: 0 of the
// 216 ops now in this repo's shared store AND its stranded queues record no provenance. The
// fix belongs in the migration (stamp the source copy's `worktree` as it appends), and is
// ticketed; guessing harder here cannot recover a fact the record does not carry.
//
// The tests pin both halves, so loosening this to `true` or tightening it to `false` is a
// deliberate red either way.
const queuedHere = (e) => {
  if (e.worktree !== undefined && e.worktree !== null) return e.worktree === here.worktree;
  if (e.branch !== undefined && e.branch !== null) return e.branch === here.branch;
  return here.worktree === "";
};
// Named by the same field, in the same order, that `queuedHere` refuses by, so the sentence
// can never describe a different field from the one that actually refused the op. Three legs,
// because `queuedHere` has three: an op recording no provenance at all is refused by every
// tree except the store's own, and saying "queued on branch 'undefined'" about it would name a
// field it does not have.
const notOursBecause = (e) =>
  e.worktree !== undefined && e.worktree !== null
    ? `were queued in working tree '${e.worktree === "" ? "the main working tree" : e.worktree}'`
    : e.branch !== undefined && e.branch !== null
      ? `were queued on branch '${e.branch}', which is not this checkout's`
      : "record no provenance at all, so only the working tree the queue store sits beside can claim them";
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
// BLZ-590: name TICKETS, not entry ids. A reconcile op's `id` is a synthetic key
// (`reconcile:BLZ`) and the tickets it covers are in `ids` — `entryIds` is the accessor
// BLZ-427 added for exactly this, and the subject line has used it all along. Capped,
// because the live case is 210 ops and a message nobody finishes is a message nobody reads.
const nameTickets = (ops) => {
  const ids = [...new Set(ops.flatMap((e) => entryIds(e)))];
  if (ids.length === 0) return "no ticket id recorded";
  return `${ids.slice(0, 10).join(", ")}${ids.length > 10 ? `, and ${ids.length - 10} more ticket(s)` : ""}`;
};
const foreign = [];
// BLZ-590: ops this run DRAINED and then could not judge, so it put them back. Separate
// from `foreign` because they got past `belongsHere` — either their provenance is another
// checkout's (refused at the partition, before any path of theirs is collected) or they
// record no paths to measure at all (discovered during classification).
const heldBack = [];
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
  if (heldBack.length > 0) {
    const by = new Map();
    for (const h of heldBack) by.set(h.why, [...(by.get(h.why) ?? []), h.entry]);
    out.push(`blaze commit: ${heldBack.length} op(s) were put back in the queue — this working tree`);
    out.push("  could not establish what they record, so it did not judge them:");
    for (const [why, ops] of [...by].sort()) {
      out.push(`    ${ops.length} op(s) ${why} — ${nameTickets(ops)}`);
    }
    out.push("  Nothing has been dropped. Whether their files are present here is not the question:");
    out.push("  an op belongs to the checkout that queued it, and only that checkout can say what");
    out.push("  became of the work. Run `blaze commit` there.");
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
//
// BLZ-590: `keepIdx` holds INDICES rather than the raw lines themselves, because a second
// decision later in the run (an op whose provenance is another checkout) also has to put a
// line back, and indices re-sort into the queue's original order. Sorting the raw strings
// would not.
for (const q of drained) {
  q.mine = [];
  q.keepIdx = [];
  q.entries.forEach((e, i) => {
    if (!belongsHere(e, here)) { q.keepIdx.push(i); foreign.push(e); return; }
    // BLZ-590 round 4. Refused HERE, not during classification, because holding the ledger
    // line is only half of not judging an op. `recorded` — and so `addPaths` and the commit
    // pathspec — is built from whatever survives this partition, so an op refused later
    // still had its files staged and COMMITTED by this run: measured on 2026-08-31, a
    // foreign op's ticket file landed in this checkout's commit while its ledger line was
    // kept and the operator was told to "run `blaze commit` there". A tracked board file
    // exists in every checkout, so it is `stageable` here whenever it is dirty here.
    //
    // Provenance needs no probe — it is a property of the RECORD, not of the tree — so it
    // can be asked before any path is collected. May-not-judge now means may-not-touch.
    if (!queuedHere(e)) {
      q.keepIdx.push(i);
      heldBack.push({ entry: e, why: notOursBecause(e) });
      return;
    }
    q.mine.push({ entry: e, index: i });
  });
}
// `origin` maps each drained entry back to the queue and line it came from. The entries
// below are COPIES (`{ ...e, session }`), so identity is the only way back, and the
// held-back decision needs the exact raw line to rewrite byte-for-byte.
const origin = new Map();
const entries = [];
for (const q of drained) {
  for (const { entry, index } of q.mine) {
    const tagged = { ...entry, session: q.session };
    origin.set(tagged, { q, index });
    entries.push(tagged);
  }
}

if (entries.length === 0) {
  // Ops this run cannot reach are NOT "nothing to flush". Saying so, and exiting 0, is
  // precisely the false green BLZ-556 exists to remove.
  if (foreign.length > 0 || heldBack.length > 0 || stranded.length > 0 || storeListing.unreadable.length > 0) {
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
//
// BLZ-590: WHICH ref, reviewed. This compared against the literal `origin/main`, and that
// one spelling was wrong in both directions at once:
//
//   * a board whose default branch is `master` has no `origin/main`, so the warning could
//     never fire on it AT ALL — the signal was simply absent, silently;
//   * a branch with an upstream of its own was measured against a ref it does not publish
//     to. That is what the operator hit: `1 commit(s) behind origin/main … rebase before
//     publishing` on `BLZ-305-v4-spine`, a branch `git` reports as up to date with
//     `origin/BLZ-305-v4-spine`. The sentence was TRUE and about the wrong ref, which is
//     the harder kind of wrong to read.
//
// The ref this warning is about is the one a push would write to — the branch's own
// upstream. Only when the branch has none does the remote default branch stand in, and
// that name is READ from the repo (`origin/HEAD`, else whichever conventional remote ref
// exists) for the same reason `branch-guard.mjs` reads it rather than spelling it here.
// The ref is named in the message, so the operator can see which comparison was made.
const gitOut = (...args) => spawnSync("git", ["-C", dataRoot, ...args], { encoding: "utf8" });
const divergenceRef = () => {
  const up = gitOut("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
  if (up.status === 0 && (up.stdout || "").trim() !== "") return (up.stdout || "").trim();
  const sym = gitOut("symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD");
  if (sym.status === 0 && (sym.stdout || "").trim() !== "") return (sym.stdout || "").trim();
  // `defaultBranch` prefers a LOCAL name (correct for the guard that uses it: it answers
  // "the branch you ought to be on"). Here it is only a candidate for a REMOTE ref, and is
  // used only if that remote ref actually exists — so a `master` checkout that merely has
  // an `origin/main` still gets compared against `origin/main` rather than nothing.
  for (const cand of [defaultBranch(dataRoot), "main", "master"]) {
    if (cand && gitOut("rev-parse", "--verify", "-q", `refs/remotes/origin/${cand}`).status === 0) {
      return `origin/${cand}`;
    }
  }
  return null;
};
const compareTo = divergenceRef();
if (compareTo !== null && gitOut("rev-parse", "--verify", "-q", compareTo).status === 0) {
  const behind = gitOut("rev-list", "--count", `HEAD..${compareTo}`);
  const n = Number((behind.stdout || "").trim());
  if (behind.status === 0 && n > 0) {
    console.error(`blaze commit: warning — ${n} commit(s) behind ${compareTo} (no fetch run); rebase before publishing`);
  }
}

// WHICH RECORDED PATHS GIT COULD HAVE A CHANGE FOR — asked of all THREE trees, because
// there are three and they disagree (BLZ-590).
//
//   existsSync  -> the WORKING TREE
//   ls-files    -> the INDEX
//   cat-file -e -> HEAD
//
// Round 2 read the first two and then made claims about the third. `git rm <boardfile>` —
// an ordinary hand action — falsifies that: the path is in neither the working tree nor
// the index, but it IS in HEAD and the index holds a staged deletion, so there is real
// work to commit for it. Reading only two trees dropped the path, left the staged deletion
// behind in the index, and called the op superseded.
//
// A path created then relocated again within one batch (a ticket moved twice) is in NONE
// of the three, and is still dropped: there is genuinely nothing to stage for it.
const isTracked = (f) =>
  spawnSync("git", ["-C", dataRoot, "ls-files", "--error-unmatch", "--", f], { stdio: "ignore" }).status === 0;
const inHead = (f) =>
  spawnSync("git", ["-C", dataRoot, "cat-file", "-e", `HEAD:${f}`], { stdio: "ignore" }).status === 0;
const recorded = [...new Set(entries.flatMap((e) => e.files))];
// TWO lists, and they are not the same list. `git add` refuses a pathspec that matches
// nothing in the working tree or the index — measured: `git add -- <git-rm'd path>` exits
// 128, "did not match any files" — so a HEAD-only path must not be handed to it. It does
// not need to be: `git rm` already staged the deletion. `git commit -- <that path>` records
// it, which is why the commit pathspec is the wider list.
const stageable = new Set(recorded.filter((f) => existsSync(join(dataRoot, f)) || isTracked(f)));
const files = recorded.filter((f) => stageable.has(f) || inHead(f));
const addPaths = files.filter((f) => stageable.has(f));

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
const add = spawnSync("git", ["-C", dataRoot, "add", "--", ...addPaths], { stdio: "ignore" });
if (add.status !== 0) bail(`blaze commit: git add failed (status ${add.status}) — ledger kept, resolve manually`);

// BLZ-590: "nothing to commit" is NOT "the commit failed". Told apart by asking the index.
//
// Hit live on 2026-08-31 draining the 210 ops BLZ-556 had just consolidated. Every one was
// orphaned — its recorded file already matched HEAD, because the work had been filed by
// hand during the weeks the flush was broken. So `git add` staged nothing, `git commit`
// exited 1, and the line below read that exit code as failure: the operator was told to
// "resolve manually" a situation with nothing to resolve, and the LEDGER WAS KEPT, so the
// queue could never empty and every later run hit the same wall. A board whose recorded
// work is entirely settled could never drain. This is BLZ-502's class one line down —
// there, `git add` failing was separated from `git commit` failing because the wrong name
// sent the operator to read hooks; here, a no-op is separated from a failure.
//
// THE FACT, NOT THE SPELLING. git's "nothing to commit, working tree clean" is a message:
// localisable, version-dependent, and not a contract. Nothing here reads it — the commit
// runs with `stdio: "inherit"`, so its text goes straight to the operator's terminal and is
// never captured, and the verdict below is reached BEFORE any commit is attempted. What is
// asked instead is `git diff --cached --quiet -- <paths>`, whose exit code IS the fact.
//
// Asked PER OP, with the same pathspec spelling `git add` was just given, because the
// answer has to carry WHICH ops were settled: a partly-settled drain must commit the real
// part, settle the rest, and report both, with no op silently dropped and none committed
// twice. Every path in `files` came from some entry's `files`, so "no op has anything
// staged" and "the batch has nothing staged" are the same statement — the batch verdict is
// DERIVED from the per-op one rather than probed a second time and risking disagreement.
//
// ADR-0030 applies unchanged: the probe is two-valued by contract (0 nothing staged,
// 1 something staged), so any third answer, and a spawn that never ran, is an absence of
// evidence and is bucketed UNKNOWN. An unknown op is committed with the rest and never
// reported settled — the safe direction, since the cost of a wrong "settled" is a cleared
// ledger whose work never landed.
//
// THE GATE, asked ONCE, before any bucket is decided.
//
// Rounds 1-3 each fixed the bucket they were shown: round 1 asserted a verdict without
// measuring, round 2 gated nothing, round 3 gated `absent` — and `settled` still cleared an
// op belonging to another checkout at exit 0, over a sentence ("every file they record
// already matches HEAD") that compared THIS checkout's copy against work living somewhere
// else. Three rounds, one defect, three buckets, because the gate was a clause inside a
// branch rather than the question in front of all of them.
//
// So it is not a clause any more. `classify` is called from exactly one place — here, past
// the gate — and a state added to `classify` tomorrow cannot escape provenance by forgetting
// to ask: it is unreachable for a foreign op by construction, not by remembering.
//
// Stated plainly rather than left looking load-bearing: the partition above already refused
// every foreign op, so `elsewhere` is not reachable from here today and no test reddens on
// this line alone. It is kept as the second of two, because the cost of the two disagreeing
// is a cleared ledger, and because it is what makes the property true of `classify` itself
// rather than of one caller.
const opState = (e) => (queuedHere(e) ? classify(e) : "elsewhere");
const classify = (e) => {
  // Zero recorded paths: there is nothing to look at, so nothing can be established. Round
  // 2 called this absent, which asserts the word over an empty measurement. Not reachable
  // from any current writer and 0 of the 210 live ops have it — said plainly rather than
  // left looking like a guarded case.
  //
  // A `files` that is not an array is a SEPARATE defect and this guard does not cover it —
  // round 4's review measured what actually happens, correcting the claim that used to sit
  // here that the `recorded` flatMap throws first. `files: undefined` throws out of
  // `node:path` join with a raw stack trace (ledger safe, exit 1); a STRING `files` does not
  // throw at all — `flatMap` spreads it, and its path is staged and committed while this
  // guard reports the op as recording no files and keeps it queued forever. Only a
  // hand-edited ledger can produce either; ticketed, not fixed here.
  if (!Array.isArray(e.files) || e.files.length === 0) return "no-paths";
  const own = e.files.filter((f) => files.includes(f));
  // Every path this op records is in NONE of the three trees — measured, by the
  // `existsSync` / `ls-files` / `cat-file -e HEAD:` that built `files` above. Deliberately
  // not `settled`: settled means the file IS in HEAD and matches it, which is the opposite
  // claim. `outstandingFiles` (pending-ledger.mjs) has kept these apart since BLZ-499,
  // "because two would lie".
  //
  // WHOSE absence it is has already been settled by the gate: only the checkout the op says
  // queued it reaches here, and only it can read absence as "superseded". No probe is run —
  // there is no pathspec to probe with, and an empty pathspec would silently widen the
  // question to the whole index.
  if (own.length === 0) return "absent";
  const r = spawnSync("git", ["-C", dataRoot, "diff", "--cached", "--quiet", "--", ...own], { stdio: "ignore" });
  if (r.status === 1) return "staged";
  if (r.status === 0) return "settled";
  return "unknown";
};
const state = new Map(entries.map((e) => [e, opState(e)]));
const stagedOps = entries.filter((e) => state.get(e) === "staged");
const unknownOps = entries.filter((e) => state.get(e) === "unknown");
const settledOps = entries.filter((e) => state.get(e) === "settled");
const absentOps = entries.filter((e) => state.get(e) === "absent");
// Put back what this working tree may not judge, in the queue's own order. `heldBack`
// carries the reason so the report names it rather than lumping every case together.
for (const e of entries) {
  const why = state.get(e);
  if (why !== "elsewhere" && why !== "no-paths") continue;
  const o = origin.get(e);
  o.q.keepIdx.push(o.index);
  heldBack.push({
    entry: e,
    why: why === "no-paths"
      ? "recording no files at all, so there is nothing to measure"
      : notOursBecause(e),
  });
}
// What actually enters the commit — and therefore what the commit MESSAGE may describe.
// `summarizeEntries(entries)` counted the whole drain, so a drain of one outstanding op
// and two already-filed ones wrote `(3 new)` onto a one-file commit. A commit message is a
// delivery record; it does not get to claim work the commit does not contain.
const committedEntries = entries.filter((e) => ["staged", "unknown"].includes(state.get(e)));
const summary = summarizeEntries(committedEntries);
const date = new Date().toISOString().slice(0, 10);
const subject = `blaze: ${date} board update (${summary})`;
const body = committedEntries.map((e) => `- ${e.message}${e.session ? ` [${e.session}]` : ""}`).join("\n");

let committed = false;
if (stagedOps.length > 0 || unknownOps.length > 0) {
  const commit = spawnSync("git", ["-C", dataRoot, "commit", "-m", subject, "-m", body, "--", ...files], { stdio: "inherit" });
  // A GENUINE failure — a hook refusing, a bad signature, a lock. The ledger is kept and
  // this exits non-zero, because the work did not land. Collapsing this into the settled
  // path would be worse than the bug it sits beside: it would clear a ledger whose ops were
  // never filed. Nothing here claims the work was filed.
  if (commit.status !== 0) {
    if (unknownOps.length > 0) {
      console.error(`blaze commit: git could not say whether ${unknownOps.length} op(s) had anything staged, so none of them is reported as already filed`);
    }
    bail(`blaze commit: git commit failed (status ${commit.status}) — ledger kept, resolve manually`);
  }
  committed = true;
}

for (const q of drained) {
  clearLedger(dataRoot, q.session, q.bytes, q.keepIdx.sort((a, b) => a - b).map((i) => q.lines[i]));
}
unlock();
if (committed) console.log(`blaze commit: flushed ${committedEntries.length} op(s) → ${subject}`);
// SETTLED and ABSENT get their own sentence each, and are never merged into one. They are
// different established facts, and each sentence says only what was actually established:
//   settled — `git diff --cached --quiet` was run and reported no difference from HEAD.
//   absent  — `existsSync` and `git ls-files` were run and found the path in neither, so
//             there is nothing to commit AND nothing that could be compared to HEAD.
// Merging them is what made round 1 wrong; the merged sentence attested the comparison
// that the absent case is precisely the case of not having.
if (settledOps.length + absentOps.length > 0) {
  // Name the tickets, capped: the live case is 210 ops, and a message nobody finishes
  // reading is a message nobody reads. The count is always exact; the list is a sample.
  const out = [committed
    ? "blaze commit: also cleared from the queue, with nothing of theirs in the commit:"
    : "blaze commit: nothing to commit, and nothing failed. Cleared from the queue:"];
  if (settledOps.length > 0) {
    out.push(`    ${settledOps.length} op(s) already filed — every file they record already matches HEAD`);
    out.push(`      — ${nameTickets(settledOps)}`);
  }
  if (absentOps.length > 0) {
    // Every clause here is a tree this run READ: `existsSync`, `git ls-files`, and
    // `git cat-file -e HEAD:`. Round 2's sentence named HEAD twice having read it zero
    // times, and `git rm` falsified both of those clauses at once.
    out.push(`    ${absentOps.length} op(s) superseded — every path they record is in none of the three trees`);
    out.push(`      this run read (this working tree, git's index, and HEAD), and nothing records them as`);
    out.push(`      queued in another checkout, so there is nothing here left to commit for them`);
    out.push(`      — ${nameTickets(absentOps)}`);
  }
  console.log(out.join("\n"));
}
// The commit succeeded; the QUEUE did not empty. Report and exit non-zero, so no caller
// can read this run as "the board is flushed".
if (foreign.length > 0 || heldBack.length > 0 || stranded.length > 0 || storeListing.unreadable.length > 0) {
  console.error(unreachedLines().join("\n"));
  process.exit(UNREACHED_EXIT);
}
