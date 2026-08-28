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
// dimension must fail this file rather than silently shrink it (BLZ-415/420/437 are
// open tickets for exactly that hole).
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

const RECONCILE_BIN = join(import.meta.dirname, "..", "scripts", "reconcile.mjs");
const COMMIT_BIN = join(import.meta.dirname, "..", "scripts", "commit-runner.mjs");

// =============================================================================
// The three dimensions
// =============================================================================

// `plant` names the condition the board is BUILT to contain; `expectFindings` and
// `expectForge` are the fixture's own statement of what it planted (source (4)) —
// presence/absence only. Counts always come from the filesystem or `git log`.
const SHAPES = [
  { name: "refused-unknown-project", plant: "merged", cliArgs: ["--project", "NOPE"],
    projects: ["NOPE"], refused: true, expectFindings: false, expectForge: false, ghFails: false },
  { name: "refused-no-key", plant: "merged", cliArgs: ["--project="],
    projects: [], refused: true, expectFindings: false, expectForge: false, ghFails: false },
  { name: "clean", plant: "none", cliArgs: [],
    projects: null, refused: false, expectFindings: false, expectForge: false, ghFails: false },
  { name: "moves-only", plant: "merged", cliArgs: [],
    projects: null, refused: false, expectFindings: false, expectForge: false, ghFails: false },
  { name: "cleared", plant: "ambiguous", cliArgs: [],
    projects: null, refused: false, expectFindings: true, expectForge: false, ghFails: false },
  { name: "findings", plant: "misfiled", cliArgs: [],
    projects: null, refused: false, expectFindings: true, expectForge: false, ghFails: false },
  { name: "forge-error", plant: "shipped", cliArgs: [],
    projects: null, refused: false, expectFindings: false, expectForge: true, ghFails: true },
  // A change that is NOT a move: a terminal ticket with a blank resolution and a
  // merged PR gets its resolution backfilled and its delivery record filled in
  // place. `changes` carries it, the directory does not change — which is exactly
  // the entry the toast used to count as a "code-bound move".
  { name: "non-moving-update", plant: "backfill", cliArgs: [],
    projects: null, refused: false, expectFindings: false, expectForge: false, ghFails: false },
];

const OUTCOMES = ["committed", "no-op", "queued", "locked", "failed"];

// Pinned deliberately: an oracle that prints its clause count but never asserts it
// shrinks silently when a dimension is deleted (BLZ-415/420/437 are open tickets for
// exactly that). Update this number only when an assertion is added or removed on
// purpose.
const EXPECTED_CLAUSES = 682;
const CONSUMERS = ["dashboard-toast", "reconcile-cli", "commit-outcome-report", "blaze-commit-subject"];

