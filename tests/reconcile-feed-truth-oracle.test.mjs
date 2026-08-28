// tests/reconcile-feed-truth-oracle.test.mjs — BLZ-404 + BLZ-405.
//
// The product assertion this lane makes is: "the activity feed's account of a reconcile
// run matches what actually happened on disk." Last lane, the equivalent claim was wrong
// in five successive directions because every round's tests pinned only the case that
// made the new claim true. This oracle instead:
//
//   1. builds ONE board holding a GENERATED cross-product of ticket shapes (status x
//      forge-signal x type x resolution x PRE-EXISTING DELIVERY RECORD);
//   2. runs the supervisor's real `runReconcile` (via `createApp`, subscribing to the
//      real `bus`) in both an applied pass and a preview pass;
//   3. derives every expectation from BEFORE/AFTER SNAPSHOTS OF THE FILESYSTEM ALONE —
//      never from `reconcile()`'s own return value, from `decide()`, or from the events
//      themselves. Deriving the oracle's ground truth from the same machinery it is
//      meant to check is exactly the vacuity trap that cost six rounds last time.
//
// REVIEW ROUND (2026-08-27) found this oracle itself REFUTED on two counts, both fixed
// here and both re-verified by hand (the mutation commands and their results are quoted
// in the PR body, not just asserted here):
//
//   - `buildOracleBoard` never wrote a `branch:`/`pr:` line, so no ticket could ever be
//     CLEARED — `clearedIds` was always empty and clause (d) only ever asserted
//     `false === false`. The cross-product was missing the one dimension that reaches
//     `hadRecord`/`recordIfAbsentOnly`/`recordAmbiguous`: a PRE-EXISTING delivery record.
//     Fixed by adding a `RECORDS` dimension (a ticket may already carry a `branch`/`pr`,
//     including the `""`-vs-absent shape `hadRecord`'s own comment warns about) and an
//     `ambiguous-merged` forge signal (two equally-titled MERGED PRs, BLZ-398's tie), which
//     together make clause (d) execute both a real CLEAR and a real NON-clear.
//   - `buildOracleBoard` git-inited `repo` but never `root`, so `commit: true` could never
//     reach a real commit and this PR's headline behaviour change (the loop COMMITS) had
//     NO oracle coverage. Fixed by git-initing `root` too and adding a commit-existence
//     clause whose ground truth is `git log`/`git show`, never `r.changes`.
//
// Non-vacuity (D1/D2/D3, now also D4/D5 for the two fixes above) is proven by hand,
// outside this file, by re-introducing each defect this oracle exists to catch and
// confirming this NAMED test goes red for the reason its name claims — see the PR body
// for the commands and the failing assertions.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const KEY = "ORC";
const STATUSES = ["defined", "in-progress", "in-review", "done"];
// "ambiguous-merged": two MERGED PRs, equally titled `<id>: the work` — BLZ-398's tie,
// the branch this oracle previously could not reach at all (see header).
const FORGES = ["none", "branch-only", "open-pr", "merged-pr", "closed-pr", "shipped-commit", "ambiguous-merged"];
const TYPES = ["task", "goal"];
const RESOLUTIONS = [null, "done"];
// A ticket may already carry a delivery record before this run — the dimension whose
// absence made clause (d) vacuous (see header). "emptyString" pins the `""`-vs-absent
// shape `hadRecord`'s own comment warns a DB storage can produce; the filesystem storage
// this fixture uses can produce it too (`branch: ""` parses to the empty string, not
// `null` — scripts/model/ticket.mjs's `coerceScalar`), and `hadRecord` must read both the
// same as truly absent.
const RECORDS = ["none", "hasRecord", "emptyString"];

