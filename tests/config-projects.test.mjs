// tests/config-projects.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects, loadProject } from "../scripts/config.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "blaze-proj-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({
    projects: ["OBA", "INF"], codeRepos: ["../fallback-repo"], port: 4321,
  }));
  mkdirSync(join(root, "projects", "OBA"), { recursive: true });
  mkdirSync(join(root, "projects", "INF"), { recursive: true });
  writeFileSync(join(root, "projects", "OBA", "project.json"), JSON.stringify({
    key: "OBA", name: "Online Broker Agent", components: ["gateway"],
    codeRepos: ["../online-broker-agent"], requireWorklogBeforeTerminal: true,
  }));
  // INF has no project.json fields beyond defaults → exercises global codeRepos fallback.
  writeFileSync(join(root, "projects", "INF", "project.json"), JSON.stringify({ key: "INF", name: "Infrastructure" }));
  return root;
}

test("listProjects reads the configured keys", () => {
  const root = fixture();
  assert.deepEqual(listProjects(undefined, { root }).sort(), ["INF", "OBA"]);
  rmSync(root, { recursive: true, force: true });
});

test("loadProject merges project.json over defaults and resolves codeRepos", () => {
  const root = fixture();
  const oba = loadProject("OBA", { root });
  assert.equal(oba.name, "Online Broker Agent");
  assert.deepEqual(oba.components, ["gateway"]);
  assert.equal(oba.requireWorklogBeforeTerminal, true);
  assert.ok(oba.codeRepoPaths[0].endsWith("/online-broker-agent"));
  assert.equal(oba.idFromRef("you/OBA-373-slug"), "OBA-373");
  assert.equal(oba.idFromRef("no-match"), null);
  assert.ok(oba.fileRegex.test("OBA-373-x.md"));
  assert.ok(!oba.fileRegex.test("INF-1-x.md"));
  rmSync(root, { recursive: true, force: true });
});

test("loadProject falls back to global codeRepos when project declares none", () => {
  const root = fixture();
  const inf = loadProject("INF", { root });
  assert.equal(inf.requireWorklogBeforeTerminal, false);  // default
  assert.ok(inf.codeRepoPaths[0].endsWith("/fallback-repo"));
  rmSync(root, { recursive: true, force: true });
});
