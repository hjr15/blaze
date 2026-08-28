// tests/board-overstatement-oracle.test.mjs — BLZ-426 + BLZ-422 + BLZ-427.
//
// THE ASSERTION: every sentence the board says about a reconcile pass and its commit
// is true of the filesystem and of `git log`. Three surfaces say those sentences and
// all three could overstate:
//
//   BLZ-426  the dashboard's reconcile button rendered a REFUSED preview as
//            "no code-bound changes" — an in-sync board that is not in sync, it
//            just never ran.
//   BLZ-422  `commitFile`'s benign empty-diff no-op returned `{ok:true,status:0}`,
//            byte-identical to a real commit, so reconcile reported
//            `commitOutcome: "committed"` with nothing in `git log`.
//   BLZ-427  `blaze commit`'s subject counted OPS, and had no label for `reconcile`
//            — so one queued reconcile op covering twelve tickets read "1 reconcile".
//
// GROUND TRUTH IS NEVER THE SUBJECT UNDER TEST. Every number this file checks comes
// from one of exactly four independent sources, and none of them is a return value
// of the thing being asserted about:
//   (1) the FILESYSTEM — a before/after snapshot of the ticket tree, where the
//       status IS the directory, taken around a real `--apply` pass on a pristine
//       copy of the same fixture;
//   (2) `git log` / `git rev-parse HEAD` — whether a commit actually exists;
//   (3) the pending-ledger FILE on disk, read before it is drained;
//   (4) the FIXTURE SPEC — which conditions this board was built to contain (a
//       misfiled ticket, a failing `gh`). Presence/absence only, never a count, so
//       the oracle cannot bless the subject's own arithmetic.
// BLZ-423 and BLZ-431 are open tickets for oracles that read their subject for
// ground truth. This is not a third.
//
// THE CROSS-PRODUCT, generated (not a hand-written list):
//   preview shape ∈ refused-unknown-project / refused-no-key / clean / moves-only /
//                   cleared / findings / forge-error / non-moving-update      (8)
//   commit outcome ∈ committed / no-op / queued / locked / failed             (5)
//   consumer ∈ dashboard-toast / reconcile-cli / commit-outcome-report /
//              blaze-commit-subject                                           (4)
// = 8 × 5 × 4 = 160 cells. The size is ASSERTED, not merely printed: deleting a
// dimension must fail this file rather than silently shrink it. So is the CLAUSE count,
// and as of BLZ-444/BLZ-452 it is DERIVED from the cross-product's own shape and checked
// PER CELL — see `budgetFor`. (The same hole in three sibling oracles was BLZ-415,
// BLZ-420 and BLZ-437, closed in the same change.)
//
// REACHABILITY, stated plainly rather than implied (work order §3):
//   - The two REFUSAL shapes require `projects !== null`, and serve.mjs's
//     `/api/reconcile-preview` route never passes one. Through the ROUTE they are
//     unreachable today; they are reachable through `reconcile` the CLI
//     (`--project NOPE`, `--project=`), which this file drives. The dashboard half
//     is therefore a CONTRACT gap, tested as one — the same precedent
//     tests/reconcile-preview-refusal.test.mjs set for BLZ-405, and for the same
//     reason: adding a `?project=` query-string surface to make it reachable would
//     ship a per-project preview, a real feature and a different ticket's scope.
//   - reconcile can never reach `commitFile`'s empty-diff no-op: a change entry
//     requires a byte difference or a rename, so the staged tree is never clean.
//     The `"no-op"` arm of `commitOutcomeFrom` is therefore UNREACHABLE THROUGH
//     `reconcile()` and no mutation of reconcile.mjs can kill it. It IS reachable
//     through `commitFile`'s other callers — `blaze edit` / `blaze resolve` /
//     `blaze link` / `POST /api/ac` all write an idempotent, byte-identical file —
//     and it is pinned there, by a real `git commit` that really has nothing to
//     commit, in the commit-outcome-report consumer below.
//     BLZ-445: because of that, the `no-op` COLUMN means something different at the
//     reconcile-cli consumer, and it now says so and has its own arm. There it is a
//     SECOND apply pass with nothing left to decide — it used to fall through to the
//     same "nothing changed" arm as several other cells, reading as coverage it did
//     not provide. The genuine empty-diff no-op remains consumer 3's, and only
//     consumer 3's.
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
import { commitOutcomeFrom, applySummary } from "../scripts/reconcile-commit-report.mjs";
import { commitFile } from "../scripts/serve-commit.mjs";
import { commitOrQueue } from "../scripts/commit-or-queue.mjs";
import { acquireLock, releaseLock } from "../scripts/commit-lock.mjs";
import { readEntries, sessionId } from "../scripts/pending-ledger.mjs";

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
// These wrappers are now the ONLY way the counter moves — the same binding the sibling
// oracle uses (`tests/schema-audit-load-agreement-oracle.test.mjs`'s `check()`/
// `sameSet()`). Deleting a clause deletes its count with it, so the cell's own budget
// assertion names it. The bare `assert.` calls that remain are deliberately NOT clauses:
// fixture preconditions (the ground-truth apply run exited 0, the competing lock was
// really taken) and meta-assertions about the budget itself (`assertCellBudget`, the
// dimension sizes, the grand total). A new oracle clause written as a bare `assert.`
// would be uncounted, and would fail the same budget from the other side.
// =============================================================================
let clauses = 0;
const eq = (a, b, msg) => { clauses += 1; assert.equal(a, b, msg); };
const ok = (c, msg) => { clauses += 1; assert.ok(c, msg); };
const matches = (s, re, msg) => { clauses += 1; assert.match(s, re, msg); };
const notMatches = (s, re, msg) => { clauses += 1; assert.doesNotMatch(s, re, msg); };
const deepEq = (a, b, msg) => { clauses += 1; assert.deepEqual(a, b, msg); };

