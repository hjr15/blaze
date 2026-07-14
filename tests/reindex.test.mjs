// tests/reindex.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../scripts/reindex.mjs", import.meta.url));

test("reindex runner builds .blaze/index.json and prints a count", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reidx-"));
  mkdirSync(join(root, "projects", "OBA", "todo"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "todo", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\n---\nbody\n");
  const r = spawnSync(process.execPath, [runner, join(root, "projects")],
    { encoding: "utf8", env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /indexed 1 ticket/);
  const out = join(root, ".blaze", "index.json");
  assert.ok(existsSync(out));
  assert.equal(JSON.parse(readFileSync(out, "utf8")).tickets[0].id, "OBA-1");
  rmSync(root, { recursive: true, force: true });
});

test("reindex prints link warnings for a malformed link key", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-reindex-"));
  const dir = join(root, "projects", "OBA", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "OBA-1.md"),
    "---\nid: OBA-1\ntype: task\nproject: OBA\ntitle: t\npriority: medium\n" +
    "links:\n  - { type: Blocks, to: OBA-2 }\n---\n\nbody\n");
  const r = spawnSync(process.execPath, [runner, join(root, "projects")],
    { env: { ...process.env, BLAZE_DB_DIR: join(root, ".blaze") }, encoding: "utf8" });
  assert.match((r.stdout || "") + (r.stderr || ""), /target:/);
  rmSync(root, { recursive: true, force: true });
});
