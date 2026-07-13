// tests/serve-batch-peronp.test.mjs — BLZ-97 companion: an explicit
// "per-op mode still commits exactly once, behaviour unchanged" check, run in
// its own process/file so it gets its own cfg.commitMode = "per-op" (fixed at
// import — see serve-batch.test.mjs's header comment for why).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "blaze-sbpo-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ projects: ["OBA"], commitMode: "per-op" }));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "in-review"), { recursive: true });
  writeFileSync(join(projects, "OBA", "in-review", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n## Acceptance Criteria\n- [ ] one\n");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  return { root, projects };
}
const commitCount = (root) =>
  Number(execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());

const initFixture = repo();
process.env.BLAZE_PROJECTS_DIR = initFixture.projects;
const { startServer, CSRF } = await import("../scripts/serve.mjs");
delete process.env.BLAZE_PROJECTS_DIR;
rmSync(initFixture.root, { recursive: true, force: true });

async function boot({ root, projects }) {
  const server = startServer({ projectsDir: projects, root, port: 0 });
  await new Promise((res) => server.once("listening", res));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

const post = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-blaze-csrf": CSRF }, body: JSON.stringify(body) });

test("per-op mode: POST /api/edit adds exactly one commit (behaviour unchanged)", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const before = commitCount(fx.root);
  const res = await post(base, "/api/edit", { id: "OBA-1", patch: { assignee: "ryan" } });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(commitCount(fx.root), before + 1, "exactly one commit must land");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});

test("per-op mode: POST /api/move adds exactly one commit (behaviour unchanged)", async () => {
  const fx = repo();
  const { server, base } = await boot(fx);
  const before = commitCount(fx.root);
  const res = await post(base, "/api/move", { id: "OBA-1", to: "done" });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(commitCount(fx.root), before + 1, "exactly one commit must land");
  server.close(); rmSync(fx.root, { recursive: true, force: true });
});