// =============================================================================
// Fixtures
// =============================================================================

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
  assert.ok(html.includes(src),
    "the served page does not contain reconcile-summary.mjs's own source — the dashboard " +
    "is running a DUPLICATE of the summary logic, which is what BLZ-426 exists to prevent");
  const i = html.indexOf(SUMMARY_FN_BEGIN);
  const j = html.indexOf(SUMMARY_FN_END);
  assert.ok(i !== -1 && j > i, "the served page carries no delimited reconcile-summary definition");
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

  const tmp = mkdtempSync(join(tmpdir(), "blz426-oracle-"));
  let clauses = 0;
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

      // The served page's own copy of the summary function, compiled from the HTML.
      const pageBoard = mkdtempSync(join(tmp, `page-${shape.name}-`));
      const summaryFn = summaryFnFromServedPage(materializeBoard(pageBoard, fixture));
      clauses += 2; // the containment + delimiter assertions inside the extractor

      let invariantText = null;

      for (const outcome of OUTCOMES) {
        await t.test(`${shape.name} × ${outcome}`, async () => {
          // ---------------------------------------------------------------
          // CONSUMER 1: dashboard-toast
          // ---------------------------------------------------------------
          {
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
            assert.equal(head(root), headBefore,
              `${shape.name}/${outcome}: the preview moved HEAD — a dry run must never commit`);
            clauses += 1;

            if (shape.refused) {
              assert.match(text, /REFUSED/,
                `${shape.name}/${outcome}: a refused preview must say so; it said ${JSON.stringify(text)}`);
              clauses += 1;
              assert.doesNotMatch(text, /no code-bound changes/,
                `${shape.name}/${outcome}: a refusal was rendered as an in-sync board — BLZ-426's own defect`);
              clauses += 1;
              assert.doesNotMatch(text, MOVES_RE,
                `${shape.name}/${outcome}: a refused run reported a move count it never computed`);
              clauses += 1;
            } else {
              // (1) filesystem: the counts a real apply pass produces on this fixture.
              const m = MOVES_RE.exec(text);
              if (gt.moved > 0) {
                assert.ok(m, `${shape.name}/${outcome}: ${gt.moved} ticket(s) really move but the toast says ` +
                  `${JSON.stringify(text)}`);
                clauses += 1;
                assert.equal(Number(m[1]), gt.moved,
                  `${shape.name}/${outcome}: the toast's move count must equal the real directory-change count`);
                clauses += 1;
              } else {
                assert.equal(m, null,
                  `${shape.name}/${outcome}: the toast claims moves that no apply pass makes`);
                clauses += 1;
              }
              const o = OTHER_RE.exec(text);
              if (gt.other > 0) {
                assert.ok(o, `${shape.name}/${outcome}: ${gt.other} non-moving write(s) really happen but the ` +
                  `toast folds them into (or hides them from) the move count: ${JSON.stringify(text)}`);
                clauses += 1;
                assert.equal(Number(o[1]), gt.other,
                  `${shape.name}/${outcome}: the toast's non-moving count must equal the real content-change count`);
                clauses += 1;
              } else {
                assert.equal(o, null,
                  `${shape.name}/${outcome}: the toast claims non-moving updates that never happen`);
                clauses += 1;
              }
              if (gt.moved === 0 && gt.other === 0) {
                assert.match(text, /no code-bound changes/,
                  `${shape.name}/${outcome}: a genuinely clean board must say so`);
                clauses += 1;
              }
              // cleared, from the filesystem: a ticket whose branch/pr lines vanished.
              const clearedGT = gt.changedIds.length === 0 ? 0 : countCleared(tmp, shape, fixture, env);
              const cl = CLEARED_RE.exec(text);
              assert.equal(cl ? Number(cl[1]) : 0, clearedGT,
                `${shape.name}/${outcome}: the toast's CLEARED count must equal the number of tickets whose ` +
                `branch/pr really disappeared from disk (${clearedGT})`);
              clauses += 1;
              // (4) fixture spec: presence only.
              assert.equal(/need attention/.test(text), shape.expectFindings,
                `${shape.name}/${outcome}: findings clause presence disagrees with what this board was built to contain`);
              clauses += 1;
              assert.equal(/forge problem\(s\)/.test(text), shape.expectForge,
                `${shape.name}/${outcome}: forge clause presence disagrees with what this board was built to contain`);
              clauses += 1;
            }
            // A preview never commits, so the commit environment must not change one
            // word of what it says. This is the outcome dimension's own assertion for
            // this consumer.
            if (invariantText === null) invariantText = text;
            else {
              assert.equal(text, invariantText,
                `${shape.name}/${outcome}: the toast changed wording with the COMMIT environment — ` +
                "a preview commits nothing and must read identically");
              clauses += 1;
            }
            cellsEvaluated += 1;
            rmSync(root, { recursive: true, force: true });
          }

          // ---------------------------------------------------------------
          // CONSUMER 2: the `reconcile --apply` CLI
          // ---------------------------------------------------------------
          const cliRoot = mkdtempSync(join(tmp, `cli-${shape.name}-${outcome}-`));
          materializeBoard(cliRoot, fixture);
          const cliTeardown = applyOutcomeEnv(cliRoot, outcome);
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
            assert.equal(/reconcile: committed /.test(res.stdout), headMoved,
              `${shape.name}/${outcome}: the CLI ${/reconcile: committed /.test(res.stdout) ? "claimed a commit" : "did not claim a commit"} ` +
              `but HEAD ${headMoved ? "moved" : "did not move"} — output was ${JSON.stringify(out)}`);
            clauses += 1;

            if (shape.refused) {
              assert.equal(res.status, 1, `${shape.name}/${outcome}: a refused run must exit non-zero`);
              clauses += 1;
              assert.match(res.stderr, /^reconcile: /m,
                `${shape.name}/${outcome}: a refused run must say why`);
              clauses += 1;
              assert.equal(headMoved, false,
                `${shape.name}/${outcome}: a refused run committed something`);
              clauses += 1;
            } else if (outcome === "queued") {
              assert.equal(headMoved, false,
                `${shape.name}/${outcome}: a batch-mode run must not commit`);
              clauses += 1;
              const ledger = readEntries(cliRoot, "oracle");
              assert.equal(/reconcile: queued /.test(res.stdout), ledger.length > 0,
                `${shape.name}/${outcome}: the CLI's "queued" claim must match the ledger file on disk`);
              clauses += 1;
            } else if ((outcome === "locked" || outcome === "failed") && gt.changedIds.length > 0) {
              assert.equal(headMoved, false,
                `${shape.name}/${outcome}: nothing may be committed when the commit could not run`);
              clauses += 1;
              assert.match(res.stderr, /FAILED TO COMMIT/,
                `${shape.name}/${outcome}: a commit that did not land must be reported, not swallowed`);
              clauses += 1;
              assert.equal(res.status, 1, `${shape.name}/${outcome}: a failed commit must exit non-zero`);
              clauses += 1;
            } else if (outcome === "committed" && gt.changedIds.length > 0) {
              assert.equal(headMoved, true,
                `${shape.name}/${outcome}: ${gt.changedIds.length} ticket(s) changed but nothing was committed`);
              clauses += 1;
              const subject = execFileSync("git", ["-C", cliRoot, "log", "-1", "--format=%s"], { encoding: "utf8" });
              assert.match(subject, new RegExp(`\\b${gt.moved} ticket\\(s\\) moved`),
                `${shape.name}/${outcome}: the commit subject's moved count must equal the real one (${gt.moved})`);
              clauses += 1;
            } else {
              assert.equal(headMoved, false,
                `${shape.name}/${outcome}: nothing changed on disk, so nothing may be committed`);
              clauses += 1;
            }
            cellsEvaluated += 1;
          } finally {
            cliTeardown();
          }

          // ---------------------------------------------------------------
          // CONSUMER 3: commitOutcomeFrom + applySummary, driven by a REAL
          // `commitFile` / `commitOrQueue` result against a real git repo.
          // ---------------------------------------------------------------
          {
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
            assert.equal(got === "committed", headMoved,
              `${shape.name}/${outcome}: commitOutcomeFrom said ${JSON.stringify(got)} but HEAD ` +
              `${headMoved ? "moved" : "did not move"} — a no-op must never be reported as a commit`);
            clauses += 1;
            assert.equal(Boolean(line && /^reconcile: committed /.test(line.text)), headMoved,
              `${shape.name}/${outcome}: the rendered line ${line ? JSON.stringify(line.text) : "(none)"} ` +
              `disagrees with git log about whether a commit exists`);
            clauses += 1;
            if (got === "queued") {
              // (3) the ledger file, on disk.
              // commitOrQueue ran IN-PROCESS here, so its queue is whatever this
              // process's own sessionId() resolves to — computed the same way rather
              // than hard-coded.
              assert.ok(readEntries(repo, sessionId(process.env)).length > 0,
                `${shape.name}/${outcome}: "queued" was reported with an empty ledger file`);
              clauses += 1;
            }
            if (line && (got === "committed" || got === "queued")) {
              const m = /(\d+) ticket\(s\) moved/.exec(line.text);
              assert.ok(m, `${shape.name}/${outcome}: the summary line states no moved count`);
              clauses += 1;
              assert.equal(Number(m[1]), gt.moved ?? 0,
                `${shape.name}/${outcome}: the summary line's moved count must equal the filesystem's`);
              clauses += 1;
            }
            if (got === "locked" || got === "failed") {
              assert.equal(line.exit, 1, `${shape.name}/${outcome}: an unlanded commit must exit non-zero`);
              clauses += 1;
              assert.equal(line.stream, "err", `${shape.name}/${outcome}: an unlanded commit must go to stderr`);
              clauses += 1;
            }
            cellsEvaluated += 1;
            rmSync(repo, { recursive: true, force: true });
          }

          // ---------------------------------------------------------------
          // CONSUMER 4: `blaze commit`'s subject line (BLZ-427)
          // ---------------------------------------------------------------
          {
            // (3) the ledger FILE, read before it is drained.
            const queued = readEntries(cliRoot, "oracle");
            const headBefore = head(cliRoot);
            const flush = spawnSync(process.execPath, [COMMIT_BIN],
              { cwd: cliRoot, encoding: "utf8", env });
            const headAfter = head(cliRoot);
            const headMoved = headAfter !== headBefore;

            assert.equal(headMoved, queued.length > 0,
              `${shape.name}/${outcome}: \`blaze commit\` ${headMoved ? "committed" : "committed nothing"} ` +
              `with ${queued.length} op(s) on the ledger — ${flush.stdout}${flush.stderr}`);
            clauses += 1;

            if (queued.length === 0) {
              assert.match(`${flush.stdout}${flush.stderr}`, /nothing to flush/,
                `${shape.name}/${outcome}: an empty ledger must say so`);
              clauses += 1;
            } else {
              const subject = execFileSync("git", ["-C", cliRoot, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
              assert.match(subject, /^blaze: \d{4}-\d{2}-\d{2} board update \(.+\)$/,
                `${shape.name}/${outcome}: unexpected subject shape: ${JSON.stringify(subject)}`);
              clauses += 1;
              // (4)+(1): the reconcile op covers gt.changedIds.length TICKETS — the
              // count comes from the filesystem measurement, not from the ledger's own
              // arithmetic and not from anything reconcile returned.
              const reconcileOps = queued.filter((e) => e.op === "reconcile");
              assert.equal(reconcileOps.length, 1,
                `${shape.name}/${outcome}: expected exactly one queued reconcile op, got ${reconcileOps.length}`);
              clauses += 1;
              assert.doesNotMatch(subject, /\b\d+ reconcile\b/,
                `${shape.name}/${outcome}: the subject printed the raw op name — BLZ-427's missing label`);
              clauses += 1;
              const n = /(\d+) reconciled/.exec(subject);
              assert.ok(n, `${shape.name}/${outcome}: the subject does not state a reconciled ticket count: ` +
                JSON.stringify(subject));
              clauses += 1;
              assert.equal(Number(n[1]), gt.changedIds.length,
                `${shape.name}/${outcome}: the subject says ${n[1]} but ${gt.changedIds.length} ticket(s) ` +
                "really changed — one reconcile OP is not one ticket");
              clauses += 1;
            }
            cellsEvaluated += 1;
          }
          rmSync(cliRoot, { recursive: true, force: true });
        });
      }
    }

    // Non-vacuity: every clause the summary can emit was really emitted by at least
    // one generated cell, so no arm of the sentence is untested.
    assert.deepEqual([...clauseKindsSeen].sort(),
      ["clean", "cleared", "findings", "forge", "moves", "other", "refused"],
      "the cross-product did not exercise every clause the toast can render — " +
      `saw ${JSON.stringify([...clauseKindsSeen].sort())}`);
    clauses += 1;
    assert.equal(cellsEvaluated, 160,
      `every one of the 160 cells must be evaluated; ${cellsEvaluated} were`);
    assert.equal(clauses, EXPECTED_CLAUSES,
      `the oracle executed ${clauses} clauses, expected ${EXPECTED_CLAUSES} — assertions were added or ` +
      "removed; update the constant deliberately rather than letting the oracle silently shrink");
  } finally {
    console.log(`BLZ-426 + BLZ-422 + BLZ-427 oracle: ${CELLS.length} cells, ${clauses} clauses executed.`);
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
