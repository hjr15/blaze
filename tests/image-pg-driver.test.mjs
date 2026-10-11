// BLZ-692. The image copied package.json and scripts/ and installed nothing, so
// `pg` — declared only as an OPTIONAL peer (and a devDependency) — was absent in
// the pod. Postgres mode there (`BLAZE_WRITE_PORT=db`, `blaze db init/load`)
// failed on the first `import("pg")`. The image now installs pg at the version
// the lockfile pins, and the build job proves the import resolves before it
// pushes, so a regression stops at CI instead of at the cutover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = readFileSync(join(REPO, "Dockerfile"), "utf8");
const workflow = readFileSync(join(REPO, ".github/workflows/build-image.yml"), "utf8");
const lock = JSON.parse(readFileSync(join(REPO, "package-lock.json"), "utf8"));

/** Dockerfile instructions only — comments may mention anything. */
const instructions = dockerfile
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n")
  .replace(/\\\n/g, " "); // a continued RUN is one instruction

test("the lockfile pins pg (the version the image must install)", () => {
  assert.match(lock.packages["node_modules/pg"]?.version ?? "", /^\d+\.\d+\.\d+$/);
});

test("the Dockerfile copies the lockfile into the image build", () => {
  assert.match(instructions, /^COPY\s+.*package-lock\.json/m);
});

test("the Dockerfile installs pg at the lockfile's version, never a floating one", () => {
  const install = instructions.match(/^RUN\s+.*npm\s+(?:install|i)\b.*$/m)?.[0];
  assert.ok(install, "expected a RUN npm install step");
  assert.match(install, /package-lock\.json/, "the pg version must be read from the lockfile");
  assert.match(install, /node_modules\/pg/, "the lockfile entry read must be pg's own");
  assert.match(install, /--ignore-scripts/, "no install scripts run in the image build");
  assert.match(install, /--no-save/, "package.json must not change inside the image");
});

test("build-image.yml proves import('pg') resolves in the built image before pushing", () => {
  const verify = workflow.indexOf('import("pg")') >= 0 ? workflow.indexOf('import("pg")') : workflow.indexOf("import('pg')");
  assert.ok(verify >= 0, "expected a step that imports pg inside the image");
  const push = workflow.search(/push:\s*true/);
  assert.ok(push > verify, "the pg check must run before the push step");
});