const RECONCILE_BIN = join(import.meta.dirname, "..", "scripts", "reconcile.mjs");
const COMMIT_BIN = join(import.meta.dirname, "..", "scripts", "commit-runner.mjs");

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
  // A change that is NOT a move: a terminal ticket with a blank resolution and a
  // merged PR gets its resolution backfilled and its delivery record filled in
  // place. `changes` carries it, the directory does not change — which is exactly
  // the entry the toast used to count as a "code-bound move".
  { name: "non-moving-update", plant: "backfill", cliArgs: [], moves: false, other: true,
    projects: null, refused: false, expectFindings: false, expectForge: false, ghFails: false },
];

/** Does an apply pass change ANYTHING on this board? Declared, not measured. */
const shapeChanges = (shape) => Boolean(shape.moves || shape.other);

const OUTCOMES = ["committed", "no-op", "queued", "locked", "failed"];

const CONSUMERS = ["dashboard-toast", "reconcile-cli", "commit-outcome-report", "blaze-commit-subject"];

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
// The one input that is not a coordinate is `shape.moves` / `shape.other`, and those are
// DECLARED by the fixture and separately asserted against the filesystem measurement
// (see `assertShapeSpecMatchesGroundTruth`) — so a shape that stopped moving anything
// fails as a shape, not as an arithmetic mismatch 700 clauses later.
// =============================================================================
function budgetFor(shape, outcome, consumer) {
  const changes = shapeChanges(shape);
  if (consumer === "dashboard-toast") {
    let n = 1;                                    // (2) git log: a preview never commits
    if (shape.refused) {
      n += 3;                                     // says REFUSED / not in-sync / no move count
    } else {
      n += shape.moves ? 2 : 1;                   // the move count is right, or absent
      n += shape.other ? 2 : 1;                   // ditto the non-moving count
      if (!shape.moves && !shape.other) n += 1;   // "no code-bound changes"
      n += 3;                                     // CLEARED count, findings presence, forge presence
    }
    // The wording-invariant clause compares against the FIRST outcome's text, so it does
    // not run on that first outcome.
    if (outcome !== OUTCOMES[0]) n += 1;
    return n;
  }
  if (consumer === "reconcile-cli") {
    if (shape.refused) return 4;                  // biconditional + exit 1 + reason + no commit
    let n = 2;                                    // the BLZ-422 biconditional + the exit code
    if (outcome === "queued") return n + 2;       // no commit + the ledger biconditional
    if (outcome === "no-op") return n + 3;        // BLZ-445's own arm, below
    if (changes && (outcome === "locked" || outcome === "failed")) return n + 2;
    if (changes && outcome === "committed") return n + 2;
    return n + 1;                                 // nothing changed, so nothing may commit
  }
  if (consumer === "commit-outcome-report") {
    // Driven by a purpose-built repo of its own, so this consumer's arm is fixed by the
    // OUTCOME alone — the shape does not reach it.
    if (outcome === "committed") return 4;
    if (outcome === "no-op") return 2;
    if (outcome === "queued") return 5;
    return 4;                                     // locked / failed
  }
  // blaze-commit-subject: the ledger carries a reconcile op exactly when this board both
  // queued and had something to queue.
  return outcome === "queued" && changes ? 6 : 2;
}

