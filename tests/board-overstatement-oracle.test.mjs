// tests/board-overstatement-oracle.test.mjs — BLZ-426 + BLZ-422 (+ BLZ-427, retired by BLZ-254).
//
// THE ASSERTION: every sentence the board says about a reconcile pass is true of the
// filesystem and of `git log`. Two surfaces say those sentences and both could overstate:
//
//   BLZ-426  the dashboard's reconcile button rendered a REFUSED preview as
//            "no code-bound changes" — an in-sync board that is not in sync, it
//            just never ran.
//   BLZ-422  the `reconcile --apply` CLI claimed a commit that `git log` did not hold
//            (`commitFile`'s benign empty-diff no-op, deleted by BLZ-254, read as "committed"). Since BLZ-254
//            the claim it must not make is ANY commit: the CLI's applied line and HEAD
//            are checked against each other on every cell.
//
// BLZ-254 (spec §5.5): reconcile stopped committing, and `blaze commit` was deleted. The
// commit-outcome dimension (committed / no-op / queued / locked / failed) went with them,
// and so did consumers 3 (`commitOutcomeFrom` + `applySummary`, deleted by BLZ-254) and 4 (`blaze commit`'s
// subject, BLZ-427), whose modules no longer exist. What is left to vary is whether the
// board has already been applied once (first-apply / second-apply).
//
// GROUND TRUTH IS NEVER THE SUBJECT UNDER TEST. Every number this file checks comes
// from one of exactly three independent sources, and none of them is a return value
// of the thing being asserted about:
//   (1) the FILESYSTEM — a before/after snapshot of the ticket tree, where the
//       status IS the directory, taken around a real `--apply` pass on a pristine
//       copy of the same fixture;
//   (2) `git log` / `git rev-parse HEAD` — that no commit exists (BLZ-254);
//   (4) the FIXTURE SPEC — which conditions this board was built to contain (a
//       misfiled ticket, a failing `gh`). Presence/absence only, never a count, so
//       the oracle cannot bless the subject's own arithmetic.
//   (Source (3), the pending-ledger file, was deleted with the ledger — BLZ-254. The
//   numbering is kept so the "(4) fixture spec" references below still resolve.)
// BLZ-423 and BLZ-431 are open tickets for oracles that read their subject for
// ground truth. This is not a third.
//
// THE CROSS-PRODUCT, generated (not a hand-written list):
//   preview shape ∈ refused-unknown-project / refused-no-key / clean / moves-only /
//                   cleared / findings / forge-error / forge-error-clean /
//                   non-moving-update                                         (9)
//   run ∈ first-apply / second-apply                                          (2)
//   consumer ∈ dashboard-toast / reconcile-cli                                (2)
// = 9 × 2 × 2 = 36 cells. The size is ASSERTED, not merely printed: deleting a
// dimension must fail this file rather than silently shrink it. So is the CLAUSE count,
// and as of BLZ-444/BLZ-452 it is DERIVED from the cross-product's own shape and checked
// PER CELL — see `budgetFor`. (The same hole in three sibling oracles was BLZ-415,
// BLZ-420 and BLZ-437, closed in the same change.)
//
// REACHABILITY, stated plainly rather than implied (work order §3):
//   - The two REFUSAL shapes require `projects !== null`, and serve.mjs's
//     `/api/reconcile-preview` route never passes one. Through the ROUTE they are
//     unreachable today; they are reachable through `reconcile` the CLI
//     (`--project NOPE`, `--project=`), which this file drives. For THOSE TWO BODIES
//     the dashboard half is a CONTRACT gap, tested as one — the same precedent
//     tests/reconcile-preview-refusal.test.mjs set for BLZ-405, and for the same
//     reason: adding a `?project=` query-string surface to make it reachable would
//     ship a per-project preview, a real feature and a different ticket's scope.
//   - BLZ-446 CORRECTS THE SENTENCE THAT USED TO STOP THERE. "Contract-only" was true
//     of the two `projects`-gated refusals and FALSE of the branch as a whole. The
//     toast's `ok !== true` arm is also taken for any non-`{ok:true}` body the route
//     can return today, with no code change and nothing to do with `projects`: a 401
//     from `gate()` (no credential, or an expired/revoked/unknown bearer token, on any
//     board with users configured), a 503 when the gate itself throws or before
//     first-run setup completes, a 500 `{errors:[…]}`, a reverse proxy's error page.
//     Under the pre-BLZ-426 inline code every one of those left `j.changes` undefined,
//     so `moves` was 0 and the toast read "no code-bound changes" ON AN AUTH FAILURE.
//     That was a live production bug, not a contract gap. The named test at the foot of
//     this file drives the REAL server and proves those bodies reach the REAL toast.
//   - BLZ-254: the bullet that stood here explained why `commitFile`'s empty-diff no-op
//     was unreachable through reconcile and pinned at consumer 3. Both are deleted.
//   - BLZ-468: FOUR SHAPES CARRY THEIR WHOLE DELIVERY SIGNAL IN THE `gh` STUB —
//     `moves-only`, `cleared`, `findings`, `non-moving-update` all plant merged PRs and
//     nothing else, so a single transient failure of that spawned process makes the pass
//     legitimately decide nothing and exit ZERO. That is the mechanism
//     behind this file's recorded `executed 678 clauses, expected 682` flake, reproduced
//     deterministically; it is checked in the reconcile-cli consumer, beside the clause.
//     BLZ-445: because of that, the `second-apply` run (the `no-op` column before
//     BLZ-254) has its own arm at the reconcile-cli consumer: a SECOND apply pass with
//     nothing left to decide.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { reconcilePreview } from "../scripts/serve.mjs";
import { pageHtml } from "../scripts/views/page.mjs";
import { reconcileSummary, SUMMARY_FN_BEGIN, SUMMARY_FN_END } from "../scripts/views/reconcile-summary.mjs";
import { isDeepStrictEqual } from "node:util";

