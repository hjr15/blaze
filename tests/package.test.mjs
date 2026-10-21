import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));

test("package identity", () => {
  assert.equal(pkg.name, "@hjr15/blaze-board");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.bin.blaze, "scripts/cli.mjs");
  assert.ok(pkg.files.includes("scripts/"), "files whitelist must ship scripts/");
  assert.ok(pkg.files.includes("AGENTS.md"), "files whitelist must ship AGENTS.md (agent-facing contract)");
  assert.ok(!pkg.files.includes("CONVENTIONS.md"), "CONVENTIONS.md is stale/removed and must not ship");
  assert.equal(pkg.engines?.node, ">=24", "engine floor matches the tested Node line — node:sqlite needs 24 (BLZ-264)");
});

// BLZ-674 cut 0.8.0 as the LAST @hjr15/blaze-board release (ADR-0008's addendum). BLZ-687
// (BLZ-254 PR D) removes `blaze commit` and `blaze publish` — breaking, so the minor moves — and
// the tree becomes 0.9.0, which is NOT published under this name: the line stays frozen at 0.8.0.
test("BLZ-687: this tree is 0.9.0 — the git ceremony is gone, and 0.8.0 stays the frozen release", async () => {
  assert.equal(pkg.version, "0.9.0");
  const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));
  assert.equal(lock.version, "0.9.0", "package-lock.json's top-level version must move with it");
  assert.equal(lock.packages[""].version, "0.9.0", "…and its root package entry");
  assert.equal(pkg.scripts.commit, undefined, "the `npm run commit` script ran the deleted commit-runner");
  const { idsFromCommitMessage } = await import("../scripts/reconcile.mjs");
  assert.deepEqual(idsFromCommitMessage("BLZ-675: x (#9)\n\n* BLZ-674: y\n* BLZ-678: z", "BLZ"),
    ["BLZ-675", "BLZ-674", "BLZ-678"], "a bundled squash still recovers every child");
});

// BLZ-474 / ADR-0028: the `docs/` assertion below is LOAD-BEARING, not incidental tidiness.
// It is one half of a decision, and the other half is that `AGENTS.md` and `README.md` — the
// two documents that DO ship — link outward by absolute URL rather than by relative path.
// Before that decision, 20 relative `docs/` links (9 in AGENTS.md, 11 in README.md) were dead
// for every installed user. Shipping `docs/` would publish `docs/superpowers/plans/` and
// `docs/superpowers/specs/` — internal work orders and hand-off briefs — to every installer,
// so the decision was to keep the tarball as it is and fix the links. Relaxing this line
// therefore reverses ADR-0028; do it deliberately, with `tests/shipped-doc-links.test.mjs`
// and `tests/config-key-validation.test.mjs`'s BLZ-460 pointer test in the same change.
test("npm pack ships engine only — no tests, no data dirs, no dotfiles beyond defaults", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: REPO, encoding: "utf8" });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  assert.ok(files.some((f) => f.startsWith("scripts/")), "scripts/ present");
  assert.ok(files.includes("AGENTS.md"), "AGENTS.md present in the packed tarball");
  for (const f of files) {
    assert.ok(!f.startsWith("tests/"), `tests must not ship: ${f}`);
    assert.ok(!f.startsWith("projects/"), `data must not ship: ${f}`);
    assert.ok(!f.startsWith("docs/"), `docs must not ship (ADR-0028): ${f}`);
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

// BLZ-687: the prepublishOnly guard is a RUNNING command, so run it — against the real package.json
// (the frozen name: exit 1 + the message) and a copy renamed to the future package (exit 0).
test("BLZ-687: prepublishOnly refuses under @hjr15/blaze-board and passes under a renamed package", () => {
  const guard = (manifest) => {
    const dir = scratch(mkdtempSync(join(tmpdir(), "blz687-prepublish-")));
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    return spawnSync("sh", ["-c", pkg.scripts.prepublishOnly], { cwd: dir, encoding: "utf8" });
  };
  const frozen = guard(pkg);
  assert.equal(frozen.status, 1);
  assert.match(frozen.stderr, /not published as @hjr15\/blaze-board/);
  const renamed = guard({ ...pkg, name: "@hjr15/blaze" });
  assert.equal(renamed.status, 0, renamed.stderr);
});
