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
import { join } from "node:path";
import { readForDrain, clearLedger, listQueues, sessionId } from "./pending-ledger.mjs";
import { resolveRoots } from "./config.mjs";
import { acquireLock, releaseLock } from "./commit-lock.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot } = resolveRoots();
const argv = process.argv.slice(2);
let all = false;
let shared = false;
for (const a of argv) {
  switch (a) {
    case "--all": all = true; break;
    case "--shared": shared = true; break;
    case "--help": case "-h":
      console.log("usage: blaze commit [--all] [--shared]  (--shared drains ONLY the shared fallback queue, never the caller's own)");
      process.exit(0);
    default:
      console.error(`unknown flag: ${a}`);
      process.exit(1);
  }
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
for (const q of drained) clearLedger(dataRoot, q.session, q.bytes);
releaseLock(dataRoot);
console.log(`blaze commit: flushed ${entries.length} op(s) → ${subject}`);
