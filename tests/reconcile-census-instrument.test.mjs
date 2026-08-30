// tests/reconcile-census-instrument.test.mjs — BLZ-509.
//
// The git-probe census above `defaultBranchRef` in scripts/reconcile.mjs names a command
// that re-takes it. The first cut of that census named a command for an instrument that had
// never been committed — `grep -rn BLZ_MEASURE .` returned nothing — which is the ticket's
// own failure mode reappearing one layer up: BLZ-509 exists because a figure whose
// instrument nobody can run rots exactly like a figure nobody maintains.
//
// So the instrument ships, and this file holds it to the three properties the census
// depends on: it records what the census counts, it is OFF by default, and it can never
// change what it measures.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";

/** One board, one code repo with a branch, a `gh` that answers nothing. Hermetic: the
 *  origin is a local path (BLZ-505) and the forge remote's host is under `.invalid`. */
function board(tmp) {
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", repo, ...a]);
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(repo, "R"), "x\n");
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("checkout", "-q", "-b", "CEN-1-work");
  writeFileSync(join(repo, "w"), "w\n");
  g("add", "-A");
  g("commit", "-q", "-m", "CEN-1: the work");
  g("checkout", "-q", "main");
  g("remote", "add", "origin", join(tmp, "no-such-origin.git"));
  g("remote", "add", "forge", "https://github.blaze-fixture.invalid/hjr15/cen.git");

  const root = join(tmp, "board");
  const dir = join(root, "projects", "CEN", "defined");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CEN-1-t.md"),
    "---\nid: CEN-1\ntype: task\nproject: CEN\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "CEN", projects: ["CEN"], codeRepos: [repo] }));

  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  return { root, bin };
}

/** Run a dry reconcile with `BLZ_MEASURE` pointed wherever the caller says (or unset). */
async function run(tmp, logPath) {
  const { root, bin } = board(tmp);
  const prevPath = process.env.PATH;
  const prevMeasure = process.env.BLZ_MEASURE;
  try {
    process.env.PATH = bin + ":" + prevPath;
    if (logPath === null) delete process.env.BLZ_MEASURE;
    else process.env.BLZ_MEASURE = logPath;
    return await reconcile({ root, projectsDir: join(root, "projects"), fetch: true, dryRun: true });
  } finally {
    process.env.PATH = prevPath;
    if (prevMeasure === undefined) delete process.env.BLZ_MEASURE;
    else process.env.BLZ_MEASURE = prevMeasure;
  }
}

