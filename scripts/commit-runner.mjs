// scripts/commit-runner.mjs — `blaze commit`: drain the caller's OWN pending
// queue (session-keyed via BLAZE_SESSION, else the shared fallback) into ONE
// commit, staging only recorded files. `--all` sweeps every queue + fallback
// (the bundler / end-of-day path). A failed flush keeps the queue files.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readForDrain, clearLedger, listQueues, sessionId } from "./pending-ledger.mjs";
import { resolveRoots } from "./config.mjs";
import { acquireLock, releaseLock } from "./commit-lock.mjs";

const { dataRoot } = resolveRoots();
const all = process.argv.slice(2).includes("--all");

// Which queues to drain: every existing queue with --all, else only the caller's own.
const targets = all ? listQueues(dataRoot) : [{ session: sessionId() }];
const drained = targets
  .map((q) => ({ session: q.session, ...readForDrain(dataRoot, q.session) }))
  .filter((q) => q.entries.length > 0);
const entries = drained.flatMap((q) => q.entries.map((e) => ({ ...e, session: q.session })));

if (entries.length === 0) {
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

const lock = acquireLock(dataRoot, { session: sessionId() });
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
