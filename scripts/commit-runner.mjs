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
import { readForDrain, clearLedger, listQueues, sessionId, readQueue, outstandingFiles, quarantineDropped, quarantinePath } from "./pending-ledger.mjs";
import { resolveRoots } from "./config.mjs";
import { acquireLock, releaseLock } from "./commit-lock.mjs";
import { assertWritable } from "./readonly.mjs";
import { checkBranch } from "./branch-guard.mjs";
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
  //   - a queue file that is a DIRECTORY -> `readFileSync` EISDIR
  //   - a recorded path outside the board -> `outstandingFiles`'s BLZ-394 refusal
  //
  // The third refusal is CORRECT and is deliberately still raised: this verb must not
  // report on a path outside the board. What changes is only its blast radius. Caught here
  // rather than pushed down into `outstandingFiles`, because that function's contract —
  // "never report a queue as settled on a probe that did not run" (ADR-0030) — is the
  // reason the refusal exists, and softening it there would weaken every other caller.
  const queues = listQueues(dataRoot).map((q) => {
    try {
      // `dropped` is why this is `readQueue` and not `readEntries`: an unparseable line
      // yields a SHORT entry list with no other trace, so a queue read in part was being
      // rendered as a queue read in full — partial buckets summed into the totals, no
      // marker, exit 0. The one shape of the four that was silent.
      const { entries, dropped } = readQueue(dataRoot, q.session);
      // Named per entry, so the operator can find the bad line rather than being told the
      // queue is "invalid". `files` is the one field every queued op must carry.
      const paths = entries.flatMap((e, i) => {
        if (!Array.isArray(e.files)) {
          throw new Error(`entry ${i + 1} (id ${e.id ?? "?"}, op ${e.op ?? "?"}) has no \`files\` list`);
        }
        return e.files;
      });
      return { session: q.session, entries, dropped, files: outstandingFiles(dataRoot, paths) };
    } catch (e) {
      // `files: null` is the ADR-0030 marker: this queue was NOT looked at, so it carries
      // no buckets to be summed into a total or mistaken for zeroes.
      return { session: q.session, entries: [], dropped: [], files: null, error: e.message };
    }
  });
  console.log(renderQueueStatus(queues, sessionId()));
  // Exit 2, not 0: the report is INCOMPLETE. A caller scripting on `blaze commit --status`
  // must be able to tell "I looked at every queue and here is the state" from "part of the
  // board is unreadable" — the exit-code seam of the same rule the output obeys. 1 is
  // already taken by the verb's own refusals (unknown flag, read-only, no identity, lock,
  // branch guard), which are a different thing: those are runs that never reported at all.
  //
  // A PARTIALLY read queue counts as incomplete here too. It is the same condition one
  // degree weaker, and it was the silent one: a queue that could not be opened at least
  // announced itself, whereas a queue with one truncated line came back short and looked
  // clean. Both make the report cover less than the board.
  process.exit(queues.some((q) => q.error || q.dropped.length) ? 2 : 0);
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
const targets = all ? listQueues(dataRoot) : [{ session: shared ? null : mySession }];
const drained = targets
  .map((q) => ({ session: q.session, ...readForDrain(dataRoot, q.session) }))
  .filter((q) => q.entries.length > 0);
const entries = drained.flatMap((q) => q.entries.map((e) => ({ ...e, session: q.session })));

if (entries.length === 0) {
  // Signpost the orphan case: a session id that no longer resolves to the
  // same queue (e.g. BLAZE_SESSION changed between runs) silently abandons
  // whatever was queued under the old name. Without this hint "nothing to
  // flush" reads as "nothing was ever queued" — name what's actually sitting
  // there so it isn't mystifying.
  if (!all) {
    const own = targets[0].session;
    const others = listQueues(dataRoot)
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

const lock = acquireLock(dataRoot, { session: mySession });
if (!lock.ok) {
  console.error(`blaze commit: commit.lock held by pid ${lock.owner?.pid ?? "?"} (session ${lock.owner?.session ?? "?"}) — try again shortly; ledger kept`);
  process.exit(1);
}
const bail = (msg) => {
  console.error(msg);
  releaseLock(dataRoot);
  process.exit(1);
};
const add = spawnSync("git", ["-C", dataRoot, "add", "--", ...files], { stdio: "ignore" });
if (add.status !== 0) bail(`blaze commit: git add failed (status ${add.status}) — ledger kept, resolve manually`);
const commit = spawnSync("git", ["-C", dataRoot, "commit", "-m", subject, "-m", body, "--", ...files], { stdio: "inherit" });
if (commit.status !== 0) bail(`blaze commit: git commit failed (status ${commit.status}) — ledger kept, resolve manually`);
// BLZ-518 review round: quarantine BEFORE the clear. `q.bytes` spans the whole file, so
// `clearLedger` erases the lines that failed to parse along with the ops just committed —
// the one path on which `blaze commit` can destroy a record for good. The flush still
// proceeds (a good ledger is not held hostage by one bad line); the bytes are parked in a
// `.corrupt` sidecar, which `listQueues` cannot pick up, and the run says so.
for (const q of drained) {
  if (q.dropped.length) {
    const where = quarantineDropped(dataRoot, q.session, q.dropped);
    console.error(
      `blaze commit: ${q.dropped.length} unparseable line(s) in ${q.session === null ? "the shared fallback queue" : `session ${q.session}`}`
      + ` were NOT committed — moved to ${relative(dataRoot, where)} rather than discarded`);
  }
  clearLedger(dataRoot, q.session, q.bytes);
}
releaseLock(dataRoot);
console.log(`blaze commit: flushed ${entries.length} op(s) → ${subject}`);
