// scripts/ci/require-engine.mjs — BLZ-601.
//
// FAIL FAST ON THE WRONG NODE, WITH THE THREE FACTS THAT END THE CONFUSION.
//
// `package.json` declares `engines: { node: ">=24" }` and nothing enforced it. Under Node
// 20 — which is what `node` resolves to on the author's machine — every file that imports
// `node:sqlite` fails to LOAD with `No such built-in module: node:sqlite`. Measured on this
// branch 2026-09-12: `/usr/bin/node` v20.20.2 gives 3,980 tests / 3,807 pass / 173 fail,
// against 4,499 / 4,497 / 0 on v24.19.0. Nothing in those 173 says "wrong Node". Real
// regressions hide behind that noise, and "the suite is green" stops being checkable.
//
// BLZ-601 was filed saying the machine had no conforming Node. That premise was wrong:
// `~/.local/node24/bin/node` there is v24.19.0 with a working `node:sqlite`, and the suite
// under it is 4,499 tests / 4,497 pass / 0 fail. What was missing was any way to
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

/** Where a conforming Node is likely to already be sitting, unfound.
 *
 *  EVERY SOURCE IS GUARDED SEPARATELY, and that is the whole point. This used to check
 *  `existsSync(home)` once and then read `join(home, ".local")` unconditionally. A home
 *  without a `.local` — a fresh container, or any box that manages Node with nvm or fnm
 *  alone — threw ENOENT there, `safeCandidates()` caught it, and nvm, fnm, volta and n were
 *  never looked at. The guard then told a developer who already had a conforming Node to go
 *  and install one, which is the discoverability failure this file exists to end, one level
 *  up. Reproduced against a fake home holding an nvm Node 24 and no `~/.local`: it printed
 *  "No conforming Node was found"; adding an empty `~/.local` flipped it to the right
 *  `export PATH=` line. So a missing or unreadable location must cost that location only.
 *
 *  The machine-global roots are a SEPARATE parameter because they are not under `$HOME` and
 *  a fake home cannot hold them out. A GitHub-hosted `ubuntu-latest` runner really does have
 *  `n` installed at the first of them: the tests that assert the exact candidate list for a
 *  fake home were green on a developer box and red in CI for precisely that reason. */
export const SYSTEM_NODE_ROOTS = ["/usr/local/n/versions/node"];

export function candidateNodePaths(home = homedir(), systemRoots = SYSTEM_NODE_ROOTS) {
  const out = [];
  for (const { parent, suffix, keep = () => true } of discoverySources(home, systemRoots)) {
    let names;
    try { names = readdirSync(parent); } catch { continue; }  // absent or unreadable: skip this source alone
    for (const name of names.filter(keep)) {
      const p = join(parent, name, ...suffix);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/** Every directory the search will read, and what it expects to find under each.
 *
 *  Split out so THE DEFAULTS THEMSELVES ARE OBSERVABLE. Parameterising `home` and
 *  `systemRoots` made the search testable and, on its own, made it possible for every test
 *  to pass both explicitly — at which point `candidateNodePaths(home = homedir(),
 *  systemRoots = [])` and `home = "/nonexistent"` both leave the suite fully green, because
 *  nothing exercises the configuration a real run uses. A test can call this with no
 *  arguments and see the actual bindings, so losing `$HOME` or `n` reddens instead of
 *  passing quietly. */
export function discoverySources(home = homedir(), systemRoots = SYSTEM_NODE_ROOTS) {
  return [
    // `~/.local` also holds bin, lib, share and state, so only `node*` entries are considered
    // — otherwise the refusal path would spawn every directory in there asking its version.
    { parent: join(home, ".local"), suffix: ["bin", "node"], keep: (n) => n.startsWith("node") },
    { parent: join(home, ".nvm", "versions", "node"), suffix: ["bin", "node"] },
    { parent: join(home, ".fnm", "node-versions"), suffix: ["installation", "bin", "node"] },
    { parent: join(home, ".volta", "tools", "image", "node"), suffix: ["bin", "node"] },
    ...systemRoots.map((parent) => ({ parent, suffix: ["bin", "node"] })),
  ];
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
    "the failures that produces mentions the engine. Measured on this repo 2026-09-12:",
    "Node v20.20.2 gives 3,980 tests / 173 fail; Node v24.19.0 gives 4,499 / 0 fail. A real",
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
