// tests/commands-doc-quiet-pins.test.mjs — BLZ-471.
//
// `docs/guide/commands.md` documented `--quiet` as "Suppress output for tickets already in
// sync." It was wrong twice:
//
//   1. it repeated the REMOVED "already in sync" claim BLZ-433 existed to eliminate — a
//      fifth instance, in a file that lane did not own at the time; and
//   2. `--quiet` gates no per-ticket output whatsoever.
//
// BLZ-471 STATED THE SECOND HALF TOO NARROWLY AND THAT CORRECTION IS PART OF THIS FIX: the
// ticket says `--quiet` gates "exactly one whole-run line". Measured against the real CLI,
// it gates THREE, all of them whole-run:
//
//   - `reconcile: no code-bound change found — nothing to do.`      (stdout)
//   - `reconcile: no projects configured — nothing to reconcile.`   (stdout, standalone board)
//   - `reconcile: scanned project(s): …`                            (stderr, unfiltered runs only)
//
// This file pins the page against the implementation IN BOTH DIRECTIONS, which is what stops
// them drifting again. The DOC is the input: the `--quiet` row is read out of the page, every
// line it says is suppressed must really be suppressed, and every category it says survives
// must really survive. It does not encode today's wording as permanent — change the row and
// the code together and this test follows.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const REPO = join(import.meta.dirname, "..");
const RECONCILE_BIN = join(REPO, "scripts", "reconcile.mjs");
const PAGE = join(REPO, "docs", "guide", "commands.md");
const page = readFileSync(PAGE, "utf8");

/** The `--quiet` row, read out of the page itself. */
function quietRow() {
  const rows = page.split("\n").filter((l) => l.startsWith("| `--quiet` |"));
  assert.equal(rows.length, 1, "commands.md must document `--quiet` exactly once");
  return rows[0];
}

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });

/** A board with one `defined` ticket and no code repo: nothing to decide, so the whole-run
 *  "nothing to do" line is the only thing a plain run prints on stdout. */
function board(tmp, { standalone = false } = {}) {
  const root = mkdtempSync(join(tmp, "board-"));
  mkdirSync(join(root, "projects", "ZZZ", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "ZZZ", "defined", "ZZZ-1-t.md"),
    "---\nid: ZZZ-1\ntitle: t\ntype: task\nproject: ZZZ\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "projects", "ZZZ", "project.json"),
    JSON.stringify({ key: "ZZZ", codeRepos: [] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: standalone ? [] : ["ZZZ"] }));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    git(root, ...a);
  }
  return root;
}

/** A board whose ticket really moves, so the per-ticket lines exist to be looked for, plus
 *  a `gh` stub that FAILS — which is how the warning stream gets something on it. */
function movingBoard(tmp) {
  const codeRepo = mkdtempSync(join(tmp, "repo-"));
  git(codeRepo, "init", "-q", "-b", "main");
  git(codeRepo, "config", "user.email", "t@t.t");
  git(codeRepo, "config", "user.name", "t");
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  git(codeRepo, "add", "-A");
  git(codeRepo, "commit", "-q", "-m", "seed");
  git(codeRepo, "commit", "-q", "--allow-empty", "-m", "ZZZ-1: work");

  const root = mkdtempSync(join(tmp, "moving-"));
  mkdirSync(join(root, "projects", "ZZZ", "defined"), { recursive: true });
  writeFileSync(join(root, "projects", "ZZZ", "defined", "ZZZ-1-t.md"),
    "---\nid: ZZZ-1\ntitle: t\ntype: task\nproject: ZZZ\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "projects", "ZZZ", "project.json"),
    JSON.stringify({ key: "ZZZ", codeRepos: [codeRepo] }));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "ZZZ", projects: ["ZZZ"] }));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    git(root, ...a);
  }
  const bin = mkdtempSync(join(tmp, "bin-"));
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\necho 'gh: unreadable (stub)' >&2\nexit 1\n");
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  return { root, bin };
}

const run = (root, args, extraPath = null) => spawnSync(process.execPath, [RECONCILE_BIN, ...args], {
  cwd: root, encoding: "utf8",
  env: extraPath ? { ...process.env, PATH: `${extraPath}:${process.env.PATH}` } : process.env,
});

