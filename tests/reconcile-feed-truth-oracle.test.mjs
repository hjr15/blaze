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

// =============================================================================
// BLZ-465: THE COUNTER IS THE ASSERTION, AND THE TOTAL IS ASSERTED.
//
// BLZ-420 closed the CROSS-PRODUCT size here (`assertCrossProductSize`), which is a
// different quantity from the CLAUSE count — and the clause count was only ever
// PRINTED. `ORACLE TOTAL` asserted `totalClauses > 0`, which every possible run
// satisfies, so a deleted clause and its hand-written `clauses += 1` left this file
// 4/4 green with a smaller banner. The equivalence run's own share was hand-fitted at
// `before.size + 6` when the code executes `before.size + 5` — an overstatement by one
// that nothing could catch, which is the failure mode in miniature.
//
// The pattern is `tests/board-overstatement-oracle.test.mjs`'s (BLZ-414/444/452):
//   1. these wrappers are the ONLY way the counter moves, so a deleted clause takes its
//      count with it and there is no separate counter left to delete;
//   2. each of the three runs asserts its own executed count against a budget DERIVED
//      from the cross-product's declared size and the FILESYSTEM ground truth (how many
//      tickets really moved, really cleared), never from a figure read off a passing
//      run; and `ORACLE TOTAL` asserts the sum.
//
// THE BINDING IS ONE-DIRECTIONAL. A DELETED clause is caught — its count vanishes and
// the run's budget names the gap. An ADDED clause written as a bare `assert.` is NOT
// caught: it is simply uncounted and the file stays green. Claiming otherwise would be
// this file's own defect. Write new clauses through the wrappers.
//
// The bare `assert.` calls that remain are deliberately NOT clauses: the fixture
// preconditions in `assertCrossProductSize` (the board really is the whole declared
// cross-product) and the budget meta-assertions themselves.
// =============================================================================
let clauses = 0;
const eq = (a, b, msg) => { clauses += 1; assert.equal(a, b, msg); };
const ok = (c, msg) => { clauses += 1; assert.ok(c, msg); };
const deepEq = (a, b, msg) => { clauses += 1; assert.deepEqual(a, b, msg); };

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

// BLZ-420: the cross-product's SIZE, declared here and asserted in every half below.
// Before this ticket the size was only printed, so deleting a dimension value — say
// "emptyString" from RECORDS — shrank the board from 336 tickets to 224 and dropped 520
// clauses while the file still reported 3/3 pass. The product is written out rather than
// hard-coded so a deleted VALUE fails here and a deleted DIMENSION fails too.
const DIMENSIONS = { STATUSES, FORGES, TYPES, RESOLUTIONS, RECORDS };
const EXPECTED_DIMENSION_SIZES = { STATUSES: 4, FORGES: 7, TYPES: 2, RESOLUTIONS: 2, RECORDS: 3 };
const EXPECTED_TICKETS =
  STATUSES.length * FORGES.length * TYPES.length * RESOLUTIONS.length * RECORDS.length;

/** Asserts the board really is the whole declared cross-product: every dimension is the
 *  size it declares, every VALUE of every dimension is actually present in the manifest,
 *  and the ticket count is the product. `manifest` is the fixture's own record of what it
 *  wrote; `snapshot` is the filesystem. Both are checked, because a manifest entry whose
 *  file failed to land would otherwise pass. */
