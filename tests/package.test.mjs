import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

test("package identity", () => {
  assert.equal(pkg.name, "@hjr15/blaze-board");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.bin.blaze, "scripts/cli.mjs");
  assert.ok(pkg.files.includes("scripts/"), "files whitelist must ship scripts/");
  assert.ok(pkg.files.includes("AGENTS.md"), "files whitelist must ship AGENTS.md (agent-facing contract)");
  assert.ok(!pkg.files.includes("CONVENTIONS.md"), "CONVENTIONS.md is stale/removed and must not ship");
  assert.equal(pkg.engines?.node, ">=20", "engine floor matches the tested Node line");
});

test("npm pack ships engine only — no tests, no data dirs, no dotfiles beyond defaults", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: REPO, encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.some((f) => f.startsWith("scripts/")), "scripts/ present");
  assert.ok(files.includes("AGENTS.md"), "AGENTS.md present in the packed tarball");
  for (const f of files) {
    assert.ok(!f.startsWith("tests/"), `tests must not ship: ${f}`);
    assert.ok(!f.startsWith("projects/"), `data must not ship: ${f}`);
    assert.ok(!f.startsWith("docs/"), `docs must not ship: ${f}`);
    assert.ok(!f.startsWith("brand/"), `brand must not ship: ${f}`);
    assert.ok(f !== "CONVENTIONS.md", "CONVENTIONS.md must not ship");
  }
});