// =============================================================================
// The fixture: one board, one code repo, one `gh` stub, a generated cross-product of
// tickets. Follows the `twoProjectBoard`/`stubGh` idiom in
// tests/reconcile-project-filter.test.mjs (real `git init`, a stub `gh` on PATH) rather
// than mocking reconcile's internals. BOTH `repo` (the code repo) and `root` (the board
// itself) are real git repos — `root` was the gap review found: without it `commit: true`
// never reaches a real commit and this PR's headline behaviour change has no coverage.
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
          for (const record of RECORDS) {
            n += 1;
            const id = `${KEY}-${n}`;
            manifest.push({ id, status, forge, type, resolution, record });

            const dir = join(root, "projects", KEY, status);
            mkdirSync(dir, { recursive: true });
            const fm = [`id: ${id}`, `title: ${id} ${status}/${forge}/${type}/${record}`, `type: ${type}`,
              `project: ${KEY}`, `estimate: 30`];
            if (resolution) fm.push(`resolution: ${resolution}`);
            // The added dimension: a PRE-EXISTING delivery record, written BEFORE reconcile
            // ever runs — the only way to reach `hadRecord`/`recordIfAbsentOnly` true, and
            // (combined with "ambiguous-merged" below) `recordAmbiguous` and a real CLEAR.
            if (record === "hasRecord") {
              fm.push(`branch: ${id}-legacy-branch`);
              fm.push(`pr: #900 — https://github.com/hjr15/orc/pull/900`);
            } else if (record === "emptyString") {
              fm.push(`branch: ""`);
              fm.push(`pr: ""`);
            }
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
            } else if (forge === "ambiguous-merged") {
              // BLZ-398's tie: two MERGED PRs, equally titled — git cannot say which one
              // delivered it, so `ambiguousDeliverers` must flag it and `decide` must
              // refuse to write (or must CLEAR) the record, never guess. Distinct numbers
              // and urls (samePr decides identity by url) so the two are genuinely two.
              prs.push({ number: n, state: "MERGED", url: `https://github.com/hjr15/orc/pull/${n}`,
                headRefName: `${id}-pr-a`, title: `${id}: the work` });
              prs.push({ number: n + 100000, state: "MERGED", url: `https://github.com/hjr15/orc/pull/${n}-b`,
                headRefName: `${id}-pr-b`, title: `${id}: the work` });
            }
            // "none": no branch, no PR, no shipped commit — the ticket is left untouched.
          }
        }
      }
    }
  }

  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);

  // BLZ-404 (review): `root` must ALSO be a real git repo, git-inited AFTER every ticket
  // file above is written so the seed commit captures the whole starting fixture. Without
  // this, `commit: true` never reaches a real `git commit` and the loop's headline
  // behaviour change — it now COMMITS — had no oracle coverage at all.
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", root, "config", "user.name", "t"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed board"]);

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
      // Raw frontmatter text, INCLUDING a bare `""` — ground truth for the has-a-record
      // question must read the same way `hadRecord` does (falsy on absent, null, AND the
      // empty string), not merely on the line being present at all.
      const val = (raw) => {
        if (raw === undefined || raw === null) return null;
        const v = raw.trim();
        return v === '""' || v === "''" ? "" : v;
      };
      out.set(idMatch[1], {
        status,
        branch: val(branchMatch && branchMatch[1]),
        pr: val(prMatch && prMatch[1]),
      });
    }
  }
  return out;
}

// A record counts as PRESENT the same way `hadRecord` in reconcile.mjs does:
// `Boolean(fm.branch || fm.pr)` — falsy on absent, `null`, AND `""`.
const hasRecord = (snap) => Boolean(snap && (snap.branch || snap.pr));

