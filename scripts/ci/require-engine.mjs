// scripts/ci/require-engine.mjs — BLZ-601.
//
// FAIL FAST ON THE WRONG NODE, WITH THE THREE FACTS THAT END THE CONFUSION.
//
// `package.json` declares `engines: { node: ">=24" }` and nothing enforced it. Under Node
// 20 — which is what `node` resolves to on the author's machine — every file that imports
// `node:sqlite` fails to LOAD with `No such built-in module: node:sqlite`. Measured on this
// branch 2026-09-07: `/usr/bin/node` v20.20.2 gives 3,916 tests / 3,743 pass / 173 fail,
// against 4,408 / 4,406 / 0 on v24.19.0. Nothing in those 173 says "wrong Node". Real
// regressions hide behind that noise, and "the suite is green" stops being checkable.
//
// BLZ-601 was filed saying the machine had no conforming Node. That premise was wrong:
// `~/.local/node24/bin/node` there is v24.19.0 with a working `node:sqlite`, and the suite
// under it is 4,408 tests / 4,406 pass / 0 fail. What was missing was any way to
// DISCOVER that. So when this guard refuses, it goes looking for a conforming Node in the
// usual places and, if it finds one, hands over the exact line that selects it.
//
// Wired as `pretest` and `pretest:coverage`, so `npm test` and `npm run test:coverage`
// refuse to start rather than producing 171 unexplained failures. Someone running
// `node --test` directly bypasses npm; `tests/engine-precondition.test.mjs` is the same
// check as an ordinary test for that path.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..", "..", "package.json");

/** Distinct from 1 so a refused engine is not read as a test failure. */
export const GUARD_EXIT_CODE = 78;

/** The floor, read from the declaration rather than repeated next to it. */
export function requiredMajor(pkgPath = PKG) {
  const range = JSON.parse(readFileSync(pkgPath, "utf8")).engines?.node ?? "";
  const m = /(\d+)/.exec(range);
  if (!m) throw new Error(`package.json engines.node is missing or unreadable: ${JSON.stringify(range)}`);
  return Number(m[1]);
}

/** What is actually running. `node:sqlite` is checked, not inferred from the version: the
 *  floor exists because of that module, and a build without it fails the same 34 files. */
export function detectEngine(version = process.env.BLAZE_ENGINE_GUARD_FAKE_VERSION || process.version) {
  const major = Number(/v?(\d+)/.exec(version)?.[1] ?? 0);
  const faked = Boolean(process.env.BLAZE_ENGINE_GUARD_FAKE_VERSION);
  let sqlite = false;
  try { sqlite = Boolean(process.getBuiltinModule?.("node:sqlite")); } catch { sqlite = false; }
  // Under the fake-version seam the real runtime's `node:sqlite` says nothing about the
  // engine being described, so it is reported missing — the seam exists to exercise the
  // refusal path, not to assert a capability.
  return { version, major, sqlite: faked ? false : sqlite };
}

/** Where a conforming Node is likely to already be sitting, unfound. */
function candidateNodePaths(home = homedir()) {
  const out = [];
  const globDirs = (parent, suffix) => {
    if (!existsSync(parent)) return;
    for (const name of readdirSync(parent)) {
      const p = join(parent, name, ...suffix);
      if (existsSync(p)) out.push(p);
    }
  };
  if (existsSync(home)) {
    for (const name of readdirSync(join(home, ".local")).filter((n) => n.startsWith("node"))
      .map((n) => join(home, ".local", n, "bin", "node")).filter(existsSync)) out.push(name);
  }
  globDirs(join(home, ".nvm", "versions", "node"), ["bin", "node"]);
  globDirs(join(home, ".fnm", "node-versions"), ["installation", "bin", "node"]);
  globDirs(join(home, ".volta", "tools", "image", "node"), ["bin", "node"]);
  globDirs("/usr/local/n/versions/node", ["bin", "node"]);
  return out;
}

/** Every candidate that actually reports a conforming version. Only ever called on the
 *  refusal path, so a healthy run spawns nothing. */
export function findConformingNodes(required = requiredMajor(), paths = null) {
  const found = [];
  for (const p of paths ?? safeCandidates()) {
    const r = spawnSync(p, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 5_000 });
    const version = r.stdout?.trim() ?? "";
    if (r.status === 0 && Number(version.split(".")[0]) >= required) found.push({ path: p, version });
  }
  return found;
}

function safeCandidates() {
  try { return candidateNodePaths(); } catch { return []; }
}

/** The verdict and, when it is a refusal, the whole message. */
export function describeEngine({ version, major, sqlite, required, conforming }) {
  const versionOk = major >= required;
  if (versionOk && sqlite) return { ok: true, message: "" };

  const why = !versionOk
    ? `this is Node ${version}, below the floor`
    : `this is Node ${version}, which is new enough but has no working \`node:sqlite\``;
  const lines = [
    `blaze requires Node ${required} or newer — ${why}.`,
    "",
    `  required:  Node ${required}+ (package.json "engines": { "node": ">=${required}" })`,
    `  detected:  ${version}`,
    `  node:sqlite: ${sqlite ? "available" : "MISSING"}`,
    "",
    "Every test file that imports `node:sqlite` fails to LOAD on this engine, and none of",
    "the failures that produces mentions the engine. Measured on this repo 2026-09-07:",
    "Node v20.20.2 gives 3,916 tests / 173 fail; Node v24.19.0 gives 4,408 / 0 fail. A real",
    "regression would be invisible in the first of those.",
    "",
  ];
  if (conforming.length) {
    lines.push("A conforming Node is already installed on this machine. Select it with:", "");
    for (const c of conforming) lines.push(`  export PATH=${dirname(c.path)}:$PATH   # Node ${c.version}`);
    lines.push("");
  } else {
    lines.push("No conforming Node was found in the usual locations (~/.local/node*, nvm, fnm,",
      "volta, n). Install one:", "",
      `  nvm install ${required} && nvm use ${required}`,
      `  # or: fnm install ${required} && fnm use ${required}`, "");
  }
  lines.push(`CI runs Node ${required} (.github/workflows/test.yml), so this is the engine the`,
    "suite's published numbers come from.");
  return { ok: false, message: lines.join("\n") };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const required = requiredMajor();
  const engine = detectEngine();
  let verdict = describeEngine({ ...engine, required, conforming: [] });
  if (!verdict.ok) verdict = describeEngine({ ...engine, required, conforming: findConformingNodes(required) });
  if (!verdict.ok) {
    process.stderr.write(`\n${verdict.message}\n\n`);
    process.exit(GUARD_EXIT_CODE);
  }
}
