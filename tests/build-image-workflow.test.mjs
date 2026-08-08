// INF-798. The engine repo builds `ghcr.io/hjr15/blaze` on every push to main
// (build-image.yml, pre-existing) but nothing moved the pin the deploy chart in
// `service-platform` actually reads — a merge here never reached the cluster on
// its own. This adds a `bump` job mirroring `hjr15/howman-cloud-site`'s
// build-and-deploy.yml, gated by a BUMP_TOKEN secret the operator must mint.
//
// The `Require BUMP_TOKEN` step's ::error:: message points the reader at a
// runbook doc — read at exactly the moment the bump is broken, so a dangling
// path there costs real time (this shipped dangling once already, in
// hjr15/howman-cloud-site, which is why its own test suite asserts the same
// thing). This is that same assertion, in this repo's own test harness
// (`node --test`, tests/*.test.mjs, wired into .github/workflows/test.yml).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = join(REPO, ".github/workflows/build-image.yml");
const raw = readFileSync(WORKFLOW_PATH, "utf8");

test("build-image.yml has a bump job that follows the build job", () => {
  assert.match(raw, /^\s*bump:\s*$/m, "expected a top-level `bump:` job");
  assert.match(raw, /needs:\s*build/, "the bump job must depend on the build job's digest output");
});

test("the bump job requires BUMP_TOKEN and fails loudly, not silently, without it", () => {
  assert.match(raw, /BUMP_TOKEN/, "expected a BUMP_TOKEN secret reference");
  assert.match(
    raw,
    /::error::.*BUMP_TOKEN/s,
    "a missing BUMP_TOKEN must emit a ::error:: annotation, not fail obscurely later"
  );
});

test("the bump job checks out hjr15/service-platform, not this repo, to write the pin", () => {
  assert.match(raw, /repository:\s*hjr15\/service-platform/);
  assert.match(raw, /token:\s*\$\{\{\s*secrets\.BUMP_TOKEN\s*\}\}/);
});

test("the bump job writes both the digest and the source commit into the blaze values file", () => {
  assert.match(raw, /deploy\/apps\/blaze\/values-dev\.yaml/);
  assert.match(raw, /\.image\.digest/);
  assert.match(raw, /\.image\.sourceCommit/);
  assert.match(raw, /github\.sha/, "sourceCommit must be github.sha, not a hand-typed value");
});

test("the bump job pushes with a rebase-retry loop, not a bare push", () => {
  // A concurrent push to service-platform (e.g. howman-cloud's own bump job
  // racing this one) makes a bare push lose silently. Mirrors
  // build-and-deploy.yml's retry loop.
  assert.match(raw, /git push origin HEAD:main/);
  assert.match(raw, /git rebase origin\/main/);
});

// THE assertion this file exists for. Comments are allowed to name a path that
// doesn't exist yet mid-edit, so this only scans non-comment lines — matching
// hjr15/howman-cloud-site's tests/deploy-config.test.ts, which draws the same
// distinction for the same reason.
test("every docs path the workflow cites in a real (non-comment) line actually exists", () => {
  const codeOnly = raw
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const cited = [...codeOnly.matchAll(/docs\/[A-Za-z0-9._/-]+\.md/g)].map((m) => m[0]);
  assert.ok(cited.length > 0, "expected the BUMP_TOKEN guard to cite at least one runbook doc");
  for (const path of cited) {
    assert.ok(existsSync(join(REPO, path)), `${path} is cited in build-image.yml but does not exist`);
  }
});