// =============================================================================
// The clauses. Every comparison reads ONLY `before`/`after` (the filesystem) and the
// raw published events — never `reconcile()`'s return, `decide()`, or anything derived
// from either. "Presents a completed move" is `moved === true && applied !== false` —
// an event with NO `applied` field at all (every event this feed published before this
// ticket) is read as claiming completion, which is exactly the ambient, unqualified
// claim BLZ-404 exists to stop.
//
// REVIEW (finding 4.2): `clauses` now counts assertions actually EXECUTED, not loop
// iterations — a clause whose body is gated (`if (...)`) increments the counter INSIDE
// the gate, at the point the assert.* call actually runs, so an iteration that never
// reaches an assertion is not counted as one. Applied to (a), (b) and (d) below; (c) was
// already gated correctly (it iterates `movedIds`, which IS the real ground truth).
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
    if (hasRecord(b) && !hasRecord(a)) clearedIds.add(id);
  }

  // (a) every event presenting a COMPLETED move names a ticket that really moved.
  for (const e of reconcileEvents) {
    if (!(e.moved === true && e.applied !== false)) continue; // not a completed-move claim
    clauses += 1;
    const b = before.get(e.id), a = after.get(e.id);
    assert.ok(b && a && b.status !== a.status,
      `${label}: ${e.id} — event claims a completed move ${e.from} -> ${e.to}, ` +
      `but the directory on disk did not change`);
    assert.equal(b.status, e.from,
      `${label}: ${e.id} — event 'from' (${e.from}) does not match the real before-directory (${b.status})`);
    assert.equal(a.status, e.to,
      `${label}: ${e.id} — event 'to' (${e.to}) does not match the real after-directory (${a.status})`);
  }

  // (b) no ticket whose directory did NOT change has any event presenting it as completed.
  for (const id of before.keys()) {
    if (movedIds.has(id)) continue; // covered by (c) below instead
    clauses += 1;
    const bad = reconcileEvents.find((e) => e.id === id && e.moved === true && e.applied !== false);
    assert.equal(bad, undefined,
      `${label}: ${id} — directory did not change on disk, but ${JSON.stringify(bad)} presents it as a completed move`);
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
  //
  // REVIEW (finding 3): gated on `e.applied !== false`. A PREVIEW event PROPOSES what
  // would happen; nothing on disk moves during a dry run (the write port is never called),
  // so `after` trivially equals `before` for every ticket and `clearedIds` is always empty
  // regardless of what the run proposed. Comparing a preview event's `cleared` against
  // that necessarily-unchanged snapshot is comparing a PROPOSAL to a REALISATION that
  // never occurred — exactly the shape the file's own header warns "would fail spuriously
  // once the fixture gains a clearable ticket" once one exists (it now does: the
  // ambiguous-merged + hasRecord dimension). The preview half's PROPOSAL is instead
  // checked directly against `movedIds`/`clearedIds`-independent non-vacuity assertions in
  // the test body below (`cleared === true` must still be PROPOSED by at least one event).
  for (const e of reconcileEvents) {
    if (e.applied === false) continue; // proposal, not a realisation — nothing on disk to check it against
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
      const commitCountBefore = Number(
        execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());

      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      app.bus.subscribe((e) => events.push(e));
      await app.runReconcile();

      const after = snapshotBoard(root);
      const reconcileEvents = events.filter((e) => e.type === "reconcile");

      const { clauses, movedIds, clearedIds } = checkGroundTruth(before, after, reconcileEvents, "applied");
      let bonusClauses = 2;
      // Non-vacuity: an applied run that moves nothing proves nothing about whether the
      // feed's claims track reality — and is exactly what the permanent-dry-run defect
      // (D1) produces. The generated cross-product across many forge signals guarantees
      // real candidates; assert the run actually acted on some of them.
      assert.ok(movedIds.size > 0,
        "applied: the fixture must produce at least one real directory move — 0 means the run never really applied");
      assert.ok(reconcileEvents.length > 0, "applied: the run must publish at least one reconcile event");

      // Non-vacuity for the added dimension (review finding 3): a run that never clears a
      // record proves nothing about whether `cleared` is reported honestly. The
      // ambiguous-merged + hasRecord + non-terminal-status combination is DESIGNED to
      // clear — assert it actually did, on disk, independent of the event.
      assert.ok(clearedIds.size > 0,
        "applied: the fixture must produce at least one REAL branch/pr clear on disk — 0 means " +
        "the added ambiguous-merged + pre-existing-record dimension is not actually exercised");
      bonusClauses += 1;

      // BLZ-404 (review finding 3): a commit-existence clause, ground truth from
      // `git log`/`git show` alone — never from `reconcile()`'s return value. This board's
      // `commitMode` is the default ("per-op"), so a run with real moves must land exactly
      // one new commit whose subject's own claimed ticket-count matches the count of
      // DISTINCT tickets the commit's diff actually touches.
      const commitCountAfter = Number(
        execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
      assert.equal(commitCountAfter, commitCountBefore + 1,
        "applied: a run with real moves, on a per-op-mode board, must create exactly one new commit");
      bonusClauses += 1;

      const subject = execFileSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
      const diffFiles = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"],
        { encoding: "utf8" }).trim().split("\n").filter(Boolean);
      const diffIds = new Set(diffFiles.map((f) => (/(ORC-\d+)/.exec(f) || [])[1]).filter(Boolean));
      // BLZ-401: the subject now states TWO quantities — tickets whose STATUS actually
      // moved, and (only when non-zero) tickets whose file was written without a status
      // change. A single "reconcile N ticket(s)" claim used to conflate the two, which is
      // the exact defect BLZ-401 fixes (a `done -> done` resolution backfill inflating the
      // count of tickets that "moved"). Ground truth for the first quantity is `movedIds`
      // — real directory changes, already computed above from the filesystem, never from
      // `reconcile()`'s own return value; ground truth for the second is the remainder of
      // the diff's distinct ids that did NOT move.
      const movedMatch = /reconcile (\d+) ticket\(s\) moved/.exec(subject);
      assert.ok(movedMatch, `applied: the commit subject must state its moved-ticket count, got: ${subject}`);
      assert.equal(Number(movedMatch[1]), movedIds.size,
        "applied: the commit subject's claimed MOVED count must match the number of tickets whose " +
        `directory really changed (ground truth: filesystem snapshot), got subject "${subject}" but ` +
        `${movedIds.size} ticket(s) really moved: ${[...movedIds].join(", ")}`);
      bonusClauses += 1;
      const nonMovedGroundTruth = diffIds.size - movedIds.size;
      const updatedMatch = /(\d+) ticket\(s\) updated without a status change/.exec(subject);
      if (nonMovedGroundTruth > 0) {
        assert.ok(updatedMatch,
          `applied: the diff touches ${diffIds.size} distinct ticket(s) but only ${movedIds.size} moved — ` +
          `the subject must name the remaining ${nonMovedGroundTruth} non-moving update(s), got: ${subject}`);
        assert.equal(Number(updatedMatch[1]), nonMovedGroundTruth,
          "applied: the commit subject's non-moving-update count must match the diff's real remainder " +
          `(${nonMovedGroundTruth}), got subject "${subject}"`);
      } else {
        assert.equal(updatedMatch, null,
          `applied: every ticket the diff touches really moved, so the subject must not claim a ` +
          `non-moving update, got: ${subject}`);
      }
      bonusClauses += 1;

      // BLZ-404 round 2 (blocking 2 — adversarial re-review's M6 mutation): the two clauses
      // above collapse a move to a SET of distinct ticket ids and survive a mutation that
      // commits only the DESTINATION path of a move and drops the SOURCE from `touched`
      // (`touched.push(dest)` alone, never `touched.push(t.file)`). Under that mutation the
      // subject still reads "reconcile N ticket(s)" and `git show --name-only` still touches
      // N distinct ids — the new path IS one of them — so both clauses above stay green while
      // the product commits a ticket at its OLD status (still tracked, still on disk, now
      // untracked-deleted) and its NEW status at once, and leaves the old path permanently
      // unstaged. `git status --porcelain`, scoped to the board's own project tree, is ground
      // truth no `git show`/subject-parsing clause can be fooled by: a real move's source
      // deletion and destination creation must BOTH have landed in the commit, or the
      // working tree is not clean. Verified by hand against the M6 mutation (see the PR
      // body): with only this clause reverted, `node --test` on this file stays green under
      // the mutation; with it in place, this exact assertion goes red.
      const boardTreeDirty = execFileSync("git",
        ["-C", root, "status", "--porcelain", "--", join(root, "projects", KEY)],
        { encoding: "utf8" }).trim();
      assert.equal(boardTreeDirty, "",
        "applied: the board's own project tree must be FULLY committed after an applied run — " +
        `git status --porcelain reports uncommitted change(s) it must not:\n${boardTreeDirty}`);
      bonusClauses += 1;

      totalClauses += clauses + bonusClauses;
      console.log(`ORACLE (applied): ${clauses + bonusClauses} clauses checked over ${before.size} tickets and ` +
        `${reconcileEvents.length} events (${movedIds.size} real moves, ${clearedIds.size} real clears), 0 mismatches`);
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
      let bonusClauses = 2;
      // (e) in preview mode, NO ticket's path changed on disk at all.
      assert.equal(movedIds.size, 0, "preview: dryRun must not move any ticket's directory on disk");
      // Non-vacuity for this half: a preview that finds nothing to propose cannot prove
      // that a genuine proposal is rendered honestly.
      assert.ok(reconcileEvents.some((e) => e.moved === true),
        "preview: the run must have proposed at least one move, or this half of the oracle is vacuous");

      // Non-vacuity for the added dimension (review finding 3), preview half: the run must
      // PROPOSE at least one clear (this is exactly the proposal clause (d) above
      // deliberately does not grade against ground truth, per its own comment — a dry run
      // never touches disk, so there is nothing real to compare a PROPOSAL against). This
      // still proves the ambiguous-merged + hasRecord dimension reaches the clearing code
      // path in preview, rather than the dimension only ever being reachable when applied.
      assert.ok(reconcileEvents.some((e) => e.cleared === true),
        "preview: the run must have PROPOSED at least one clear, or the added ambiguous-merged + " +
        "pre-existing-record dimension is not exercised in preview at all");
      bonusClauses += 1;

      totalClauses += clauses + bonusClauses;
      console.log(`ORACLE (preview): ${clauses + bonusClauses} clauses checked over ${before.size} tickets and ` +
        `${reconcileEvents.length} events (${movedIds.size} real moves), 0 mismatches`);
    } finally {
      if (app) app.server.close();
      process.env.PATH = prevPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("ORACLE TOTAL", () => {
    // Reported so the PR body can quote an exact figure, not a range. REVIEW (finding
    // 4.2): this number is now a count of assertions actually EXECUTED (see
    // `checkGroundTruth`'s header comment), not of loop iterations — it is smaller than
    // the previously-claimed total, and it is smaller because the previous total was
    // wrong, not because less is now checked.
    console.log(`ORACLE TOTAL: ${totalClauses} clauses checked across both runs, 0 mismatches`);
    assert.ok(totalClauses > 0);
  });
});
