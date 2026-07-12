// scripts/pending-ledger.mjs — append-only JSONL ledgers of pending board ops
// for batch commit mode. One queue per session (keyed by BLAZE_SESSION) under
// .blaze/pending/, plus the legacy shared fallback .blaze/pending-commit.jsonl
// for callers with no session set. All gitignored; drained by `blaze commit`.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

// Sanitized BLAZE_SESSION, or null when unset/empty-after-sanitize.
export function sessionId(env = process.env) {
  const clean = (env.BLAZE_SESSION || "").replace(/[^A-Za-z0-9._-]/g, "");
  return clean === "" ? null : clean;
}

export function ledgerPath(root, session = null) {
  return session
    ? join(root, ".blaze", "pending", `${session}.jsonl`)
    : join(root, ".blaze", "pending-commit.jsonl");
}

export function appendEntry(root, entry, session = null) {
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