// =============================================================================
// BLZ-414 round 2: THE COUNTER IS THE ASSERTION, not a line written beside it.
//
// The per-cell budget below is only evidence if a clause cannot be counted without
// being checked. It was not: every count was a hand-written `clauses += 1` sitting
// NEXT TO its assertion, and review measured the consequence — deleting BLZ-427's core
// assertion ("the subject says N but M ticket(s) really changed") while leaving its
// increment left this file 41/41 green at exactly 734 clauses. A budget that a deleted
// assertion still satisfies proves nothing about that cell, which is this lane's own
// thesis failing in this lane's own file.
//
// These wrappers — `eq`, `ok`, `matches`, `notMatches`, `deepEq`, all five of them — are
// now the ONLY way the counter moves. The binding was first used in
// `tests/schema-audit-load-agreement-oracle.test.mjs` (`check()`/`sameSet()`) and is now
// shared by `tests/reconcile-change-report-oracle.test.mjs` and
// `tests/reconcile-feed-truth-oracle.test.mjs` as well. Deleting a clause deletes its
// count with it, so the cell's own budget assertion names it.
//
// BLZ-483: THE INVENTORY BELOW USED TO BE SHORT BY A WHOLE CATEGORY, which is the same
// defect in miniature that this file exists to catch. The bare `assert.` calls that
// remain are deliberately NOT clauses, and they are of THREE kinds, not two:
//   1. fixture preconditions — the ground-truth apply run exited 0, the competing lock
//      was really taken;
//   2. meta-assertions about the counting itself — `assertCellBudget`, the three
//      dimension sizes, `CELLS.length`, `cellsEvaluated`, and the grand total;
//   3. every assertion in the second top-level test in this file, `BLZ-446: a REACHABLE
//      non-ok body …`. Those are real oracle clauses, but they are not cells of the
//      cross-product and must not move its budget — that test says so at its own head.
//
// THE BINDING IS ONE-DIRECTIONAL, and saying otherwise would be the exact defect this
// oracle exists to catch. A DELETED clause is caught: its count goes with it and the
// cell's budget names the gap. An ADDED clause written as a bare `assert.` is NOT
// caught — it is simply uncounted, and the file stays green. Verified: a real bare
// `assert.` oracle clause added inside the reconcile-cli cell left the file 41/41.
// So: write new clauses through the wrappers. Nothing here will remind you.
// =============================================================================
let clauses = 0;
const eq = (a, b, msg) => { clauses += 1; assert.equal(a, b, msg); };
const ok = (c, msg) => { clauses += 1; assert.ok(c, msg); };
const matches = (s, re, msg) => { clauses += 1; assert.match(s, re, msg); };
const notMatches = (s, re, msg) => { clauses += 1; assert.doesNotMatch(s, re, msg); };
const deepEq = (a, b, msg) => { clauses += 1; assert.deepEqual(a, b, msg); };

const RECONCILE_BIN = join(import.meta.dirname, "..", "scripts", "reconcile.mjs");

// =============================================================================
// The three dimensions
// =============================================================================

// `plant` names the condition the board is BUILT to contain; `expectFindings` and
// `expectForge` are the fixture's own statement of what it planted (source (4)) —
// presence/absence only. Counts always come from the filesystem or `git log`.
// `moves`/`other` are the fixture's own statement of WHETHER an apply pass changes
// anything on this board — presence/absence, never a count, exactly like `expectFindings`
// and `expectForge` (ground-truth source (4)). BLZ-452: they are what the clause budget
// below is derived from, and they are themselves checked against the filesystem
// measurement, so the budget never depends on which branches the data happened to take.
const SHAPES = [
  { name: "refused-unknown-project", plant: "merged", cliArgs: ["--project", "NOPE"],
    projects: ["NOPE"], refused: true, expectFindings: false, expectForge: false, ghFails: false },
  { name: "refused-no-key", plant: "merged", cliArgs: ["--project="],
    projects: [], refused: true, expectFindings: false, expectForge: false, ghFails: false },
  { name: "clean", plant: "none", cliArgs: [], moves: false, other: false,
    projects: null, refused: false, expectFindings: false, expectForge: false, ghFails: false },
  { name: "moves-only", plant: "merged", cliArgs: [], moves: true, other: false,
    projects: null, refused: false, expectFindings: false, expectForge: false, ghFails: false },
  { name: "cleared", plant: "ambiguous", cliArgs: [], moves: true, other: false,
    projects: null, refused: false, expectFindings: true, expectForge: false, ghFails: false },
  { name: "findings", plant: "misfiled", cliArgs: [], moves: true, other: false,
    projects: null, refused: false, expectFindings: true, expectForge: false, ghFails: false },
  { name: "forge-error", plant: "shipped", cliArgs: [], moves: true, other: false,
    projects: null, refused: false, expectFindings: false, expectForge: true, ghFails: true },
  // BLZ-450: the combination the cross-product did not contain. `forge-error` above has
  // `moves: true`, so the toast always had a move count to report and the ZERO-DECIDABLE-
  // CHANGE-plus-degraded-forge cell was never generated — which is why the oracle passed
  // while the toast composed "no code-bound changes · 1 forge problem(s)": an in-sync
  // claim in the same sentence as "the check was degraded". Same plant as `clean` (one
  // `defined` ticket, no signal at all), same `gh` that exits 1 as `forge-error`.
  { name: "forge-error-clean", plant: "none", cliArgs: [], moves: false, other: false,
    projects: null, refused: false, expectFindings: false, expectForge: true, ghFails: true },
  // A change that is NOT a move: a terminal ticket with a blank resolution and a
  // merged PR gets its resolution backfilled and its delivery record filled in
  // place. `changes` carries it, the directory does not change — which is exactly
  // the entry the toast used to count as a "code-bound move".
  { name: "non-moving-update", plant: "backfill", cliArgs: [], moves: false, other: true,
    projects: null, refused: false, expectFindings: false, expectForge: false, ghFails: false },
];

