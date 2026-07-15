// tests/runner-schema-guard.test.mjs — D5b: the 6 mutating runners
// (move/edit/link/log/resolve/new) already called loadConfig, but AFTER their
// mutation. Each test here pins the fixed property: on a board stamped
// schemaVersion newer than the engine supports, the runner must throw the
// schema-guard error AND must NOT have mutated the board first (no file
// relocated/edited/created). Mirrors link-runner.test.mjs's spawnSync +
// BLAZE_PROJECTS_DIR isolation style — no git needed, the guard fires before
// any commitOrQueue call is ever reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const runnerPath = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));

// A throwaway DATA dir stamped schemaVersion: 99 (newer than the engine's
// SCHEMA_VERSION=1) — no git needed, the guard must fire before any commit
// attempt. One ticket seeded in projects/OBA/in-progress/OBA-1.md.
function stampedBoard() {
  const root = mkdtempSync(join(tmpdir(), "blaze-guard-"));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "OBA", projects: ["OBA"], schemaVersion: 99 }));
  const dir = join(root, "projects", "OBA", "in-progress");
  mkdirSync(dir, { recursive: true });
  const ticketText = "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\npriority: medium\n---\n\nbody\n";
  writeFileSync(join(dir, "OBA-1.md"), ticketText);
  return { root, ticketFile: join(dir, "OBA-1.md"), ticketText };
}

const run = (name, root, args) => spawnSync(process.execPath, [runnerPath(name), ...args],
  { env: { ...process.env, BLAZE_PROJECTS_DIR: join(root, "projects") }, encoding: "utf8" });

test("blaze move fails loud on a stamped-incompatible board and does not relocate the ticket", () => {
  const { root, ticketFile, ticketText } = stampedBoard();
  const r = run("move-runner.mjs", root, ["OBA-1", "in-review"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze: board schemaVersion 99/);
  assert.ok(existsSync(ticketFile), "ticket must still be in in-progress/");
  assert.equal(readFileSync(ticketFile, "utf8"), ticketText, "ticket content must be untouched");
  assert.ok(!existsSync(join(root, "projects", "OBA", "in-review")), "no in-review/ dir must have been created");
  rmSync(root, { recursive: true, force: true });
});

test("blaze edit fails loud on a stamped-incompatible board and does not edit the ticket", () => {
  const { root, ticketFile, ticketText } = stampedBoard();
  const r = run("edit-runner.mjs", root, ["OBA-1", "priority", "high"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze: board schemaVersion 99/);
  assert.equal(readFileSync(ticketFile, "utf8"), ticketText, "ticket content must be untouched");
  rmSync(root, { recursive: true, force: true });
});

test("blaze link fails loud on a stamped-incompatible board and does not add the link", () => {
  const { root, ticketFile, ticketText } = stampedBoard();
  // second ticket so the link target resolves
  writeFileSync(join(root, "projects", "OBA", "in-progress", "OBA-2.md"),
    "---\nid: OBA-2\ntitle: t2\ntype: task\nproject: OBA\npriority: medium\n---\n\nbody\n");
  const r = run("link-runner.mjs", root, ["OBA-1", "Blocks", "OBA-2"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze: board schemaVersion 99/);
  assert.equal(readFileSync(ticketFile, "utf8"), ticketText, "ticket content must be untouched");
  rmSync(root, { recursive: true, force: true });
});

test("blaze log fails loud on a stamped-incompatible board and does not append a worklog entry", () => {
  const { root, ticketFile, ticketText } = stampedBoard();
  const r = run("log-runner.mjs", root, ["OBA-1", "30"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze: board schemaVersion 99/);
  assert.equal(readFileSync(ticketFile, "utf8"), ticketText, "ticket content must be untouched");
  rmSync(root, { recursive: true, force: true });
});

test("blaze resolve fails loud on a stamped-incompatible board and does not set resolution", () => {
  const { root, ticketFile, ticketText } = stampedBoard();
  const r = run("resolve-runner.mjs", root, ["OBA-1", "wont-do"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze: board schemaVersion 99/);
  assert.equal(readFileSync(ticketFile, "utf8"), ticketText, "ticket content must be untouched");
  rmSync(root, { recursive: true, force: true });
});

test("blaze new fails loud on a stamped-incompatible board and does not create a ticket", () => {
  const { root } = stampedBoard();
  const r = run("new-runner.mjs", root, ["--project", "OBA", "--type", "task", "brand new"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /blaze: board schemaVersion 99/);
  assert.ok(!existsSync(join(root, "projects", "OBA", "defined")), "no defined/ dir must have been created — no ticket written");
  rmSync(root, { recursive: true, force: true });
});
