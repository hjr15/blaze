// tests/reconcile-change-report-oracle.test.mjs — BLZ-401 + BLZ-406.
//
// THE ASSERTION: every line reconcile PRINTS, and every count it COMMITS, matches
// what actually happened to the files on disk. Nothing here trusts `r.changes`,
// `decide()`, or the printed output as its own witness — GROUND TRUTH IS THE
// FILESYSTEM AND `git show` OF THE COMMIT, exactly as the lane brief requires,
// because a prior lane pinned only the case that made its own claim true, five
// times in a row.
//
// So this file drives the REAL CLI (`node scripts/reconcile.mjs`) as a subprocess —
// never the library function's `r.changes` array as a stand-in for what a person
// actually sees — and parses its stdout/stderr the way a person would read them.
// A renderer mutation that keeps `r.changes` structurally correct but prints the
// wrong words (BLZ-401's own defect) is invisible to a test that only inspects the
// object; it is exactly what this file is built to catch.
//
// Cross-product, ONE board, nested loops (not a hand-written list):
//   status   ∈ defined / in-progress / in-review / done
//   signal   ∈ none / branch-only / OPEN PR / MERGED PR / CLOSED PR /
//              shipped-commit-only / AMBIGUOUS merged set
//   resolution ∈ blank / set
//   record     ∈ absent / present
// = 4 × 7 × 2 × 2 = 112 tickets, plus one MISFILED ticket (BLZ-406): its directory
// is one project's, its frontmatter names another's, and it carries its own MERGED
// PR so it is provably movable — a misfiled ticket with no signal at all would
// "pass" the scope test by being inert either way, which proves nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// =============================================================================
// BLZ-465: THE COUNTER IS THE ASSERTION, AND THE TOTAL IS ASSERTED.
//
// This file used to end by PRINTING its clause total and nothing more. Review measured the consequence: deleting BLZ-435's own newly-added
// `deepEqual(mismatchReported, mismatchedGT)` clause TOGETHER WITH its
// `totalChecked += 1` dropped the banner from 1861 to 1856 and left the file 6/6
// GREEN. An honest count that nothing checks is not evidence of anything.
//
// Two changes close that, copied from `tests/board-overstatement-oracle.test.mjs`
// (BLZ-414/BLZ-444/BLZ-452), with `schema-audit-load-agreement-oracle.test.mjs`'s
// `check()`/`sameSet()` as the older precedent:
//
//   1. These wrappers are the ONLY way the counter moves. A deleted clause takes its
//      count with it, so it cannot be deleted "together with its counter" any more —
//      there is no separate counter to delete.
//   2. Every run mode asserts its own executed count against a budget DERIVED from the
//      cross-product's shape: the mode's own flags, plus the before/after FILESYSTEM
//      snapshots (which ticket really moved, which file really changed). Nothing is
//      read off a passing run, and the file total is the sum of the per-mode budgets,
//      so it cannot be fitted either. A lost clause names the MODE it was lost from.
//
// THE BINDING IS ONE-DIRECTIONAL, and it would be this file's own defect to claim
// otherwise. A DELETED clause is caught: its count vanishes and the mode's budget names
// the gap. An ADDED clause written as a bare `assert.` is NOT caught — it is simply
// uncounted, and the file stays green. So: write new clauses through the wrappers.
// Nothing here will remind you.
//
// The bare `assert.` calls that remain are deliberately NOT clauses: fixture
// preconditions (reconcile exited 0; the ground-truth board is the same fixture) and
// meta-assertions about the budget itself.
// =============================================================================
let clauses = 0;
const eq = (a, b, msg) => { clauses += 1; assert.equal(a, b, msg); };
const ok = (c, msg) => { clauses += 1; assert.ok(c, msg); };
const matches = (t, re, msg) => { clauses += 1; assert.match(t, re, msg); };
const notMatches = (t, re, msg) => { clauses += 1; assert.doesNotMatch(t, re, msg); };
const deepEq = (a, b, msg) => { clauses += 1; assert.deepEqual(a, b, msg); };

const RECONCILE_BIN = join(import.meta.dirname, "..", "scripts", "reconcile.mjs");

const STATUSES = ["defined", "in-progress", "in-review", "done"];
const SIGNALS = ["none", "branch-only", "open-pr", "merged-pr", "closed-pr", "shipped-only", "ambiguous-merged"];
const RESOLUTIONS = ["blank", "set"];
const RECORDS = ["absent", "present"];

