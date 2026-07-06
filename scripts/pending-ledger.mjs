// scripts/pending-ledger.mjs — append-only JSONL ledger of pending board ops
// for batch commit mode. Lives in .blaze/ (gitignored); drained by `blaze commit`.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export function ledgerPath(root) {
  return join(root, ".blaze", "pending-commit.jsonl");
}

export function appendEntry(root, entry) {
  const path = ledgerPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n"); // append-mode: atomic for the small single-line writes this ledger produces
}

export function readEntries(root) {
  const path = ledgerPath(root);
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

export function clearLedger(root) {
  const path = ledgerPath(root);
  if (existsSync(path)) writeFileSync(path, "");
}
