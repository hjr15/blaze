// tests/reconcile-unfinished-pass.test.mjs — BLZ-404, round-5 adversarial review.
//
// Round 2 shipped `dirtyTicketPaths`: a recovery WRITE that reused `git status
// --porcelain` output to finish a previous pass's uncommitted commit. Round 3 deleted
// that write and replaced it with `hasUncommittedTicketChanges` / `dirtyTicketTree`: a
// BOOLEAN detect-and-report. Round 4's adversarial review refuted the boolean too — it
// conflates three distinct board states and asserts the wrong one:
//   1. a previous pass genuinely failed to commit (the only state it was meant to catch);
//   2. a `commitMode: "batch"` board that queued a change BY DESIGN — healthy, but the
//      very next run falsely blamed "a previous pass wrote ticket files and failed to
//      commit them" and exited 1;
//   3. a human's own untracked file under `projects/<KEY>/` (a draft, a swapfile) —
//      healthy, but it wedges `blaze reconcile` at exit 1 permanently, and the remedy it
//      prints (`blaze commit`) is a no-op.
// It also UNDER-fired on the case it was written to close: with `projects/` a symlink,
// `git status --porcelain` through the symlinked path exits 0 printing nothing, so the
// detector reports a clean board over a genuinely dirty one, forever.
//
// There is no version of this that works from the tree alone: telling "a previous pass
// of MINE failed to commit" apart from "this tree is dirty for a reason I neither caused
// nor can see" needs the pending ledger, not `git status`. That is a real feature with its
// own ticket and its own design — it is not built here. `hasUncommittedTicketChanges`,
// `dirtyTicketTree`, and every branch that read them are DELETED. What remains is the
// actual defect underneath all four rounds: the CLI's "already in sync — nothing to do."
// asserted more than reconcile knows. Reconcile knows one thing — whether THIS pass found
// any code-bound change to make — and says exactly that now, nothing about the state of
// the git tree.
//
// BLZ-254: the round-2/round-5 describes are deleted — they pinned reconcile's commit
// outcomes (locked, failed, queued), and reconcile no longer commits. The --project
// blast-radius describe is kept; its HEAD clauses now read "reconcile made no commit at all".
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const RECONCILE_BIN = join(import.meta.dirname, "..", "scripts", "reconcile.mjs");

function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

function headSha(dir) {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function porcelain(root, ...pathspec) {
  return execFileSync("git", ["-C", root, "status", "--porcelain", "--", ...pathspec], { encoding: "utf8" }).trim();
}

/** A board with ONE ticket that a real `<KEY>-<n>:` commit on the code repo's default
 *  branch drives from `defined` straight to `done` — copied from
 *  tests/reconcile-commit-routing.test.mjs's `movableBoard` (that file is deleted, BLZ-254). */
function movableBoard(tmp, cfgExtra = {}) {
  const repo = join(tmp, "code");
  mkdirSync(repo, { recursive: true });
  gitInit(repo);
  writeFileSync(join(repo, "README.md"), "x\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "OBA-1: shipped work"]);

  const root = join(tmp, "board");
  const projects = join(root, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "OBA", projects: ["OBA"], ...cfgExtra }));
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", codeRepos: [repo] }));
  writeFileSync(join(projects, "OBA", "defined", "OBA-1.md"),
    "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");

  gitInit(root);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed board"]);
  return { root, repo };
}

// BLZ-406: `project-mismatch` deliberately NARROWS the invariant this describe block
// pins. It is raised from the FULL ticket walk — before the `--project` scope guard,
// unconditionally, on every run mode (see reconcile.mjs) — precisely so a ticket no
// single-project run can ever reconcile is still reported, not silently dropped. That
// means an out-of-scope ticket CAN legitimately be named on a scoped run: through its
// own project-mismatch finding, and nowhere else. `stripProjectMismatchLines` carves
// those lines out before checking for a scope leak anywhere else in the report, so the
// blanket "never mention it" claim below is checked in the one place it still holds.
function stripProjectMismatchLines(output) {
  return output.split("\n")
    .filter((l) => !(l.includes("NEEDS ATTENTION") && l.includes("no single-project run")))
    .join("\n");
}

