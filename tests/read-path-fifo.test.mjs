// tests/read-path-fifo.test.mjs — BLZ-493.
//
// Ten `readFileSync` sites on the shared read path — and one `writeFileSync` beside one of
// them — opened a path without first asking what
// kind of file it was. `readFileSync` on a FIFO BLOCKS FOREVER: no error, no timeout, no
// exit. BLZ-484 fixed one of them (the `.git` probe it had just added, ADR-0030 §4) and left
// the rest, because making them merely SKIP would reintroduce exactly the silent drop BLZ-470
// exists to close — so each needed its own decision about what it reports. ADR-0031 records
// those decisions; this file pins them.
//
// Every site below was reproduced as a HANG at 1b00f3a before a line of the fix was written,
// under an 8-second child-process cap — 15 of 16 constructed cases killed. See ADR-0031's
// table for the per-site result and for the two corrections it makes to the ticket's own
// inventory (`claims.mjs` is reached from `reindex`, not `buildIndex`; and `schema-config`
// opens the same `project.json` a second time, so site 2 is worthless without site 9).
//
// EVERY CASE HERE RUNS OUT OF PROCESS, and that is the load-bearing part — the same rule
// ADR-0030 §4 established and the same harness `tests/walk-unreadable-dirs.test.mjs` uses.
// `node:test`'s `timeout` option is enforced on the EVENT LOOP, and a blocking synchronous
// `readFileSync` never yields to it, so the option cannot fire: an in-process case for this
// shape does not fail, it WEDGES THE WHOLE FILE. So the hang is detected the only way it can
// be — a child process with a hard wall-clock limit and an assertion on the child's `signal`.
// A killed child IS the hang, and it is reported as a failure rather than as a suite that
// never finishes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const mod = (...p) => JSON.stringify(join(SCRIPTS, ...p));
const CHILD_MS = 15000;

/** A two-ticket board with the files every entry point on the read path expects. */
function board(root) {
  const projects = join(root, "projects");
  mkdirSync(join(projects, "BLZ", "defined"), { recursive: true });
  mkdirSync(join(projects, "BLZ", "done"), { recursive: true });
  for (const [n, status] of [[1, "defined"], [2, "done"]]) {
    writeFileSync(join(projects, "BLZ", status, `BLZ-${n}-t.md`),
      `---\nid: BLZ-${n}\ntype: task\nproject: BLZ\ntitle: t${n}\n---\n\nbody\n`);
  }
  writeFileSync(join(projects, "BLZ", "project.json"), JSON.stringify({ key: "BLZ", codeRepos: [] }));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "BLZ", projects: ["BLZ"] }));
  return projects;
}

const fifo = (p) => execFileSync("mkfifo", [p]);

/** Run `source` in a child node process under a hard wall-clock limit. A child that had to be
 *  KILLED is the hang itself — the one outcome this whole file exists to turn into a failure. */
function child(tmp, source, { ms = CHILD_MS, cwd = tmp } = {}) {
  const script = join(tmp, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, source);
  const res = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: ms, cwd });
  assert.equal(res.signal, null,
    `the child had to be KILLED after ${ms}ms — THAT IS THE HANG, not a failed assertion. ` +
    "A `readFileSync` on this path opened a FIFO and blocked forever, taking every reader " +
    `with it.\nstdout so far: ${res.stdout}\nstderr so far: ${res.stderr}`);
  return res;
}

/** Run a repo script in a child process under the same limit. */
function childScript(tmp, script, args, { ms = CHILD_MS } = {}) {
  const res = spawnSync(process.execPath, [join(SCRIPTS, script), ...args],
    { encoding: "utf8", timeout: ms, cwd: tmp });
  assert.equal(res.signal, null,
    `${script} had to be KILLED after ${ms}ms — THAT IS THE HANG. A CLI that never exits ` +
    "reports nothing at all, which is strictly worse than the wrong sentence this guards.");
  return res;
}

/** The shape every REFUSING site must produce: a named throw, not a silent default. */
function assertRefusal(out, { path, kind = "FIFO" }) {
  assert.match(out, /REFUSED/,
    `the site must REFUSE a non-regular file, not fall back to a default — a default here is ` +
    "exactly the silent drop BLZ-470 exists to close. Got: " + out);
  assert.match(out, /ERR_BLAZE_NOT_A_REGULAR_FILE/,
    "the refusal must carry the named code, so a caller can tell it from ENOENT");
  assert.ok(out.includes(path), `the refusal must NAME the path it would not read; got: ${out}`);
  assert.ok(out.includes(kind), `the refusal must say WHAT it found (${kind}); got: ${out}`);
}

