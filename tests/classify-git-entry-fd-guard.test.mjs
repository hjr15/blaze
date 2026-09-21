// tests/classify-git-entry-fd-guard.test.mjs — BLZ-511.
//
// `classifyGitEntry` is the last stat-then-open in `scripts/model/`. ADR-0030 §4 gave it the
// rule — never open an entry that is not a regular file — and implemented it as `statSync`
// then `readFileSync`. ADR-0031 replaced that shape everywhere else and recorded this one as
// left behind:
//
//   > `classifyGitEntry` still uses `statSync`-then-open — correct as far as it goes, and it
//   > no longer hangs, but it keeps the race this module removes.
//
// A stat on a PATH answers about the file that was there a moment ago; the process then
// opens the file that is there NOW. Losing that race is not a wrong answer, it is an
// unbounded hang — and this predicate sits on the path `blaze audit`, `buildIndex`, id
// resolution, the board view, `reconcile` and the long-lived server all share.
//
// HOW THIS IS TESTED, AND WHY NOT WITH A RACE. Two real files cannot be made to disagree on
// demand, and a loop that renames a FIFO over a path until the window is hit is a flaky test
// dressed as a deterministic one. So `node:module`'s `registerHooks` swaps `node:fs` for a
// shim — FOR `regular-file.mjs` ONLY, so `index.mjs`'s own `statSync` stays real — in which
// an open DESCRIPTOR reports a FIFO while the path genuinely is a regular file. That is the
// race, made deterministic and made to happen every time.
//
// THE DISCRIMINATOR IS THE CLASSIFICATION ITSELF, not a source pin. The `.git` file holds a
// VALID `gitdir:` pointer, so a run that took the path's word for it classifies
// `nested-repo-pointer` — which is what the pre-fix code returns, because the shim does not
// touch `readFileSync`. Only a run that asked the DESCRIPTOR refuses. The two outcomes are
// different strings, so this cannot pass for the wrong reason.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const mod = (...p) => JSON.stringify(join(SCRIPTS, ...p));

/** `node:fs` with one lie in it: an open DESCRIPTOR reports `fdKind` while the PATH reports
 *  whatever it really is. Everything else is the real call, and every stat is recorded so
 *  the test can prove the module was actually asked. The export list is exactly what
 *  `scripts/model/regular-file.mjs` imports; if that changes, the child fails to LINK and
 *  `runChild` reports the missing export rather than a bare parse error. */
const FS_SHIM = `
const real = globalThis.__realFs;
const seen = globalThis.__fsSeen;
function typed(kind, base) {
  const is = (k) => () => k === kind;
  return { ...base, isFile: is("file"), isFIFO: is("fifo"), isDirectory: is("dir"),
    isSocket: is("sock"), isCharacterDevice: is("chr"), isBlockDevice: is("blk") };
}
export function fstatSync(fd, ...r) {
  seen.push("fstatSync");
  return typed(globalThis.__fdKind, real.fstatSync(fd, ...r));
}
export function statSync(p, ...r) { seen.push("statSync"); return real.statSync(p, ...r); }
export function openSync(...a) { seen.push("openSync"); return real.openSync(...a); }
export function closeSync(...a) { return real.closeSync(...a); }
export function readFileSync(...a) { seen.push("readFileSync"); return real.readFileSync(...a); }
export function writeFileSync(...a) { return real.writeFileSync(...a); }
export function appendFileSync(...a) { return real.appendFileSync(...a); }
export const constants = real.constants;
`;

/** A board with one project whose status directory carries a `.git` entry. */
function board(root, dotGitContent) {
  const projects = join(root, "projects");
  const at = join(projects, "BLZ", "defined");
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "BLZ-1-t.md"),
    "---\nid: BLZ-1\ntype: task\nproject: BLZ\ntitle: t\n---\n\nbody\n");
  writeFileSync(join(projects, "BLZ", "project.json"), JSON.stringify({ key: "BLZ" }));
  writeFileSync(join(at, ".git"), dotGitContent);
  return { projects, at };
}

/** Run `unreadableTicketDirs` in a child whose `regular-file.mjs` sees a lying `node:fs`.
 *  Out of process AND under a hard wall-clock cap, because the failure this guards is a
 *  HANG: an in-process case for it does not fail, it wedges the whole file. */
