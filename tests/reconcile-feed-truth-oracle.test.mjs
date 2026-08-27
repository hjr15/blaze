// tests/reconcile-feed-truth-oracle.test.mjs — BLZ-404 + BLZ-405.
//
// The product assertion this lane makes is: "the activity feed's account of a reconcile
// run matches what actually happened on disk." Last lane, the equivalent claim was wrong
// in five successive directions because every round's tests pinned only the case that
// made the new claim true. This oracle instead:
//
//   1. builds ONE board holding a GENERATED cross-product of ticket shapes (96 tickets,
//      not a hand-picked list) — status x forge-signal x type x resolution;
//   2. runs the supervisor's real `runReconcile` (via `createApp`, subscribing to the
//      real `bus`) in both an applied pass and a preview pass;
//   3. derives every expectation from BEFORE/AFTER SNAPSHOTS OF THE FILESYSTEM ALONE —
//      never from `reconcile()`'s own return value, from `decide()`, or from the events
//      themselves. Deriving the oracle's ground truth from the same machinery it is
//      meant to check is exactly the vacuity trap that cost six rounds last time.
//
// Non-vacuity (D1/D2/D3) is proven by hand, outside this file, by re-introducing each
// defect this oracle exists to catch and confirming this NAMED test goes red for the
// reason its name claims — see the PR body for the commands and the failing assertions.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const KEY = "ORC";
const STATUSES = ["defined", "in-progress", "in-review", "done"];
const FORGES = ["none", "branch-only", "open-pr", "merged-pr", "closed-pr", "shipped-commit"];
const TYPES = ["task", "goal"];
const RESOLUTIONS = [null, "done"];

// =============================================================================
// The fixture: one board, one code repo, one `gh` stub, 96 generated tickets.
// Follows the `twoProjectBoard`/`stubGh` idiom in tests/reconcile-project-filter.test.mjs
// (real `git init`, a stub `gh` on PATH) rather than mocking reconcile's internals.
// =============================================================================
function buildOracleBoard(tmp) {
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "README.md"), "x\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "seed"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/hjr15/orc.git"]);

  const root = join(tmp, "board");
  mkdirSync(join(root, "projects", KEY), { recursive: true });
  writeFileSync(join(root, "projects", KEY, "project.json"),
    JSON.stringify({ key: KEY, codeRepos: [repo] }));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ key: KEY, projects: [KEY] }));

  const prs = [];
  const manifest = [];
  let n = 0;
  for (const status of STATUSES) {
    for (const forge of FORGES) {
      for (const type of TYPES) {
        for (const resolution of RESOLUTIONS) {
          n += 1;
          const id = `${KEY}-${n}`;
          manifest.push({ id, status, forge, type, resolution });

          const dir = join(root, "projects", KEY, status);
          mkdirSync(dir, { recursive: true });
          const fm = [`id: ${id}`, `title: ${id} ${status}/${forge}/${type}`, `type: ${type}`,
            `project: ${KEY}`, `estimate: 30`];
          if (resolution) fm.push(`resolution: ${resolution}`);
          writeFileSync(join(dir, `${id}-t.md`), `---\n${fm.join("\n")}\n---\n\nbody\n`);

          if (forge === "shipped-commit") {
            // A <KEY>-<n>: commit reachable from the default branch — the bundled-child
            // signal (BLZ-131). Must land on `main`, which is always the checked-out
            // branch at this point in the loop (branch-only below always returns to it).
            execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", `${id}: shipped work`]);
          } else if (forge === "branch-only") {
            // A branch embedding the key, with a commit of its own — corroborated per
            // buildBranchMap — that never merges into `main`.
            execFileSync("git", ["-C", repo, "checkout", "-q", "-b", `${id}-work`]);
            execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", `${id}: work`]);
            execFileSync("git", ["-C", repo, "checkout", "-q", "main"]);
          } else if (forge === "open-pr" || forge === "merged-pr" || forge === "closed-pr") {
            const state = forge === "open-pr" ? "OPEN" : forge === "merged-pr" ? "MERGED" : "CLOSED";
            prs.push({ number: n, state, url: `https://github.com/hjr15/orc/pull/${n}`,
              headRefName: `${id}-pr`, title: `${id}: the work` });
          }
          // "none": no branch, no PR, no shipped commit — the ticket is left untouched.
        }
      }
    }
  }

  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);

  return { root, repo, bin, manifest };
}