describe("BLZ-509: the census instrument the census header tells you to run", () => {
  test("BLZ_MEASURE records every git probe, with the arguments and outcome the census counts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz509-census-on-"));
    const log = join(tmp, "census.jsonl");
    try {
      await run(tmp, log);
      const rows = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const probes = rows.filter((r) => r.p === "probe");
      assert.ok(probes.length > 0, "the census counts git probes; none were recorded");
      // Every column the census table has, present and typed.
      for (const r of probes) {
        assert.ok(Array.isArray(r.args) && r.args.length > 0, "each row names the probe: " + JSON.stringify(r));
        assert.equal(typeof r.ok, "boolean");
        assert.ok(r.status === null || typeof r.status === "number",
          "`could-not-run` is `status === null`, and the census splits on it");
        assert.equal(typeof r.repo, "string");
      }
      // The exact probe forms the census rows are keyed on must all appear, or a row could
      // silently read zero because the instrument stopped seeing it.
      const verbs = new Set(probes.map((r) => r.args.join(" ").replace(/\s+\S*CEN\S*/g, " <x>")));
      for (const form of ["for-each-ref", "rev-parse", "log", "fetch"]) {
        assert.ok([...verbs].some((v) => v.startsWith(form)),
          `no \`${form}\` row was recorded; the census's ${form} count would read zero`);
      }
      // …and the branchMap row, which is what BLZ-506's corroboration figure is taken from.
      const maps = rows.filter((r) => r.p === "branchMap");
      assert.ok(maps.length > 0, "buildBranchMap must be recorded too");
      assert.equal(typeof maps[0].refs, "number");
      assert.equal(typeof maps[0].corroborated, "number");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("with BLZ_MEASURE unset it writes nothing at all", async () => {
    // The instrument ships in the production path, so "off by default" is not a nicety.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz509-census-off-"));
    const wouldBe = join(tmp, "census.jsonl");
    try {
      await run(tmp, null);
      assert.equal(existsSync(wouldBe), false, "no census file may be created when unset");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("every BLZ_MEASURE path reconcile cannot append to is swallowed, and none changes what it decides", async () => {
    // RENAMED AND WIDENED (review round 3). This was called "an unwritable BLZ_MEASURE
    // cannot change what reconcile decides" and covered exactly ONE errno — ENOTDIR — while
    // its name claimed the whole class. The class has four members and they fail four
    // different ways; a FIFO was not unwritable at all, it was unreturnable, and the
    // sibling test below is the one that holds it.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz509-census-bad-"));
    try {
      const blocker = join(tmp, "not-a-dir");
      writeFileSync(blocker, "x\n");
      const adir = join(tmp, "a-directory");
      mkdirSync(adir);
      // A fresh tree per run: `board` git-inits, so no two may share a directory.
      const trees = ["control", "notdir", "isdir", "device"].map((n) => {
        const d = join(tmp, n); mkdirSync(d); return d;
      });
      const off = await run(trees[0], null);
      const cases = [
        ["a path inside a file (ENOTDIR)", await run(trees[1], join(blocker, "census.jsonl"))],
        ["a directory (EISDIR)", await run(trees[2], adir)],
        ["a device node (refused by NotARegularFileError)", await run(trees[3], "/dev/null")],
      ];
      // Compared on SHAPE, not verbatim: each run lives in its own temp tree, so the
      // messages carry different paths.
      const shape = (r) => (r.gitErrors || []).map((e) =>
        ({ reason: e.reason, severity: e.severity, command: e.command, status: e.status }));
      for (const [label, broken] of cases) {
        assert.equal(broken.ok, true, `${label}: a census path must not fail the run`);
        assert.deepEqual(broken.changes, off.changes,
          `${label}: …and must not change a single decision the run makes`);
        assert.deepEqual(shape(broken), shape(off),
          `${label}: …nor which git conditions the run reports`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a FIFO BLZ_MEASURE fails fast — ADR-0031's hang class does not reappear on the write side", () => {
    // THE ONE THE `try`/`catch` NEVER COVERED. `appendFileSync` opens the path, and an open
    // of a FIFO with no reader blocks in `open(2)`: the catch is never reached, and
    // `node:test`'s own `timeout` option cannot rescue it either, because that timer lives
    // on an event loop a synchronous open never yields to. Measured through the real
    // `reconcile()` before the fix: EXIT=124 at a 10s `timeout` and again at 25s.
    //
    // So this runs in a CHILD under a hard timeout rather than in-process. A regression here
    // must FAIL, not hang the suite — a hanging suite is the symptom ADR-0031 exists to
    // remove, and reproducing it inside the guard against it would be the same defect twice.
    const tmp = mkdtempSync(join(tmpdir(), "blaze-blz509-census-fifo-"));
    try {
      const { root } = board(tmp);
      const fifo = join(tmp, "census.fifo");
      execFileSync("mkfifo", [fifo]);
      const driver = join(tmp, "drive.mjs");
      writeFileSync(driver,
        'process.env.BLZ_MEASURE = process.argv[2];\n' +
        'const { reconcile } = await import(process.argv[3]);\n' +
        'const r = await reconcile({ root: process.argv[4], projectsDir: process.argv[5], dryRun: true });\n' +
        'console.log(JSON.stringify({ ok: r.ok, changes: r.changes.length }));\n');
      const reconcilePath = new URL("../scripts/reconcile.mjs", import.meta.url).href;
      const drive = (measure) => spawnSync(process.execPath,
        [driver, measure, reconcilePath, root, join(root, "projects")],
        { encoding: "utf8", timeout: 20000 });

      const res = drive(fifo);
      assert.notEqual(res.signal, "SIGTERM",
        "the run never returned: an open on a FIFO with no reader blocked, which is exactly "
        + "what `appendRegularFileSync`'s O_NONBLOCK exists to prevent. stderr: " + res.stderr);
      assert.equal(res.status, 0, "the run must complete and exit cleanly: " + res.stderr);

      // The control, through the identical path with no census at all. Without it a fix that
      // simply stopped reconciling would satisfy every assertion above.
      const control = drive("");
      assert.equal(control.status, 0, control.stderr);
      assert.deepEqual(JSON.parse(res.stdout.trim()), JSON.parse(control.stdout.trim()),
        "…and must decide exactly what the same run decides with no census at all");
      assert.equal(JSON.parse(control.stdout.trim()).ok, true, "the control must be a real run");

      // The FIFO must still be untouched — nothing was written into a pipe with no reader.
      assert.equal(statSync(fifo).isFIFO(), true);
      assert.equal(statSync(fifo).size, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
