// tests/model/transitions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseTransitions, buildTransitions, loadTransitions } from "../../scripts/model/transitions.mjs";

test("parseTransitions extracts status moves and skips pure-slug renames", () => {
  const NUL = "\0";
  const log =
    `${NUL}abc${NUL}2026-07-01T10:00:00+00:00\n` +
    `R100\tprojects/DEMO/defined/DEMO-1-old.md\tprojects/DEMO/in-progress/DEMO-1-old.md\n` +
    `R096\tprojects/DEMO/in-progress/DEMO-2-a.md\tprojects/DEMO/in-review/DEMO-2-b.md\n` +  // slug also changed
    `R100\tprojects/DEMO/done/DEMO-3-x.md\tprojects/DEMO/done/DEMO-3-y.md\n`;              // pure slug -> skip
  const out = parseTransitions(log);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "DEMO-1", from: "defined", to: "in-progress", ts: "2026-07-01T10:00:00+00:00" });
  assert.equal(out[1].id, "DEMO-2"); assert.equal(out[1].from, "in-progress"); assert.equal(out[1].to, "in-review");
});

test("parseTransitions handles multiple records and unparseable paths", () => {
  const NUL = "\0";
  const log =
    `${NUL}sha1${NUL}2026-07-01T10:00:00+00:00\n` +
    `R100\tprojects/DEMO/defined/DEMO-1-old.md\tprojects/DEMO/in-progress/DEMO-1-old.md\n` +
    `${NUL}sha2${NUL}2026-07-02T11:00:00+00:00\n` +
    `R100\treadme.md\tREADME.md\n` +  // no project/status/id structure -> skip
    `R100\tprojects/DEMO/in-progress/DEMO-4-a.md\tprojects/DEMO/done/DEMO-4-a.md\n`;
  const out = parseTransitions(log);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "DEMO-1", from: "defined", to: "in-progress", ts: "2026-07-01T10:00:00+00:00" });
  assert.deepEqual(out[1], { id: "DEMO-4", from: "in-progress", to: "done", ts: "2026-07-02T11:00:00+00:00" });
});

test("parseTransitions returns [] on empty input", () => {
  assert.deepEqual(parseTransitions(""), []);
});

function repo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-transitions-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  mkdirSync(join(root, "projects", "T", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "T", "defined", "T-1.md"),
    "---\nid: T-1\ntitle: t\ntype: task\nproject: T\n---\n## Acceptance Criteria\n- [ ] one\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return root;
}

function headOf(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("buildTransitions reads a real git-mv status move from a fixture repo", () => {
  const root = repo();
  mkdirSync(join(root, "projects", "T", "in-progress"), { recursive: true });
  execFileSync("git", ["-C", root, "mv",
    join("projects", "T", "defined", "T-1.md"),
    join("projects", "T", "in-progress", "T-1.md")]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "move T-1"]);

  const { head, transitions } = buildTransitions({ root });
  assert.equal(head, headOf(root));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].id, "T-1");
  assert.equal(transitions[0].from, "defined");
  assert.equal(transitions[0].to, "in-progress");
  assert.equal(typeof transitions[0].ts, "string");

  rmSync(root, { recursive: true, force: true });
});

test("buildTransitions degrades to empty on a non-repo directory", () => {
  const root = mkdtempSync(join(tmpdir(), "blaze-notrepo-"));
  const { head, transitions } = buildTransitions({ root });
  assert.deepEqual({ head, transitions }, { head: null, transitions: [] });
  rmSync(root, { recursive: true, force: true });
});

test("loadTransitions writes the cache and rebuilds identically after deletion", () => {
  const root = repo();
  mkdirSync(join(root, "projects", "T", "in-progress"), { recursive: true });
  execFileSync("git", ["-C", root, "mv",
    join("projects", "T", "defined", "T-1.md"),
    join("projects", "T", "in-progress", "T-1.md")]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "move T-1"]);

  const first = loadTransitions({ root });
  const cachePath = join(root, ".blaze", "transitions.json");
  assert.ok(existsSync(cachePath));
  const cached = JSON.parse(readFileSync(cachePath, "utf8"));
  assert.deepEqual(cached, first);

  rmSync(cachePath, { force: true });
  const rebuilt = loadTransitions({ root });
  assert.deepEqual(rebuilt, first);

  rmSync(root, { recursive: true, force: true });
});

test("loadTransitions refreshes after HEAD moves (new git mv + commit)", () => {
  const root = repo();
  mkdirSync(join(root, "projects", "T", "in-progress"), { recursive: true });
  execFileSync("git", ["-C", root, "mv",
    join("projects", "T", "defined", "T-1.md"),
    join("projects", "T", "in-progress", "T-1.md")]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "move T-1"]);

  const first = loadTransitions({ root });
  assert.equal(first.transitions.length, 1);

  mkdirSync(join(root, "projects", "T", "done"), { recursive: true });
  execFileSync("git", ["-C", root, "mv",
    join("projects", "T", "in-progress", "T-1.md"),
    join("projects", "T", "done", "T-1.md")]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "move T-1 done"]);

  const second = loadTransitions({ root });
  assert.equal(second.transitions.length, 2);
  assert.notEqual(second.head, first.head);
  assert.equal(second.head, headOf(root));

  rmSync(root, { recursive: true, force: true });
});