function assertCrossProductSize(manifest, snapshot, label) {
  for (const [name, values] of Object.entries(DIMENSIONS)) {
    assert.equal(values.length, EXPECTED_DIMENSION_SIZES[name],
      `${label}: the ${name} dimension changed size — ${values.length} values, ` +
      `${EXPECTED_DIMENSION_SIZES[name]} declared`);
    assert.equal(new Set(values.map(String)).size, values.length,
      `${label}: the ${name} dimension has a duplicate value, so it is narrower than it looks`);
  }
  const field = { STATUSES: "status", FORGES: "forge", TYPES: "type",
    RESOLUTIONS: "resolution", RECORDS: "record" };
  for (const [name, values] of Object.entries(DIMENSIONS)) {
    const seen = new Set(manifest.map((m) => String(m[field[name]])));
    for (const v of values) {
      assert.ok(seen.has(String(v)),
        `${label}: no ticket in the fixture carries ${name}=${String(v)} — the dimension is ` +
        "declared but not generated");
    }
  }
  assert.equal(manifest.length, EXPECTED_TICKETS,
    `${label}: the fixture must generate ${EXPECTED_TICKETS} tickets ` +
    `(${Object.values(DIMENSIONS).map((d) => d.length).join(" x ")}), it generated ${manifest.length}`);
  assert.equal(snapshot.size, EXPECTED_TICKETS,
    `${label}: ${snapshot.size} ticket(s) are on disk but the cross-product declares ` +
    `${EXPECTED_TICKETS} — a dimension was deleted, or a file did not land`);
  assert.equal(new Set(manifest.map((m) => m.id)).size, EXPECTED_TICKETS,
    `${label}: the manifest holds duplicate ids`);
}

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
// from either.
//
// BLZ-465 REPLACES THE LOOP STRUCTURE, not the assertions. Clauses (a), (b), (c) and
// (d) used to iterate `reconcileEvents` — the SUBJECT's own output — so the number of
// clauses this function executed depended on how many events the subject chose to
// publish, and no budget derived from the fixture could state it in advance. They are
// now driven by the FILESYSTEM: one pass over `before`, with the events for each id
// looked up. What each clause asserts is unchanged or stronger:
//
//   (a)+(b)+(c) become, per ticket, "the number of events presenting a COMPLETED move
//     for this ticket is exactly 1 if its directory really changed and 0 if it did not",
//     plus (for a ticket that really moved) "there is exactly ONE event about it at all"
//     and the from/to pair. A completed-move claim naming a ticket that is not on the
//     board at all — which (a) used to catch by finding `before.get(e.id)` undefined —
//     is caught by the one whole-set clause after the loop.
//   (d) becomes, per ticket, "every REALISATION event for it claims `cleared` if the
//     branch/pr really disappeared from disk, and none of them do if it did not", which
//     is exactly the per-event equality it replaces, quantified over the same events.
//
// "Presents a completed move" is still `moved === true && applied !== false` — an event
// with NO `applied` field at all (every event this feed published before BLZ-404) is
// read as claiming completion, which is exactly the ambient, unqualified claim BLZ-404
// exists to stop.
// =============================================================================
const presentsCompletedMove = (e) => e.moved === true && e.applied !== false;

function checkGroundTruth(before, after, reconcileEvents, label) {
  const movedIds = new Set();
  const clearedIds = new Set();
  for (const [id, b] of before) {
    const a = after.get(id);
    if (a && b.status !== a.status) movedIds.add(id);
    if (a && hasRecord(b) && !hasRecord(a)) clearedIds.add(id);
  }

  for (const [id, b] of before) {
    const a = after.get(id);
    ok(a, `${label}: ${id} must still exist on disk after the run`);

    const evs = reconcileEvents.filter((e) => e.id === id);
    const done = evs.filter(presentsCompletedMove);
    const reallyMoved = movedIds.has(id);

    // (a)+(b): a completed-move claim exists for exactly the tickets that really moved.
    eq(done.length, reallyMoved ? 1 : 0,
      `${label}: ${id} — the directory on disk ${reallyMoved ? "really changed" : "did not change"} ` +
      `but ${done.length} event(s) present it as a completed move: ${JSON.stringify(done)}`);

    if (reallyMoved) {
      // (c): one account of one ticket, and its from/to are the real directories.
      eq(evs.length, 1,
        `${label}: ${id} — directory changed on disk but ${evs.length} event(s) describe it`);
      eq(done[0].from, b.status,
        `${label}: ${id} — event 'from' (${done[0].from}) does not match the real before-directory (${b.status})`);
      eq(done[0].to, a.status,
        `${label}: ${id} — event 'to' (${done[0].to}) does not match the real after-directory (${a.status})`);
    }

    // (d) `cleared` is true of a REALISATION exactly when branch/pr really disappeared.
    //
    // REVIEW (finding 3): gated on `applied !== false`. A PREVIEW event PROPOSES what
    // would happen; nothing on disk moves during a dry run (the write port is never
    // called), so `after` trivially equals `before` for every ticket and `clearedIds` is
    // always empty regardless of what the run proposed. Comparing a preview event's
    // `cleared` against that necessarily-unchanged snapshot is comparing a PROPOSAL to a
    // REALISATION that never occurred. The preview half's PROPOSAL is instead graded
    // against a real applied pass, in the equivalence test below (BLZ-421).
    const realisations = evs.filter((e) => e.applied !== false);
    const reallyCleared = clearedIds.has(id);
    eq(realisations.filter((e) => Boolean(e.cleared)).length, reallyCleared ? realisations.length : 0,
      `${label}: ${id} — branch/pr on disk ${reallyCleared ? "did" : "did not"} disappear, but the ` +
      `realisation events for it say ${JSON.stringify(realisations.map((e) => Boolean(e.cleared)))}`);
  }

  // (a), for the case a per-ticket loop over the board cannot see: an event naming a
  // ticket that is not on this board at all.
  deepEq(reconcileEvents.filter((e) => !before.has(e.id)).map((e) => e.id).sort(), [],
    `${label}: the feed published event(s) for id(s) that are not on the board`);

  return { movedIds, clearedIds };
}