// =============================================================================
// Fixture construction — the git signal is built ONCE (read-only after this);
// the ticket TREE is materialized fresh per run mode, since apply mutates it.
// =============================================================================

function git(repo, ...args) { execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }); }

/** Builds the shared code repo and returns the cross-product's descriptors:
 *  every ticket this test will create, plus the `gh pr list` payload that
 *  corroborates the PR-shaped signals. Git branches/commits are created HERE,
 *  once, for the signals that need real git state (branch-only, shipped-only). */
function buildFixture(tmp) {
  const codeRepo = join(tmp, "repo-zzz");
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
  let n = 1;
  let prNumber = 1;

  for (const status of STATUSES) {
    for (const signal of SIGNALS) {
      for (const resolution of RESOLUTIONS) {
        for (const record of RECORDS) {
          const id = `ZZZ-${n}`;
          n += 1;
          tickets.push({ id, status, signal, resolution, record });

          if (signal === "branch-only") {
            git(codeRepo, "checkout", "-q", "-b", `${id}-work`);
            git(codeRepo, "commit", "-q", "--allow-empty", "-m", `${id}: work`);
            git(codeRepo, "checkout", "-q", "main");
          } else if (signal === "shipped-only") {
            git(codeRepo, "commit", "-q", "--allow-empty", "-m", `${id}: work`);
          } else if (signal === "open-pr" || signal === "merged-pr" || signal === "closed-pr") {
            const state = signal === "open-pr" ? "OPEN" : signal === "merged-pr" ? "MERGED" : "CLOSED";
            prs.push({ number: prNumber, state, url: `https://github.com/hjr15/zzz/pull/${prNumber}`,
                       headRefName: `${id}-work`, title: `${id}: work` });
            prNumber += 1;
          } else if (signal === "ambiguous-merged") {
            prs.push({ number: prNumber, state: "MERGED", url: `https://github.com/hjr15/zzz/pull/${prNumber}`,
                       headRefName: `${id}-work-a`, title: `${id}: work a` });
            prNumber += 1;
            prs.push({ number: prNumber, state: "MERGED", url: `https://github.com/hjr15/zzz/pull/${prNumber}`,
                       headRefName: `${id}-work-b`, title: `${id}: work b` });
            prNumber += 1;
          }
        }
      }
    }
  }

  // BLZ-406: the misfiled ticket. Directory ZZZ, frontmatter says YYY — no wait,
  // the other way round reads better against the two-project convention below:
  // it sits under YYY's directory but its frontmatter claims project ZZZ, and it
  // carries its OWN merged PR (in ZZZ's repo) so an unfiltered run really can move
  // it — otherwise this proves nothing about scope, only that an inert ticket
  // stays inert.
  const misfiled = { id: "ZZZ-999", dirProject: "YYY", fmProject: "ZZZ" };
  prs.push({ number: prNumber, state: "MERGED", url: `https://github.com/hjr15/zzz/pull/${prNumber}`,
             headRefName: `${misfiled.id}-work`, title: `${misfiled.id}: work` });
  prNumber += 1;

  return { codeRepo, tickets, prs, misfiled };
}