describe("BLZ-404 round 3/4/5 (finding 4): --project blast radius covers the REPORT, not just the write", () => {
  test("an in-sync OBA plus a dirty ORC ticket — --project OBA --apply leaves projects/ORC untouched, uncommitted, and unreported", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404r5-blast-"));
    try {
      const { root } = movableBoard(tmp);

      // Bring OBA to a genuinely in-sync, fully-committed state first.
      const seed = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(seed.status, 0, `test setup: the seeding pass must succeed: ${seed.stderr}`);
      // BLZ-254: reconcile no longer commits — in fs mode the operator versions the files.
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "operator commits the seed pass"]);
      assert.equal(porcelain(root), "", "test setup: OBA must be fully in sync before ORC is added");

      // Add a second project, ORC, with no code-repo signal, so it never has a move of
      // its own to propose.
      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "OBA", projects: ["OBA", "ORC"] }));
      mkdirSync(join(root, "projects", "ORC", "defined"), { recursive: true });
      writeFileSync(join(root, "projects", "ORC", "project.json"), JSON.stringify({ key: "ORC", codeRepos: [] }));
      writeFileSync(join(root, "projects", "ORC", "defined", "ORC-1.md"),
        "---\nid: ORC-1\ntitle: t\ntype: task\nproject: ORC\nestimate: 30\n---\n\nbody\n");
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "add ORC"]);

      // Leave ORC-1 dirty (uncommitted) on disk — a stand-in for a previous pass's
      // unfinished write, or simply a human editing it.
      writeFileSync(join(root, "projects", "ORC", "defined", "ORC-1.md"),
        "---\nid: ORC-1\ntitle: t2\ntype: task\nproject: ORC\nestimate: 30\n---\n\nedited\n");
      const orcDirtyBefore = porcelain(root, join(root, "projects", "ORC"));
      assert.notEqual(orcDirtyBefore, "", "test setup: ORC-1 must be genuinely dirty");
      const before = headSha(root);

      const res = spawnSync(process.execPath, [RECONCILE_BIN, "--project", "OBA", "--apply"],
        { cwd: root, encoding: "utf8" });

      // BLZ-431: THE RUN RESULT, no longer voided. The report half below is a
      // `doesNotMatch`, and a `doesNotMatch` is satisfied by silence — so until this
      // ticket the test could not tell "the run reported nothing about ORC" from "the
      // run did not report at all". Measured: with a `process.exit(1)` inserted ahead of
      // every line of output whenever `--project` is passed, this named test stayed
      // GREEN. The write half survives that mutation for its own reason (a run that
      // never starts also never commits), which is exactly why the finding said it kills
      // an unscoped WRITE but not an unscoped REPORT.
      //
      // Three clauses, in the order that makes the fourth meaningful: the run succeeded,
      // it produced a report at all, and that report is about the project it was scoped
      // to. Only then does "and it never mentions ORC" carry any weight.
      assert.equal(res.status, 0,
        `--project OBA --apply must succeed, it exited ${res.status} — stdout:\n${res.stdout}\n` +
        `stderr:\n${res.stderr}`);
      const report = res.stdout + res.stderr;
      assert.notEqual(report.trim(), "",
        "--project OBA --apply printed nothing at all — an empty report trivially satisfies " +
        "the out-of-scope silence clause below without proving any scoping happened");
      assert.match(report, /scanned project\(s\): OBA\b/,
        "--project OBA --apply must state the scope it actually looked at, so the silence " +
        `about ORC below is a scoped report rather than an absent one — got:\n${report}`);

      // The WRITE half (kills an unscoped commit that touches ORC's file).
      assert.equal(headSha(root), before, "reconcile made no commit at all (BLZ-254) — so none can touch ORC's file");
      assert.equal(porcelain(root, join(root, "projects", "ORC")), orcDirtyBefore,
        "projects/ORC must be left byte-for-byte as dirty as it started — --project OBA must never see it");

      // The REPORT half (finding 4): a run scoped to OBA must never NAME ORC either, on
      // stdout or stderr, even though it changed nothing there — OUTSIDE of its own
      // project-mismatch finding (BLZ-406), which is deliberately unscoped and is not
      // this scenario: ORC-1's frontmatter names project: ORC, matching its directory,
      // so no mismatch is ever raised for it here and the blanket check below holds
      // without needing to strip anything. `scannedProjects`/`missingRepos`/`forgeErrors`
      // and every OTHER kind of finding are still built from `sig`, which is populated
      // only from `keys` (the `--project` filter); `project-mismatch` alone is not, and
      // the second test below pins that it is the ONLY channel through which a scoped
      // run may name an out-of-scope ticket. The assertion here was previously entirely
      // absent (`void res;`), so a future regression that adds an unscoped report (not
      // just an unscoped write) would have gone undetected. This closes that gap; see the
      // PR body for why deleting the cross-pass detector removes no coverage here (it was
      // already scoped by `keys`, same as everything else).
      assert.doesNotMatch(stripProjectMismatchLines(res.stdout + res.stderr), /ORC/,
        "a run scoped to --project OBA must not mention ORC anywhere in its report, outside " +
        "its own project-mismatch finding");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a misfiled ORC-1 (dir ORC, frontmatter project: OBA) — --project OBA --apply names it ONLY via its project-mismatch finding, never elsewhere", () => {
    // BLZ-406's second, previously-missing case: the ticket the invariant above CANNOT
    // stay silent about. Unlike the sibling test's ORC-1 (frontmatter matches directory,
    // so no finding fires and out-of-scope silence is the whole story), this one IS
    // project-mismatched — the exact condition BLZ-406 exists to surface even on a
    // single-project run — so the assertion here is the mirror: the finding line MUST
    // name ORC-1, and nothing else in the report may.
    const tmp = mkdtempSync(join(tmpdir(), "blz406-mismatch-scoped-"));
    try {
      const { root } = movableBoard(tmp);

      // Bring OBA to a genuinely in-sync, fully-committed state first.
      const seed = spawnSync(process.execPath, [RECONCILE_BIN, "--apply"], { cwd: root, encoding: "utf8" });
      assert.equal(seed.status, 0, `test setup: the seeding pass must succeed: ${seed.stderr}`);
      // BLZ-254: reconcile no longer commits — in fs mode the operator versions the files.
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "operator commits the seed pass"]);
      assert.equal(porcelain(root), "", "test setup: OBA must be fully in sync before ORC is added");

      writeFileSync(join(root, "blaze.config.json"),
        JSON.stringify({ key: "OBA", projects: ["OBA", "ORC"] }));
      mkdirSync(join(root, "projects", "ORC", "defined"), { recursive: true });
      writeFileSync(join(root, "projects", "ORC", "project.json"), JSON.stringify({ key: "ORC", codeRepos: [] }));
      // Directory ORC, frontmatter claims OBA — a project-mismatch, not merely a ticket
      // out of --project OBA's scope.
      writeFileSync(join(root, "projects", "ORC", "defined", "ORC-1.md"),
        "---\nid: ORC-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\n\nbody\n");
      execFileSync("git", ["-C", root, "add", "-A"]);
      execFileSync("git", ["-C", root, "commit", "-q", "-m", "add misfiled ORC-1"]);
      const before = headSha(root);

      const res = spawnSync(process.execPath, [RECONCILE_BIN, "--project", "OBA", "--apply"],
        { cwd: root, encoding: "utf8" });

      assert.equal(res.status, 0, `--project OBA --apply must still succeed: ${res.stderr}`);
      // BLZ-431, the sibling half: this test already read the run's status, and its
      // mismatch clause below is a positive `assert.ok`, so an absent report fails it.
      // The scope line is pinned here anyway so both tests state the same premise.
      assert.match(res.stdout + res.stderr, /scanned project\(s\): OBA\b/,
        "--project OBA --apply must state the scope it actually looked at");
      assert.equal(headSha(root), before, "reconcile made no commit at all (BLZ-254) — so none can touch ORC-1's file");

      const mismatchLine = res.stderr.split("\n")
        .find((l) => l.includes("NEEDS ATTENTION") && l.includes("ORC-1"));
      assert.ok(mismatchLine,
        `--project OBA must still report ORC-1's project-mismatch — stderr:\n${res.stderr}`);
      assert.match(mismatchLine, /no single-project run/,
        "the finding must say no single-project run reconciles it");

      assert.doesNotMatch(stripProjectMismatchLines(res.stdout + res.stderr), /ORC/,
        "outside its own project-mismatch finding, --project OBA must not name ORC-1 or " +
        "projects/ORC anywhere in its report");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// BLZ-254: moved here from tests/reconcile-commit-routing.test.mjs when that file was deleted
