import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../scripts/config.mjs";
import { createApp } from "../scripts/supervisor.mjs";

function gitBoard() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-sup-"));
  mkdirSync(join(dir, "backlog"), { recursive: true });
  const stub = join(dir, "stub-agent.sh");
  writeFileSync(stub, '#!/usr/bin/env bash\nsed -i -E "s/^labels: \\[\\]/labels: [backend]/" "$BLAZE_GROOM_TARGET"\n');
  chmodSync(stub, 0o755);
  writeFileSync(join(dir, "blaze.config.json"), JSON.stringify({
    key: "TASK", agentCommand: `bash ${stub}`, loops: { groomer: { columns: ["backlog"] } },
  }));
  writeFileSync(join(dir, "backlog", "TASK-001-x.md"),
    "---\nid: TASK-001\ntitle: x\ntype: feature\npriority: medium\nlabels: []\n---\nbody\n");
  for (const a of [["init","-q"],["config","user.email","t@t"],["config","user.name","t"],["add","-A"],["commit","-q","-m","seed"]])
    execFileSync("git", ["-C", dir, ...a]);
  return dir;
}

function sseFirstEvent(port) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request({ port, path: "/events" }, (res) => {
        let buf = "";
        res.on("data", (c) => {
          buf += c;
          const m = buf.match(/data: (.*)\n\n/);
          if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  });
}

function post(port, path) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request({ port, path, method: "POST" }, (res) => { res.resume(); res.on("end", resolve); });
      req.on("error", reject);
      req.end();
    });
  });
}

test("control/groomer/run publishes a groom event on the SSE stream and commits", async () => {
  const dir = gitBoard();
  const cfg = loadConfig({ root: dir, env: {} });
  const app = createApp(cfg, { root: dir });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;

  const eventP = sseFirstEvent(port);
  await new Promise((r) => setTimeout(r, 50)); // let the stream attach before publishing
  await post(port, "/control/groomer/run");
  const evt = await eventP;

  assert.equal(evt.type, "groom");
  assert.equal(evt.id, "TASK-001");
  const log = execFileSync("git", ["-C", dir, "log", "--oneline"], { encoding: "utf8" });
  assert.match(log, /chore\(groom\): TASK-001/);

  app.server.close();
  rmSync(dir, { recursive: true, force: true });
});
