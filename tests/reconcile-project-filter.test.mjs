// reconcile-project-filter.test.mjs — BLZ-394.
//
// `reconcile --apply` writes ticket files directly and then commits every file it touched,
// so a session that owns three tickets authors a commit moving fifteen it never looked at.
// A dry run during the INF-645 closeout proposed 22 changes, roughly 15 of them `OBA-*`
// belonging to concurrent sister sessions.
//
// ADR-0023 §3 already ruled that `--apply` STAYS a direct write and is NOT session-scoped:
// the session-queue machinery serialises divergent INTENTS, and reconcile has none — it
// derives its answer from git rather than from anything a session wants. What is left is
// BLAST RADIUS, not correctness, and the fix is a `--project` filter on the verb.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";

/** A board with TWO projects, each pointed at its own code repo, each with one ticket
 *  that a merged PR should drive to `done`. */
function twoProjectBoard(tmp) {
  const repos = {};
  for (const key of ["INF", "OBA"]) {
    const dir = join(tmp, `repo-${key}`);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    writeFileSync(join(dir, "README.md"), "x\n");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
    execFileSync("git", ["-C", dir, "remote", "add", "origin",
      `https://github.com/hjr15/${key.toLowerCase()}.git`]);
    repos[key] = dir;
  }
  const root = join(tmp, "board");
  for (const [key, id] of [["INF", "INF-1"], ["OBA", "OBA-1"]]) {
    const dir = join(root, "projects", key, "defined");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}-t.md`),
      `---\nid: ${id}\ntype: task\nproject: ${key}\nestimate: 30\n---\n\nbody\n`);
    writeFileSync(join(root, "projects", key, "project.json"),
      JSON.stringify({ key, codeRepos: [repos[key]] }));
  }
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF", "OBA"] }));
  return root;
}

/** A `gh` that answers with a merged PR for whichever repo it is invoked in. */
function stubGh(tmp) {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const pr = (key, n) => ({ number: n, state: "MERGED", url: `https://github.com/hjr15/x/pull/${n}`,
    headRefName: `${key}-1-work`, title: `${key}-1: the work` });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$PWD" in
  *repo-INF) cat <<'JSON'
${JSON.stringify([pr("INF", 11)])}
JSON
  ;;
  *) cat <<'JSON'
${JSON.stringify([pr("OBA", 22)])}
JSON
  ;;
esac
`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  return () => { process.env.PATH = prev; };
}

const at = (root, key, status) =>
  existsSync(join(root, "projects", key, status, `${key}-1-t.md`));

describe("BLZ-394: --project restricts BOTH the scan and the write", () => {
  test("AC-1: a filtered run moves exactly the project named, and no other", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-one-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const r = await reconcile({ root, dryRun: false, projects: ["INF"] });
      assert.equal(r.ok, true);
      assert.ok(at(root, "INF", "done"), "the project in scope must reconcile");
      assert.ok(at(root, "OBA", "defined"),
        "the project OUT of scope must not be touched — this is the whole ticket");
      assert.deepEqual(r.changes.map((c) => c.id), ["INF-1"]);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC-1: more than one project can be named", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-two-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const r = await reconcile({ root, dryRun: false, projects: ["INF", "OBA"] });
      assert.deepEqual(r.changes.map((c) => c.id).sort(), ["INF-1", "OBA-1"]);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC-2: without the flag, every configured project reconciles exactly as before", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-none-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.changes.map((c) => c.id).sort(), ["INF-1", "OBA-1"]);
      assert.ok(at(root, "INF", "done"));
      assert.ok(at(root, "OBA", "done"));
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC-4: an unknown key is a LOUD error naming the configured projects", async () => {
    // Not a silent empty run. A typo'd --project that quietly reconciles nothing looks
    // exactly like an in-sync board, which is the INF-763 lesson in a new place.
    const tmp = mkdtempSync(join(tmpdir(), "blz394-bad-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const r = await reconcile({ root, dryRun: true, projects: ["NOPE"] });
      assert.equal(r.ok, false, "an unknown key must not report a healthy run");
      assert.match(r.error, /NOPE/);
      assert.match(r.error, /INF/);
      assert.match(r.error, /OBA/, "the error must name what IS configured");
      assert.deepEqual(r.changes, []);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC-4: one bad key among good ones still refuses — no partial run", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-mixed-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const r = await reconcile({ root, dryRun: false, projects: ["INF", "NOPE"] });
      assert.equal(r.ok, false);
      assert.ok(at(root, "INF", "defined"),
        "a refused run must write nothing at all, not the half it understood");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC-5: the result states which projects were scanned", async () => {
    // So a filtered run cannot be mistaken for an in-sync board.
    const tmp = mkdtempSync(join(tmpdir(), "blz394-scanned-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const filtered = await reconcile({ root, dryRun: true, projects: ["INF"] });
      assert.deepEqual(filtered.scannedProjects, ["INF"]);
      const all = await reconcile({ root, dryRun: true });
      assert.deepEqual(all.scannedProjects.sort(), ["INF", "OBA"],
        "an unfiltered run says so too — the field is not only for filtered runs");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("AC-3: the --apply commit names only the tickets in scope", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-commit-"));
    const root = twoProjectBoard(tmp);
    for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                     ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      execFileSync("git", ["-C", root, ...a]);
    }
    const restore = stubGh(tmp);
    try {
      const r = await reconcile({ root, dryRun: false, commit: true, projects: ["INF"] });
      assert.equal(r.committed, true, "the filtered run must still commit what it did move");
      const files = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"],
        { encoding: "utf8" });
      assert.match(files, /INF/);
      assert.doesNotMatch(files, /OBA/,
        "a session that owns INF must not author a commit touching OBA — the ticket in one line");
      const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" });
      assert.match(subject, /1 ticket/,
        "and the count must be of the tickets in scope, not of the whole board");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BLZ-394: the CLI surface", () => {
  function runCli(root, tmp, args) {
    return spawnSync(process.execPath,
      [join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), ...args],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(tmp, "bin")}:${process.env.PATH}` } });
  }

  test("--project accepts a repeated flag and a comma-separated list alike", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-cli-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      for (const args of [["--project", "INF"], ["--project=INF"], ["--project", "INF,OBA"],
                          ["--project", "INF", "--project", "OBA"]]) {
        const res = runCli(root, tmp, args);
        assert.equal(res.status, 0, `${args.join(" ")}: ${res.stderr}`);
        const want = args.join(" ").includes("OBA") ? /INF, OBA|INF,OBA/ : /INF/;
        assert.match(res.stdout + res.stderr, want, `${args.join(" ")} should say what it scanned`);
      }
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the dry-run output names the projects scanned", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-say-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const res = runCli(root, tmp, ["--project", "INF"]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout + res.stderr, /scanned/i);
      assert.match(res.stdout + res.stderr, /INF/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("an unknown key exits non-zero and names the configured projects", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-clibad-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const res = runCli(root, tmp, ["--project", "NOPE"]);
      assert.notEqual(res.status, 0, "a typo'd key must not look like a clean run");
      assert.match(res.stderr, /NOPE/);
      assert.match(res.stderr, /INF/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--project with no value is refused, not read as the next flag", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz394-noval-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const res = runCli(root, tmp, ["--project", "--apply"]);
      assert.notEqual(res.status, 0, "`--project --apply` must not silently scope to a project named '--apply'");
      assert.match(res.stderr, /--project/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
