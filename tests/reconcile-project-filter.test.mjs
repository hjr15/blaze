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

// BLZ-436. The out-of-scope key must not appear in what the run SAYS ABOUT ITS OWN WORK —
// what it scanned, what it moved, what it committed. It may legitimately appear in ONE
// channel: `reconcile: NEEDS ATTENTION`, the findings stream.
//
// BLZ-406 raises `project-mismatch` BEFORE the scope guard and UNCONDITIONALLY, on every
// run, filtered or not, and `scripts/reconcile.mjs` spells out why: a ticket whose
// directory and frontmatter disagree is reconcilable by NO single-project run — a
// `--project <directory>` run has no signal keyed by its frontmatter's project, and a
// `--project <frontmatter>` run excludes it by directory — so gating the finding on scope
// "would make it exactly the silent skip this finding exists to report". Its message names
// `projects/<directory>/` by construction, which for such a ticket is a project the run is
// NOT scoped to.
//
// So the PRODUCT is right here and the blanket assertion was wrong: it demanded a property
// BLZ-406 deliberately does not hold. This narrows it to the claim BLZ-394 is actually
// about, and the sibling test below pins the exception positively so the narrowing is a
// statement rather than a weakening.
//
// BLZ-486: …AND THE NARROWING WAS ITSELF TOO WIDE. It excepted every line on the
// `NEEDS ATTENTION` channel while its rationale covers exactly one finding kind, so the
// BLZ-394 scope-leak assertions — the ones that exist to prove a scoped run does not name
// an out-of-scope project — were blind on every OTHER kind. An out-of-scope key leaking
// through `ambiguous-deliverer`, `terminal-record-unverifiable`,
// `merged-pr-title-claims-nothing`, `open-pr-on-terminal` or `unreadable-ticket-directory`
// went uncaught. `project-mismatch` is the only kind BLZ-406 argues for, so it is the only
// kind excepted — matched on the SENTENCE it emits, which the positive sibling test below
// pins against the real product output so this pattern cannot quietly stop matching.
const PROJECT_MISMATCH_LINE = /NEEDS ATTENTION — \S+ sits under projects\//;
const exceptProjectMismatch = (out) => out.split("\n")
  .filter((l) => !PROJECT_MISMATCH_LINE.test(l))
  .join("\n");

// Every finding kind `scripts/reconcile.mjs` can raise, read FROM THE SOURCE rather than
// listed by hand — a hand-written roster is how the filter came to cover kinds nobody had
// re-read it for. A new kind turns this red, which is the point: whoever adds one has to
// decide whether the scope-leak assertions may go blind on it.
const RECONCILE_FINDING_KINDS = readFileSync(
  join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), "utf8")
  .split("\n")
  .map((l) => /^\s+kind: "([a-z-]+)",$/.exec(l))
  .filter(Boolean)
  .map((m) => m[1]);

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

// =============================================================================
// Adversarial review — the shapes the first cut got wrong
// =============================================================================