/** Two clauses the extractor runs once per SHAPE, plus the shape-spec agreement clauses. */
const perShapeBudget = (shape) => 2 + (shape.refused ? 1 : 3);

// =============================================================================
// Fixtures
// =============================================================================

/** BLZ-452: one cell's executed clause count against the budget its coordinates imply.
 *  A deleted assertion now fails HERE, naming the cell, rather than surfacing as a wrong
 *  grand total with no indication of where the evidence went. */
function assertCellBudget(executed, shape, outcome, consumer) {
  assert.equal(executed, budgetFor(shape, outcome, consumer),
    `${shape.name}/${outcome}/${consumer}: this cell executed ${executed} clause(s); its ` +
    `coordinates budget ${budgetFor(shape, outcome, consumer)}. A clause was added or removed ` +
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

// ---- the commit environment each outcome needs -----------------------------

/** Puts a board into the state the named commit outcome requires. Returns a
 *  teardown. `committed` and `no-op` need nothing here: `no-op` is realised at the
 *  `commitFile` layer (see the reachability note in the header). */
function applyOutcomeEnv(root, outcome) {
  if (outcome === "queued") {
    const p = join(root, "blaze.config.json");
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), commitMode: "batch" }));
    return () => {};
  }
  if (outcome === "locked") {
    assert.equal(acquireLock(root, { session: "oracle-other-writer" }).ok, true);
    return () => releaseLock(root);
  }
  if (outcome === "failed") {
    const hook = join(root, ".git", "hooks", "pre-commit");
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho 'oracle: pre-commit refuses' >&2\nexit 1\n");
    execFileSync("chmod", ["+x", hook]);
    return () => rmSync(hook, { force: true });
  }
  return () => {};
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