describe("BLZ-471: commands.md's `--quiet` row says what the flag actually gates", () => {
  test("the removed 'already in sync' wording is gone from this page", () => {
    // BLZ-433 removed that sentence from the product. This page was the fifth place still
    // quoting it, and the only one an installed user reads.
    assert.doesNotMatch(page, /already in sync/,
      "commands.md still quotes a sentence reconcile has not emitted since BLZ-404 round 5");
  });

  test("the row does not describe `--quiet` as per-ticket", () => {
    const row = quietRow();
    assert.doesNotMatch(row, /for tickets\b/,
      `the row still describes per-ticket gating: ${JSON.stringify(row)}`);
    assert.match(row, /whole-run/,
      "the row must say plainly that the flag gates whole-run lines");
  });

  test("every whole-run line the row names as suppressed IS suppressed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz471-suppressed-"));
    try {
      const row = quietRow();
      // Read the sentences out of the PAGE, then check each against the real CLI.
      const emptyPass = "reconcile: no code-bound change found — nothing to do.";
      const standalonePass = "reconcile: no projects configured — nothing to reconcile.";
      const scanned = "reconcile: scanned project(s): ";
      for (const claim of [emptyPass, standalonePass]) {
        assert.ok(row.includes(claim), `the row must name ${JSON.stringify(claim)} as suppressed`);
      }
      assert.ok(row.includes("reconcile: scanned project(s): …"),
        "the row must name the scanned-projects line as suppressed on an unfiltered run");

      const plain = board(tmp);
      const loud = run(plain, []);
      const quiet = run(plain, ["--quiet"]);
      assert.equal(loud.status, 0, loud.stderr);
      assert.equal(quiet.status, 0, quiet.stderr);
      assert.ok(loud.stdout.includes(emptyPass), `a plain run must print it — got ${JSON.stringify(loud.stdout)}`);
      assert.ok(!quiet.stdout.includes(emptyPass), `--quiet must suppress it — got ${JSON.stringify(quiet.stdout)}`);
      assert.ok(loud.stderr.includes(scanned), `a plain run must print it — got ${JSON.stringify(loud.stderr)}`);
      assert.ok(!quiet.stderr.includes(scanned), `--quiet must suppress it — got ${JSON.stringify(quiet.stderr)}`);

      const alone = board(tmp, { standalone: true });
      assert.ok(run(alone, []).stdout.includes(standalonePass));
      assert.ok(!run(alone, ["--quiet"]).stdout.includes(standalonePass));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the scanned-projects line survives --quiet on a FILTERED run, exactly as the row says", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz471-filtered-"));
    try {
      assert.match(quietRow(), /printed anyway whenever `--project` was given/,
        "the row must state the exception the code makes");
      const root = board(tmp);
      const r = run(root, ["--quiet", "--project", "ZZZ"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /reconcile: scanned project\(s\): ZZZ/,
        "a filtered run must say what it looked at, --quiet or not — otherwise 'nothing to do' " +
        "reads as 'the whole board is in sync'");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--quiet gates NO per-ticket output, and no warning or finding — the half BLZ-471 is really about", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz471-perticket-"));
    try {
      const row = quietRow();
      assert.match(row, /never per-ticket output/,
        `the row must state that per-ticket output is never gated: ${JSON.stringify(row)}`);
      assert.match(row, /Per-ticket .+ are printed under `--quiet` exactly as without it/,
        `the row must name what survives the flag: ${JSON.stringify(row)}`);
      const { root, bin } = movingBoard(tmp);
      const loud = run(root, [], bin);
      const quiet = run(root, ["--quiet"], bin);
      assert.equal(loud.status, 0, loud.stderr);
      assert.equal(quiet.status, 0, quiet.stderr);

      // The per-ticket line and the dry-run tail: byte-identical with and without the flag.
      const perTicket = (out) => out.split("\n").filter((l) => /^would move ZZZ-1: /.test(l));
      assert.deepEqual(perTicket(loud.stdout), ["would move ZZZ-1: defined → done"],
        `the fixture must really produce a per-ticket line — got ${JSON.stringify(loud.stdout)}`);
      assert.deepEqual(perTicket(quiet.stdout), perTicket(loud.stdout),
        `--quiet suppressed per-ticket output — got ${JSON.stringify(quiet.stdout)}`);
      assert.match(quiet.stdout, /\(dry-run: 1 move\(s\); rerun with --apply/,
        `--quiet suppressed the dry-run tail — got ${JSON.stringify(quiet.stdout)}`);

      // The warning stream: a degraded forge is a reason not to trust the run, so it is
      // printed under --quiet too.
      assert.match(loud.stderr, /FORGE UNREADABLE/, "the fixture must really degrade the forge");
      assert.match(quiet.stderr, /FORGE UNREADABLE/,
        `--quiet suppressed a FORGE line — got ${JSON.stringify(quiet.stderr)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