// (every other test in it pinned how reconcile routed its commit). This one pins surviving
// behaviour — assertWritable is hoisted above the write port — so it is kept, minus its
// `commit: true` argument and its `committed` clause.
describe("BLZ-404 (review finding 1): assertWritable is hoisted before the write port", () => {
  test("BLAZE_READONLY refuses before any ticket file is written — no dirty-tree-then-decline", async () => {
    const { reconcile } = await import("../scripts/reconcile.mjs");
    const tmp = mkdtempSync(join(tmpdir(), "blz404-readonly-"));
    const prevReadonly = process.env.BLAZE_READONLY;
    try {
      const { root } = movableBoard(tmp);
      const ticket = join(root, "projects", "OBA", "defined", "OBA-1.md");
      const beforeText = readFileSync(ticket, "utf8");
      process.env.BLAZE_READONLY = "1";
      const r = await reconcile({ fetch: false, dryRun: false, root });
      assert.equal(r.ok, false);
      assert.match(r.error, /read-only mode/i);
      // The file must be BYTE-IDENTICAL, not merely "still present" — a refusal that
      // wrote the file first is the exact "dirty-tree failure, not a clean refusal"
      // hazard this hoisted check exists to avoid.
      assert.equal(readFileSync(ticket, "utf8"), beforeText,
        "BLAZE_READONLY must refuse BEFORE the write port touches any file");
    } finally {
      if (prevReadonly === undefined) delete process.env.BLAZE_READONLY; else process.env.BLAZE_READONLY = prevReadonly;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