// =============================================================================
// The guard itself.
// =============================================================================

describe("BLZ-493: readRegularFileSync refuses what it cannot safely open", () => {
  const G = mod("model", "regular-file.mjs");

  test("a FIFO is refused, and the refusal names the path and the type", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-guard-"));
    try {
      const p = join(tmp, "f");
      fifo(p);
      const out = child(tmp, `import { readRegularFileSync } from ${G};\n` +
        `try { readRegularFileSync(${JSON.stringify(p)}); console.log("NO REFUSAL"); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: p, kind: "FIFO" });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a regular file still reads, byte for byte", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-guardok-"));
    try {
      const p = join(tmp, "r.txt");
      writeFileSync(p, "hello\nthere\n");
      const out = child(tmp, `import { readRegularFileSync } from ${G};\n` +
        `console.log(JSON.stringify(readRegularFileSync(${JSON.stringify(p)})));`).stdout;
      assert.equal(JSON.parse(out), "hello\nthere\n");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a DIRECTORY and a device node are refused by the same rule", () => {
    // A directory already threw EISDIR from `readFileSync` — measured at 1b00f3a — so this
    // is not a new refusal, it is the SAME refusal given a message that names the path.
    // /dev/null is the counter-example that stops "not a regular file" being read as "hangs":
    // a device node returns 0 bytes instantly, and a run that silently accepted that would
    // read an empty config as a config.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-guarddir-"));
    try {
      mkdirSync(join(tmp, "d"));
      const out = child(tmp, `import { readRegularFileSync } from ${G};\n` +
        `for (const p of [${JSON.stringify(join(tmp, "d"))}, "/dev/null"]) {\n` +
        `  try { readRegularFileSync(p); console.log("NO REFUSAL " + p); }\n` +
        `  catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); } }`).stdout;
      const lines = out.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[0], /REFUSED ERR_BLAZE_NOT_A_REGULAR_FILE .*directory/);
      assert.match(lines[1], /REFUSED ERR_BLAZE_NOT_A_REGULAR_FILE .*device/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("writeRegularFileSync refuses too — a blocking WRITE is the same defect", () => {
    // The write half exists because guarding only the read moves the transitions-cache hang
    // three lines down. A FIFO cannot exercise the type check here — `open` on one for writing
    // fails ENXIO before `fstat` is reached, which is itself the fix — so the check is pinned
    // with a device node, which opens for writing and is not a regular file.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-guardw-"));
    try {
      const out = child(tmp, `import { writeRegularFileSync } from ${G};\n` +
        `try { writeRegularFileSync("/dev/null", "x"); console.log("NO REFUSAL"); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assert.match(out, /REFUSED ERR_BLAZE_NOT_A_REGULAR_FILE .*device.*will not write it/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("ENOENT is passed through UNCHANGED — a missing file is not an unreadable one", () => {
    // Every caller below distinguishes them: `loadConfig` treats a missing config as an
    // empty one, `loadSprints` treats a missing registry as no sprints. Folding ENOENT into
    // the new refusal would turn every board without an optional file into a hard failure.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-guardenoent-"));
    try {
      const out = child(tmp, `import { readRegularFileSync } from ${G};\n` +
        `try { readRegularFileSync(${JSON.stringify(join(tmp, "nope"))}); console.log("NO THROW"); }\n` +
        `catch (e) { console.log(e.code); }`).stdout.trim();
      assert.equal(out, "ENOENT");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("the check is on the OPEN FILE DESCRIPTOR, so there is no stat-then-open window", () => {
    // BLZ-521. This test USED TO BE `assert.doesNotMatch(src, /\bstatSync\s*\(/)` — a pin on
    // a SPELLING, which `lstatSync` or an aliased import walks straight past. MEASURED, with
    // the type decision moved to `lstatSync as peek` on the PATH in all three verbs: the
    // whole suite stayed green — 4412 tests, 0 fail — including the test you are reading.
    //
    // So it does not read the source at all now. It makes the PATH and the DESCRIPTOR
    // DISAGREE and asks the module which one it believed, which no rename can survive.
    //
    // The old `assert.match(src, /O_NONBLOCK/)` went with it, and nothing is lost: setting
    // `NONBLOCK = 0` reddens 14 of this file's own tests by HANGING their children out to
    // the 15s cap — measured. A source pin adds nothing on top of a behaviour that already
    // fails that loudly.
    //
    // A stat on a PATH answers about the file that was there a moment ago; the process then
    // opens the file that is there now. Losing that race is not a wrong answer, it is an
    // UNBOUNDED HANG, and one site (`views/panel-content.mjs`) is reachable ONLY through a
    // race of exactly that shape. Real files cannot be made to disagree on demand, so
    // `node:module`'s `registerHooks` swaps `node:fs` for a shim that answers one type from
    // a path and another from a descriptor. Everything else in the shim is the real fs.
    //
    // HOW THIS DIFFERS FROM ITS SIBLING [[BLZ-535]], the same "pins a spelling" defect on the
    // write-seam guard in `tests/model/seam-closure.test.mjs`. Two remedies, deliberately:
    // that one is STRUCTURAL and corpus-wide — which modules may reach node:fs at all — with
    // no behaviour to run, so it enumerates the fs surface instead of naming members. This
    // one is BEHAVIOURAL and single-function — how ONE function decides a type — so it runs
    // the function and disagrees with it. Enumerating a surface would not have pinned this;
    // running it does.
    for (const [verb, call, ok] of [
      ["read", `readRegularFileSync(P)`, `"READ"`],
      ["write", `writeRegularFileSync(P, "x")`, `"WROTE"`],
      ["append to", `appendRegularFileSync(P, "x")`, `"APPENDED"`],
    ]) {
      const tmp = mkdtempSync(join(tmpdir(), "blz521-fd-"));
      try {
        const target = join(tmp, "r.txt");
        writeFileSync(target, "hello\n");

        // The path says REGULAR FILE, the descriptor says FIFO. A guard that asked the path
        // goes ahead; a guard that asked the descriptor refuses. Only one of those is safe.
        const lying = underDisagreeingFs(tmp,
          { pathKind: "file", fdKind: "fifo" }, target, call, ok);
        assert.match(lying.out, /REFUSED ERR_BLAZE_NOT_A_REGULAR_FILE/,
          `${verb}: the DESCRIPTOR said FIFO and the path said regular file. Refusing is the ` +
          "only safe answer, and this took the path's word for it. Got: " + lying.out);
        assert.match(lying.out, /FIFO/,
          `${verb}: the refusal must name what the DESCRIPTOR found, not what the path said`);

        // And the mirror, which is the half a merely-stricter guard would fail: the path
        // says FIFO, the descriptor says regular file. The open succeeded on a regular
        // file, so the verb must go through. A stat-then-open guard refuses a healthy file.
        const scared = underDisagreeingFs(tmp,
          { pathKind: "fifo", fdKind: "file" }, target, call, ok);
        assert.match(scared.out, new RegExp(JSON.parse(ok)),
          `${verb}: the DESCRIPTOR said regular file — the only thing that is actually open — ` +
          "so this must go through. Refusing here is a stat-then-open guard. Got: " + scared.out);

        // Assert the OBSERVATION happened. If the shim were not installed the two cases
        // above would both run against the real fs and could agree by accident; an empty
        // trace is the shape of a test that proved nothing.
        for (const seen of [lying.seen, scared.seen]) {
          assert.ok(seen.length > 0,
            `${verb}: the shim was never consulted — this test observed nothing`);
          assert.ok(seen.includes("fstatSync"),
            `${verb}: the type must be read from the DESCRIPTOR; trace was ${seen.join(",")}`);
          assert.deepEqual(seen.filter((c) => c === "statSync" || c === "lstatSync"), [],
            `${verb}: a stat on the PATH is the race this guard exists not to have; ` +
            `trace was ${seen.join(",")}`);
        }
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
  });
});

/** A stand-in for `node:fs` in which a PATH and an OPEN DESCRIPTOR disagree about the type.
 *  Every call is the real one; only the `isX()` answers are rewritten, and every call is
 *  recorded so the test can prove the module was actually asked. The real fs is handed in on
 *  `globalThis` because the resolve hook below would otherwise intercept the shim's own
 *  import of it too.
 *
 *  The named exports are exactly what `scripts/model/regular-file.mjs` imports today. If it
 *  starts importing another fs member the child fails to LINK, loudly, which is the correct
 *  outcome — a shim that silently stopped covering the module is a test that proves nothing. */
const FS_SHIM = `
const real = globalThis.__realFs;
const plan = globalThis.__fsPlan;
const seen = globalThis.__fsSeen;
function typed(kind, base) {
  const is = (k) => () => k === kind;
  return { ...base, isFile: is("file"), isFIFO: is("fifo"), isDirectory: is("dir"),
    isSocket: is("sock"), isCharacterDevice: is("chr"), isBlockDevice: is("blk") };
}
export function statSync(p, ...r) { seen.push("statSync"); return typed(plan.pathKind, real.statSync(p, ...r)); }
export function lstatSync(p, ...r) { seen.push("lstatSync"); return typed(plan.pathKind, real.lstatSync(p, ...r)); }
export function fstatSync(fd, ...r) { seen.push("fstatSync"); return typed(plan.fdKind, real.fstatSync(fd, ...r)); }
export function openSync(...a) { seen.push("openSync"); return real.openSync(...a); }
export function closeSync(...a) { return real.closeSync(...a); }
export function readFileSync(...a) { return real.readFileSync(...a); }
export function writeFileSync(...a) { return real.writeFileSync(...a); }
export function appendFileSync(...a) { return real.appendFileSync(...a); }
export const constants = real.constants;
`;

/** Run one verb of `regular-file.mjs` in a child whose `node:fs` is the shim above. Returns
 *  what the verb said and the trace of fs calls the shim actually saw. */
function underDisagreeingFs(tmp, plan, target, call, ok) {
  const shim = join(tmp, `fs-shim-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(shim, FS_SHIM);
  const out = child(tmp, `
import * as realFs from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
globalThis.__realFs = realFs;
globalThis.__fsPlan = ${JSON.stringify(plan)};
globalThis.__fsSeen = [];
const SHIM = pathToFileURL(${JSON.stringify(shim)}).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "node:fs" || spec === "fs") return { url: SHIM, shortCircuit: true };
    return next(spec, ctx);
  },
});
const { readRegularFileSync, writeRegularFileSync, appendRegularFileSync } = await import(${mod("model", "regular-file.mjs")});
const P = ${JSON.stringify(target)};
let said;
try { ${call}; said = ${ok}; }
catch (e) { said = "REFUSED " + e.code + " :: " + e.message; }
console.log(JSON.stringify({ said, seen: globalThis.__fsSeen }));
`).stdout;
  const parsed = JSON.parse(out);
  return { out: parsed.said, seen: parsed.seen };
}

// =============================================================================
// Site 1 — `walkTickets`'s `.md` read. REFUSE.
// =============================================================================

describe("BLZ-493 site 1: walkTickets REFUSES a `.md` that is not a regular file", () => {
  test("a FIFO named like a ticket refuses instead of hanging the walk", () => {
    // Decision (ADR-0031): REFUSE, matching what this walk ALREADY does with the two other
    // unreadable `.md` shapes — a malformed `.md` throws from `parseTicket` (BLZ-430 kept
    // that on purpose) and a DIRECTORY named `X.md` already threw EISDIR. A skip here would
    // make a ticket-shaped entry vanish from the board, the index and the audit in silence,
    // which BLZ-430 explicitly refused to introduce.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-walk-"));
    try {
      const projects = board(tmp);
      const target = join(projects, "BLZ", "defined", "BLZ-9-fifo.md");
      fifo(target);
      const out = child(tmp, `import { fsReadStorage } from ${mod("model", "read-storage.mjs")};\n` +
        `try { console.log("NO REFUSAL " + [...fsReadStorage.listTickets(${JSON.stringify(projects)})].length); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: target });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a healthy board still walks — the guard costs no ticket", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-walkok-"));
    try {
      const projects = board(tmp);
      const out = child(tmp, `import { fsReadStorage } from ${mod("model", "read-storage.mjs")};\n` +
        `console.log(JSON.stringify([...fsReadStorage.listTickets(${JSON.stringify(projects)})]` +
        `.map((t) => t.frontmatter.id).sort()));`).stdout;
      assert.deepEqual(JSON.parse(out), ["BLZ-1", "BLZ-2"]);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Site 2 — `audit-runner`'s `project.json`. REFUSE, and site 9 with it.
// =============================================================================

describe("BLZ-493 site 2: `blaze audit` REFUSES a project.json it cannot read", () => {
  test("a FIFO project.json exits non-zero with a named message, rather than never exiting", () => {
    // Decision (ADR-0031): REFUSE. The existing `catch` fell back to `{ key: k }` — the
    // taxonomy of a project that declares nothing — so every schema finding the run then
    // printed was measured against a taxonomy it had never read. That is ADR-0030's defect
    // exactly: a run that could not look reporting what a run that looked reports.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-audit-"));
    try {
      const projects = board(tmp);
      rmSync(join(projects, "BLZ", "project.json"));
      fifo(join(projects, "BLZ", "project.json"));
      const res = childScript(tmp, "audit-runner.mjs", [projects]);
      assert.notEqual(res.status, 0, "a taxonomy this run could not read must not audit ok");
      const out = res.stdout + res.stderr;
      assert.match(out, /project\.json/);
      assert.match(out, /not a regular file|FIFO/);
      assert.doesNotMatch(out, /ok=true/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a healthy board still audits clean", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-auditok-"));
    try {
      const res = childScript(tmp, "audit-runner.mjs", [board(tmp)]);
      assert.match(res.stdout, /ok=true/);
      assert.equal(res.status, 0);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("loadProjectSchema refuses the same file — the audit's OTHER project.json read", () => {
    // Site 9, found by this lane rather than by the ticket. Without it, fixing the runner's
    // own read only moves the hang: `auditCorpus`'s schema layer opens the same path.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-schema-"));
    try {
      const projects = board(tmp);
      rmSync(join(projects, "BLZ", "project.json"));
      fifo(join(projects, "BLZ", "project.json"));
      const out = child(tmp, `import { loadProjectSchema } from ${mod("model", "schema-config.mjs")};\n` +
        `try { loadProjectSchema(${JSON.stringify(projects)}, "BLZ"); console.log("NO REFUSAL"); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: join(projects, "BLZ", "project.json") });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Site 3 — `liveModel`'s activity feed. REPORT. This one is the running server.
// =============================================================================

describe("BLZ-493 site 3: liveModel REPORTS an unreadable feed rather than rendering it empty", () => {
  test("a FIFO activity.jsonl returns, and says it could not be read", () => {
    // Decision (ADR-0031): REPORT, not refuse. This is `serve.mjs`'s `/api/live` route on a
    // LONG-LIVED process — the site whose hang was reproduced as exit 137 — and a throw here
    // would take a route down over an optional feed. But `groups: []` alone is the ADR-0030
    // defect: `views/live.mjs` renders exactly `No recent activity.` for it, which is a
    // sentence about the WORLD produced by a run that never looked at it.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-live-"));
    try {
      const projects = board(tmp);
      mkdirSync(join(tmp, ".blaze"), { recursive: true });
      const feed = join(tmp, ".blaze", "activity.jsonl");
      fifo(feed);
      const out = child(tmp, `import { liveModel } from ${mod("views", "data.mjs")};\n` +
        `console.log(JSON.stringify(liveModel(${JSON.stringify(tmp)}, ${JSON.stringify(projects)})));`).stdout;
      const m = JSON.parse(out);
      assert.deepEqual(m.groups, [], "there is genuinely nothing to show — but that is not the report");
      assert.ok(m.unreadable, "the model must carry WHAT IT COULD NOT READ, or the view cannot say so");
      assert.equal(m.unreadable.path, feed);
      assert.match(m.unreadable.detail, /FIFO/);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a MISSING feed is not an unreadable one — the report is not a fill queue", () => {
    // Nearly every board has no activity feed at all. Reporting those would make the banner
    // permanent furniture, which is the gate people learn to skip.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-livemissing-"));
    try {
      const projects = board(tmp);
      const out = child(tmp, `import { liveModel } from ${mod("views", "data.mjs")};\n` +
        `console.log(JSON.stringify(liveModel(${JSON.stringify(tmp)}, ${JSON.stringify(projects)})));`).stdout;
      const m = JSON.parse(out);
      assert.deepEqual(m.groups, []);
      assert.equal(m.unreadable, null);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("the Live view renders the report instead of `No recent activity.`", () => {
    // The payload is only half a report if the one surface that consumes it still prints the
    // false sentence. Pinned on the client source because that branch runs in a browser.
    //
    // THE FIRST VERSION OF THIS TEST WAS NOT EVIDENCE, and the revert rule is what caught it:
    // it asserted `/unreadable/` against the whole file, which the DESTRUCTURING
    // `const {groups,unreadable}=...` satisfies on its own — so deleting the entire render
    // branch left it green. It now pins the branch itself and the order it must come in.
    const src = execFileSync("cat", [join(SCRIPTS, "views", "live.mjs")], { encoding: "utf8" });
    assert.match(src, /if\(unreadable\)\{/,
      "views/live.mjs must BRANCH on `unreadable`, or the server reports to nobody");
    assert.match(src, /ACTIVITY FEED UNREADABLE/,
      "and the branch must say what happened, in the words an operator reads");
    assert.match(src, /if\(unreadable\)[\s\S]*?No recent activity/,
      "the unreadable branch must come BEFORE the empty-state branch, or it never runs");
  });
});

// =============================================================================
// Sites 4 and 5 — `readCutover` and `loadSprints`. REFUSE.
// =============================================================================

describe("BLZ-493 sites 4-5: the two buildIndex/reindex reads REFUSE", () => {
  test("readCutover refuses a FIFO `.cutover` instead of returning null", () => {
    // Decision (ADR-0031): REFUSE. `null` means "this project has never allocated through
    // the ledger", and `missingClaimErrors` answers it by STAYING SILENT — so a `.cutover`
    // that could not be read forgives every genuinely missing claim on the board. The
    // laundering is total: the check exists to prove ids are unique, and this makes it
    // report that they are.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-cutover-"));
    try {
      const projects = board(tmp);
      mkdirSync(join(projects, "BLZ", ".ids"), { recursive: true });
      const target = join(projects, "BLZ", ".ids", ".cutover");
      fifo(target);
      const out = child(tmp, `import { readCutover } from ${mod("model", "claims.mjs")};\n` +
        `try { console.log("NO REFUSAL " + readCutover(${JSON.stringify(projects)}, "BLZ")); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: target });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("readCutover still returns null for a project that never allocated", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-cutovernull-"));
    try {
      const projects = board(tmp);
      const out = child(tmp, `import { readCutover } from ${mod("model", "claims.mjs")};\n` +
        `console.log(JSON.stringify(readCutover(${JSON.stringify(projects)}, "BLZ")));`).stdout;
      assert.equal(JSON.parse(out), null);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("loadSprints refuses a FIFO sprints.json instead of returning EMPTY", () => {
    // Decision (ADR-0031): REFUSE — and this is the line the whole ADR draws. A MALFORMED
    // registry still yields EMPTY, unchanged, because that is an ANSWER: Blaze looked and
    // the file is junk. A registry it could not open is NOT an answer, and EMPTY would tell
    // `blaze new` that every sprint id is invalid and tell the board there are no sprints.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-sprints-"));
    try {
      board(tmp);
      const target = join(tmp, "sprints.json");
      fifo(target);
      const out = child(tmp, `import { loadSprints } from ${mod("model", "sprints.mjs")};\n` +
        `try { console.log("NO REFUSAL " + JSON.stringify(loadSprints({ root: ${JSON.stringify(tmp)} }))); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: target });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("loadSprints still yields EMPTY for a MALFORMED registry — that one IS an answer", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-sprintsjunk-"));
    try {
      board(tmp);
      writeFileSync(join(tmp, "sprints.json"), "{ not json");
      const out = child(tmp, `import { loadSprints } from ${mod("model", "sprints.mjs")};\n` +
        `console.log(JSON.stringify(loadSprints({ root: ${JSON.stringify(tmp)} })));`).stdout;
      assert.deepEqual(JSON.parse(out), { active: null, sprints: [] });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("buildIndex carries the sprints refusal out rather than hanging", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-sprintsidx-"));
    try {
      const projects = board(tmp);
      fifo(join(tmp, "sprints.json"));
      const out = child(tmp, `import { buildIndex } from ${mod("model", "index.mjs")};\n` +
        `try { console.log("NO REFUSAL " + buildIndex(${JSON.stringify(projects)}).rows.length); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: join(tmp, "sprints.json") });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Site 6 — `panelHtml`'s re-read. REFUSE. Reachable only through the race
// `serve.mjs` already documents, which is why the guard must be race-free.
// =============================================================================

describe("BLZ-493 site 6: panelHtml REFUSES rather than hangs — from the WALK it re-runs", () => {
  test("panelHtml over a FIFO ticket file refuses, and the refusal comes from the walk", () => {
    // WHAT THIS TEST PROVES, AND WHAT IT DOES NOT — established by the revert rule, which
    // caught this test claiming more than it pins. `panelHtml` calls `buildIndex` on its FIRST
    // LINE and `buildIndex` never memoises, so the WALK opens every `.md` — including this one
    // — before the re-read four lines later is ever reached. Reverting `panel-content.mjs`'s
    // own guard therefore leaves this test GREEN: what it pins is that `/api/panel` REFUSES
    // AND RETURNS over a FIFO ticket file, which is the property `serve.mjs` needs (it wraps
    // the call in a try/catch and answers 500). It does NOT pin `panel-content.mjs:84`.
    //
    // That line is reachable only through the sub-second window INSIDE `panelHtml` between
    // the walk's read of this file and the re-read — the same window `serve.mjs:519` already
    // documents for ENOENT. No test constructs it, so the guard there is defence in depth and
    // is stated as such in ADR-0031 rather than implied to be pinned.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-panel-"));
    try {
      const projects = board(tmp);
      const target = join(projects, "BLZ", "defined", "BLZ-1-t.md");
      const out = child(tmp, `import { execFileSync } from "node:child_process";\n` +
        `import { unlinkSync } from "node:fs";\n` +
        `import { buildIndex } from ${mod("model", "index.mjs")};\n` +
        `import { panelHtml } from ${mod("views", "panel-content.mjs")};\n` +
        `buildIndex(${JSON.stringify(projects)});\n` +
        `unlinkSync(${JSON.stringify(target)});\n` +
        `execFileSync("mkfifo", [${JSON.stringify(target)}]);\n` +
        `try { console.log("NO REFUSAL " + String(panelHtml(${JSON.stringify(projects)}, "BLZ-1")).slice(0, 30)); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: target });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("panelHtml still renders a healthy ticket", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-panelok-"));
    try {
      const projects = board(tmp);
      const out = child(tmp, `import { panelHtml } from ${mod("views", "panel-content.mjs")};\n` +
        `console.log(JSON.stringify(panelHtml(${JSON.stringify(projects)}, "BLZ-1").includes("BLZ-1")));`).stdout;
      assert.equal(JSON.parse(out), true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Site 7 — `loadTransitions`'s cache. SKIP, and the reason is written down.
// =============================================================================

describe("BLZ-493 site 7: the transitions CACHE is skipped, and that costs nothing", () => {
  /** A board that is also a git repo, so `loadTransitions` has a real answer to fall back to. */
  function repo(tmp) {
    const projects = board(tmp);
    const git = (...a) => execFileSync("git", ["-C", tmp, ...a], { stdio: "ignore" });
    git("init", "-b", "main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-m", "base");
    return projects;
  }

  test("an unreadable cache falls back to git and RETURNS — no refusal, and none is owed", () => {
    // Decision (ADR-0031): the ONLY site of the ten that is allowed to skip in silence, and
    // the reason is that it is the only one where the fallback IS the answer. The cache is a
    // pure optimisation over `git log`; a run that cannot read it still LOOKS — at git — and
    // gets the true result. ADR-0030's rule is about a run that could not look reporting what
    // a looking run reports, and this run looked.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-txn-"));
    try {
      repo(tmp);
      mkdirSync(join(tmp, ".blaze"), { recursive: true });
      fifo(join(tmp, ".blaze", "transitions.json"));
      const out = child(tmp, `import { loadTransitions } from ${mod("model", "transitions.mjs")};\n` +
        `const r = loadTransitions({ root: ${JSON.stringify(tmp)} });\n` +
        `console.log(JSON.stringify({ head: r.head !== null, n: r.transitions.length }));`).stdout;
      assert.deepEqual(JSON.parse(out), { head: true, n: 0 },
        "the true answer from git, not a refusal and not a hang");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("the cache WRITE is skipped too — writeFileSync on a FIFO blocks just as hard", () => {
    // Guarding only the read moves the hang three lines down: after falling back to git,
    // `loadTransitions` writes the cache, and `writeFileSync` to a FIFO with no reader blocks
    // forever exactly as the read does (measured at 1b00f3a). The write was already
    // best-effort in a try/catch — a blocking write is simply not something a catch can see.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-txnwrite-"));
    try {
      repo(tmp);
      mkdirSync(join(tmp, ".blaze"), { recursive: true });
      fifo(join(tmp, ".blaze", "transitions.json"));
      const out = child(tmp, `import { loadTransitions } from ${mod("model", "transitions.mjs")};\n` +
        `loadTransitions({ root: ${JSON.stringify(tmp)} });\n` +
        `loadTransitions({ root: ${JSON.stringify(tmp)} });\n` +
        `console.log("BOTH RETURNED");`).stdout.trim();
      assert.equal(out, "BOTH RETURNED");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a healthy cache is still written and still read back", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-txnok-"));
    try {
      repo(tmp);
      const out = child(tmp, `import { existsSync, readFileSync } from "node:fs";\n` +
        `import { join } from "node:path";\n` +
        `import { loadTransitions } from ${mod("model", "transitions.mjs")};\n` +
        `loadTransitions({ root: ${JSON.stringify(tmp)} });\n` +
        `const p = join(${JSON.stringify(tmp)}, ".blaze", "transitions.json");\n` +
        `console.log(JSON.stringify({ wrote: existsSync(p), head: JSON.parse(readFileSync(p, "utf8")).head !== null }));`).stdout;
      assert.deepEqual(JSON.parse(out), { wrote: true, head: true });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// =============================================================================
// Site 8 — `loadConfig` and `loadProject`. REFUSE. `existsSync` is satisfied by
// a FIFO, and this pair sits on nearly every entry point.
// =============================================================================

describe("BLZ-493 site 8: loadConfig/loadProject REFUSE what existsSync waved through", () => {
  test("a FIFO blaze.config.json refuses, and NOT as a parse error", () => {
    // Decision (ADR-0031): REFUSE with a plain `Error`, deliberately NOT `ConfigParseError`.
    // BLZ-392's tolerance in `audit-runner.mjs` keys off that class to CONTINUE past a config
    // it could not load; continuing past a config this run never read is the laundering
    // itself. A plain Error lands in the `config-unloadable` HARD finding instead — named,
    // `ok=false`, exit 1.
    const tmp = mkdtempSync(join(tmpdir(), "blz493-cfg-"));
    try {
      board(tmp);
      rmSync(join(tmp, "blaze.config.json"));
      const target = join(tmp, "blaze.config.json");
      fifo(target);
      const out = child(tmp, `import { loadConfig, ConfigParseError } from ${mod("config.mjs")};\n` +
        `try { console.log("NO REFUSAL"); loadConfig({ root: ${JSON.stringify(tmp)} }); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + (e instanceof ConfigParseError) + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: target });
      assert.match(out, /:: false ::/,
        "a config that could not be READ must not be filed as a config that failed to PARSE — " +
        "audit-runner tolerates the second and continues");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("`blaze audit` over a FIFO config exits 1 with the HARD config-unloadable finding", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-cfgaudit-"));
    try {
      const projects = board(tmp);
      rmSync(join(tmp, "blaze.config.json"));
      fifo(join(tmp, "blaze.config.json"));
      const res = childScript(tmp, "audit-runner.mjs", [projects]);
      assert.match(res.stdout, /\[hard\] config-unloadable: 1/);
      assert.match(res.stdout, /ok=false/);
      assert.equal(res.status, 1);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a MISSING config is still an empty config, not a refusal", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-cfgmissing-"));
    try {
      board(tmp);
      rmSync(join(tmp, "blaze.config.json"));
      const out = child(tmp, `import { loadConfig } from ${mod("config.mjs")};\n` +
        `console.log(JSON.stringify(typeof loadConfig({ root: ${JSON.stringify(tmp)} }).minutes_per_day !== "undefined" ` +
        `|| typeof loadConfig({ root: ${JSON.stringify(tmp)} }) === "object"));`).stdout;
      assert.equal(JSON.parse(out), true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test("loadProject refuses a FIFO project.json instead of hanging every verb", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz493-proj-"));
    try {
      const projects = board(tmp);
      rmSync(join(projects, "BLZ", "project.json"));
      const target = join(projects, "BLZ", "project.json");
      fifo(target);
      const out = child(tmp, `import { loadProject } from ${mod("config.mjs")};\n` +
        `try { console.log("NO REFUSAL " + loadProject("BLZ", { root: ${JSON.stringify(tmp)} }).key); }\n` +
        `catch (e) { console.log("REFUSED " + e.code + " :: " + e.message); }`).stdout;
      assertRefusal(out, { path: target });
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
