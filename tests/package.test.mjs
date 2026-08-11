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

test("attribution: the LICENSE retains the upstream notice and adds the maintainer's", () => {
  // INF-767: hjr15/blaze is a FORK of sychyoboN/blaze, and its LICENSE originally carried only
  // the upstream author's copyright — which `files` then shipped under this npm scope. MIT
  // requires RETAINING the original notice, so the fix adds a line rather than replacing one.
  // Both lines must survive; a future tidy-up that drops the upstream line is a licence breach.
  const license = readFileSync(join(REPO, "LICENSE"), "utf8");
  assert.match(license, /^MIT License/);
  assert.match(license, /Copyright \(c\) \d{4} Jordan Lyons/, "upstream notice must be retained");
  assert.match(license, /Copyright \(c\) \d{4} Ryan Howman/, "maintainer notice must be present");
  assert.ok(pkg.files.includes("LICENSE"), "the corrected LICENSE must actually ship");
});

test("discovery metadata is set — a published package with blank fields is unfindable", () => {
  // INF-824. `npm view` rendered author/homepage/bugs/keywords as undefined on 0.5.1: the
  // package resolved and installed, so nothing failed, but it carried no maintainer, no route
  // to report a bug, and nothing to match a search on.
  assert.ok(pkg.author, "author must name the maintainer of this scope");
  assert.ok(pkg.homepage, "homepage must point somewhere a reader can learn what this is");
  assert.ok(pkg.bugs?.url, "bugs.url must give a route to report a defect");
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 3, "keywords must support search");
  assert.match(pkg.repository.url, /github\.com\/hjr15\/blaze/, "repository must resolve to the source");
});