// =============================================================================
// Ground truth: read straight off the filesystem, independent of every production
// reader (no `walkTickets`, no `fsReadStorage`, no `decide()`). A ticket's directory
// IS its status; `branch`/`pr` are read as raw frontmatter lines.
// =============================================================================
function snapshotBoard(root) {
  const out = new Map(); // id -> { status, branch, pr }
  const projDir = join(root, "projects", KEY);
  for (const status of readdirSync(projDir)) {
    const statusDir = join(projDir, status);
    if (!statSync(statusDir).isDirectory()) continue;
    for (const file of readdirSync(statusDir)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(statusDir, file), "utf8");
      const fmBlock = /^---\n([\s\S]*?)\n---/.exec(text);
      if (!fmBlock) continue;
      const idMatch = /^id:\s*(\S+)\s*$/m.exec(fmBlock[1]);
      if (!idMatch) continue;
      const branchMatch = /^branch:\s*(.+)$/m.exec(fmBlock[1]);
      const prMatch = /^pr:\s*(.+)$/m.exec(fmBlock[1]);
      out.set(idMatch[1], {
        status,
        branch: branchMatch ? branchMatch[1].trim() : null,
        pr: prMatch ? prMatch[1].trim() : null,
      });
    }
  }
  return out;
}

// =============================================================================
// The clauses. Every comparison reads ONLY `before`/`after` (the filesystem) and the
// raw published events — never `reconcile()`'s return, `decide()`, or anything derived
// from either. "Presents a completed move" is `moved === true && applied !== false` —
// an event with NO `applied` field at all (every event this feed published before this
// ticket) is read as claiming completion, which is exactly the ambient, unqualified
// claim BLZ-404 exists to stop.
// =============================================================================
function checkGroundTruth(before, after, reconcileEvents, label) {
  let clauses = 0;
  const movedIds = new Set();
  const clearedIds = new Set();
  for (const [id, b] of before) {
    const a = after.get(id);
    clauses += 1;
    assert.ok(a, `${label}: ${id} must still exist on disk after the run`);
    if (b.status !== a.status) movedIds.add(id);
    if ((b.branch || b.pr) && !(a.branch || a.pr)) clearedIds.add(id);
  }

  // (a) every event presenting a COMPLETED move names a ticket that really moved.
  for (const e of reconcileEvents) {
    clauses += 1;
    if (e.moved === true && e.applied !== false) {
      const b = before.get(e.id), a = after.get(e.id);
      assert.ok(b && a && b.status !== a.status,
        `${label}: ${e.id} — event claims a completed move ${e.from} -> ${e.to}, ` +
        `but the directory on disk did not change`);
      assert.equal(b.status, e.from,
        `${label}: ${e.id} — event 'from' (${e.from}) does not match the real before-directory (${b.status})`);
      assert.equal(a.status, e.to,
        `${label}: ${e.id} — event 'to' (${e.to}) does not match the real after-directory (${a.status})`);
    }
  }

  // (b) no ticket whose directory did NOT change has any event presenting it as completed.
  for (const id of before.keys()) {
    clauses += 1;
    if (!movedIds.has(id)) {
      const bad = reconcileEvents.find((e) => e.id === id && e.moved === true && e.applied !== false);
      assert.equal(bad, undefined,
        `${label}: ${id} — directory did not change on disk, but ${JSON.stringify(bad)} presents it as a completed move`);
    }
  }

  // (c) every ticket whose directory DID change has exactly one event describing it,
  //     with from/to equal to the real before/after directories.
  for (const id of movedIds) {
    clauses += 1;
    const matches = reconcileEvents.filter((e) => e.id === id);
    assert.equal(matches.length, 1,
      `${label}: ${id} — directory changed on disk but ${matches.length} event(s) describe it`);
    const [e] = matches;
    const b = before.get(id), a = after.get(id);
    assert.equal(e.from, b.status, `${label}: ${id} — event 'from' does not match the real before-directory`);
    assert.equal(e.to, a.status, `${label}: ${id} — event 'to' does not match the real after-directory`);
  }

  // (d) e.cleared === true iff branch/pr really disappeared from disk.
  for (const e of reconcileEvents) {
    clauses += 1;
    const reallyCleared = clearedIds.has(e.id);
    assert.equal(Boolean(e.cleared), reallyCleared,
      `${label}: ${e.id} — event.cleared=${e.cleared} but branch/pr on disk ${reallyCleared ? "did" : "did not"} disappear`);
  }

  return { clauses, movedIds, clearedIds };
}

