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

export function readEntries(root, session = null) {
  const path = ledgerPath(root, session);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
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

export function clearLedger(root, session = null) {
  const path = ledgerPath(root, session);
  if (existsSync(path)) writeFileSync(path, "");
}

// Every queue that exists: the shared fallback first (session: null), then
// each .blaze/pending/<session>.jsonl sorted by session name.
export function listQueues(root) {
  const queues = [];
  if (existsSync(ledgerPath(root))) queues.push({ session: null, path: ledgerPath(root) });
  const dir = join(root, ".blaze", "pending");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
      queues.push({ session: f.slice(0, -".jsonl".length), path: join(dir, f) });
    }
  }
  return queues;
}