describe("BLZ-394: a --project that yields no key REFUSES, it does not go wide", () => {
  function runCli(root, tmp, args) {
    return spawnSync(process.execPath,
      [join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), ...args],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(tmp, "bin")}:${process.env.PATH}` } });
  }

  // The first cut passed `projectKeys.length ? projectKeys : null`, so a flag that was
  // GIVEN but produced no key fell back to null — UNFILTERED. `blaze reconcile
  // --project=$PROJ --apply` with `$PROJ` unset reconciled and committed the whole board,
  // and with `--quiet` nothing on stderr said so. A shell script produces this by accident.
  for (const args of [["--project="], ["--project=,,"], ["--project", ","], ["--project", ",,"],
                      ["--project", " "], ["--project", ""]]) {
    test(`\`${args.join(" ")}\` is refused, not treated as unfiltered`, () => {
      const tmp = mkdtempSync(join(tmpdir(), "blz394-empty-"));
      const root = twoProjectBoard(tmp);
      const restore = stubGh(tmp);
      try {
        const res = runCli(root, tmp, [...args, "--apply"]);
        assert.notEqual(res.status, 0,
          "an empty --project must not silently reconcile every project on the board");
        assert.match(res.stderr, /--project/);
        assert.ok(at(root, "INF", "defined"), "and must write nothing at all");
        assert.ok(at(root, "OBA", "defined"));
      } finally {
        restore();
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  test("the library refuses an empty list directly, too", async () => {
    // The guard the CLI failed to reach. It was unpinned: replacing it with `if (false)`
    // survived the whole suite.
    const tmp = mkdtempSync(join(tmpdir(), "blz394-emptylib-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const r = await reconcile({ root, dryRun: false, commit: true, projects: [] });
      assert.equal(r.ok, false);
      assert.match(r.error, /--project/);
      assert.ok(at(root, "INF", "defined"));
      assert.ok(at(root, "OBA", "defined"));
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--quiet does not hide which projects were scanned on a filtered run", () => {
    // `--quiet` means "print only on change"; a narrowed scope is a reason not to trust
    // the absence of one. This `|| projectKeys.length` was unpinned.
    const tmp = mkdtempSync(join(tmpdir(), "blz394-quiet-"));
    const root = twoProjectBoard(tmp);
    const restore = stubGh(tmp);
    try {
      const res = runCli(root, tmp, ["--project", "INF", "--quiet"]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /scanned project\(s\): INF/);
      assert.doesNotMatch(exceptProjectMismatch(res.stderr), /OBA/);   // BLZ-436, see exceptProjectMismatch
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("BLZ-394: a typo'd key is refused even on a board with no projects configured", async () => {
  // The unknown-key guard sat BEHIND the standalone early return, so on such a board a
  // typo reported `ok: true, standalone: true` — a clean, empty, successful run, which is
  // the exact shape the refusal exists to prevent.
  const tmp = mkdtempSync(join(tmpdir(), "blz394-standalone-"));
  const root = join(tmp, "board");
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "INF", projects: [] }));
  try {
    const r = await reconcile({ root, dryRun: true, projects: ["NOPE"] });
    assert.equal(r.ok, false, "a standalone board must still refuse a key it does not have");
    assert.match(r.error, /NOPE/);
    const clean = await reconcile({ root, dryRun: true });
    assert.equal(clean.ok, true, "...while an unfiltered run on the same board is still fine");
    assert.equal(clean.standalone, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-394: scope follows the DIRECTORY, not just the frontmatter", async () => {
  // `sig` is keyed by the frontmatter's project but the write lands by the ticket's
  // DIRECTORY, so a ticket at projects/OBA/ carrying `project: INF` was selected by an
  // INF filter and then written into projects/OBA/ — a commit naming its scope as (INF)
  // while touching another project's files. Blast radius is a property of the path.
  const tmp = mkdtempSync(join(tmpdir(), "blz394-crossdir-"));
  const root = twoProjectBoard(tmp);
  writeFileSync(join(root, "projects", "OBA", "defined", "INF-2-t.md"),
    "---\nid: INF-2\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  // The misfiled ticket needs a MERGED PR of its own, or it never moves under either the
  // shipped code or the mutant and this test proves nothing. The first version of it had
  // no such PR and survived the very mutation it names.
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const pr = (ref, n) => ({ number: n, state: "MERGED", url: `https://github.com/hjr15/x/pull/${n}`,
    headRefName: ref, title: `${ref.split("-").slice(0, 2).join("-")}: the work` });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$PWD" in
  *repo-INF) cat <<'JSON'
${JSON.stringify([pr("INF-1-work", 11), pr("INF-2-work", 12)])}
JSON
  ;;
  *) cat <<'JSON'
${JSON.stringify([pr("OBA-1-work", 22)])}
JSON
  ;;
esac
`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  const prevPath = process.env.PATH;
  process.env.PATH = `${bin}:${prevPath}`;
  const restore = () => { process.env.PATH = prevPath; };
  try {
    // Control: unfiltered, INF-2 DOES move — so the assertion below is about scope, not
    // about INF-2 being inert.
    const control = await reconcile({ root, dryRun: true });
    assert.ok(control.changes.some((c) => c.id === "INF-2"),
      "the misfiled ticket must be movable, or this test cannot see the filter at all");

    const r = await reconcile({ root, dryRun: false, commit: true, projects: ["INF"] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.changes.map((c) => c.id), ["INF-1"],
      "the misfiled ticket lives under OBA, so an INF-scoped run must leave it alone");
    const files = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"],
      { encoding: "utf8" });
    assert.doesNotMatch(files, /projects\/OBA/,
      "a commit scoped to INF must not touch projects/OBA, whatever the frontmatter says");
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-394: the --apply commit subject carries the scope", async () => {
  // Unpinned in the first cut: dropping the `(${keys})` suffix survived the suite.
  const tmp = mkdtempSync(join(tmpdir(), "blz394-subject-"));
  const root = twoProjectBoard(tmp);
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  const restore = stubGh(tmp);
  try {
    await reconcile({ root, dryRun: false, commit: true, projects: ["INF"] });
    const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" });
    assert.match(subject, /\(INF\)/, "a scoped commit must say so in its subject");
    assert.doesNotMatch(subject, /OBA/);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-394: the CLI tests discriminate on SCOPE, not just on parsing", () => {
  // Four of the original CLI tests stayed green under a `no-filter` mutation: they matched
  // /INF/ against output that an unfiltered run also produces. This one asserts the
  // negative — the project OUT of scope must appear nowhere.
  const tmp = mkdtempSync(join(tmpdir(), "blz394-disc-"));
  const root = twoProjectBoard(tmp);
  // BLZ-404 (review finding 1): `root` must be a real git repo. Before reconcile's commit
  // block routed through `commitOrQueue` -> `commitFile`, a non-repo `root` silently
  // failed `git add`/`git commit` and the CLI never checked the result — this test passed
  // by accident while nothing was ever actually committed. Now a failed commit is reported
  // and exits non-zero (finding 2), so the fixture needs a real repo to prove the SCOPE
  // discrimination this test is actually about, exactly like the sibling "--apply commit
  // subject carries the scope" test above it.
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  const restore = stubGh(tmp);
  try {
    const res = spawnSync(process.execPath,
      [join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), "--project", "INF", "--apply"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(tmp, "bin")}:${process.env.PATH}` } });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(exceptProjectMismatch(res.stdout + res.stderr), /OBA/,
      "an INF-scoped run must not mention OBA in its account of its own work — see " +
      "exceptProjectMismatch for the one kind BLZ-406 deliberately exempts");
    assert.ok(at(root, "OBA", "defined"), "nor move it");
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-394: the refusal never reports a project count in the REPO count field", async () => {
  // `configuredRepos` counts REPOS. Both refusal returns set it to `configured.length` —
  // a project count in a named field. Unreachable through today's callers, but a wrong
  // value in a named field is wrong whether or not anyone currently reads it.
  const tmp = mkdtempSync(join(tmpdir(), "blz394-counts-"));
  const root = twoProjectBoard(tmp);
  const restore = stubGh(tmp);
  try {
    for (const projects of [["NOPE"], []]) {
      const r = await reconcile({ root, dryRun: true, projects });
      assert.equal(r.ok, false, JSON.stringify(projects));
      assert.equal(r.configuredRepos, 0,
        `${JSON.stringify(projects)}: a refused run scanned no repos, so it configures none to report`);
      assert.deepEqual(r.scannedProjects, []);
    }
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-394: a board with no projects says so, rather than trailing off", async () => {
  // The message read "This board configures: " with an empty tail, which tells a person
  // nothing at the moment they most need telling.
  const tmp = mkdtempSync(join(tmpdir(), "blz394-emptyboard-"));
  const root = join(tmp, "board");
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "INF", projects: [] }));
  try {
    const r = await reconcile({ root, dryRun: true, projects: ["NOPE"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /no projects at all/);
    assert.doesNotMatch(r.error, /configures: *$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-436: a scoped run DOES name an out-of-scope directory in a project-mismatch finding", async () => {
  // The positive half of the narrowing above, and the reason the narrowing is not a
  // weakening: BLZ-406's finding is raised before the scope guard and unconditionally,
  // precisely because NO single-project run can reconcile a misfiled ticket, so a filtered
  // run that stayed silent about it would be the silent skip the finding exists to report.
  //
  // It is asserted here as a REQUIREMENT: an INF-scoped run must say that INF-2 sits under
  // projects/OBA/ — while still writing nothing there, which is what BLZ-394 is about.
  const tmp = mkdtempSync(join(tmpdir(), "blz436-mismatch-"));
  const root = twoProjectBoard(tmp);
  writeFileSync(join(root, "projects", "OBA", "defined", "INF-2-t.md"),
    "---\nid: INF-2\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n");
  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    execFileSync("git", ["-C", root, ...a]);
  }
  const restore = stubGh(tmp);
  try {
    const res = spawnSync(process.execPath,
      [join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), "--project", "INF", "--apply"],
      { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(tmp, "bin")}:${process.env.PATH}` } });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /NEEDS ATTENTION — INF-2 sits under projects\/OBA\//,
      "an INF-scoped run must still report a ticket no single-project run can reconcile");
    // …and everything BLZ-394 asserts is unchanged: nothing under OBA moved or was
    // committed, and no other channel names it.
    assert.ok(at(root, "OBA", "defined"), "the out-of-scope project must not move");
    assert.ok(existsSync(join(root, "projects", "OBA", "defined", "INF-2-t.md")),
      "nor may the misfiled ticket be written or moved by a run that is not scoped to it");
    assert.doesNotMatch(exceptProjectMismatch(res.stdout + res.stderr), /OBA/,
      "OBA must appear in the project-mismatch finding and NOWHERE else");
    // BLZ-486: the filter is keyed on a SENTENCE, so it has to be checked against the
    // sentence the product actually emits, on real output, or it silently stops matching
    // and the exception silently becomes an assertion.
    assert.ok(!exceptProjectMismatch(res.stderr).includes("sits under projects/"),
      "exceptProjectMismatch must actually remove the project-mismatch line it exists to except");
    const files = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"],
      { encoding: "utf8" });
    assert.doesNotMatch(files, /projects\/OBA/);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// BLZ-451 — `--ticket`, the filter finer than `--project`.
//
// Hit live on 2026-08-28. `blaze reconcile --project BLZ` proposed five moves: four
// correct and one wrong (BLZ-408, driven to `done` by BLZ-440's defect). `--apply` is
// all-or-nothing WITHIN a project, so there was no way to take the four without also
// writing a false, WRITE-ONCE terminal delivery record on the fifth — `pr` is not in
// EDITABLE_FIELDS (ADR-0023), so there is no route back. The board could not be
// reconciled at all until BLZ-440 was fixed.
//
// This is the same BLAST-RADIUS control BLZ-394 is, one level finer, and it inherits
// BLZ-394's hard-won rule verbatim: A FILTER THAT WAS GIVEN AND YIELDED NOTHING REFUSES.
// `--project=$PROJ` with `$PROJ` unset reconciled and committed the whole board, silently;
// a second filter that falls back to "unfiltered" reintroduces exactly that, and a shell
// script produces it by accident. Every empty and malformed spelling below is therefore a
// REFUSAL with nothing written, not a wide run.
// =============================================================================

/** ONE project, TWO tickets, both of which a merged PR would drive to `done`. The
 *  two-PROJECT board above cannot show a finer-than-project filter at all: with one
 *  ticket per project, `--ticket INF-1` and `--project INF` are the same run. */
function twoTicketBoard(tmp) {
  const dir = join(tmp, "repo-INF");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin",
    "https://github.com/hjr15/inf.git"]);

  const root = join(tmp, "board");
  for (const n of [1, 2]) {
    const d = join(root, "projects", "INF", "defined");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `INF-${n}-t.md`),
      `---\nid: INF-${n}\ntype: task\nproject: INF\nestimate: 30\n---\n\nbody\n`);
  }
  const oba = join(root, "projects", "OBA", "defined");
  mkdirSync(oba, { recursive: true });
  writeFileSync(join(oba, "OBA-1-t.md"),
    "---\nid: OBA-1\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");
  writeFileSync(join(root, "projects", "INF", "project.json"),
    JSON.stringify({ key: "INF", codeRepos: [dir] }));
  writeFileSync(join(root, "projects", "OBA", "project.json"),
    JSON.stringify({ key: "OBA", codeRepos: [dir] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF", "OBA"] }));

  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  const pr = (id, n) => ({ number: n, state: "MERGED", url: `https://github.com/hjr15/x/pull/${n}`,
    headRefName: `${id}-work`, title: `${id}: the work` });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n` +
    JSON.stringify([pr("INF-1", 11), pr("INF-2", 12), pr("OBA-1", 22)]) + `\nJSON\n`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  return root;
}

const ticketAt = (root, key, n, status) =>
  existsSync(join(root, "projects", key, status, `${key}-${n}-t.md`));

function runTicketCli(root, tmp, args) {
  return spawnSync(process.execPath,
    [join(import.meta.dirname, "..", "scripts", "reconcile.mjs"), ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${join(tmp, "bin")}:${process.env.PATH}` } });
}

/** Run `fn` with a fresh two-ticket board and its stubbed `gh` on PATH. */
async function withBoard(label, fn) {
  const tmp = mkdtempSync(join(tmpdir(), `blz451-${label}-`));
  const prev = process.env.PATH;
  try {
    const root = twoTicketBoard(tmp);
    process.env.PATH = `${join(tmp, "bin")}:${prev}`;
    return await fn(root, tmp);
  } finally {
    process.env.PATH = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("BLZ-451: --ticket scopes the run finer than --project", () => {
  test("AC-1: a ticket-scoped run moves exactly the ids named, and no sibling in the same project", async () => {
    await withBoard("one", async (root) => {
      const r = await reconcile({ root, dryRun: false, tickets: ["INF-1"] });
      assert.equal(r.ok, true, r.error);
      assert.ok(ticketAt(root, "INF", 1, "done"), "the ticket in scope must reconcile");
      assert.ok(ticketAt(root, "INF", 2, "defined"),
        "its SIBLING IN THE SAME PROJECT must not be touched — this is the whole ticket");
      assert.ok(ticketAt(root, "OBA", 1, "defined"));
      assert.deepEqual(r.changes.map((c) => c.id), ["INF-1"]);
    });
  });

  test("AC-1: more than one id can be named, and it composes with --project", async () => {
    await withBoard("many", async (root) => {
      const r = await reconcile({ root, dryRun: false, projects: ["INF"], tickets: ["INF-1", "INF-2"] });
      assert.equal(r.ok, true, r.error);
      assert.ok(ticketAt(root, "INF", 1, "done"));
      assert.ok(ticketAt(root, "INF", 2, "done"));
      assert.ok(ticketAt(root, "OBA", 1, "defined"));
      assert.deepEqual(r.changes.map((c) => c.id).sort(), ["INF-1", "INF-2"]);
    });
  });

  test("AC-4: the result and the report both say what was scoped to", async () => {
    await withBoard("says", async (root, tmp) => {
      const r = await reconcile({ root, dryRun: true, tickets: ["INF-1"] });
      assert.deepEqual(r.scopedTickets, ["INF-1"]);
      // ...and an UNFILTERED run says `null`, so a consumer can tell the two apart from
      // the field alone — the BLZ-394 AC-5 lesson, which an empty array would lose.
      const wide = await reconcile({ root, dryRun: true });
      assert.equal(wide.scopedTickets, null);
      const res = runTicketCli(root, tmp, ["--ticket", "INF-1"]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /scoped to ticket\(s\): INF-1/);
    });
  });

  test("AC-4: --quiet does not hide the ticket scope", async () => {
    // Same rule as `--project`: `--quiet` means "print only on change", and a narrowed
    // scope is precisely a reason not to trust the ABSENCE of one.
    await withBoard("quiet", async (root, tmp) => {
      const res = runTicketCli(root, tmp, ["--ticket", "INF-1", "--quiet"]);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /scoped to ticket\(s\): INF-1/);
    });
  });

  test("AC-5: a scoped --apply commit files only the ticket the pass decided", async () => {
    await withBoard("commit", async (root, tmp) => {
      execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
      execFileSync("git", ["-C", root, "config", "user.name", "t"]);
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed board"]);
      const res = runTicketCli(root, tmp, ["--ticket", "INF-1", "--apply"]);
      assert.equal(res.status, 0, res.stderr + res.stdout);
      const files = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"],
        { encoding: "utf8" }).split("\n").filter(Boolean);
      assert.ok(files.every((f) => f.includes("INF-1")),
        `the commit filed something outside the scope: ${files.join(", ")}`);
      assert.ok(ticketAt(root, "INF", 2, "defined"));
    });
  });

  test("the CLI accepts a repeated flag, a comma-separated list and the `=` form alike", async () => {
    await withBoard("spelling", async (root, tmp) => {
      for (const args of [["--ticket", "INF-1"], ["--ticket=INF-1"],
                          ["--ticket", "INF-1,INF-2"], ["--ticket", "INF-1", "--ticket", "INF-2"]]) {
        const res = runTicketCli(root, tmp, args);
        assert.equal(res.status, 0, `${args.join(" ")}: ${res.stderr}`);
        assert.match(res.stderr, /scoped to ticket\(s\):/, args.join(" "));
        assert.match(res.stderr, /INF-1/, args.join(" "));
      }
    });
  });
});

describe("BLZ-451: a --ticket that yields no usable id REFUSES, it does not go wide", () => {
  // BLZ-394's failure, which this filter must not reintroduce. Every one of these was a
  // silent whole-board reconcile the first time round.
  for (const args of [["--ticket="], ["--ticket=,,"], ["--ticket", ","], ["--ticket", ",,"],
                      ["--ticket", " "], ["--ticket", ""]]) {
    test(`\`${args.join(" ")}\` is refused, not treated as unfiltered`, async () => {
      await withBoard("empty", async (root, tmp) => {
        const res = runTicketCli(root, tmp, [...args, "--apply"]);
        assert.notEqual(res.status, 0,
          "an empty --ticket must not silently reconcile every ticket on the board");
        assert.match(res.stderr, /--ticket/);
        assert.ok(ticketAt(root, "INF", 1, "defined"), "and must write nothing at all");
        assert.ok(ticketAt(root, "INF", 2, "defined"));
        assert.ok(ticketAt(root, "OBA", 1, "defined"));
      });
    });
  }

  test("--ticket with no value is refused BY NAME, not read as the next flag", async () => {
    // The OUTCOME here is over-determined and this test says so: with the CLI's own guard
    // removed, `--ticket --apply` still refuses, because `--apply` is not a ticket id and
    // the library's malformed check catches it. A mutation run proved exactly that — the
    // guard survived a test asserting only `status !== 0` and `/--ticket/`.
    //
    // So what is pinned is the one thing the guard alone produces: a refusal that names
    // the TYPO rather than reporting "--apply" as a malformed ticket id, which sends the
    // reader hunting for a ticket. Assert the wording, or do not claim the line is pinned.
    await withBoard("noval", async (root, tmp) => {
      const res = runTicketCli(root, tmp, ["--ticket", "--apply"]);
      assert.notEqual(res.status, 0,
        "`--ticket --apply` must not scope the run to a ticket named '--apply'");
      assert.match(res.stderr, /--ticket needs a ticket id/,
        "the missing-value refusal must name the missing value, not blame the next flag");
      assert.doesNotMatch(res.stderr, /not ticket ids/,
        "the malformed-id refusal is the WRONG diagnosis for a missing value");
      assert.ok(ticketAt(root, "INF", 1, "defined"));
    });
    // ...and the same for the last-argument case, where there is no next flag at all.
    await withBoard("noval-tail", async (root, tmp) => {
      const res = runTicketCli(root, tmp, ["--ticket"]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /--ticket needs a ticket id/);
    });
  });

  test("the library refuses an empty list directly, too", async () => {
    await withBoard("emptylib", async (root) => {
      const r = await reconcile({ root, dryRun: false, commit: true, tickets: [] });
      assert.equal(r.ok, false);
      assert.match(r.error, /--ticket/);
      assert.equal(r.scopedTickets, null, "a refusal scoped to nothing, not to everything");
      assert.ok(ticketAt(root, "INF", 1, "defined"));
      assert.ok(ticketAt(root, "INF", 2, "defined"));
    });
  });

  test("AC-2: a MALFORMED id is refused — it is not a ticket id, so it cannot scope anything", async () => {
    // A value that is not `<KEY>-<n>` cannot match any ticket, so accepting it would
    // reconcile NOTHING while reporting a clean run — indistinguishable from an in-sync
    // board, the INF-763 lesson this file already applies to `--project`.
    await withBoard("malformed", async (root) => {
      for (const bad of ["INF", "1", "INF-", "-1", "INF-1x", "INF 1", "inf-1x", "INF-01a"]) {
        const r = await reconcile({ root, dryRun: false, tickets: [bad] });
        assert.equal(r.ok, false, `${bad} must be refused`);
        assert.match(r.error, /--ticket/, bad);
        assert.match(r.error, /INF-1|malformed|not a ticket id/i, bad);
      }
      assert.ok(ticketAt(root, "INF", 1, "defined"), "nothing may be written by a refused run");
    });
  });

  test("AC-3: an id OUTSIDE the run's projects is refused, not silently ignored", async () => {
    await withBoard("outside", async (root) => {
      // Out by --project scope: OBA is configured, but this run is scoped to INF.
      const scoped = await reconcile({ root, dryRun: false, projects: ["INF"], tickets: ["OBA-1"] });
      assert.equal(scoped.ok, false);
      assert.match(scoped.error, /OBA-1/);
      assert.match(scoped.error, /INF/, "the refusal must name the projects the run covers");
      // Out by the BOARD's own configuration: no such project key at all.
      const unknown = await reconcile({ root, dryRun: false, tickets: ["ZZZ-1"] });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error, /ZZZ-1/);
      assert.ok(ticketAt(root, "OBA", 1, "defined"));
      assert.ok(ticketAt(root, "INF", 1, "defined"));
    });
  });

  test("AC-3: an id naming NO ticket on the board is refused, not a clean empty run", async () => {
    // The typo case. `--ticket INF-9999` that quietly reconciles nothing is
    // indistinguishable from an in-sync board — the same reason `--project NOPE` refuses.
    await withBoard("nosuch", async (root) => {
      const r = await reconcile({ root, dryRun: true, tickets: ["INF-9999"] });
      assert.equal(r.ok, false);
      assert.match(r.error, /INF-9999/);
      // ...and a mix of one good and one bad id still refuses the WHOLE run: a partial
      // run writes half of what its caller asked for while reporting failure.
      const mixed = await reconcile({ root, dryRun: false, tickets: ["INF-1", "INF-9999"] });
      assert.equal(mixed.ok, false);
      assert.ok(ticketAt(root, "INF", 1, "defined"), "no partial application");
    });
  });
});

// =============================================================================
// BLZ-486 — the exception is one KIND, not the whole channel.
//
// `exceptFindings` stripped every `reconcile: NEEDS ATTENTION` line before asserting that a
// scoped run never names an out-of-scope project, while the rationale beside it covers only
// BLZ-406's unconditional `project-mismatch`. Measured on the parent commit, reconcile could
// raise five kinds on that channel; four of them were therefore invisible to the BLZ-394
// scope-leak assertions, so a key leaking through any of them went uncaught.
//
// This suite is what stops that returning. It reads the kind roster from the source, so a
// sixth kind cannot be added without someone deciding what the filter does with it.
// =============================================================================

describe("BLZ-486: only the project-mismatch finding is excepted from the scope-leak assertions", () => {
  test("the kind roster is read from reconcile.mjs and is not empty", () => {
    // An extractor that silently stops matching would make every assertion below vacuous —
    // the same "prints a count it never asserts" failure the oracles were built against.
    assert.ok(RECONCILE_FINDING_KINDS.length >= 6,
      `expected at least six finding kinds in reconcile.mjs; got ${JSON.stringify(RECONCILE_FINDING_KINDS)}`);
    assert.ok(RECONCILE_FINDING_KINDS.includes("project-mismatch"));
    assert.deepEqual([...new Set(RECONCILE_FINDING_KINDS)].sort(), [
      "ambiguous-deliverer",
      "merged-pr-title-claims-nothing",
      "open-pr-on-terminal",
      "project-mismatch",
      "terminal-record-unverifiable",
      "unreadable-ticket-directory",
    ], "a new finding kind must be classified here deliberately, not inherited silently");
  });

  test("a leak through any OTHER kind survives the filter — one line per kind, all still visible", () => {
    // The heart of the ticket. Each of these is a real `NEEDS ATTENTION` line carrying an
    // out-of-scope key; only the project-mismatch one may be removed.
    const lines = {
      "project-mismatch":
        "reconcile: NEEDS ATTENTION — INF-2 sits under projects/OBA/ but its frontmatter names project: INF.",
      "ambiguous-deliverer":
        "reconcile: NEEDS ATTENTION — OBA-1 has 2 merged PRs claiming it (the pull request #10 — u10), and none claims it more strongly than the rest.",
      "terminal-record-unverifiable":
        "reconcile: NEEDS ATTENTION — OBA-1 is done and already holds a delivery record (#7 — u7), but git now shows 2 merged PRs tied for having delivered it.",
      "merged-pr-title-claims-nothing":
        "reconcile: NEEDS ATTENTION — OBA-1 is defined and the pull request #10 is MERGED on a branch that derives its id (OBA-1-work), but its TITLE does not claim it.",
      "open-pr-on-terminal":
        "reconcile: NEEDS ATTENTION — OBA-1 is done, but the pull request #10 carrying its key is still OPEN.",
      "unreadable-ticket-directory":
        "reconcile: NEEDS ATTENTION — projects/OBA/defined was NOT read: it holds a ZERO-BYTE `.git` file.",
    };
    assert.deepEqual(Object.keys(lines).sort(), [...new Set(RECONCILE_FINDING_KINDS)].sort(),
      "every kind reconcile can raise needs a line here, or this test is blind on the new one");

    const kept = exceptProjectMismatch(Object.values(lines).join("\n")).split("\n").filter(Boolean);
    assert.equal(kept.length, Object.keys(lines).length - 1,
      "exactly one line — the project-mismatch one — may be removed");
    assert.ok(!kept.some((l) => l.includes("sits under projects/")));
    for (const [kind, line] of Object.entries(lines)) {
      if (kind === "project-mismatch") continue;
      assert.ok(kept.includes(line),
        `a leak through ${kind} must survive the filter, or the scope-leak assertion is blind on it`);
      assert.match(exceptProjectMismatch(line), /OBA/,
        `…and must still carry the out-of-scope key that the assertion greps for (${kind})`);
    }
  });

  test("the filter removes the project-mismatch line and nothing that merely resembles it", () => {
    const other = "reconcile: NEEDS ATTENTION — OBA-9 sits in projects/OBA/ with no record";
    assert.equal(exceptProjectMismatch(other), other,
      "only the sentence BLZ-406 actually emits is excepted");
    assert.equal(exceptProjectMismatch("reconcile: WARNING — codeRepo not found, skipped: /x/OBA"),
      "reconcile: WARNING — codeRepo not found, skipped: /x/OBA",
      "and no other channel is touched — WARNING, FORGE and GIT lines all stay asserted");
  });
});