let totalClauses = 0;

describe("BLZ-404 + BLZ-405: the reconcile feed's account of a run matches the filesystem", () => {
  test("applied run: every event's claim about a move matches a real directory change on disk", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-oracle-applied-"));
    const prevPath = process.env.PATH;
    let app;
    try {
      const { root, bin } = buildOracleBoard(tmp);
      process.env.PATH = `${bin}:${prevPath}`;

      const before = snapshotBoard(root);

      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      app.bus.subscribe((e) => events.push(e));
      await app.runReconcile();

      const after = snapshotBoard(root);
      const reconcileEvents = events.filter((e) => e.type === "reconcile");

      const { clauses, movedIds } = checkGroundTruth(before, after, reconcileEvents, "applied");
      // Non-vacuity: an applied run that moves nothing proves nothing about whether the
      // feed's claims track reality — and is exactly what the permanent-dry-run defect
      // (D1) produces. 96 generated tickets across four forge signals guarantee real
      // candidates; assert the run actually acted on some of them.
      assert.ok(movedIds.size > 0,
        "applied: the fixture must produce at least one real directory move — 0 means the run never really applied");
      assert.ok(reconcileEvents.length > 0, "applied: the run must publish at least one reconcile event");
      totalClauses += clauses + 2;
      console.log(`ORACLE (applied): ${clauses + 2} clauses checked over ${before.size} tickets and ` +
        `${reconcileEvents.length} events (${movedIds.size} real moves), 0 mismatches`);
    } finally {
      if (app) app.server.close();
      process.env.PATH = prevPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("preview run: nothing on disk moves, and no event presents a completed move", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-oracle-preview-"));
    const prevPath = process.env.PATH;
    let app;
    try {
      const { root, bin } = buildOracleBoard(tmp);
      process.env.PATH = `${bin}:${prevPath}`;

      const before = snapshotBoard(root);

      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      app.bus.subscribe((e) => events.push(e));
      await app.runReconcile({ dryRun: true });

      const after = snapshotBoard(root);
      const reconcileEvents = events.filter((e) => e.type === "reconcile");

      const { clauses, movedIds } = checkGroundTruth(before, after, reconcileEvents, "preview");
      // (e) in preview mode, NO ticket's path changed on disk at all.
      assert.equal(movedIds.size, 0, "preview: dryRun must not move any ticket's directory on disk");
      // Non-vacuity for this half: a preview that finds nothing to propose cannot prove
      // that a genuine proposal is rendered honestly.
      assert.ok(reconcileEvents.some((e) => e.moved === true),
        "preview: the run must have proposed at least one move, or this half of the oracle is vacuous");
      totalClauses += clauses + 2;
      console.log(`ORACLE (preview): ${clauses + 2} clauses checked over ${before.size} tickets and ` +
        `${reconcileEvents.length} events (${movedIds.size} real moves), 0 mismatches`);
    } finally {
      if (app) app.server.close();
      process.env.PATH = prevPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("ORACLE TOTAL", () => {
    // Reported so the PR body can quote an exact figure, not a range.
    console.log(`ORACLE TOTAL: ${totalClauses} clauses checked across both runs, 0 mismatches`);
    assert.ok(totalClauses > 0);
  });
});
