// tests/serve-batch.test.mjs — BLZ-97: the board's POST /api/* write handlers
// call commitFile directly, ignoring commitMode entirely (no batch path at
// all). Mirrors serve-endpoints.test.mjs's repo()/boot()/post() helpers.
//
// serve.mjs resolves its config ONCE at module import time, from
// resolveRoots()'s dataRoot (see scripts/config.mjs) — so BLAZE_PROJECTS_DIR
// must point at a batch-mode fixture BEFORE serve.mjs is imported. That's
// also exactly how the real CLI entrypoint resolves cfg vs. the board's data
// tree (both come from the same resolveRoots() call), so this mirrors
// production rather than being a test-only shortcut. The init fixture below
// exists only to fix cfg.commitMode = "batch" for this whole process; every
// test below then works against its own fresh repo() fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readEntries, sessionId } from "../scripts/pending-ledger.mjs";
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

// BLZ-120: with BLAZE_SESSION unset (as in this whole test file), queued ops
// auto-derive their own session from ppid rather than landing in the shared
// legacy fallback — read from that queue, not the bare `readEntries(root)`.
const ownQueue = (root) => readEntries(root, sessionId({}));

function repo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-sb-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode: "batch" }));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "in-review"), { recursive: true });
  writeFileSync(join(projects, "OBA", "in-review", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\nworklog:\n  - { date: 2026-06-01, minutes: 30 }\n---\n## Acceptance Criteria\n- [ ] one\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}
const head = (root) => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const initFixture = repo();
process.env.BLAZE_PROJECTS_DIR = initFixture.projects;
const { startServer, CSRF } = await import("../scripts/serve.mjs");
delete process.env.BLAZE_PROJECTS_DIR;
rmSync(initFixture.root, { recursive: true, force: true }); // only needed it to fix cfg.commitMode at import

async function boot({ root, projects }) {
  const server = startServer({ projectsDir: projects, root, port: 0 });
  await new Promise((res) => server.once("listening", res));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-blaze-csrf": CSRF }, body: JSON.stringify(body) });

test("batch mode: POST /api/edit queues, no commit", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const before = head(fx.root);
  const res = await post(base, "/api/edit", { id: "OBA-1", patch: { assignee: "ryan" } });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(head(fx.root), before, "HEAD must not move in batch mode");
  const entries = ownQueue(fx.root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "edit");
  assert.match(entries[0].message, /^OBA-1: edit assignee$/);
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("batch mode: POST /api/move queues a two-file entry, no commit", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const before = head(fx.root);
  const res = await post(base, "/api/move", { id: "OBA-1", to: "done" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(head(fx.root), before, "HEAD must not move in batch mode");
  const entries = ownQueue(fx.root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "move");
  assert.ok(entries[0].files.some((f) => f.includes("in-review")), "ledger must include the source path");
  assert.ok(entries[0].files.some((f) => f.includes("done")), "ledger must include the destination path");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("batch mode: POST /api/resolve queues, no commit", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const before = head(fx.root);
  const res = await post(base, "/api/resolve", { id: "OBA-1", resolution: "wont-do" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(head(fx.root), before, "HEAD must not move in batch mode");
  const entries = ownQueue(fx.root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "resolve");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("batch mode: POST /api/log queues, no commit", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const before = head(fx.root);
  const res = await post(base, "/api/log", { id: "OBA-1", minutes: 15, note: "review" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(head(fx.root), before, "HEAD must not move in batch mode");
  const entries = ownQueue(fx.root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "log");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("batch mode: POST /api/ac queues, no commit", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const before = head(fx.root);
  const res = await post(base, "/api/ac", { id: "OBA-1", index: 0, checked: true });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(head(fx.root), before, "HEAD must not move in batch mode");
  const entries = ownQueue(fx.root);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].op, "ac");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("batch mode: a held commit lock does not block a queued write (batch never touches the lock)", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  assert.equal(acquireLock(fx.root, { session: "other" }).ok, true);
  try {
    const res = await post(base, "/api/log", { id: "OBA-1", minutes: 5 });
    assert.equal(res.status, 200);
  } finally {
    releaseLock(fx.root);
    server.close(); rmSync(fx.root, { recursive: true, force: true });
  }
});
