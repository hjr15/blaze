import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeBoard(key) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-board-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "backlog"), { recursive: true });
  mkdirSync(join(dir, "todo"), { recursive: true });
  copyFileSync(join(REPO, "scripts", "new-ticket.sh"), join(dir, "scripts", "new-ticket.sh"));
  copyFileSync(join(REPO, "scripts", "config.mjs"), join(dir, "scripts", "config.mjs"));
  copyFileSync(join(REPO, "TEMPLATE.md"), join(dir, "TEMPLATE.md"));
  const cfg = { key, columns: ["backlog", "todo", "in-progress", "in-review", "done", "canceled", "duplicate"] };
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify(cfg));
  return dir;
}

test("creates the first ticket with the configured key and a slug", () => {
  const dir = makeBoard("TASK");
  execFileSync("bash", ["scripts/new-ticket.sh", "Fix shift overlap validation"], { cwd: dir });
  const files = readdirSync(join(dir, "backlog")).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  assert.equal(files[0], "TASK-001-fix-shift-overlap-validation.md");
  const body = readFileSync(join(dir, "backlog", files[0]), "utf8");
  assert.match(body, /^id: TASK-001$/m);
  assert.match(body, /^title: Fix shift overlap validation$/m);
  rmSync(dir, { recursive: true, force: true });
});

test("next id is max+1 across all columns, honouring a custom key", () => {
  const dir = makeBoard("DEV");
  writeFileSync(join(dir, "todo", "DEV-007-existing.md"), "---\nid: DEV-007\n---\n");
  execFileSync("bash", ["scripts/new-ticket.sh", "Add CSV export", "--priority", "high"], { cwd: dir });
  const files = readdirSync(join(dir, "backlog")).filter((f) => f.endsWith(".md"));
  assert.equal(files[0], "DEV-008-add-csv-export.md");
  const body = readFileSync(join(dir, "backlog", files[0]), "utf8");
  assert.match(body, /^priority: high$/m);
  rmSync(dir, { recursive: true, force: true });
});