/** Does an apply pass change ANYTHING on this board? Declared, not measured. */
const shapeChanges = (shape) => Boolean(shape.moves || shape.other);

// BLZ-254 (spec §5.5): reconcile no longer commits, so the five commit outcomes this
// dimension used to range over (committed / no-op / queued / locked / failed) are gone.
// What still distinguishes two runs of `--apply` is whether the board has ALREADY been
// applied: a first pass writes what it decides, a second pass on the same tree has
// nothing left to decide (BLZ-445's reachable "nothing happened", kept).
const RUNS = ["first-apply", "second-apply"];

// BLZ-254: consumers 3 (commitOutcomeFrom + applySummary) and 4 (`blaze commit`'s subject) are
// deleted with the modules they pinned.
const CONSUMERS = ["dashboard-toast", "reconcile-cli"];

// =============================================================================
// THE CLAUSE BUDGET — DERIVED, NOT OBSERVED (BLZ-444), AND PER-CELL (BLZ-452)
//
// This used to be `const EXPECTED_CLAUSES = 682`, read off a passing run and pinned. It
// discriminated — deleting a dimension failed it — but a reviewer could only check that
// it was STABLE, never that it was RIGHT: two compensating edits (delete a real clause,
// add a vacuous one) kept the total at 682 and the file green while the evidence shrank.
//
// Worse, it was accumulated at RUNTIME through data-dependent conditionals, so it could
// go red for a reason that had nothing to do with the assertions. Under full-suite
// concurrency it failed once with `executed 678 clauses, expected 682` and passed on
// re-run — a size assertion that fails for an unrelated reason trains a reader to re-run
// instead of investigate, which is the opposite of what it is for.
//
// `budgetFor` states, for one cell, how many clauses the code below contains for that
// cell's COORDINATES — read off the branch structure, not off a run. Every cell asserts
// its own count against it, so a deleted assertion now names the cell it was deleted
// from; and the file total is the sum over the cross-product, so it cannot be fitted.
//
// BLZ-466 NARROWS WHAT THAT BUYS, because the BLZ-444 commit claimed more than it does.
// It said "the same pair of edits names both the cell that lost a clause and the ones
// that gained". It does not. `assert` THROWS, so a run carrying a removal in one arm and
// an addition in another stops at whichever cell the loops reach FIRST and names only
// that consumer's cells — review measured 41/41 failing, every one of them at
// `dashboard-toast`, with the cells that gained never reported. What IS true, and all
// that is claimed here: a REMOVAL-ONLY edit names every cell that lost a clause (a
// deleted `blaze-commit-subject` clause named all five `*/queued/blaze-commit-subject`
// cells), and in ANY run the FIRST affected cell is named with its coordinates instead
// of surfacing as a wrong grand total hundreds of clauses later. Fix what it names, re-
// run, and the next one is named; the budget does not report them all at once.
//
// The one input that is not a coordinate is `shape.moves` / `shape.other`, and those are
// DECLARED by the fixture and separately asserted against the filesystem measurement
// (see `assertShapeSpecMatchesGroundTruth`) — so a shape that stopped moving anything
// fails as a shape, not as an arithmetic mismatch 700 clauses later.
// =============================================================================
function budgetFor(shape, run, consumer) {
  if (consumer === "dashboard-toast") {
    let n = 1;                                    // (2) git log: a preview never commits
    if (shape.refused) {
      n += 3;                                     // says REFUSED / not in-sync / no move count
    } else {
      n += shape.moves ? 2 : 1;                   // the move count is right, or absent
      n += shape.other ? 2 : 1;                   // ditto the non-moving count
      if (!shape.moves && !shape.other) n += 2;   // BLZ-450: which in-sync wording, and qualified?
      n += 3;                                     // CLEARED count, findings presence, forge presence
    }
    // The wording-invariant clause compares against the FIRST run's text, so it does not
    // run on that first run.
    if (run !== RUNS[0]) n += 1;
    return n;
  }
  // reconcile-cli. 1: HEAD never moves (BLZ-254) — on every cell, refused or not.
  if (shape.refused) return 1 + 3;              // + exit 1 + reason + no applied line
  let n = 1 + 2;                                // + exit 0 + BLZ-468 forge integrity
  if (run === "second-apply") return n + 2;     // the first pass wrote iff the shape changes; nothing left
  return n + (shapeChanges(shape) ? 2 : 1);     // applied line + its moved count, or "nothing to do"
}

/** Two clauses the extractor runs once per SHAPE, plus the shape-spec agreement clauses. */
const perShapeBudget = (shape) => 2 + (shape.refused ? 1 : 3);

// =============================================================================
// Fixtures
// =============================================================================

/** BLZ-452: one cell's executed clause count against the budget its coordinates imply.
 *  A deleted assertion now fails HERE, naming the cell, rather than surfacing as a wrong
 *  grand total with no indication of where the evidence went. */
function assertCellBudget(executed, shape, run, consumer) {
  assert.equal(executed, budgetFor(shape, run, consumer),
    `${shape.name}/${run}/${consumer}: this cell executed ${executed} clause(s); its ` +
    `coordinates budget ${budgetFor(shape, run, consumer)}. A clause was added or removed ` +
    "in this arm — update budgetFor to match the code, deliberately");
}