function runChild(tmp, projects, fdKind) {
  const shim = join(tmp, "fs-shim.mjs");
  writeFileSync(shim, FS_SHIM);
  const script = join(tmp, "probe.mjs");
  writeFileSync(script, `
import * as realFs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
globalThis.__realFs = realFs;
globalThis.__fdKind = ${JSON.stringify(fdKind)};
globalThis.__fsSeen = [];
const SHIM = pathToFileURL(${JSON.stringify(shim)}).href;
registerHooks({
  resolve(spec, ctx, next) {
    // ONLY \`regular-file.mjs\`. \`index.mjs\` keeps the real fs, so the PATH genuinely is a
    // regular file and only the DESCRIPTOR lies — which is the race, not a simulation of a
    // different file being there.
    if ((spec === "node:fs" || spec === "fs")
        && String(ctx.parentURL || "").endsWith("regular-file.mjs")) {
      return { url: SHIM, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const { unreadableTicketDirs } = await import(${mod("model", "index.mjs")});
const found = unreadableTicketDirs(${JSON.stringify(projects)});
console.log(JSON.stringify({ found, seen: globalThis.__fsSeen }));
`);
  const res = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15000, cwd: tmp });
  assert.equal(res.signal, null,
    "the child had to be KILLED — THAT IS THE HANG this guard exists to prevent, not a "
    + `failed assertion.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  try { return JSON.parse(res.stdout); } catch {
    assert.fail(
      "the child under the lying-fs shim printed no result, so nothing was observed. If the "
      + "message below names an export, `scripts/model/regular-file.mjs` now imports an fs "
      + "member FS_SHIM does not provide — add it; a shim that silently stopped covering the "
      + `module is a test that proves nothing.\nexit ${res.status}\nstderr: ${res.stderr}`);
  }
}

const POINTER = "gitdir: ../../../.git/modules/vendor\n";

describe("BLZ-511: classifyGitEntry decides from the OPEN DESCRIPTOR, not from the path", () => {
  test("a descriptor that reports a FIFO is REFUSED, though the path is a regular file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz511-"));
    try {
      const { projects } = board(tmp, POINTER);
      const { found, seen } = runChild(tmp, projects, "fifo");

      assert.equal(found.length, 1, `exactly one directory should be named; got ${JSON.stringify(found)}`);
      assert.equal(found[0].reason, "git-file-unreadable",
        "the DESCRIPTOR said FIFO and the path said regular file. Refusing is the only safe "
        + "answer, and `nested-repo-pointer` here means it took the path's word for it — "
        + `which is the stat-then-open race itself. Got: ${JSON.stringify(found[0])}`);
      assert.match(found[0].detail, /ERR_BLAZE_NOT_A_REGULAR_FILE/,
        `the refusal must be named, so it is not mistaken for an errno. Got: ${found[0].detail}`);
      assert.notEqual(found[0].reason, "nested-repo-pointer",
        "the file IS a valid gitdir: pointer, so this is what a successful read would have "
        + "classified it as — asserting it did NOT is what makes this evidence");

      // ASSERT THE OBSERVATION HAPPENED. If the shim were never consulted the case would run
      // against the real fs and could pass for an unrelated reason; an empty trace is the
      // shape of a test that proved nothing.
      assert.ok(seen.includes("fstatSync"),
        `the type must be read from the DESCRIPTOR; trace was ${seen.join(",")}`);
      assert.ok(seen.includes("openSync"),
        `and it must be an OPEN that produced it; trace was ${seen.join(",")}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("with the descriptor telling the truth, the same board classifies as before", () => {
    // The control. Without it the case above is satisfied by any change that makes
    // `classifyGitEntry` refuse everything, which would be a different defect.
    const tmp = mkdtempSync(join(tmpdir(), "blz511-ok-"));
    try {
      const { projects } = board(tmp, POINTER);
      const { found, seen } = runChild(tmp, projects, "file");
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, "nested-repo-pointer",
        `a genuine gitdir: pointer must still be recognised. Got: ${JSON.stringify(found[0])}`);
      assert.ok(seen.includes("fstatSync"), "the shim must have been consulted here too");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("the byte count it reports is the file it OPENED, not the one it stat'd", () => {
    // The stale `statSync` result was used for more than the type: `st.size` decided
    // `git-file-empty` and the "N-byte" wording. Both now come from the bytes actually read,
    // so the sentence describes the file the process opened rather than one that may have
    // been replaced since. A 7-byte non-pointer gives a reason no other branch produces.
    const tmp = mkdtempSync(join(tmpdir(), "blz511-size-"));
    try {
      const { projects } = board(tmp, "abcdefg");
      const { found } = runChild(tmp, projects, "file");
      assert.equal(found[0].reason, "git-file-unrecognised");
      assert.match(found[0].detail, /\b7-byte\b/,
        `the count must be the bytes read. Got: ${found[0].detail}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a ZERO-BYTE `.git` file is still named as empty, from the bytes read", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz511-empty-"));
    try {
      const { projects } = board(tmp, "");
      const { found } = runChild(tmp, projects, "file");
      assert.equal(found[0].reason, "git-file-empty",
        `got: ${JSON.stringify(found[0])}`);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
