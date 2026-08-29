// scripts/pending-ledger.mjs — append-only JSONL ledgers of pending board ops
// for batch commit mode. One queue per session (keyed by BLAZE_SESSION) under
// .blaze/pending/, plus the legacy shared fallback .blaze/pending-commit.jsonl
// for callers with no session set. All gitignored; drained by `blaze commit`.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
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

function parseLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
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

export function readEntries(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return [];
  return parseLines(readFileSync(path, "utf8"));
}

// Read a queue for draining: entries plus the byte length consumed, so the
// drainer can clear exactly what it read and preserve ops appended meanwhile.
// bytes is measured on the RAW buffer — the same offset space clearLedger
// subarrays. Measuring the decoded string would inflate the offset when the
// file ends in a partial multibyte char (process killed mid-append): the
// invalid byte decodes to U+FFFD, which re-encodes at 3 bytes.
export function readForDrain(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return { entries: [], bytes: 0 };
  const buf = readFileSync(path);
  return { entries: parseLines(buf.toString("utf8")), bytes: buf.length };
}

export function clearLedger(root, session = null, consumedBytes = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return;
  if (consumedBytes === null) {
    writeFileSync(path, ""); // back-compat: truncate to empty exactly as before
    return;
  }
  // Drain-exact clear: keep only bytes appended AFTER the drain read, so an op
  // queued by another session mid-commit isn't lost. A microsecond
  // read-rewrite window remains between the readFileSync and writeFileSync
  // below (an append landing in that gap is overwritten by the rewrite) —
  // acceptable for this advisory, single-host design; not distributed-safe.
  const buf = readFileSync(path);
  writeFileSync(path, buf.subarray(consumedBytes));
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
