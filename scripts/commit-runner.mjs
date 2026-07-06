// scripts/commit-runner.mjs — `blaze commit`: drain .blaze/pending-commit.jsonl
// into ONE commit (subject summary + per-op body), staging only recorded files.
import { spawnSync } from "node:child_process";
import { readEntries, clearLedger } from "./pending-ledger.mjs";
import { resolveRoots } from "./config.mjs";

const { dataRoot } = resolveRoots();

const entries = readEntries(dataRoot);
if (entries.length === 0) {
  console.log("blaze commit: nothing to flush");
  process.exit(0);
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
const body = entries.map((e) => `- ${e.message}`).join("\n");

const files = [...new Set(entries.flatMap((e) => e.files))];

const add = spawnSync("git", ["-C", dataRoot, "add", "--", ...files], { stdio: "ignore" });
if (add.status !== 0) {
  console.error(`blaze commit: git add failed (status ${add.status}) — ledger kept, resolve manually`);
  process.exit(1);
}
const commit = spawnSync("git", ["-C", dataRoot, "commit", "-m", subject, "-m", body, "--", ...files], { stdio: "inherit" });
if (commit.status !== 0) {
  console.error(`blaze commit: git commit failed (status ${commit.status}) — ledger kept, resolve manually`);
  process.exit(1);
}
clearLedger(dataRoot);
console.log(`blaze commit: flushed ${entries.length} op(s) → ${subject}`);
