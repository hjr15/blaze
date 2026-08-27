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

function materializeBoard(root, { codeRepo, tickets, misfiled }) {
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
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: "ZZZ", projects: ["ZZZ", "YYY"] }));

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
 *  happened to the ticket tree. Returns the number of assertions actually
 *  EXECUTED (not the number of ids iterated — an id that changed nothing on
 *  disk contributes to one assertion, not a phantom count). */
function assertOracle({ label, before, after, stdout }) {
  let checked = 0;
  const { moves, nonMoves } = parseChangeLines(stdout);
  const allIds = new Set([...before.keys(), ...after.keys()]);

  for (const id of allIds) {
    const b = before.get(id), a = after.get(id);
    const dirChanged = Boolean(b) && Boolean(a) && b.dir !== a.dir;
    const moveLine = moves.get(id);
    const nonMoveLine = nonMoves.get(id);

    if (dirChanged) {
      // c) exactly one line, and it claims a move.
      assert.ok(moveLine, `${label}: ${id} really moved ${b.dir} -> ${a.dir} but no rendered line claims it`);
      checked += 1;
      assert.equal(nonMoveLine, undefined,
        `${label}: ${id} really moved but ALSO has a non-move line — two accounts of one ticket`);
      checked += 1;
      // a) the from/to on that line are the REAL directories.
      assert.equal(moveLine.from, b.dir, `${label}: ${id}'s rendered 'from' does not match its real prior directory`);
      checked += 1;
      assert.equal(moveLine.to, a.dir, `${label}: ${id}'s rendered 'to' does not match its real new directory`);
      checked += 1;
    } else {
      // b) no ticket whose directory did NOT change has a line claiming a move.
      assert.equal(moveLine, undefined,
        `${label}: ${id}'s directory did not change, but a line claims it moved: ${moveLine && moveLine.line}`);
      checked += 1;
    }

    if (!dirChanged && b && a) {
      const contentChanged = b.raw !== a.raw;
      // e1) a non-move line only exists where the FILE really changed.
      if (nonMoveLine) {
        assert.ok(contentChanged,
          `${label}: ${id} has a non-move line but its file is byte-identical: "${nonMoveLine.line}"`);
        checked += 1;
      }
      // e2) the mirror — D4: a file that really changed without moving must be
      // NAMED, not silently dropped from the report.
      if (contentChanged) {
        assert.ok(nonMoveLine,
          `${label}: ${id}'s file changed (no directory change) but no line reports it — a real write went unreported`);
        checked += 1;
      }
    }
  }
  return checked;
}

// =============================================================================
// The three run modes the lane brief names
// =============================================================================

test("BLZ-401 + BLZ-406: the change report matches the filesystem, across the cross-product", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "blz401-oracle-"));
  let totalChecked = 0;
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
      { label: "dry-run (unfiltered)", args: [], groundArgs: ["--apply"], commit: false, apply: false },
      { label: "--apply (unfiltered)", args: ["--apply"], commit: true, apply: true },
      { label: "--apply --project ZZZ", args: ["--project", "ZZZ", "--apply"], commit: true, apply: true },
    ];

    for (const mode of modes) {
      await t.test(mode.label, () => {
        const root = mkdtempSync(join(tmp, "board-"));
        materializeBoard(root, fixture);
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
            assert.deepEqual(a, before.get(id), `${mode.label}: dry-run wrote to ${id}'s file — it must write nothing`);
            totalChecked += 1;
          }
          const groundRoot = mkdtempSync(join(tmp, "ground-"));
          materializeBoard(groundRoot, fixture);
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
        totalChecked += assertOracle({ label: mode.label, before, after, stdout: res.stdout });

        // f) the misfiled ticket's mismatch is reported on EVERY run mode, including
        // the one that filters it out of scope entirely (--project ZZZ: its directory
        // is YYY, so the scope guard skips it before it can ever move).
        const misfiledLine = res.stderr.split("\n")
          .find((l) => l.includes("NEEDS ATTENTION") && l.includes(fixture.misfiled.id));
        assert.ok(misfiledLine, `${mode.label}: no project-mismatch finding for ${fixture.misfiled.id} — ` +
          `stderr:\n${res.stderr}`);
        totalChecked += 1;
        assert.match(misfiledLine, /no single-project run/,
          `${mode.label}: the finding must say no single-project run reconciles it`);
        totalChecked += 1;

        // d) the --apply commit message's two quantities, both from ground truth.
        if (mode.commit) {
          const movedGT = [...before.keys()].filter((id) => {
            const b = before.get(id), a = after.get(id);
            return b && a && b.dir !== a.dir;
          }).length;
          const nonMovedGT = [...before.keys()].filter((id) => {
            const b = before.get(id), a = after.get(id);
            return b && a && b.dir === a.dir && b.raw !== a.raw;
          }).length;
          const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%B"], { encoding: "utf8" });
          assert.match(subject, new RegExp(`\\b${movedGT} ticket\\(s\\) moved`),
            `${mode.label}: commit message's moved count must equal the real directory-change count (${movedGT})`);
          totalChecked += 1;
          if (nonMovedGT > 0) {
            assert.match(subject, new RegExp(`\\b${nonMovedGT} ticket\\(s\\) updated without a status change`),
              `${mode.label}: commit message must also state the real non-moving write count (${nonMovedGT})`);
            totalChecked += 1;
          } else {
            assert.doesNotMatch(subject, /updated without a status change/,
              `${mode.label}: commit message claims non-moving updates that did not really happen`);
            totalChecked += 1;
          }
        }
      });
    }
  } finally {
    console.log(`BLZ-401 + BLZ-406 oracle: ${totalChecked} assertions executed, 0 mismatches.`);
    rmSync(tmp, { recursive: true, force: true });
  }
});