function materializeBoard(root, { codeRepo, tickets, misfiled }, cfgExtra = {}) {
  const projectsDir = join(root, "projects");
  for (const t of tickets) {
    const dir = join(projectsDir, "ZZZ", t.status);
    mkdirSync(dir, { recursive: true });
    let fm = `---\nid: ${t.id}\ntype: task\nproject: ZZZ\nestimate: 30\n`;
    if (t.resolution === "set") fm += "resolution: done\n";
    if (t.record === "present") {
      fm += `branch: ${t.id}-old-branch\npr: '#9000 — https://github.com/hjr15/zzz/pull/9000'\n`;
    }
    fm += "---\n\nbody\n";
    writeFileSync(join(dir, `${t.id}-t.md`), fm);
  }

  const misDir = join(projectsDir, misfiled.dirProject, "defined");
  mkdirSync(misDir, { recursive: true });
  writeFileSync(join(misDir, `${misfiled.id}-t.md`),
    `---\nid: ${misfiled.id}\ntype: task\nproject: ${misfiled.fmProject}\nestimate: 30\n---\n\nbody\n`);

  mkdirSync(join(projectsDir, "ZZZ"), { recursive: true });
  writeFileSync(join(projectsDir, "ZZZ", "project.json"), JSON.stringify({ key: "ZZZ", codeRepos: [codeRepo] }));
  mkdirSync(join(projectsDir, "YYY"), { recursive: true });
  writeFileSync(join(projectsDir, "YYY", "project.json"), JSON.stringify({ key: "YYY", codeRepos: [] }));
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "ZZZ", projects: ["ZZZ", "YYY"], ...cfgExtra }));

  for (const a of [["init", "-q"], ["config", "user.email", "t@t.t"], ["config", "user.name", "t"],
                   ["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    git(root, ...a);
  }
}

function stubGh(prs, tmp) {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  return bin;
}

// =============================================================================
// Ground truth — the filesystem, nothing else
// =============================================================================

/** Map<id, {project, dir, file, raw}> read directly off disk. `dir` is the
 *  status directory the file actually sits in RIGHT NOW — that is BLZ-406's own
 *  "the directory is status" fact, applied as the oracle's ground truth. */
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
        const file = join(statusPath, f);
        const raw = readFileSync(file, "utf8");
        const idm = /^id:\s*(\S+)/m.exec(raw);
        if (!idm) continue;
        out.set(idm[1], { project, dir: status, file, raw });
      }
    }
  }
  return out;
}

const MOVE_RE = /^(?:moved|would move) (\S+): (\S+) → (\S+)/;
const NONMOVE_RE = /^(?:updated|would update) (\S+) \(still (\S+)\)/;

// BLZ-401 (adversarial round, finding 1): the per-ticket MOVE_RE/NONMOVE_RE lines were
// the only surfaces the oracle pinned. Two more readers state the SAME two quantities in
// aggregate — the dry-run tail line, and the `--apply` summary line (committed or, on a
// `commitMode: "batch"` board, queued) — and both were provably unguarded: reverting
// either verbatim to its pre-BLZ-401 wording (or to a wrong number) left the whole suite
// green. These three regexes pin them against the same ground truth as everything else
// in this file.
const DRYRUN_TAIL_RE = /\(dry-run: (\d+) move\(s\)(?:, (\d+) other update\(s\))?; rerun with --apply to write locally — reconcile never pushes\)/;
const COMMITTED_LINE_RE = /reconcile: committed (\d+) ticket\(s\) moved(?:, (\d+) ticket\(s\) updated without a status change)?\./;
const QUEUED_LINE_RE = /reconcile: queued \(commitMode: batch\) — run `blaze commit` to flush (\d+) ticket\(s\) moved(?:, (\d+) ticket\(s\) updated without a status change)?\./;
// BLZ-477: reconcile.mjs's COMMIT SUBJECT, named. It was pinned only by an inline regex
// built at the call site, which is why `reconcile-commit-report.mjs` and
// `reconcile-summary.mjs` could both credit the wrong constants with pinning it — the two
// above match `res.stdout`, which is `applySummary`'s line, i.e. those modules' OWN site.
// A factory rather than a literal because the count is ground truth from the filesystem.
const COMMIT_SUBJECT_MOVED_RE = (moved) => new RegExp(`\\b${moved} ticket\\(s\\) moved`);
const COMMIT_SUBJECT_NONMOVED_RE = (nonMoved) =>
  new RegExp(`\\b${nonMoved} ticket\\(s\\) updated without a status change`);

/** Asserts a two-quantity summary line (dry-run tail, --apply committed, or --apply
 *  queued) states exactly the ground-truth moved/non-moved counts — including the
 *  absence of the second clause when there is nothing non-moving to report, the same
 *  rule the commit-message check below already enforces.
 *
 *  BLZ-438: EXACTLY ONE line may match. `re.exec` returns only the FIRST match of an
 *  unanchored pattern, so a second, contradictory summary line — the same reader
 *  printed twice, the second one claiming a different number — was entirely unpinned:
 *  verified by making reconcile print a duplicate tail claiming 999 moves and a
 *  duplicate committed line claiming 999 tickets, under which this whole file stayed
 *  5/5 green. Uniqueness is checked before the contents, because "the first one is
 *  right" is not the claim these readers make.
 *
 *  BLZ-437 counted this call site as ONE assertion when it executes four, understating
 *  the file's banner by 2 per call site (8 across the four of them: a printed 1,494
 *  against a real 1,502) and it was fixed by RETURNING the executed count for the caller
 *  to add. BLZ-465 removes the arithmetic entirely: the four clauses count themselves,
 *  through the wrappers, so the figure cannot be wrong and cannot be dropped. Always
 *  exactly 4, whichever branch the non-moved clause takes — which is why the budget can
 *  state it as a constant. */
