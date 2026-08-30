// scripts/pending-ledger.mjs — append-only JSONL ledgers of pending board ops
// for batch commit mode. One queue per session (keyed by BLAZE_SESSION) under
// .blaze/pending/, plus the legacy shared fallback .blaze/pending-commit.jsonl
// for callers with no session set. All gitignored; drained by `blaze commit`.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, relative, isAbsolute } from "node:path";
import { assertWritable } from "./readonly.mjs";

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

export function ledgerPath(root, session = null) {
  return session
    ? join(root, ".blaze", "pending", `${session}.jsonl`)
    : join(root, ".blaze", "pending-commit.jsonl");
}

export function appendEntry(root, entry, session = null) {
  // BLZ-121 defence-in-depth (see commit-or-queue.mjs's guard for the
  // rationale) — this is currently commitOrQueue's only caller, but guarding
  // here too covers any future direct caller without relying on that.
  assertWritable("append to the pending ledger");
  const path = ledgerPath(root, session);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n"); // append-mode: atomic for the small single-line writes this ledger produces
}

/** Parse a ledger's lines, returning BOTH what parsed and the raw text of what did not.
 *
 *  Skipping rather than throwing is deliberate and stays: one corrupt line must not hold a
 *  good ledger hostage. What was missing until BLZ-518's review round is that the skip went
 *  no further than a `process.stderr.write` — so every caller received a SHORT list of
 *  entries with no way to know it was short. `blaze commit --status` then rendered such a
 *  queue as fully read, summed its partial buckets into the totals and exited 0, and
 *  `blaze commit` cleared the unparseable bytes along with the ops it had committed. A
 *  caller reading only the exit code, or only the entries, could not see either.
 *
 *  `dropped` carries the RAW lines, not a count: a count is enough to disclaim a total, but
 *  only the bytes let the flush quarantine a record instead of destroying it. */
function parseLines(text) {
  const entries = [];
  const dropped = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partial final line (process killed mid-append) or a corrupt line. The warning
      // stays — it is the only signal on paths that do not read `dropped` — but it is no
      // longer the ONLY signal.
      process.stderr.write("blaze: skipping unparseable pending-commit ledger line\n");
      dropped.push(line);
    }
  }
  return { entries, dropped };
}

/** A queue's parsed entries AND the raw lines that could not be parsed. Callers that must
 *  distinguish "this queue is clean" from "this queue is as much of a queue as I could
 *  read" (ADR-0030) use this; `readEntries` remains the shorthand for the many callers
 *  that only want the entries. */
export function readQueue(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return { entries: [], dropped: [] };
  return parseLines(readFileSync(path, "utf8"));
}

export function readEntries(root, session = null) {
  return readQueue(root, session).entries;
}

// Read a queue for draining: entries plus the byte length consumed, so the
// drainer can clear exactly what it read and preserve ops appended meanwhile.
// bytes is measured on the RAW buffer — the same offset space clearLedger
// subarrays. Measuring the decoded string would inflate the offset when the
// file ends in a partial multibyte char (process killed mid-append): the
// invalid byte decodes to U+FFFD, which re-encodes at 3 bytes.
export function readForDrain(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return { entries: [], dropped: [], bytes: 0 };
  const buf = readFileSync(path);
  // `dropped` rides along so the drainer can quarantine what it could not parse BEFORE it
  // clears the bytes those lines occupy — `bytes` spans the whole file, unparseable lines
  // included, so without this the clear destroys them.
  return { ...parseLines(buf.toString("utf8")), bytes: buf.length };
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
  writeFileSync(path, remainder);
};

export function clearLedger(root, session = null, consumedBytes = null) {
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
  const buf = readFileSync(path);
  clearOrRemove(path, buf.subarray(consumedBytes));
}

/** Where a flush parks the lines it could not parse.
 *
 *  BLZ-518 review round. `readForDrain` measures `bytes` over the WHOLE file, so
 *  `clearLedger(bytes)` erased an unparseable line along with the ops that were
 *  successfully committed — a record destroyed by the flush, verified by construction at
 *  be4b110 (three recorded ops in, two in the commit body, the third then present nowhere
 *  on disk). It has never fired on the live board (the 185 orphaned ops contain 0
 *  unparseable lines) but the path exists, and it is the one way `blaze commit` can lose
 *  something for good.
 *
 *  The extension is deliberately NOT `.jsonl`: `listQueues` filters on that suffix, so a
 *  sidecar can never be picked up as a phantom queue — which would make the condition
 *  self-perpetuating, since its contents are by definition unparseable. */
export function quarantinePath(root, session = null) {
  return session
    ? join(root, ".blaze", "pending", `${session}.corrupt`)
    : join(root, ".blaze", "pending-commit.corrupt");
}

/** Append raw unparseable lines to the queue's sidecar, timestamped. Returns the path so
 *  the caller can name it. Called at the same point as `clearLedger` — after both git calls
 *  have returned 0 — so a failed flush, which keeps its ledger, cannot duplicate them on
 *  the next run. */
export function quarantineDropped(root, session, lines) {
  assertWritable("quarantine unparseable pending-ledger lines");
  const path = quarantinePath(root, session);
  mkdirSync(dirname(path), { recursive: true });
  const stamp = new Date().toISOString();
  appendFileSync(path, lines.map((l) => `${stamp}\t${l}\n`).join(""));
  return path;
}

// Every queue that exists: the shared fallback first (session: null), then
// each .blaze/pending/<session>.jsonl sorted by session name.
export function listQueues(root) {
  const queues = [];
  if (existsSync(ledgerPath(root))) queues.push({ session: null, path: ledgerPath(root) });
  const dir = join(root, ".blaze", "pending");
  if (existsSync(dir)) {
    // Sort by session NAME, not filename: "main-2.jsonl" < "main.jsonl" as
    // filenames ('-' < '.'), but "main" < "main-2" as names.
    const sessions = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => n.slice(0, -".jsonl".length))
      .sort();
    for (const s of sessions) queues.push({ session: s, path: join(dir, `${s}.jsonl`) });
  }
  return queues;
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