function git(repo, ...args) { execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }); }
function head(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** One code repo + `gh` payload per shape. Built once; read-only afterwards. */
function buildShapeFixture(tmp, shape) {
  const codeRepo = join(tmp, `repo-${shape.name}`);
  mkdirSync(codeRepo, { recursive: true });
  git(codeRepo, "init", "-q", "-b", "main");
  git(codeRepo, "config", "user.email", "t@t.t");
  git(codeRepo, "config", "user.name", "t");
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  git(codeRepo, "add", "-A");
  git(codeRepo, "commit", "-q", "-m", "seed");
  git(codeRepo, "remote", "add", "origin", "https://github.com/hjr15/zzz.git");

  const tickets = [];
  const prs = [];
  const pr = (n, state, headRefName, title) => ({
    number: n, state, url: `https://github.com/hjr15/zzz/pull/${n}`, headRefName, title,
  });

  if (shape.plant === "none") {
    tickets.push({ id: "ZZZ-1", dirProject: "ZZZ", fmProject: "ZZZ", status: "defined", record: false });
  } else if (shape.plant === "merged") {
    tickets.push({ id: "ZZZ-1", dirProject: "ZZZ", fmProject: "ZZZ", status: "defined", record: false });
    tickets.push({ id: "ZZZ-2", dirProject: "ZZZ", fmProject: "ZZZ", status: "defined", record: false });
    prs.push(pr(1, "MERGED", "ZZZ-1-work", "ZZZ-1: work"));
    prs.push(pr(2, "MERGED", "ZZZ-2-work", "ZZZ-2: work"));
  } else if (shape.plant === "ambiguous") {
    // Two merged PRs claim one ticket that ALREADY holds a delivery record: reconcile
    // refuses to guess and DELETES the record (BLZ-398) — the `cleared` shape.
    tickets.push({ id: "ZZZ-1", dirProject: "ZZZ", fmProject: "ZZZ", status: "in-progress", record: true });
    prs.push(pr(1, "MERGED", "ZZZ-1-work-a", "ZZZ-1: work a"));
    prs.push(pr(2, "MERGED", "ZZZ-1-work-b", "ZZZ-1: work b"));
  } else if (shape.plant === "misfiled") {
    // Filed under YYY's directory, frontmatter says ZZZ, and it carries its own
    // merged PR so an unfiltered run really can move it — an inert misfiled ticket
    // would prove nothing.
    tickets.push({ id: "ZZZ-9", dirProject: "YYY", fmProject: "ZZZ", status: "defined", record: false });
    prs.push(pr(1, "MERGED", "ZZZ-9-work", "ZZZ-9: work"));
  } else if (shape.plant === "backfill") {
    tickets.push({ id: "ZZZ-1", dirProject: "ZZZ", fmProject: "ZZZ", status: "done", record: false });
    prs.push(pr(1, "MERGED", "ZZZ-1-work", "ZZZ-1: work"));
  } else if (shape.plant === "shipped") {
    // A merged commit on main, no PR at all — so the board still moves the ticket
    // while `gh` is unreadable, which is what makes the forge-error shape non-inert.
    tickets.push({ id: "ZZZ-1", dirProject: "ZZZ", fmProject: "ZZZ", status: "defined", record: false });
    git(codeRepo, "commit", "-q", "--allow-empty", "-m", "ZZZ-1: work");
  }

  const bin = join(tmp, `bin-${shape.name}`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), shape.ghFails
    ? "#!/usr/bin/env bash\necho 'gh: unreadable forge (oracle stub)' >&2\nexit 1\n"
    : `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);

  return { codeRepo, tickets, bin };
}

/** A fresh board on disk, git-inited and seeded. `cfgExtra` carries commitMode. */
function materializeBoard(root, fixture, cfgExtra = {}) {
  const projectsDir = join(root, "projects");
  for (const t of fixture.tickets) {
    const dir = join(projectsDir, t.dirProject, t.status);
    mkdirSync(dir, { recursive: true });
    let fm = `---\nid: ${t.id}\ntitle: t\ntype: task\nproject: ${t.fmProject}\nestimate: 30\n`;
    if (t.record) {
      fm += `branch: ${t.id}-old-branch\npr: '#9000 — https://github.com/hjr15/zzz/pull/9000'\n`;
    }
    fm += "---\n\nbody\n";
    writeFileSync(join(dir, `${t.id}-t.md`), fm);
  }
  for (const key of ["ZZZ", "YYY"]) {
    mkdirSync(join(projectsDir, key), { recursive: true });
    writeFileSync(join(projectsDir, key, "project.json"),
      JSON.stringify({ key, codeRepos: key === "ZZZ" ? [fixture.codeRepo] : [] }));
  }
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ", "YYY"], ...cfgExtra }));
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    git(root, ...a);
  }
  return projectsDir;
}

// ---- ground truth source (1): the filesystem -------------------------------

/** Map<id, {dir, raw}> read straight off disk. The status IS the directory. */
function snapshotBoard(projectsDir) {
  const out = new Map();
  for (const project of readdirSync(projectsDir)) {
    const projPath = join(projectsDir, project);
    if (!statSync(projPath).isDirectory()) continue;
    for (const status of readdirSync(projPath)) {
      if (status.startsWith(".")) continue;
      const statusPath = join(projPath, status);
      if (!statSync(statusPath).isDirectory()) continue;
      for (const f of readdirSync(statusPath)) {
        if (!f.endsWith(".md")) continue;
        const raw = readFileSync(join(statusPath, f), "utf8");
        const idm = /^id:\s*(\S+)/m.exec(raw);
        if (idm) out.set(idm[1], { dir: status, raw });
      }
    }
  }
  return out;
}

/** Ground truth for one shape: what a REAL apply pass does to the ticket tree.
 *  Computed on a pristine copy, once per shape, from the filesystem alone —
 *  nothing reconcile printed or returned is consulted. */
function measureShape(tmp, shape, fixture, env) {
  if (shape.refused) return { moved: null, other: null, changedIds: null, refused: true };
  const root = mkdtempSync(join(tmp, `gt-${shape.name}-`));
  const projectsDir = materializeBoard(root, fixture);
  const before = snapshotBoard(projectsDir);
  const res = spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
    { cwd: root, encoding: "utf8", env });
  assert.equal(res.status, 0, `${shape.name}: ground-truth apply run exited ${res.status} — ${res.stderr}`);
  const after = snapshotBoard(projectsDir);
  const changedIds = [];
  let moved = 0, other = 0;
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    if (b.dir !== a.dir) { moved += 1; changedIds.push(id); }
    else if (b.raw !== a.raw) { other += 1; changedIds.push(id); }
  }
  return { moved, other, changedIds, refused: false };
}

// =============================================================================
// Consumer 1 — the dashboard toast (BLZ-426)
// =============================================================================

/** Recovers the summary function FROM THE SERVED HTML and evaluates that copy.
 *  Two separate proofs that the page has no drifting duplicate:
 *    (a) the served page contains this module's exact source text, and
 *    (b) every dashboard clause below runs against the function compiled from the
 *        page, not against the imported one.
 *  A re-inlined hand-copy fails (a); a stale injected copy fails (b). */
function summaryFnFromServedPage(projectsDir) {
  const html = pageHtml({ project: "all", projectsDir, now: 1751932800000, transitions: [] });
  const src = String(reconcileSummary);
  ok(html.includes(src),
    "the served page does not contain reconcile-summary.mjs's own source — the dashboard " +
    "is running a DUPLICATE of the summary logic, which is what BLZ-426 exists to prevent");
  const i = html.indexOf(SUMMARY_FN_BEGIN);
  const j = html.indexOf(SUMMARY_FN_END);
  ok(i !== -1 && j > i, "the served page carries no delimited reconcile-summary definition");
  const extracted = html.slice(i + SUMMARY_FN_BEGIN.length, j);
  // eslint-disable-next-line no-new-func -- compiling the page's own text is the point
  return new Function(`${extracted}; return reconcileSummary;`)();
}

const MOVES_RE = /(\d+) code-bound move\(s\)/;
const OTHER_RE = /(\d+) other update\(s\)/;
const CLEARED_RE = /(\d+) would have their branch\/pr CLEARED/;

// =============================================================================
// The oracle
// =============================================================================

test("BLZ-426 + BLZ-422: no board surface overstates, across the cross-product", async (t) => {
  // --- the cross-product's own size, ASSERTED (BLZ-415/420/437) -------------
  assert.equal(SHAPES.length, 9, "preview-shape dimension changed size");
  assert.equal(RUNS.length, 2, "run dimension changed size");
  assert.equal(CONSUMERS.length, 2, "consumer dimension changed size");
  const CELLS = [];
  for (const shape of SHAPES) for (const run of RUNS) for (const consumer of CONSUMERS) {
    CELLS.push({ shape, run, consumer });
  }
  assert.equal(CELLS.length, 36,
    `the cross-product must be 9 × 2 × 2 = 36 cells, got ${CELLS.length} — a dimension was deleted`);

  // BLZ-444: the total is the SUM OF THE CROSS-PRODUCT'S OWN BUDGET, not a number read
  // off a run. Nothing below may adjust it.
  const EXPECTED_CLAUSES =
    SHAPES.reduce((n, shape) => n + perShapeBudget(shape), 0)
    + CELLS.reduce((n, c) => n + budgetFor(c.shape, c.run, c.consumer), 0)
    + 1;   // the clause-kinds non-vacuity check at the very end

  const tmp = mkdtempSync(join(tmpdir(), "blz426-oracle-"));
  clauses = 0;
  let cellsEvaluated = 0;
  // Every rendered clause the toast can produce. Asserted non-empty at the end: a
  // cross-product whose fixtures all collapse to "no code-bound changes" would pass
  // every assertion above while proving nothing, which is the vacuity failure this
  // whole file exists to prevent.
  const clauseKindsSeen = new Set();
  const shapeGroundTruth = [];
  try {
    for (const shape of SHAPES) {
      const fixture = buildShapeFixture(tmp, shape);
      const env = { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, BLAZE_SESSION: "oracle" };
      const gt = measureShape(tmp, shape, fixture, env);
      shapeGroundTruth.push(`${shape.name}: moved=${gt.moved} other=${gt.other} refused=${gt.refused}`);

      // BLZ-452: the fixture's DECLARED move/update facts — the only non-coordinate input
      // to the clause budget — checked against the filesystem measurement, here, once,
      // with the shape's name on the failure. Before this, a shape that had quietly
      // stopped moving anything surfaced only as a wrong grand total hundreds of clauses
      // later, which is exactly the failure mode that trains a reader to re-run.
      eq(gt.refused, shape.refused,
        `${shape.name}: the fixture declares refused=${shape.refused} but a real apply pass ` +
        `${gt.refused ? "was refused" : "ran"}`);
      if (!shape.refused) {
        eq(gt.moved > 0, Boolean(shape.moves),
          `${shape.name}: the fixture declares moves=${Boolean(shape.moves)} but a real apply ` +
          `pass moved ${gt.moved} ticket(s)`);
        eq(gt.other > 0, Boolean(shape.other),
          `${shape.name}: the fixture declares other=${Boolean(shape.other)} but a real apply ` +
          `pass made ${gt.other} non-moving write(s)`);
      }

      // The served page's own copy of the summary function, compiled from the HTML.
      const pageBoard = mkdtempSync(join(tmp, `page-${shape.name}-`));
      const summaryFn = summaryFnFromServedPage(materializeBoard(pageBoard, fixture));

      let invariantText = null;

      for (const run of RUNS) {
        await t.test(`${shape.name} × ${run}`, async () => {
          // ---------------------------------------------------------------
          // CONSUMER 1: dashboard-toast
          // ---------------------------------------------------------------
          {
            const cellStart = clauses;   // BLZ-452: this cell's own budget
            const root = mkdtempSync(join(tmp, `dash-${shape.name}-${run}-`));
            const projectsDir = materializeBoard(root, fixture);
            const headBefore = head(root);
            const prevPath = process.env.PATH;
            process.env.PATH = env.PATH;
            let body;
            try {
              body = await reconcilePreview({ root, projectsDir, projects: shape.projects });
            } finally {
              process.env.PATH = prevPath;
            }
            const text = summaryFn(body);
            if (/REFUSED/.test(text)) clauseKindsSeen.add("refused");
            if (MOVES_RE.test(text)) clauseKindsSeen.add("moves");
            if (OTHER_RE.test(text)) clauseKindsSeen.add("other");
            if (/no code-bound changes/.test(text)) clauseKindsSeen.add("clean");
            // BLZ-450: the qualified form is its own arm of the sentence, so the
            // non-vacuity check below fails if the cross-product stops generating it.
            if (/no code-bound change was DECIDABLE/.test(text)) clauseKindsSeen.add("clean-degraded");
            if (CLEARED_RE.test(text)) clauseKindsSeen.add("cleared");
            if (/need attention/.test(text)) clauseKindsSeen.add("findings");
            if (/forge problem/.test(text)) clauseKindsSeen.add("forge");

            // (2) git log: a PREVIEW never commits, whatever the run.
            eq(head(root), headBefore,
              `${shape.name}/${run}: the preview moved HEAD — a dry run must never commit`);

            if (shape.refused) {
              matches(text, /REFUSED/,
                `${shape.name}/${run}: a refused preview must say so; it said ${JSON.stringify(text)}`);
              notMatches(text, /no code-bound changes/,
                `${shape.name}/${run}: a refusal was rendered as an in-sync board — BLZ-426's own defect`);
              notMatches(text, MOVES_RE,
                `${shape.name}/${run}: a refused run reported a move count it never computed`);
            } else {
              // (1) filesystem: the counts a real apply pass produces on this fixture.
              const m = MOVES_RE.exec(text);
              if (gt.moved > 0) {
                ok(m, `${shape.name}/${run}: ${gt.moved} ticket(s) really move but the toast says ` +
                  `${JSON.stringify(text)}`);
                eq(Number(m[1]), gt.moved,
                  `${shape.name}/${run}: the toast's move count must equal the real directory-change count`);
              } else {
                eq(m, null,
                  `${shape.name}/${run}: the toast claims moves that no apply pass makes`);
              }
              const o = OTHER_RE.exec(text);
              if (gt.other > 0) {
                ok(o, `${shape.name}/${run}: ${gt.other} non-moving write(s) really happen but the ` +
                  `toast folds them into (or hides them from) the move count: ${JSON.stringify(text)}`);
                eq(Number(o[1]), gt.other,
                  `${shape.name}/${run}: the toast's non-moving count must equal the real content-change count`);
              } else {
                eq(o, null,
                  `${shape.name}/${run}: the toast claims non-moving updates that never happen`);
              }
              if (gt.moved === 0 && gt.other === 0) {
                // BLZ-450. "no code-bound changes" is an IN-SYNC CLAIM about the board,
                // and it is only earned when the check that produced it was complete. An
                // unreadable forge means candidates were never examined, so the run may
                // report what it could decide and nothing more. Ground truth for WHICH
                // sentence is owed is the fixture's own statement of what it planted
                // (source (4), presence only) — never anything the toast said.
                matches(text,
                  shape.expectForge ? /no code-bound change was DECIDABLE/ : /no code-bound changes/,
                  `${shape.name}/${run}: a board with nothing to do and a ` +
                  `${shape.expectForge ? "DEGRADED" : "healthy"} forge check must say so in ` +
                  `those terms; it said ${JSON.stringify(text)}`);
                eq(/says nothing about whether the board is in sync/.test(text), shape.expectForge,
                  `${shape.name}/${run}: the in-sync claim must be QUALIFIED exactly when ` +
                  "the forge could not be read — an unqualified 'no code-bound changes' beside " +
                  `'N forge problem(s)' is BLZ-450's own defect. Got ${JSON.stringify(text)}`);
              }
              // cleared, from the filesystem: a ticket whose branch/pr lines vanished.
              const clearedGT = gt.changedIds.length === 0 ? 0 : countCleared(tmp, shape, fixture, env);
              const cl = CLEARED_RE.exec(text);
              eq(cl ? Number(cl[1]) : 0, clearedGT,
                `${shape.name}/${run}: the toast's CLEARED count must equal the number of tickets whose ` +
                `branch/pr really disappeared from disk (${clearedGT})`);
              // (4) fixture spec: presence only.
              eq(/need attention/.test(text), shape.expectFindings,
                `${shape.name}/${run}: findings clause presence disagrees with what this board was built to contain`);
              eq(/forge problem\(s\)/.test(text), shape.expectForge,
                `${shape.name}/${run}: forge clause presence disagrees with what this board was built to contain`);
            }
            // A preview writes nothing, so two fresh boards must read identically. This is
            // the run dimension's own assertion for this consumer.
            if (invariantText === null) invariantText = text;
            else {
              eq(text, invariantText,
                `${shape.name}/${run}: the toast changed wording between two fresh boards — a preview must read identically`);
            }
            assertCellBudget(clauses - cellStart, shape, run, "dashboard-toast");
            cellsEvaluated += 1;
            rmSync(root, { recursive: true, force: true });
          }

          // ---------------------------------------------------------------
          // CONSUMER 2: the `reconcile --apply` CLI
          // ---------------------------------------------------------------
          const cliRoot = mkdtempSync(join(tmp, `cli-${shape.name}-${run}-`));
          const cliProjects = materializeBoard(cliRoot, fixture);
          const cliCellStart = clauses;   // BLZ-452: this cell's own budget
          const headBefore = head(cliRoot);
          let firstWrote = null;
          if (run === "second-apply") {
            const snapBefore = snapshotBoard(cliProjects);
            spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
              { cwd: cliRoot, encoding: "utf8", env });
            firstWrote = !isDeepStrictEqual(snapshotBoard(cliProjects), snapBefore);
          }
          const res = spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
            { cwd: cliRoot, encoding: "utf8", env });
          const out = `${res.stdout}\n${res.stderr}`;

          // BLZ-254 (spec §5.5): reconcile never commits — not on a first pass, not on a second,
          // not on a refusal. `git log` is the ground truth, never the CLI's own words.
          eq(head(cliRoot), headBefore,
            `${shape.name}/${run}: reconcile moved HEAD — the board never commits; output was ${JSON.stringify(out)}`);

          if (!shape.refused) {
            eq(res.status, 0, `${shape.name}/${run}: expected exit 0, got ${res.status} — output was ${JSON.stringify(out)}`);
            // BLZ-468: the run's own forge account against the fixture's declaration — the clause
            // that catches a transient `gh` failure emptying this shape's only delivery signal.
            eq(/^reconcile: FORGE (UNREADABLE|DATA) —/m.test(res.stderr), Boolean(shape.expectForge),
              `${shape.name}/${run}: this fixture declares expectForge=${Boolean(shape.expectForge)} but the run ` +
              `${/^reconcile: FORGE /m.test(res.stderr) ? "reported" : "reported no"} forge problem — output was ${JSON.stringify(out)}`);
          }

          if (shape.refused) {
            eq(res.status, 1, `${shape.name}/${run}: a refused run must exit non-zero`);
            matches(res.stderr, /^reconcile: /m, `${shape.name}/${run}: a refused run must say why`);
            notMatches(res.stdout, /ticket\(s\) moved/,
              `${shape.name}/${run}: a refused run claimed writes it never made`);
          } else if (run === "second-apply") {
            // BLZ-445, kept: the first pass wrote exactly when this board has something to change,
            // and the second finds nothing at all.
            eq(firstWrote, shapeChanges(shape),
              `${shape.name}/${run}: the FIRST pass must write exactly when this board has something ` +
              "to change — otherwise the second pass is not a second pass at all");
            matches(out, /no code-bound change found — nothing to do\./,
              `${shape.name}/${run}: a second pass must report an empty pass — output was ${JSON.stringify(out)}`);
          } else if (shapeChanges(shape)) {
            const m = /reconcile: (\d+) ticket\(s\) moved/.exec(res.stdout);
            ok(m, `${shape.name}/${run}: ${gt.changedIds.length} ticket(s) changed but the CLI printed no applied line — ` +
              `output was ${JSON.stringify(out)}`);
            eq(Number(m[1]), gt.moved,
              `${shape.name}/${run}: the applied line's moved count must equal the real one (${gt.moved})`);
          } else {
            matches(out, /no code-bound change found — nothing to do\./,
              `${shape.name}/${run}: nothing changes on this board, so the run must say so — output was ${JSON.stringify(out)}`);
          }
          assertCellBudget(clauses - cliCellStart, shape, run, "reconcile-cli");
          cellsEvaluated += 1;
          rmSync(cliRoot, { recursive: true, force: true });
        });
      }
    }

    // Non-vacuity: every clause the summary can emit was really emitted by at least
    // one generated cell, so no arm of the sentence is untested.
    deepEq([...clauseKindsSeen].sort(),
      ["clean", "clean-degraded", "cleared", "findings", "forge", "moves", "other", "refused"],
      "the cross-product did not exercise every clause the toast can render — " +
      `saw ${JSON.stringify([...clauseKindsSeen].sort())}`);
    assert.equal(cellsEvaluated, 36,
      `every one of the 36 cells must be evaluated; ${cellsEvaluated} were`);
    assert.equal(clauses, EXPECTED_CLAUSES,
      `the oracle executed ${clauses} clauses; the cross-product's own budget is ` +
      `${EXPECTED_CLAUSES}. Every cell already checked its own share, so a mismatch HERE ` +
      "means a clause was added or removed outside a cell — update budgetFor/perShapeBudget "
      + "deliberately rather than letting the oracle shrink");
  } finally {
    console.log(`BLZ-426 + BLZ-422 oracle: ${CELLS.length} cells, ${clauses} clauses executed ` +
      "(budget derived from the cross-product's shape, per cell — BLZ-444/BLZ-452).");
    console.log(`  filesystem ground truth per shape — ${shapeGroundTruth.join("; ")}`);
    rmSync(tmp, { recursive: true, force: true });
  }
});