function assertSummaryLine({ label, what, re, text, movedGT, nonMovedGT }) {
  const all = String(text).match(new RegExp(re.source, `${re.flags}g`)) || [];
  eq(all.length, 1,
    `${label}: expected exactly ONE ${what} line, found ${all.length} — ` +
    (all.length === 0
      ? "the reader printed no such line at all"
      : "a doubled summary line states the quantity twice and a reader has no way to know " +
        "which is meant") +
    `: ${JSON.stringify(all)}\nfull text: ${JSON.stringify(text)}`);
  const m = re.exec(text);
  ok(m, `${label}: no ${what} line matched the expected shape in: ${JSON.stringify(text)}`);
  eq(Number(m[1]), movedGT, `${label}: the ${what} line's moved count must equal the real directory-change count (${movedGT})`);
  if (nonMovedGT > 0) {
    eq(Number(m[2]), nonMovedGT, `${label}: the ${what} line must also state the real non-moving write count (${nonMovedGT})`);
  } else {
    eq(m[2], undefined, `${label}: the ${what} line claims non-moving updates that did not really happen`);
  }
}
const SUMMARY_LINE_CLAUSES = 4;   // uniqueness, shape, moved count, non-moved count

/** Parses the CLI's stdout into the two shapes of line it emits: a claimed MOVE
 *  and a claimed non-moving update. Anything else on stdout (the dry-run tail
 *  line, "no code-bound change found") is deliberately ignored here. */
function parseChangeLines(stdout) {
  const moves = new Map();   // id -> {from, to, line}
  const nonMoves = new Map(); // id -> {status, line}
  for (const line of stdout.split("\n")) {
    const m = MOVE_RE.exec(line);
    if (m) { moves.set(m[1], { from: m[2], to: m[3], line }); continue; }
    const nm = NONMOVE_RE.exec(line);
    if (nm) { nonMoves.set(nm[1], { status: nm[2], line }); continue; }
  }
  return { moves, nonMoves };
}

/** The oracle itself: cross-checks the CLI's rendered lines against what really
 *  happened to the ticket tree.
 *
 *  BLZ-465: it no longer counts anything — the wrappers do — and its clause count per
 *  ticket is now a function of the FILESYSTEM alone, so `oracleBudget` below can state
 *  it in advance. The one change that made that possible: (e1) and (e2) used to be two
 *  separately-gated implications, each counted only when its own gate opened, so the
 *  per-ticket count depended on what the CLI PRINTED — the subject. They are one
 *  BICONDITIONAL now. That is exactly their conjunction (`p -> q` and `q -> p`), so
 *  nothing is weakened, and it runs once per non-moving ticket whatever the CLI said. */
function assertOracle({ label, before, after, stdout }) {
  const { moves, nonMoves } = parseChangeLines(stdout);
  const allIds = new Set([...before.keys(), ...after.keys()]);

  for (const id of allIds) {
    const b = before.get(id), a = after.get(id);
    const dirChanged = Boolean(b) && Boolean(a) && b.dir !== a.dir;
    const moveLine = moves.get(id);
    const nonMoveLine = nonMoves.get(id);

    if (dirChanged) {
      // c) exactly one line, and it claims a move.
      ok(moveLine, `${label}: ${id} really moved ${b.dir} -> ${a.dir} but no rendered line claims it`);
      eq(nonMoveLine, undefined,
        `${label}: ${id} really moved but ALSO has a non-move line — two accounts of one ticket`);
      // a) the from/to on that line are the REAL directories.
      eq(moveLine.from, b.dir, `${label}: ${id}'s rendered 'from' does not match its real prior directory`);
      eq(moveLine.to, a.dir, `${label}: ${id}'s rendered 'to' does not match its real new directory`);
    } else {
      // b) no ticket whose directory did NOT change has a line claiming a move.
      eq(moveLine, undefined,
        `${label}: ${id}'s directory did not change, but a line claims it moved: ${moveLine && moveLine.line}`);
    }

    if (!dirChanged && b && a) {
      const contentChanged = b.raw !== a.raw;
      // e) a non-move line exists EXACTLY where the file really changed. Both
      // directions at once: a line for a byte-identical file is a claimed write that
      // never happened, and a real write with no line is D4's silently-dropped report.
      eq(Boolean(nonMoveLine), contentChanged,
        `${label}: ${id} ${contentChanged ? "really changed on disk" : "is byte-identical on disk"} ` +
        `but the report ${nonMoveLine ? "claims" : "does not claim"} a non-moving update` +
        `${nonMoveLine ? `: "${nonMoveLine.line}"` : ""}`);
    }
  }
}