test("BLZ-426 + BLZ-422 + BLZ-427: no board surface overstates, across the cross-product", async (t) => {
  // --- the cross-product's own size, ASSERTED (BLZ-415/420/437) -------------
  assert.equal(SHAPES.length, 8, "preview-shape dimension changed size");
  assert.equal(OUTCOMES.length, 5, "commit-outcome dimension changed size");
  assert.equal(CONSUMERS.length, 4, "consumer dimension changed size");
  const CELLS = [];
  for (const shape of SHAPES) for (const outcome of OUTCOMES) for (const consumer of CONSUMERS) {
    CELLS.push({ shape, outcome, consumer });
  }
  assert.equal(CELLS.length, 160,
    `the cross-product must be 8 × 5 × 4 = 160 cells, got ${CELLS.length} — a dimension was deleted`);

  // BLZ-444: the total is the SUM OF THE CROSS-PRODUCT'S OWN BUDGET, not a number read
  // off a run. Nothing below may adjust it.
  const EXPECTED_CLAUSES =
    SHAPES.reduce((n, shape) => n + perShapeBudget(shape), 0)
    + CELLS.reduce((n, c) => n + budgetFor(c.shape, c.outcome, c.consumer), 0)
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

      for (const outcome of OUTCOMES) {
        await t.test(`${shape.name} × ${outcome}`, async () => {
          // ---------------------------------------------------------------
          // CONSUMER 1: dashboard-toast
          // ---------------------------------------------------------------
          {
            const cellStart = clauses;   // BLZ-452: this cell's own budget
            const root = mkdtempSync(join(tmp, `dash-${shape.name}-${outcome}-`));
            const projectsDir = materializeBoard(root, fixture);
            const teardown = applyOutcomeEnv(root, outcome);
            const headBefore = head(root);
            const prevPath = process.env.PATH;
            process.env.PATH = env.PATH;
            let body;
            try {
              body = await reconcilePreview({ root, projectsDir, projects: shape.projects });
            } finally {
              process.env.PATH = prevPath;
              teardown();
            }
            const text = summaryFn(body);
            if (/REFUSED/.test(text)) clauseKindsSeen.add("refused");
            if (MOVES_RE.test(text)) clauseKindsSeen.add("moves");
            if (OTHER_RE.test(text)) clauseKindsSeen.add("other");
            if (/no code-bound changes/.test(text)) clauseKindsSeen.add("clean");
            if (CLEARED_RE.test(text)) clauseKindsSeen.add("cleared");
            if (/need attention/.test(text)) clauseKindsSeen.add("findings");
            if (/forge problem/.test(text)) clauseKindsSeen.add("forge");

            // (2) git log: a PREVIEW never commits, whatever the commit environment.
            eq(head(root), headBefore,
              `${shape.name}/${outcome}: the preview moved HEAD — a dry run must never commit`);

            if (shape.refused) {
              matches(text, /REFUSED/,
                `${shape.name}/${outcome}: a refused preview must say so; it said ${JSON.stringify(text)}`);
              notMatches(text, /no code-bound changes/,
                `${shape.name}/${outcome}: a refusal was rendered as an in-sync board — BLZ-426's own defect`);
              notMatches(text, MOVES_RE,
                `${shape.name}/${outcome}: a refused run reported a move count it never computed`);
            } else {
              // (1) filesystem: the counts a real apply pass produces on this fixture.
              const m = MOVES_RE.exec(text);
              if (gt.moved > 0) {
                ok(m, `${shape.name}/${outcome}: ${gt.moved} ticket(s) really move but the toast says ` +
                  `${JSON.stringify(text)}`);
                eq(Number(m[1]), gt.moved,
                  `${shape.name}/${outcome}: the toast's move count must equal the real directory-change count`);
              } else {
                eq(m, null,
                  `${shape.name}/${outcome}: the toast claims moves that no apply pass makes`);
              }
              const o = OTHER_RE.exec(text);
              if (gt.other > 0) {
                ok(o, `${shape.name}/${outcome}: ${gt.other} non-moving write(s) really happen but the ` +
                  `toast folds them into (or hides them from) the move count: ${JSON.stringify(text)}`);
                eq(Number(o[1]), gt.other,
                  `${shape.name}/${outcome}: the toast's non-moving count must equal the real content-change count`);
              } else {
                eq(o, null,
                  `${shape.name}/${outcome}: the toast claims non-moving updates that never happen`);
              }
              if (gt.moved === 0 && gt.other === 0) {
                matches(text, /no code-bound changes/,
                  `${shape.name}/${outcome}: a genuinely clean board must say so`);
              }
              // cleared, from the filesystem: a ticket whose branch/pr lines vanished.
              const clearedGT = gt.changedIds.length === 0 ? 0 : countCleared(tmp, shape, fixture, env);
              const cl = CLEARED_RE.exec(text);
              eq(cl ? Number(cl[1]) : 0, clearedGT,
                `${shape.name}/${outcome}: the toast's CLEARED count must equal the number of tickets whose ` +
                `branch/pr really disappeared from disk (${clearedGT})`);
              // (4) fixture spec: presence only.
              eq(/need attention/.test(text), shape.expectFindings,
                `${shape.name}/${outcome}: findings clause presence disagrees with what this board was built to contain`);
              eq(/forge problem\(s\)/.test(text), shape.expectForge,
                `${shape.name}/${outcome}: forge clause presence disagrees with what this board was built to contain`);
            }
            // A preview never commits, so the commit environment must not change one
            // word of what it says. This is the outcome dimension's own assertion for
            // this consumer.
            if (invariantText === null) invariantText = text;
            else {
              eq(text, invariantText,
                `${shape.name}/${outcome}: the toast changed wording with the COMMIT environment — ` +
                "a preview commits nothing and must read identically");
            }
            assertCellBudget(clauses - cellStart, shape, outcome, "dashboard-toast");
            cellsEvaluated += 1;
            rmSync(root, { recursive: true, force: true });
          }

          // ---------------------------------------------------------------
          // CONSUMER 2: the `reconcile --apply` CLI
          // ---------------------------------------------------------------
          const cliRoot = mkdtempSync(join(tmp, `cli-${shape.name}-${outcome}-`));
          materializeBoard(cliRoot, fixture);
          const cliTeardown = applyOutcomeEnv(cliRoot, outcome);
          const cliCellStart = clauses;   // BLZ-452: this cell's own budget
          let res;
          try {
            const headBefore = head(cliRoot);
            if (outcome === "no-op") {
              // reconcile cannot reach commitFile's empty-diff no-op (header note);
              // the reachable "nothing entered git log" shape for THIS consumer is a
              // second pass with nothing left to decide.
              spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
                { cwd: cliRoot, encoding: "utf8", env });
            }
            const headBefore2 = outcome === "no-op" ? head(cliRoot) : headBefore;
            res = spawnSync(process.execPath, [RECONCILE_BIN, "--apply", ...shape.cliArgs],
              { cwd: cliRoot, encoding: "utf8", env });
            const headAfter = head(cliRoot);
            const headMoved = headAfter !== headBefore2;
            const out = `${res.stdout}\n${res.stderr}`;

            // THE BLZ-422 BICONDITIONAL, against `git log` and nothing else.
            eq(/reconcile: committed /.test(res.stdout), headMoved,
              `${shape.name}/${outcome}: the CLI ${/reconcile: committed /.test(res.stdout) ? "claimed a commit" : "did not claim a commit"} ` +
              `but HEAD ${headMoved ? "moved" : "did not move"} — output was ${JSON.stringify(out)}`);

            if (!shape.refused) {
              // BLZ-452: THE EXIT CODE, asserted on every non-refused cell. Its absence is
              // how a cell could degrade in silence: a `queued` run that died before
              // queueing anything left `/reconcile: queued /` false AND the ledger empty,
              // so the biconditional below held, `blaze commit` said "nothing to flush",
              // and the ONLY trace was the grand clause total coming up short. That is the
              // 678-vs-682 signature this file was flaky with. An exit code is a fact
              // about the run, independent of everything it printed.
              const expectExit = shapeChanges(shape) && (outcome === "locked" || outcome === "failed")
                ? 1 : 0;
              eq(res.status, expectExit,
                `${shape.name}/${outcome}: expected exit ${expectExit}, got ${res.status} — ` +
                `output was ${JSON.stringify(out)}`);
            }

            if (shape.refused) {
              eq(res.status, 1, `${shape.name}/${outcome}: a refused run must exit non-zero`);
              matches(res.stderr, /^reconcile: /m,
                `${shape.name}/${outcome}: a refused run must say why`);
              eq(headMoved, false,
                `${shape.name}/${outcome}: a refused run committed something`);
            } else if (outcome === "no-op") {
              // BLZ-445. This column used to fall through to the generic "nothing changed,
              // so nothing may be committed" arm, indistinguishable from several other
              // cells — a column that read as coverage it did not provide. `commitFile`'s
              // genuine empty-diff no-op is UNREACHABLE through reconcile (header note) and
              // is pinned at consumer 3; what IS reachable here, and what this column is
              // renamed to mean, is a SECOND apply pass with nothing left to decide. Its
              // own arm, with the two facts that make it a second pass rather than a first:
              // the first pass really did (or really did not) commit, exactly as the shape
              // declares, and the second one finds nothing at all.
              eq(headMoved, false,
                `${shape.name}/${outcome}: a second pass with nothing left to decide must not commit`);
              eq(headBefore2 !== headBefore, shapeChanges(shape),
                `${shape.name}/${outcome}: the FIRST pass must commit exactly when this board has ` +
                "something to change — otherwise the second pass is not a second pass at all");
              matches(out, /no code-bound change found — nothing to do\./,
                `${shape.name}/${outcome}: a second pass must report an empty pass, not a commit — ` +
                `output was ${JSON.stringify(out)}`);
            } else if (outcome === "queued") {
              eq(headMoved, false,
                `${shape.name}/${outcome}: a batch-mode run must not commit`);
              const ledger = readEntries(cliRoot, "oracle");
              eq(/reconcile: queued /.test(res.stdout), ledger.length > 0,
                `${shape.name}/${outcome}: the CLI's "queued" claim must match the ledger file on disk`);
            } else if ((outcome === "locked" || outcome === "failed") && shapeChanges(shape)) {
              eq(headMoved, false,
                `${shape.name}/${outcome}: nothing may be committed when the commit could not run`);
              matches(res.stderr, /FAILED TO COMMIT/,
                `${shape.name}/${outcome}: a commit that did not land must be reported, not swallowed`);
              // The exit code is asserted once, above, for every non-refused cell.
            } else if (outcome === "committed" && shapeChanges(shape)) {
              eq(headMoved, true,
                `${shape.name}/${outcome}: ${gt.changedIds.length} ticket(s) changed but nothing was committed`);
              const subject = execFileSync("git", ["-C", cliRoot, "log", "-1", "--format=%s"], { encoding: "utf8" });
              matches(subject, new RegExp(`\\b${gt.moved} ticket\\(s\\) moved`),
                `${shape.name}/${outcome}: the commit subject's moved count must equal the real one (${gt.moved})`);
            } else {
              eq(headMoved, false,
                `${shape.name}/${outcome}: nothing changed on disk, so nothing may be committed`);
            }
            assertCellBudget(clauses - cliCellStart, shape, outcome, "reconcile-cli");
            cellsEvaluated += 1;
          } finally {
            cliTeardown();
          }

          // ---------------------------------------------------------------
          // CONSUMER 3: commitOutcomeFrom + applySummary, driven by a REAL
          // `commitFile` / `commitOrQueue` result against a real git repo.
          // ---------------------------------------------------------------
          {
            const cellStart = clauses;   // BLZ-452: this cell's own budget
            const repo = mkdtempSync(join(tmp, `cor-${shape.name}-${outcome}-`));
            git(repo, "init", "-q", "-b", "main");
            git(repo, "config", "user.email", "t@t.t");
            git(repo, "config", "user.name", "t");
            const f = join(repo, "t.md");
            writeFileSync(f, "one\n");
            git(repo, "add", "-A");
            git(repo, "commit", "-q", "-m", "seed");

            let c;
            const headBefore = head(repo);
            if (outcome === "queued") {
              c = commitOrQueue({ root: repo, mode: "batch", op: "reconcile", id: "reconcile:ZZZ",
                message: "chore(board): reconcile", files: [f] });
            } else if (outcome === "no-op") {
              // The real thing: a byte-identical idempotent re-write. `git commit`
              // exits non-zero with "nothing to commit" and the staged tree is clean.
              writeFileSync(f, "one\n");
              c = commitFile(repo, f, "chore(board): reconcile");
            } else if (outcome === "locked") {
              assert.equal(acquireLock(repo, { session: "other" }).ok, true);
              writeFileSync(f, "two\n");
              c = commitFile(repo, f, "chore(board): reconcile", [], { retries: 0, delayMs: 1 });
              releaseLock(repo);
            } else if (outcome === "failed") {
              const hook = join(repo, ".git", "hooks", "pre-commit");
              writeFileSync(hook, "#!/bin/sh\nexit 1\n");
              execFileSync("chmod", ["+x", hook]);
              writeFileSync(f, "two\n");
              c = commitFile(repo, f, "chore(board): reconcile");
            } else {
              writeFileSync(f, "two\n");
              c = commitFile(repo, f, "chore(board): reconcile");
            }
            const headMoved = head(repo) !== headBefore;
            const { outcome: got, error } = commitOutcomeFrom(c);
            const line = applySummary({
              outcome: got, error, movedCount: gt.moved ?? 0, nonMovedCount: gt.other ?? 0,
            });

            // (2) git log is the whole ground truth here.
            eq(got === "committed", headMoved,
              `${shape.name}/${outcome}: commitOutcomeFrom said ${JSON.stringify(got)} but HEAD ` +
              `${headMoved ? "moved" : "did not move"} — a no-op must never be reported as a commit`);
            eq(Boolean(line && /^reconcile: committed /.test(line.text)), headMoved,
              `${shape.name}/${outcome}: the rendered line ${line ? JSON.stringify(line.text) : "(none)"} ` +
              `disagrees with git log about whether a commit exists`);
            if (got === "queued") {
              // (3) the ledger file, on disk.
              // commitOrQueue ran IN-PROCESS here, so its queue is whatever this
              // process's own sessionId() resolves to — computed the same way rather
              // than hard-coded.
              ok(readEntries(repo, sessionId(process.env)).length > 0,
                `${shape.name}/${outcome}: "queued" was reported with an empty ledger file`);
            }
            if (line && (got === "committed" || got === "queued")) {
              const m = /(\d+) ticket\(s\) moved/.exec(line.text);
              ok(m, `${shape.name}/${outcome}: the summary line states no moved count`);
              eq(Number(m[1]), gt.moved ?? 0,
                `${shape.name}/${outcome}: the summary line's moved count must equal the filesystem's`);
            }
            if (got === "locked" || got === "failed") {
              eq(line.exit, 1, `${shape.name}/${outcome}: an unlanded commit must exit non-zero`);
              eq(line.stream, "err", `${shape.name}/${outcome}: an unlanded commit must go to stderr`);
            }
            assertCellBudget(clauses - cellStart, shape, outcome, "commit-outcome-report");
            cellsEvaluated += 1;
            rmSync(repo, { recursive: true, force: true });
          }

          // ---------------------------------------------------------------
          // CONSUMER 4: `blaze commit`'s subject line (BLZ-427)
          // ---------------------------------------------------------------
          {
            const cellStart = clauses;   // BLZ-452: this cell's own budget
            // (3) the ledger FILE, read before it is drained.
            const queued = readEntries(cliRoot, "oracle");
            const headBefore = head(cliRoot);
            const flush = spawnSync(process.execPath, [COMMIT_BIN],
              { cwd: cliRoot, encoding: "utf8", env });
            const headAfter = head(cliRoot);
            const headMoved = headAfter !== headBefore;

            eq(headMoved, queued.length > 0,
              `${shape.name}/${outcome}: \`blaze commit\` ${headMoved ? "committed" : "committed nothing"} ` +
              `with ${queued.length} op(s) on the ledger — ${flush.stdout}${flush.stderr}`);

            if (queued.length === 0) {
              matches(`${flush.stdout}${flush.stderr}`, /nothing to flush/,
                `${shape.name}/${outcome}: an empty ledger must say so`);
            } else {
              const subject = execFileSync("git", ["-C", cliRoot, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
              matches(subject, /^blaze: \d{4}-\d{2}-\d{2} board update \(.+\)$/,
                `${shape.name}/${outcome}: unexpected subject shape: ${JSON.stringify(subject)}`);
              // (4)+(1): the reconcile op covers gt.changedIds.length TICKETS — the
              // count comes from the filesystem measurement, not from the ledger's own
              // arithmetic and not from anything reconcile returned.
              const reconcileOps = queued.filter((e) => e.op === "reconcile");
              eq(reconcileOps.length, 1,
                `${shape.name}/${outcome}: expected exactly one queued reconcile op, got ${reconcileOps.length}`);
              notMatches(subject, /\b\d+ reconcile\b/,
                `${shape.name}/${outcome}: the subject printed the raw op name — BLZ-427's missing label`);
              const n = /(\d+) reconciled/.exec(subject);
              ok(n, `${shape.name}/${outcome}: the subject does not state a reconciled ticket count: ` +
                JSON.stringify(subject));
              eq(Number(n[1]), gt.changedIds.length,
                `${shape.name}/${outcome}: the subject says ${n[1]} but ${gt.changedIds.length} ticket(s) ` +
                "really changed — one reconcile OP is not one ticket");
            }
            assertCellBudget(clauses - cellStart, shape, outcome, "blaze-commit-subject");
            cellsEvaluated += 1;
          }
          rmSync(cliRoot, { recursive: true, force: true });
        });
      }
    }

    // Non-vacuity: every clause the summary can emit was really emitted by at least
    // one generated cell, so no arm of the sentence is untested.
    deepEq([...clauseKindsSeen].sort(),
      ["clean", "cleared", "findings", "forge", "moves", "other", "refused"],
      "the cross-product did not exercise every clause the toast can render — " +
      `saw ${JSON.stringify([...clauseKindsSeen].sort())}`);
    assert.equal(cellsEvaluated, 160,
      `every one of the 160 cells must be evaluated; ${cellsEvaluated} were`);
    assert.equal(clauses, EXPECTED_CLAUSES,
      `the oracle executed ${clauses} clauses; the cross-product's own budget is ` +
      `${EXPECTED_CLAUSES}. Every cell already checked its own share, so a mismatch HERE ` +
      "means a clause was added or removed outside a cell — update budgetFor/perShapeBudget "
      + "deliberately rather than letting the oracle shrink");
  } finally {
    console.log(`BLZ-426 + BLZ-422 + BLZ-427 oracle: ${CELLS.length} cells, ${clauses} clauses executed ` +
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