/** How many clauses `checkGroundTruth` executes — three per ticket on the board, three
 *  more for each ticket that really moved, and the one whole-set clause. Derived from
 *  the cross-product's declared size and the FILESYSTEM, never from a run. */
const groundTruthBudget = (before, movedIds) => 3 * before.size + 3 * movedIds.size + 1;

let expectedTotal = 0;

describe("BLZ-404 + BLZ-405: the reconcile feed's account of a run matches the filesystem", () => {
  test("applied run: every event's claim about a move matches a real directory change on disk", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz404-oracle-applied-"));
    const prevPath = process.env.PATH;
    let app;
    try {
      const { root, bin, manifest } = buildOracleBoard(tmp);
      process.env.PATH = `${bin}:${prevPath}`;

      const before = snapshotBoard(root);
      assertCrossProductSize(manifest, before, "applied");   // BLZ-420
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

      const runStart = clauses;
      const { movedIds, clearedIds } = checkGroundTruth(before, after, reconcileEvents, "applied");
      // Non-vacuity: an applied run that moves nothing proves nothing about whether the
      // feed's claims track reality — and is exactly what the permanent-dry-run defect
      // (D1) produces. The generated cross-product across many forge signals guarantees
      // real candidates; assert the run actually acted on some of them.
      ok(movedIds.size > 0,
        "applied: the fixture must produce at least one real directory move — 0 means the run never really applied");
      ok(reconcileEvents.length > 0, "applied: the run must publish at least one reconcile event");

      // Non-vacuity for the added dimension (review finding 3): a run that never clears a
      // record proves nothing about whether `cleared` is reported honestly. The
      // ambiguous-merged + hasRecord + non-terminal-status combination is DESIGNED to
      // clear — assert it actually did, on disk, independent of the event.
      ok(clearedIds.size > 0,
        "applied: the fixture must produce at least one REAL branch/pr clear on disk — 0 means " +
        "the added ambiguous-merged + pre-existing-record dimension is not actually exercised");

      // BLZ-404 (review finding 3): a commit-existence clause, ground truth from
      // `git log`/`git show` alone — never from `reconcile()`'s return value. This board's
      // `commitMode` is the default ("per-op"), so a run with real moves must land exactly
      // one new commit whose subject's own claimed ticket-count matches the count of
      // DISTINCT tickets the commit's diff actually touches.
      const commitCountAfter = Number(
        execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
      eq(commitCountAfter, commitCountBefore + 1,
        "applied: a run with real moves, on a per-op-mode board, must create exactly one new commit");

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
      ok(movedMatch, `applied: the commit subject must state its moved-ticket count, got: ${subject}`);
      eq(Number(movedMatch[1]), movedIds.size,
        "applied: the commit subject's claimed MOVED count must match the number of tickets whose " +
        `directory really changed (ground truth: filesystem snapshot), got subject "${subject}" but ` +
        `${movedIds.size} ticket(s) really moved: ${[...movedIds].join(", ")}`);
      const nonMovedGroundTruth = diffIds.size - movedIds.size;
      const updatedMatch = /(\d+) ticket\(s\) updated without a status change/.exec(subject);
      if (nonMovedGroundTruth > 0) {
        ok(updatedMatch,
          `applied: the diff touches ${diffIds.size} distinct ticket(s) but only ${movedIds.size} moved — ` +
          `the subject must name the remaining ${nonMovedGroundTruth} non-moving update(s), got: ${subject}`);
        eq(Number(updatedMatch[1]), nonMovedGroundTruth,
          "applied: the commit subject's non-moving-update count must match the diff's real remainder " +
          `(${nonMovedGroundTruth}), got subject "${subject}"`);
      } else {
        eq(updatedMatch, null,
          `applied: every ticket the diff touches really moved, so the subject must not claim a ` +
          `non-moving update, got: ${subject}`);
      }

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
      eq(boardTreeDirty, "",
        "applied: the board's own project tree must be FULLY committed after an applied run — " +
        `git status --porcelain reports uncommitted change(s) it must not:\n${boardTreeDirty}`);

      // BLZ-465: this run's own budget. Everything above the per-ticket loop is a fixed
      // count for this run's coordinates; the loop's share is derived from the declared
      // cross-product size and the filesystem measurement. `nonMovedGroundTruth` comes
      // from `git show`, an independent source, not from anything the feed said.
      const budget = groundTruthBudget(before, movedIds) + 7 + (nonMovedGroundTruth > 0 ? 2 : 1);
      assert.equal(clauses - runStart, budget,
        `applied: this run executed ${clauses - runStart} clause(s); its declared cross-product ` +
        `and the filesystem budget ${budget}. A clause was added or removed — update ` +
        "groundTruthBudget or this run's constant to match the code, deliberately");
      expectedTotal += budget;
      console.log(`ORACLE (applied): ${budget} clauses checked over ${before.size} tickets and ` +
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
      const { root, bin, manifest } = buildOracleBoard(tmp);
      process.env.PATH = `${bin}:${prevPath}`;

      const before = snapshotBoard(root);
      assertCrossProductSize(manifest, before, "preview");   // BLZ-420

      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      app.bus.subscribe((e) => events.push(e));
      await app.runReconcile({ dryRun: true });

      const after = snapshotBoard(root);
      const reconcileEvents = events.filter((e) => e.type === "reconcile");

      const runStart = clauses;
      const { movedIds } = checkGroundTruth(before, after, reconcileEvents, "preview");
      // (e) in preview mode, NO ticket's path changed on disk at all.
      eq(movedIds.size, 0, "preview: dryRun must not move any ticket's directory on disk");
      // Non-vacuity for this half: a preview that finds nothing to propose cannot prove
      // that a genuine proposal is rendered honestly.
      ok(reconcileEvents.some((e) => e.moved === true),
        "preview: the run must have proposed at least one move, or this half of the oracle is vacuous");

      // Non-vacuity for the added dimension (review finding 3), preview half: the run must
      // PROPOSE at least one clear (this is exactly the proposal clause (d) above
      // deliberately does not grade against ground truth, per its own comment — a dry run
      // never touches disk, so there is nothing real to compare a PROPOSAL against). This
      // still proves the ambiguous-merged + hasRecord dimension reaches the clearing code
      // path in preview, rather than the dimension only ever being reachable when applied.
      ok(reconcileEvents.some((e) => e.cleared === true),
        "preview: the run must have PROPOSED at least one clear, or the added ambiguous-merged + " +
        "pre-existing-record dimension is not exercised in preview at all");

      // BLZ-465. `movedIds` is empty by construction here (a dry run writes nothing), so
      // the loop's moved-ticket share is 0 — asserted rather than assumed by the clause
      // above it.
      const budget = groundTruthBudget(before, movedIds) + 3;
      assert.equal(clauses - runStart, budget,
        `preview: this run executed ${clauses - runStart} clause(s); its declared cross-product ` +
        `and the filesystem budget ${budget}`);
      expectedTotal += budget;
      console.log(`ORACLE (preview): ${budget} clauses checked over ${before.size} tickets and ` +
        `${reconcileEvents.length} events (${movedIds.size} real moves), 0 mismatches`);
    } finally {
      if (app) app.server.close();
      process.env.PATH = prevPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // BLZ-421 — the preview half's `cleared` flag, graded against a REALISATION.
  //
  // The preview half could not detect an OVERSTATED `cleared`. Its only clearing clause
  // was `some(e => e.cleared === true)`, which a production change setting `cleared: true`
  // on every entry satisfies trivially — verified: with `cleared: true` hard-coded into
  // reconcile's change entry, the preview test above stayed green while the applied test
  // went red. The preview's own before/after snapshot cannot supply ground truth (a dry
  // run writes nothing, so `after` always equals `before` and every id looks uncleared).
  //
  // The ground truth used here is still the FILESYSTEM, not the subject: preview and
  // apply run over the SAME board, in that order, and the preview's PROPOSAL is compared
  // to what the apply pass then really does to the files on disk. A preview is a promise
  // about what `--apply` would do; the only honest grader is `--apply` doing it. Nothing
  // reads `reconcile()`'s return, `decide()`, or the applied run's own events.
  // ===========================================================================
  test("preview run: the moves and clears it PROPOSES are exactly the ones an applied pass really performs", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz421-oracle-equiv-"));
    const prevPath = process.env.PATH;
    let app;
    try {
      const { root, bin, manifest } = buildOracleBoard(tmp);
      process.env.PATH = `${bin}:${prevPath}`;

      const before = snapshotBoard(root);
      assertCrossProductSize(manifest, before, "equivalence");   // BLZ-420
      const runStart = clauses;

      const { loadConfig } = await import("../scripts/config.mjs");
      const { createApp } = await import("../scripts/supervisor.mjs");
      app = createApp(loadConfig({ root }), { root });
      const events = [];
      const unsubscribe = app.bus.subscribe((e) => events.push(e));

      await app.runReconcile({ dryRun: true });
      const proposed = events.filter((e) => e.type === "reconcile");
      const midway = snapshotBoard(root);
      deepEq([...midway.keys()].sort(), [...before.keys()].sort(),
        "equivalence: the dry run changed the set of files on disk — it must write nothing");

      // Same board, same starting state, now for real.
      events.length = 0;
      await app.runReconcile();
      const after = snapshotBoard(root);
      if (unsubscribe) unsubscribe();

      // Ground truth: the filesystem, before vs after the APPLY pass.
      const reallyMoved = new Set();
      const reallyCleared = new Set();
      for (const [id, b] of before) {
        const a = after.get(id);
        ok(a, `equivalence: ${id} must still exist on disk after the applied pass`);
        if (b.status !== a.status) reallyMoved.add(id);
        if (hasRecord(b) && !hasRecord(a)) reallyCleared.add(id);
      }

      const proposedMoved = new Set(proposed.filter((e) => e.moved === true).map((e) => e.id));
      const proposedCleared = new Set(proposed.filter((e) => e.cleared === true).map((e) => e.id));

      // Non-vacuity FIRST: an empty proposal set would satisfy every equality below.
      ok(reallyMoved.size > 0, "equivalence: the applied pass must really move something");
      ok(reallyCleared.size > 0,
        "equivalence: the applied pass must really clear at least one branch/pr on disk");

      deepEq([...proposedCleared].sort(), [...reallyCleared].sort(),
        "equivalence: the preview PROPOSED a different set of branch/pr clears than the " +
        "applied pass then really performed on disk — a preview that over- or under-states " +
        "`cleared` is exactly BLZ-421's hole");
      deepEq([...proposedMoved].sort(), [...reallyMoved].sort(),
        "equivalence: the preview PROPOSED a different set of moves than the applied pass " +
        "then really performed on disk");

      // BLZ-465. This run's share used to be the hand-written `before.size + 6`; the code
      // executes `before.size + 5` — the dry-run-wrote-nothing clause, one existence
      // clause per ticket, two non-vacuity clauses and the two set equalities. Nothing
      // could catch the extra 1, because nothing compared the figure to anything.
      const budget = before.size + 5;
      assert.equal(clauses - runStart, budget,
        `equivalence: this run executed ${clauses - runStart} clause(s); the declared ` +
        `cross-product budgets ${budget}`);
      expectedTotal += budget;
      console.log(`ORACLE (equivalence): ${budget} clauses over ${before.size} tickets; preview proposed ` +
        `${proposedMoved.size} move(s) and ${proposedCleared.size} clear(s); the applied pass ` +
        `really made ${reallyMoved.size} and ${reallyCleared.size}, 0 mismatches`);
    } finally {
      if (app) app.server.close();
      process.env.PATH = prevPath;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("ORACLE TOTAL", () => {
    // BLZ-465: ASSERTED, not merely printed, and asserted against the SUM OF THE THREE
    // RUNS' OWN BUDGETS — each derived from the declared cross-product size and the
    // filesystem, none read off a passing run. This used to be `assert.ok(totalClauses >
    // 0)`, which every possible run satisfies. Each run already checked its own share, so
    // a mismatch HERE means a clause was added or removed outside one of the three.
    console.log(`ORACLE TOTAL: ${clauses} clauses checked and ASSERTED across the applied, ` +
      "preview and equivalence runs, 0 mismatches");
    assert.equal(expectedTotal > 0, true,
      "ORACLE TOTAL ran before the three runs did — it must be the last test in this file");
    assert.equal(clauses, expectedTotal,
      `the oracle executed ${clauses} clause(s); the three runs' own budgets sum to ${expectedTotal}`);
  });
});