/** How many clauses `assertOracle` executes for this before/after pair — derived from
 *  the FILESYSTEM, which is this file's ground truth, and never from the CLI's output.
 *  Four clauses for a ticket that really moved, one for a ticket that did not, plus the
 *  move/non-move biconditional for every ticket present in both snapshots. */
function oracleBudget(before, after) {
  let n = 0;
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(id), a = after.get(id);
    const dirChanged = Boolean(b) && Boolean(a) && b.dir !== a.dir;
    n += dirChanged ? 4 : 1;
    if (!dirChanged && b && a) n += 1;
  }
  return n;
}

/** Every clause one run mode executes, from the mode's own coordinates plus the
 *  filesystem. Nothing here is read off a passing run. */
function modeBudget(mode, before, after) {
  return oracleBudget(before, after)
    // A dry run must have written nothing: one clause per ticket on disk.
    + (mode.groundArgs ? before.size : 0)
    // The misfiled ticket is named, and the finding says why (2); BLZ-435's negative
    // side — the reported set IS the real set, and the real set is non-empty (2).
    + 4
    + (mode.dryRunTail ? SUMMARY_LINE_CLAUSES : 0)
    // The commit message's two quantities (2, whichever branch the second takes), then
    // the CLI's own committed/queued summary line (4). A queued run defers the commit,
    // so it has no subject to read.
    + (mode.commit ? (mode.queued ? 0 : 2) + SUMMARY_LINE_CLAUSES : 0);
}

// =============================================================================
// The three run modes the lane brief names
// =============================================================================