/** How many tickets really lost their branch/pr on disk in a real apply pass —
 *  ground truth source (1), measured on its own pristine copy. Memoised per shape. */
const _clearedCache = new Map();
function countCleared(tmp, shape, fixture, env) {
  if (_clearedCache.has(shape.name)) return _clearedCache.get(shape.name);
  const root = mkdtempSync(join(tmp, `cl-${shape.name}-`));
  const projectsDir = materializeBoard(root, fixture);
  const before = snapshotBoard(projectsDir);
  spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
    { cwd: root, encoding: "utf8", env });
  const after = snapshotBoard(projectsDir);
  let n = 0;
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    const had = /^(branch|pr):/m.test(b.raw);
    const has = /^(branch|pr):/m.test(a.raw);
    if (had && !has) n += 1;
  }
  rmSync(root, { recursive: true, force: true });
  _clearedCache.set(shape.name, n);
  return n;
}

// =============================================================================
// BLZ-446 — THE REACHABLE HALF OF THE `ok !== true` BRANCH.
//
// The cross-product above drives `reconcilePreview` as a FUNCTION, so the only non-ok
// bodies it can generate are the two `projects`-gated refusals — the ones the route
// genuinely cannot produce, and the ones the BLZ-426 commit was describing when it
// called the fix "contract-only". That description was incomplete, and the header of
// this file now says so. This test covers what it left out: the bodies the ROUTE
// really can return today, taken from the REAL SERVER over a REAL SOCKET, fed to the
// REAL toast.
//
// Why it matters, concretely. Under the pre-BLZ-426 inline consumer, `j.changes` on
// every one of these bodies was `undefined` -> `moves = 0` -> the toast read "no code-
// bound changes". A person whose token had expired was told the board was in sync. The
// clause below that asserts `changes === undefined` is that mechanism, pinned: it is
// the property that made the old code silently wrong, and it still holds of these
// bodies, so the ONLY thing standing between them and a false in-sync claim is the
// `ok !== true` branch.
//
// The asserts here are deliberately BARE `assert.` calls, not the counting wrappers
// (`eq`/`ok`/`matches`/`notMatches`/`deepEq` — BLZ-483: this list named three of the five,
// which reads as though the other two were available here and were not chosen): they are
// not cells of the cross-product and must not move its clause budget. (Kind 3 in the
// inventory at the head of this file.)
//
// NOT COVERED, stated plainly: a 500 from `/api/reconcile-preview` itself. The route
// body is `json(200, await reconcilePreview(...))` with no throwing path between the
// gate and the response, so there is no way to force one without editing serve.mjs to
// create it. The 500 shape reaches this consumer only from a route-level crash or a
// reverse proxy, and it is covered at the FUNCTION by the `{errors:[…]}` case in
// tests/board-overstatement-guards.test.mjs. What is proven live here is 401 and 503.
test("BLZ-446: a REACHABLE non-ok body from /api/reconcile-preview reaches the toast as a refusal", async (t) => {
  const { startServer } = await import("../scripts/serve.mjs");
  const { addUser } = await import("../scripts/model/user-admin.mjs");

  /** The summary function the BROWSER runs, compiled from the served page's own text.
   *  Bare asserts, for the reason in this block's header. */
  function browserSummaryFn(projectsDir) {
    const html = pageHtml({ project: "all", projectsDir, now: 1751932800000, transitions: [] });
    assert.ok(html.includes(String(reconcileSummary)),
      "the served page does not carry reconcile-summary.mjs's own source");
    const i = html.indexOf(SUMMARY_FN_BEGIN);
    const j = html.indexOf(SUMMARY_FN_END);
    // eslint-disable-next-line no-new-func -- compiling the page's own text is the point
    return new Function(`${html.slice(i + SUMMARY_FN_BEGIN.length, j)}; return reconcileSummary;`)();
  }

  const tmp = mkdtempSync(join(tmpdir(), "blz446-reachable-"));
  /** A board with ONE clean ticket: were the request to get through, the preview would
   *  return `{ok:true, changes:[]}` and the toast would legitimately say the board is
   *  in sync. So a toast that says "in sync" here is indistinguishable from the honest
   *  answer — which is exactly what made the pre-fix bug invisible. */
  function board() {
    const root = mkdtempSync(join(tmp, "board-"));
    const projectsDir = join(root, "projects");
    mkdirSync(join(projectsDir, "ZZZ", "defined"), { recursive: true });
    writeFileSync(join(projectsDir, "ZZZ", "defined", "ZZZ-1-t.md"),
      "---\nid: ZZZ-1\ntitle: t\ntype: task\nproject: ZZZ\nestimate: 30\n---\n\nbody\n");
    writeFileSync(join(projectsDir, "ZZZ", "project.json"), JSON.stringify({ key: "ZZZ", codeRepos: [] }));
    writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "ZZZ", projects: ["ZZZ"] }));
    for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                     ["config", "user.name", "t"], ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
      git(root, ...a);
    }
    return { root, projectsDir };
  }

  // A gate that cannot decide. Same injection tests/identity-resilience.test.mjs uses:
  // it isolates the one thing under test (what the route answers) from any need for a
  // read-only mount or a held lock.
  const explodingIdentity = () => ({
    hasIdentity: true,
    close() {},
    store: { authenticate: async () => { throw new Error("database is locked"); } },
  });

  const CASES = [
    { name: "401 — no credential at all",
      status: 401, headers: {}, withUser: true, identity: undefined },
    { name: "401 — an expired, revoked or unknown bearer token",
      status: 401, headers: { authorization: "Bearer blz_this_token_is_not_valid" },
      withUser: true, identity: undefined },
    { name: "503 — the gate itself could not decide",
      status: 503, headers: { authorization: "Bearer blz_whatever" },
      withUser: false, identity: explodingIdentity },
  ];

  try {
    for (const c of CASES) {
      await t.test(c.name, async () => {
        const { root, projectsDir } = board();
        if (c.withUser) await addUser(root, { email: "ops@example.com", role: "admin" });
        const server = startServer({ port: 0, root, projectsDir,
          ...(c.identity ? { identity: c.identity() } : {}) });
        await new Promise((res) => server.once("listening", res));
        try {
          const res = await fetch(
            `http://127.0.0.1:${server.address().port}/api/reconcile-preview`,
            { headers: c.headers });
          assert.equal(res.status, c.status,
            `${c.name}: this body is only reachable if the route really answers ${c.status}`);
          const body = await res.json();

          // THE MECHANISM, pinned. `changes` is absent on every one of these bodies, so
          // a consumer that reads `j.changes` and not `j.ok` computes 0 moves and says
          // the board is in sync. That is precisely the pre-BLZ-426 inline code.
          assert.equal(body.changes, undefined,
            `${c.name}: this body carries no \`changes\` — the property that made the ` +
            "pre-fix consumer silently report an in-sync board");
          assert.ok(Array.isArray(body.errors) && body.errors.length > 0,
            `${c.name}: the route must say why: ${JSON.stringify(body)}`);

          const text = browserSummaryFn(projectsDir)(body);
          assert.match(text, /^reconcile REFUSED: /,
            `${c.name}: the toast must render this as a refusal, it rendered ` +
            `${JSON.stringify(text)}`);
          assert.doesNotMatch(text, /no code-bound change/,
            `${c.name}: THE PRODUCTION BUG — the toast told a caller whose request was ` +
            `refused with ${c.status} that the board had no code-bound changes. Got ` +
            `${JSON.stringify(text)}`);
          assert.ok(text.includes(body.errors[0]),
            `${c.name}: the refusal must carry the server's own reason ` +
            `(${JSON.stringify(body.errors[0])}), it said ${JSON.stringify(text)}`);
          assert.match(text, /the board was NOT checked/,
            `${c.name}: and must say plainly that nothing was checked`);
        } finally {
          server.close();
        }
      });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