test("BLZ-401 + BLZ-406: the change report matches the filesystem, across the cross-product", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "blz401-oracle-"));
  clauses = 0;
  let expectedClauses = 0;
  let modesRun = 0;
  try {
    const fixture = buildFixture(tmp);
    const bin = stubGh(fixture.prs, tmp);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

    // `groundArgs` is the equivalent `--apply` invocation used ONLY to produce ground
    // truth for a dry run — dry-run BY DEFINITION writes nothing, so its own
    // before/after snapshot is always identical and cannot be the ground truth for
    // what it PREDICTS. The predictions are checked against a real `--apply` pass over
    // an IDENTICALLY materialized, otherwise untouched copy of the same board.
    const modes = [
      { label: "dry-run (unfiltered)", args: [], groundArgs: ["--apply"], commit: false, apply: false, dryRunTail: true },
      { label: "--apply (unfiltered)", args: ["--apply"], commit: true, apply: true },
      { label: "--apply --project ZZZ", args: ["--project", "ZZZ", "--apply"], commit: true, apply: true },
      // BLZ-401 (adversarial round, finding 1): the `queued` outcome — a
      // `commitMode: "batch"` board — states the identical two quantities through its
      // OWN wording branch (`reconcile: queued (commitMode: batch) — run \`blaze
      // commit\` to flush …`), a distinct code path from "committed" that nothing
      // exercised before this round. Files still land on disk (queueing only defers
      // the git commit), so the same filesystem ground truth applies; there is no
      // commit to read a subject line off, so this mode is checked via the CLI's own
      // stdout instead of `git log`.
      { label: "--apply (unfiltered, commitMode: batch — queued)", args: ["--apply"], commit: true, apply: true,
        queued: true, cfgExtra: { commitMode: "batch" } },
      // BLZ-439: the queued branch was exercised ONLY on an unfiltered run. `--project`
      // and `commitMode: "batch"` are independent switches and the queue is built from
      // `keys` — the very list `--project` narrows — so "queued" and "scoped" is a cell
      // nothing covered. Verified vacuous: making `commitOrQueue` fall back to "per-op"
      // whenever a `--project` filter is present (so a scoped batch board COMMITS
      // instead of queueing) left this whole file 5/5 green.
      { label: "--apply --project ZZZ (commitMode: batch — queued, scoped)",
        args: ["--project", "ZZZ", "--apply"], commit: true, apply: true,
        queued: true, cfgExtra: { commitMode: "batch" } },
    ];

    for (const mode of modes) {
      await t.test(mode.label, () => {
        const modeStart = clauses;
        const root = mkdtempSync(join(tmp, "board-"));
        materializeBoard(root, fixture, mode.cfgExtra);
        const projectsDir = join(root, "projects");
        const before = snapshotBoard(projectsDir);

        const res = spawnSync(process.execPath, [RECONCILE_BIN, ...mode.args],
          { cwd: root, encoding: "utf8", env });
        assert.equal(res.status, 0, `${mode.label}: reconcile exited non-zero — ${res.stderr}`);

        let after = snapshotBoard(projectsDir);
        if (mode.groundArgs) {
          // Sanity check first: a dry run must ITSELF have written nothing at all —
          // that is the premise for needing a companion apply run as ground truth.
          for (const [id, a] of after) {
            deepEq(a, before.get(id), `${mode.label}: dry-run wrote to ${id}'s file — it must write nothing`);
          }
          const groundRoot = mkdtempSync(join(tmp, "ground-"));
          materializeBoard(groundRoot, fixture, mode.cfgExtra);
          const groundBefore = snapshotBoard(join(groundRoot, "projects"));
          const groundRes = spawnSync(process.execPath, [RECONCILE_BIN, ...mode.groundArgs],
            { cwd: groundRoot, encoding: "utf8", env });
          assert.equal(groundRes.status, 0, `${mode.label}: ground-truth apply run exited non-zero — ${groundRes.stderr}`);
          after = snapshotBoard(join(groundRoot, "projects"));
          // The dry run's OWN before must line up with the ground run's before — both
          // are fresh copies of the identical fixture, so this is a fixture sanity
          // check, not part of the oracle proper.
          assert.deepEqual([...before.keys()].sort(), [...groundBefore.keys()].sort(),
            `${mode.label}: the ground-truth board is not the same fixture as the dry-run board`);
        }
        assertOracle({ label: mode.label, before, after, stdout: res.stdout });

        // f) the misfiled ticket's mismatch is reported on EVERY run mode, including
        // the one that filters it out of scope entirely (--project ZZZ: its directory
        // is YYY, so the scope guard skips it before it can ever move).
        const misfiledLine = res.stderr.split("\n")
          .find((l) => l.includes("NEEDS ATTENTION") && l.includes(fixture.misfiled.id));
        ok(misfiledLine, `${mode.label}: no project-mismatch finding for ${fixture.misfiled.id} — ` +
          `stderr:\n${res.stderr}`);
        matches(misfiledLine, /no single-project run/,
          `${mode.label}: the finding must say no single-project run reconciles it`);

        // BLZ-435: the NEGATIVE side. Until this ticket the only clause was "the
        // misfiled ticket IS named", which a guard that fired for every one of the 113
        // tickets on this board satisfies just as well — the finding had no way to be
        // caught over-firing in its own suite. Ground truth is the FILESYSTEM: a
        // ticket is mismatched exactly when its directory project and its frontmatter
        // `project:` are both present and disagree, read off the snapshot, never from
        // anything reconcile reported.
        const mismatchedGT = [...before.entries()]
          .filter(([, t]) => {
            const fm = /^project:\s*(\S+)\s*$/m.exec(t.raw);
            return fm && fm[1] !== t.project;
          })
          .map(([id]) => id).sort();
        const mismatchReported = [...new Set(res.stderr.split("\n")
          .filter((l) => l.includes("NEEDS ATTENTION"))
          .map((l) => (/(\b[A-Z][A-Z0-9]*-\d+) sits under projects\//.exec(l) || [])[1])
          .filter(Boolean))].sort();
        deepEq(mismatchReported, mismatchedGT,
          `${mode.label}: the set of tickets reported as project-mismatched must be exactly ` +
          `the set that really is one on disk (${JSON.stringify(mismatchedGT)}), not ` +
          `${JSON.stringify(mismatchReported)} — a finding that fires for a WELL-FILED ticket ` +
          "is as wrong as one that misses a misfiled one");
        // Non-vacuity for the clause above: an empty ground-truth set would make the
        // equality hold for a guard that never fires at all.
        eq(mismatchedGT.length, 1,
          `${mode.label}: the fixture must contain exactly one genuinely misfiled ticket, ` +
          `it contains ${mismatchedGT.length}`);

        // Ground truth for every aggregate-count reader below (the dry-run tail, the
        // --apply commit message, and the --apply/queued summary line): the SAME two
        // quantities the per-ticket oracle above already checked line-by-line, computed
        // once here from the filesystem, not from anything reconcile printed.
        const movedGT = [...before.keys()].filter((id) => {
          const b = before.get(id), a = after.get(id);
          return b && a && b.dir !== a.dir;
        }).length;
        const nonMovedGT = [...before.keys()].filter((id) => {
          const b = before.get(id), a = after.get(id);
          return b && a && b.dir === a.dir && b.raw !== a.raw;
        }).length;

        // BLZ-401 (adversarial round, finding 1): the dry-run tail line — the surface a
        // person reads before believing the board on the default, no-flags invocation —
        // was provably unpinned; reverting it verbatim to its pre-BLZ-401 wording, or to
        // either count being wrong, left the whole suite green. Pinned here against the
        // same ground truth as every other reader.
        if (mode.dryRunTail) {
          assertSummaryLine({ label: mode.label, what: "dry-run tail",
            re: DRYRUN_TAIL_RE, text: res.stdout, movedGT, nonMovedGT });
        }

        if (mode.commit) {
          // d) the --apply commit message's two quantities, both from ground truth.
          // Only meaningful when a commit actually happened — a queued (`commitMode:
          // "batch"`) run defers the commit entirely, so there is no new subject line
          // to read; that outcome is pinned via the CLI's own stdout instead, below.
          if (!mode.queued) {
            const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%B"], { encoding: "utf8" });
            matches(subject, COMMIT_SUBJECT_MOVED_RE(movedGT),
              `${mode.label}: commit message's moved count must equal the real directory-change count (${movedGT})`);
            if (nonMovedGT > 0) {
              matches(subject, COMMIT_SUBJECT_NONMOVED_RE(nonMovedGT),
                `${mode.label}: commit message must also state the real non-moving write count (${nonMovedGT})`);
            } else {
              notMatches(subject, /updated without a status change/,
                `${mode.label}: commit message claims non-moving updates that did not really happen`);
            }
          }

          // BLZ-401 (adversarial round, finding 1): the CLI's own `--apply` summary
          // line — committed or queued — states the identical two quantities and was
          // just as unpinned as the dry-run tail; the queued branch in particular was
          // not exercised by any test before this round.
          assertSummaryLine({
            label: mode.label,
            what: mode.queued ? "queued summary" : "committed summary",
            re: mode.queued ? QUEUED_LINE_RE : COMMITTED_LINE_RE,
            text: res.stdout, movedGT, nonMovedGT,
          });
        }

        // BLZ-465: THIS MODE'S OWN BUDGET. A deleted clause fails HERE, naming the run
        // mode it was deleted from, rather than surfacing as a wrong grand total with
        // no indication of where the evidence went — and it can no longer be deleted
        // "with its counter", because the wrappers ARE the counter.
        const budget = modeBudget(mode, before, after);
        assert.equal(clauses - modeStart, budget,
          `${mode.label}: this mode executed ${clauses - modeStart} clause(s); its own ` +
          `coordinates plus the filesystem budget ${budget}. A clause was added or removed ` +
          "in this arm — update modeBudget/oracleBudget to match the code, deliberately");
        expectedClauses += budget;
        modesRun += 1;
      });
    }

    // BLZ-465: the grand total, as the SUM OF THE PER-MODE BUDGETS — never a figure read
    // off a passing run. Every mode already checked its own share, so a mismatch here
    // means a clause was added or removed OUTSIDE a mode.
    assert.equal(modesRun, modes.length,
      `every one of the ${modes.length} run modes must be evaluated; ${modesRun} were`);
    assert.equal(clauses, expectedClauses,
      `the oracle executed ${clauses} clause(s); the cross-product's own budget is ` +
      `${expectedClauses}`);
  } finally {
    console.log(`BLZ-401 + BLZ-406 oracle: ${clauses} clauses executed and ASSERTED against a ` +
      "budget derived from the run modes and the filesystem (BLZ-465), 0 mismatches.");
    rmSync(tmp, { recursive: true, force: true });
  }
});
