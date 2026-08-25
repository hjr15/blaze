// reconcile-delivery-truth.test.mjs — BLZ-130 + BLZ-131.
//
// Two bugs, one failure: reconcile's reading of git/PR state diverges from
// delivery truth, in opposite directions.
//
//   BLZ-130 — ANY merged PR carrying a key drove the ticket to done, even while a
//             later PR carrying the same key was still OPEN. Over-reports.
//   BLZ-131 — a squash merge collapses a branch's commits into one whose SUBJECT is
//             the PR title, so per-ticket `KEY-n:` subjects do not survive and
//             bundled children never reconcile at all. Under-reports.
//
// Both are guarded here against the real recorded evidence: hjr15/service-platform
// epic INF-645, its merged docs-only PR #80, its open PR #81, and the six children
// stranded by the squash of #81.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile, buildPrMap, buildBranchMap, decide, idsFromCommitMessage, idsFromSubject } from "../scripts/reconcile.mjs";

const idFromRef = (ref) => {
  const m = /\bINF-(\d+)/i.exec(ref || "");
  return m ? `INF-${m[1]}` : null;
};

// The two PRs exactly as recorded on the epic, titles following the house
// `KEY-n: desc` convention so both claims corroborate under INF-735.
const PR_80_MERGED = {
  number: 80, state: "MERGED", url: "u80", headRefName: "INF-645-descope-dead-mans-switch",
  title: "INF-645: descope the dead-man's switch for local; cover the real risk with a CI guard test",
};
const PR_81_OPEN = {
  number: 81, state: "OPEN", url: "u81", headRefName: "INF-645-tier1-alert-gaps",
  title: "INF-645: close the Tier-1 alert gaps, guard the blackhole receiver, centralise observability docs",
};

function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
}

/** A board with one INF project pointed at `codeRepo`. Returns its root. */
function board(tmp, codeRepo, tickets) {
  const root = join(tmp, "board");
  const projectsDir = join(root, "projects");
  mkdirSync(projectsDir, { recursive: true });
  for (const [id, type, status, extra] of tickets) {
    const dir = join(projectsDir, "INF", status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}-t.md`),
      `---\nid: ${id}\ntype: ${type}\nproject: INF\nestimate: 30\n${extra || ""}---\n\nbody\n`);
  }
  writeFileSync(join(root, "blaze.config.json"),
    JSON.stringify({ key: "INF", projects: ["INF"], codeRepos: [codeRepo] }));
  return root;
}

/** Put a `gh` on PATH that answers `pr list` with `prs`. Returns a restore fn. */
function stubGh(tmp, prs) {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  return () => { process.env.PATH = prev; };
}

// =============================================================================
// BLZ-130 — an OPEN PR carrying the key vetoes "done"
// =============================================================================

test("BLZ-130: an OPEN PR outranks a MERGED one — the epic is not shipped while work is open", () => {
  const prMap = buildPrMap([PR_80_MERGED, PR_81_OPEN], idFromRef, null);
  const chosen = prMap.get("INF-645");
  assert.equal(chosen.state, "OPEN",
    "PR #80 merging early must not out-rank the open PR that carries the actual work");
  assert.equal(chosen.number, 81);
});

test("BLZ-130: PR order does not change the verdict — the open PR wins either way", () => {
  // Guards the ranking itself rather than iteration order: reverse the input and
  // the answer must not move.
  assert.equal(buildPrMap([PR_81_OPEN, PR_80_MERGED], idFromRef, null).get("INF-645").state, "OPEN");
});

test("BLZ-130: the chosen PR drives the epic to in-review, never done", () => {
  const prMap = buildPrMap([PR_80_MERGED, PR_81_OPEN], idFromRef, null);
  const d = decide({ pr: prMap.get("INF-645") }, "defined", "epic");
  assert.equal(d.target, "in-review");
  assert.notEqual(d.target, "done", "this is the bug: the board said shipped while PR #81 was open");
  assert.equal(d.resolution, undefined, "a non-terminal target must not carry a resolution");
});

test("BLZ-130: a lone MERGED PR still reaches done — the fix must not disable reconcile", () => {
  const prMap = buildPrMap([PR_80_MERGED], idFromRef, null);
  assert.equal(prMap.get("INF-645").state, "MERGED");
  assert.equal(decide({ pr: prMap.get("INF-645") }, "in-review", "epic").target, "done");
});

test("BLZ-130: a MERGED PR still outranks a CLOSED one", () => {
  const closed = { ...PR_80_MERGED, number: 79, state: "CLOSED", title: "INF-645: abandoned attempt" };
  assert.equal(buildPrMap([closed, PR_80_MERGED], idFromRef, null).get("INF-645").state, "MERGED");
});

// AC-3: the ticket asks whether `story` shares the failure. It does — and so does
// every other delivery type, because the veto lives in PR ranking, which never
// sees the type. Pinned for all four rather than scoped out.
for (const type of ["epic", "story", "task", "bug"]) {
  test(`BLZ-130: the open-PR veto is type-independent — ${type}`, () => {
    const prMap = buildPrMap([PR_80_MERGED, PR_81_OPEN], idFromRef, null);
    assert.equal(decide({ pr: prMap.get("INF-645") }, "defined", type).target, "in-review");
  });
}

test("BLZ-130 regression, end-to-end: an epic with one merged and one open PR stays out of done/", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "blz130-e2e-"));
  const codeRepo = join(tmp, "svc");
  mkdirSync(codeRepo, { recursive: true });
  gitInit(codeRepo);
  execFileSync("git", ["-C", codeRepo, "remote", "add", "origin", "https://github.com/hjr15/service-platform.git"]);
  const root = board(tmp, codeRepo, [["INF-645", "epic", "defined"]]);
  const restore = stubGh(tmp, [PR_80_MERGED, PR_81_OPEN]);
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.equal(r.ok, true);
    assert.deepEqual(r.forgeErrors, [], "the gh stub must be read successfully or this proves nothing");
    assert.ok(!existsSync(join(root, "projects", "INF", "done", "INF-645-t.md")),
      "INF-645 must NOT be in done/ — PR #81 carrying its work is still open");
    assert.ok(existsSync(join(root, "projects", "INF", "in-review", "INF-645-t.md")),
      "it belongs in in-review, the status its open PR actually describes");
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// BLZ-131 — a squash body's bulleted subjects are the shipped signal
// =============================================================================

test("BLZ-131: a squashed epic PR's bulleted body subjects count as shipped", () => {
  // Verbatim shape of GitHub's default squash message: PR title as the subject,
  // each collapsed commit's subject as a `* ` bullet in the body.
  const msg = [
    "INF-645: close the Tier-1 alert gaps (#81)",
    "",
    "* INF-646: guard the blackhole receiver",
    "",
    "Some prose about the receiver.",
    "",
    "* INF-647: centralise observability docs",
  ].join("\n");
  assert.deepEqual(idsFromCommitMessage(msg, "INF"), ["INF-645", "INF-646", "INF-647"]);
});

test("BLZ-131: the subject alone is still read, so a solo ticket's commit is unaffected", () => {
  assert.deepEqual(idsFromCommitMessage("INF-9: do the thing", "INF"), ["INF-9"]);
});

test("BLZ-131: prose that merely NAMES a ticket is not evidence it shipped", () => {
  // Measured on blaze's own history: unbulleted body lines really do begin with
  // `KEY-n:` — plan listings and wrapped prose. Honouring them would mark
  // untouched tickets done, which is BLZ-130's failure re-introduced.
  const msg = [
    "INF-1: the real work",
    "",
    "INF-103: config-schema versioning + migration guard",
    "INF-376: ticket is not STRICT and never was\" immediately followed by \"and under",
    "fixes INF-4 and relates to INF-5",
  ].join("\n");
  assert.deepEqual(idsFromCommitMessage(msg, "INF"), ["INF-1"]);
});

test("BLZ-131: a bullet naming another project's key is not this project's signal", () => {
  assert.deepEqual(idsFromCommitMessage("INF-1: x\n\n* OBA-2: not ours", "INF"), ["INF-1"]);
});

test("BLZ-131: a bullet without the `KEY-n:` subject form is not a collapsed commit", () => {
  assert.deepEqual(idsFromCommitMessage("INF-1: x\n\n* see INF-2 for context", "INF"), ["INF-1"]);
});

test("BLZ-131 regression, end-to-end: six children of one squashed epic PR all reach done/", async () => {
  // The recorded INF-645 shape: one squash commit on main whose subject is the PR
  // title, and ZERO surviving per-ticket subjects — every child's subject exists
  // only as a bullet in the body.
  const tmp = mkdtempSync(join(tmpdir(), "blz131-e2e-"));
  const codeRepo = join(tmp, "svc");
  mkdirSync(codeRepo, { recursive: true });
  gitInit(codeRepo);
  const children = ["INF-646", "INF-647", "INF-648", "INF-649", "INF-650", "INF-652"];
  const squashMsg = "INF-645: close the Tier-1 alert gaps, guard the blackhole receiver (#81)\n\n"
    + children.map((c) => `* ${c}: work for ${c}`).join("\n\n");
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m", squashMsg]);

  // Prove the premise before asserting the fix: no child's subject survived.
  const subjects = execFileSync("git", ["-C", codeRepo, "log", "main", "--format=%s"], { encoding: "utf8" });
  for (const c of children) {
    assert.doesNotMatch(subjects, new RegExp(`^${c}:`, "m"), `${c} must have no surviving commit subject`);
  }

  const root = board(tmp, codeRepo, children.map((c) => [c, "task", "defined"]));
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.equal(r.ok, true);
    for (const c of children) {
      assert.ok(existsSync(join(root, "projects", "INF", "done", `${c}-t.md`)),
        `${c} shipped inside the squashed epic PR and must reach done/`);
      assert.ok(!existsSync(join(root, "projects", "INF", "defined", `${c}-t.md`)),
        `${c} must not be stranded in defined/`);
    }
    const again = await reconcile({ root, dryRun: false });
    assert.deepEqual(again.changes.filter((c) => children.includes(c.id)), [],
      "a second run must be a no-op — the shipped signal is not a repeating write");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-131: a child whose bullet is only on an unmerged branch does NOT move", async () => {
  // The safe direction, kept: the squash body counts only once it is ON the
  // default branch. A still-open epic PR strands nothing to done.
  const tmp = mkdtempSync(join(tmpdir(), "blz131-open-"));
  const codeRepo = join(tmp, "svc");
  mkdirSync(codeRepo, { recursive: true });
  gitInit(codeRepo);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "-b", "INF-700-bundle"]);
  execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m",
    "INF-700: the bundle (#99)\n\n* INF-701: unmerged child work"]);
  execFileSync("git", ["-C", codeRepo, "checkout", "-q", "main"]);
  const root = board(tmp, codeRepo, [["INF-701", "task", "defined"]]);
  try {
    await reconcile({ root, dryRun: false });
    assert.ok(existsSync(join(root, "projects", "INF", "defined", "INF-701-t.md")),
      "a child whose bundle has not merged must stay put");
    assert.ok(!existsSync(join(root, "projects", "INF", "done", "INF-701-t.md")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// Round 2 — defects an adversarial review found before merge
// =============================================================================

// FINDING 1, the critical one. `scripts/commit-runner.mjs` writes every batch board
// commit's body as `- <message> [<session>]`, and those messages are `KEY-n: <board
// op>`. The board repo is itself a configured codeRepo for its own project, which is
// the hazard INF-735's comment already names. So a first cut that honoured any
// `[*+-]` bullet turned the board's OWN LEDGER into a delivery signal: measured on the
// live board, 299 ids were harvested where the shipped set should have gained none,
// and `decide()` moved 137 INF tickets `defined → done` off `edit labels` and
// `defined → in-progress` lines. BLZ-130's failure, at a hundred times the scale,
// re-introduced by the fix for its sibling.
describe("BLZ-131: a bullet is only delivery inside a squashed TICKET PR", () => {
  test("a board-ledger commit's `- KEY-n:` lines are not delivery", () => {
    const msg = [
      "blaze: 2026-08-08 board update (3 moves, 1 edit)",
      "",
      "- INF-15: edit labels [inf-truth-20260802]",
      "- INF-350: defined → in-progress [inf-truth-20260802]",
      "- INF-909: in-progress → in-review [inf907-epic-closeout]",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), [],
      "moving a ticket on the board is not shipping it");
  });

  test("`* KEY-n:` bullets under a non-ticket subject are not delivery either", () => {
    // Real shape from the board repo: a squashed PR of board CONTENT edits. The
    // bullets are genuine `KEY-n:` commit subjects; what they describe is editing a
    // ticket's body, not delivering it.
    const msg = [
      "blaze: 2026-08-08 board + ticket work (#60)",
      "",
      "* INF-805: record that the stuck Application blocks ALL new infra deploys",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), [],
      "a squash whose own subject names no ticket is not a bundled feature PR");
  });

  test("a `- KEY-n:` ledger line inside a squashed TICKET PR is still not delivery", () => {
    // ISOLATES THE MARKER, and it exists because a mutation sweep caught the gap: with
    // only the non-ticket-subject case covered, widening the marker back to `[*+-]`
    // killed nothing, because the subject gate was already rejecting that fixture. The
    // marker earns its place on exactly this shape — the board's ledger lines swept into
    // a PR that IS titled for a ticket, which on the board repo is the difference
    // between 41 false ids and 2 true ones.
    const msg = [
      "INF-693: deploy-path observability epic (board) (#24)",
      "",
      "* INF-701: file the two follow-ups from INF-693's final review",
      "- INF-15: edit labels [inf-truth-20260802]",
      "- INF-350: defined → in-progress [inf-truth-20260802]",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), ["INF-693", "INF-701"],
      "the starred child ships; the dashed ledger lines do not");
  });

  test("...but bullets under a squashed TICKET PR are exactly what BLZ-131 is for", () => {
    // The real INF-693 shape from the board repo: an epic PR titled `KEY-n: …`
    // carrying a child's commit. This one MUST still be honoured.
    const msg = [
      "INF-693: deploy-path observability epic (board) (#24)",
      "",
      "* INF-701: file the two follow-ups from INF-693's final review",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), ["INF-693", "INF-701"]);
  });

  test("regression, end-to-end: a board ledger on the default branch ships nothing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz131-ledger-"));
    const codeRepo = join(tmp, "board");
    mkdirSync(codeRepo, { recursive: true });
    gitInit(codeRepo);
    execFileSync("git", ["-C", codeRepo, "commit", "-q", "--allow-empty", "-m",
      "blaze: 2026-08-08 board update (2 moves)\n\n"
      + "- INF-15: edit labels [s1]\n- INF-16: defined → in-progress [s1]"]);
    const root = board(tmp, codeRepo, [["INF-15", "task", "defined"], ["INF-16", "task", "defined"]]);
    try {
      await reconcile({ root, dryRun: false });
      for (const id of ["INF-15", "INF-16"]) {
        assert.ok(existsSync(join(root, "projects", "INF", "defined", `${id}-t.md`)),
          `${id} was only EDITED on the board — it must not be reported as shipped`);
        assert.ok(!existsSync(join(root, "projects", "INF", "done", `${id}-t.md`)));
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

// FINDING 2. Terminal-sticky clamped `target` and nothing else, so the branch/pr
// frontmatter of an ALREADY-DONE ticket was rewritten to point at whichever PR now won
// the rank — which, after BLZ-130, is a later OPEN one. The move was correctly
// suppressed and the delivery record was silently replaced anyway: `#80 — u80` became
// `#81 — u81` on a ticket #80 actually delivered. One-time corruption, not per-run
// churn (a second run reports no change), and it destroys the only record of what
// shipped the work.
describe("BLZ-130: a terminal ticket's delivery record is history, not a live field", () => {
  test("a later OPEN PR does not rewrite a done ticket's branch and pr", () => {
    const d = decide({ pr: PR_81_OPEN }, "done", "epic");
    assert.equal(d.target, "done");
    assert.equal(d.moved, false);
    assert.equal(d.branchVal, null, "the branch that delivered it must not be overwritten");
    assert.equal(d.prVal, null, "nor the PR that delivered it");
  });

  test("a non-terminal ticket still records its branch and pr", () => {
    const d = decide({ pr: PR_81_OPEN }, "defined", "epic");
    assert.equal(d.branchVal, "INF-645-tier1-alert-gaps");
    assert.equal(d.prVal, "#81 — u81");
  });
});

// =============================================================================
// Round 3 — defects round 2's own fixes introduced
// =============================================================================

// FINDING 1. The terminal clamp stopped the OVERWRITE and stopped the WRITE with it.
// `branchVal`/`prVal` were nulled for every terminal ticket, and the caller only writes
// on a truthy value — so a done ticket that never had its PR recorded could never
// acquire one. Reconcile is the sole producer of those fields, so that is permanent:
// on the live board 945 of 1,479 done tickets carry no `pr:` at all. The corruption
// this was written to stop is an OPEN PR replacing the record of the MERGED one that
// delivered the work; withholding the merged record too was over-correction, and the
// fix's own rationale — "the branch and PR are what delivered it" — argues against it.
describe("BLZ-130: a terminal ticket records what delivered it, and nothing else", () => {
  test("a done ticket with no record yet still gets the MERGED PR that delivered it", () => {
    const d = decide({ pr: PR_80_MERGED }, "done", "epic");
    assert.equal(d.target, "done");
    assert.equal(d.moved, false);
    assert.equal(d.branchVal, "INF-645-descope-dead-mans-switch",
      "reconcile is the only producer of this field — withholding it strands the ticket forever");
    assert.equal(d.prVal, "#80 — u80");
  });

  test("but a later OPEN PR still cannot replace it", () => {
    const d = decide({ pr: PR_81_OPEN }, "done", "epic");
    assert.equal(d.branchVal, null, "an open PR has not delivered anything");
    assert.equal(d.prVal, null);
  });

  test("a bare branch is not a delivery record for a terminal ticket either", () => {
    const d = decide({ branch: "INF-645-stale-leftover" }, "done", "epic");
    assert.equal(d.branchVal, null);
  });
});

// FINDING 2. The subject gate rejected the house's own multi-ticket feature titles.
// `BLZ-286/287/288: config projection … (#71)` is a real squashed feature PR on this
// repo's default branch carrying three genuine `* BLZ-…:` bullets, and the gate threw
// all three away. Worse, THIS PR is titled `BLZ-130 + BLZ-131: …`, so merging it would
// have stranded BLZ-131 — the gate rests on "a feature PR is titled that way by
// convention", and both multi-ticket PRs in this repo's history use a shape it rejected.
describe("BLZ-131: a feature PR may name more than one ticket", () => {
  test("a `/`-joined title is a ticket subject, and every id in it counts", () => {
    const msg = [
      "BLZ-286/287/288: config projection — resolved_* tables (#71)",
      "",
      "* BLZ-286: the blaze_config namespace",
      "* BLZ-287: the resolved_* projection tables",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "BLZ"), ["BLZ-286", "BLZ-287", "BLZ-288"]);
  });

  test("a `+`-joined title too — the shape this very PR uses", () => {
    const msg = [
      "BLZ-130 + BLZ-131: reconcile stops saying shipped when it is not (#123)",
      "",
      "* BLZ-130: an open pull request vetoes done",
      "* BLZ-131: a bullet only counts inside a squashed ticket PR",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "BLZ"), ["BLZ-130", "BLZ-131"]);
  });

  test("an id mentioned AFTER the colon is still only a mention", () => {
    // The anchored-leading-id rule this file has always had must survive the widening.
    assert.deepEqual(idsFromCommitMessage("BLZ-1: fixes BLZ-4 and relates to BLZ-5", "BLZ"),
      ["BLZ-1"]);
  });

  test("the widening does not re-admit the board ledger", () => {
    const msg = "blaze: 2026-08-08 board update (3 moves)\n\n- INF-15: edit labels [s1]";
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), []);
  });

  test("nor a board-content PR whose subject names no ticket", () => {
    const msg = "blaze: 2026-08-08 board + ticket work (#60)\n\n* INF-805: record the stuck Application";
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), []);
  });
});

// =============================================================================
// Round 4 — defects round 3's own fixes introduced
// =============================================================================

// FINDING 2. The colon anchor in `idsFromSubject` was entirely unpinned: deleting the
// `(?=\s*:)` lookahead killed no test in any of the eleven reconcile test files, while
// it is the whole of condition 2 for a colon-less subject. Round 3's commit message
// claimed "the list must be contiguous and end at the colon, and a test pins that" —
// what the existing test pinned was the separator class, not the colon.
describe("BLZ-131: the subject's id list must END at a colon", () => {
  test("a subject with no colon claims nothing, and its bullets go with it", () => {
    assert.deepEqual(idsFromCommitMessage("BLZ-36 dep bump\n\n* BLZ-99: never shipped", "BLZ"), []);
  });

  test("idsFromSubject: the leading list, and only the leading list", () => {
    assert.deepEqual(idsFromSubject("BLZ-286/287/288: config projection (#71)", "BLZ"),
      ["BLZ-286", "BLZ-287", "BLZ-288"]);
    assert.deepEqual(idsFromSubject("BLZ-130 + BLZ-131: reconcile (#123)", "BLZ"),
      ["BLZ-130", "BLZ-131"]);
    assert.deepEqual(idsFromSubject("BLZ-1: fixes BLZ-4", "BLZ"), ["BLZ-1"]);
    assert.deepEqual(idsFromSubject("BLZ-36 dep bump", "BLZ"), [], "no colon, no claim");
    assert.deepEqual(idsFromSubject("docs: mentions BLZ-9", "BLZ"), [], "not leading, no claim");
    assert.deepEqual(idsFromSubject("blaze: 2026-08-08 board update (3 moves)", "INF"), []);
    assert.deepEqual(idsFromSubject("", "BLZ"), []);
  });
});

// =============================================================================
// Round 5 — latitude wider than anything documented or intended
// =============================================================================

describe("BLZ-131: the subject list accepts only the forms the house writes", () => {
  test("a bare number is a continuation only after `/`", () => {
    // `KEY-a/b/c:` is the house's own shorthand and omits the key on continuations.
    // `+`, `,` and `&` do not, so accepting a bare number after them let an ordinary
    // subject claim a ticket that does not exist: `BLZ-1 + 2026: annual` yielded
    // BLZ-2026. Nothing documented that latitude and nothing wanted it.
    assert.deepEqual(idsFromSubject("BLZ-286/287/288: config projection", "BLZ"),
      ["BLZ-286", "BLZ-287", "BLZ-288"]);
    assert.deepEqual(idsFromSubject("BLZ-1 + 2026: annual review", "BLZ"), [],
      "a year is not a ticket id");
    assert.deepEqual(idsFromSubject("BLZ-1 + BLZ-2: real pair", "BLZ"), ["BLZ-1", "BLZ-2"]);
  });

  test("an indented bullet is not a collapsed commit subject", () => {
    // Every one of the 104 `* KEY-n:` lines in this repo's history sits at column 0,
    // which is where GitHub writes them. An indented one is a sub-bullet inside some
    // commit's prose, and reading it as a delivered child is a guess.
    assert.deepEqual(idsFromCommitMessage("BLZ-1: x\n\n  * BLZ-2: a nested note", "BLZ"),
      ["BLZ-1"]);
    assert.deepEqual(idsFromCommitMessage("BLZ-1: x\n\n* BLZ-2: a real child", "BLZ"),
      ["BLZ-1", "BLZ-2"]);
  });
});

// =============================================================================
// Round 6 — a fix that was described but never shipped, and two unpinned lines
// =============================================================================

// THE WRITE-ONCE RULE WAS LOST IN A COMMIT SPLIT. `57f2313` describes it, the ADR and
// the guide assert it, and the code never had it: splitting round 4 into per-ticket
// commits reverted the hunk and the branch carried on from the reverted tree. The
// comment in `decide` ended "Hence also the write-once rule below" with nothing below
// it. A review reproduced the exact corruption the commit claimed to have closed.
describe("BLZ-130: the record is written once — the rule, not just the comment", () => {
  test("decide flags a terminal ticket as record-if-absent-only", () => {
    assert.equal(decide({ pr: PR_80_MERGED }, "done", "epic").recordIfAbsentOnly, true);
    assert.equal(decide({ pr: PR_80_MERGED }, "in-review", "epic").recordIfAbsentOnly, false);
  });

  test("a later MERGED follow-up PR does not replace the record of what delivered it", async () => {
    const followUp = {
      number: 123, state: "MERGED", url: "u123", headRefName: "INF-645-follow-up-docs-tidy",
      title: "INF-645: follow-up docs tidy",
    };
    const tmp = mkdtempSync(join(tmpdir(), "blz130-writeonce-"));
    const codeRepo = join(tmp, "svc");
    mkdirSync(codeRepo, { recursive: true });
    gitInit(codeRepo);
    execFileSync("git", ["-C", codeRepo, "remote", "add", "origin",
      "https://github.com/hjr15/service-platform.git"]);
    const root = board(tmp, codeRepo,
      [["INF-645", "epic", "done", "branch: INF-645-descope-dead-mans-switch\npr: '#80 — u80'\n"]]);
    const restore = stubGh(tmp, [PR_80_MERGED, followUp]);
    try {
      await reconcile({ root, dryRun: false });
      const body = readFileSync(join(root, "projects", "INF", "done", "INF-645-t.md"), "utf8");
      assert.match(body, /pr: '?#80/, "a docs follow-up must not claim to have delivered the epic");
      assert.doesNotMatch(body, /#123/);
      assert.doesNotMatch(body, /follow-up-docs-tidy/);
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });

  // THE OTHER HALF OF THE SAME RULE, AND THE ONE NO TEST REACHED. `keep()` is
  // `recordIfAbsentOnly && Boolean(current)`; every assertion above seeds the ticket
  // WITH a record, so all of them survive dropping `&& Boolean(current)` — which turns
  // "fill a blank, never overwrite" into "never write at all". That is direction 2, the
  // over-correction round 2 already made once: reconcile is the sole producer of these
  // fields, so a terminal ticket that never acquired one could never acquire it again.
  // 1,141 of 1,679 `done` tickets on the board carry neither field today.
  test("a done ticket with NO record still acquires one — write-once fills a blank", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz130-backfill-"));
    const codeRepo = join(tmp, "svc");
    mkdirSync(codeRepo, { recursive: true });
    gitInit(codeRepo);
    execFileSync("git", ["-C", codeRepo, "remote", "add", "origin",
      "https://github.com/hjr15/service-platform.git"]);
    const root = board(tmp, codeRepo, [["INF-645", "epic", "done", ""]]);
    const restore = stubGh(tmp, [PR_80_MERGED]);
    try {
      await reconcile({ root, dryRun: false });
      const body = readFileSync(join(root, "projects", "INF", "done", "INF-645-t.md"), "utf8");
      assert.match(body, /branch: INF-645-descope-dead-mans-switch/,
        "a blank branch on a terminal ticket must be filled, not kept blank");
      assert.match(body, /pr: '?#80/,
        "a blank pr on a terminal ticket must be filled, not kept blank");
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });

  test("a non-terminal ticket's record still UPDATES — write-once is terminal-only", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz130-nonterm-"));
    const codeRepo = join(tmp, "svc");
    mkdirSync(codeRepo, { recursive: true });
    gitInit(codeRepo);
    execFileSync("git", ["-C", codeRepo, "remote", "add", "origin",
      "https://github.com/hjr15/service-platform.git"]);
    const root = board(tmp, codeRepo,
      [["INF-700", "task", "in-progress", "branch: INF-700-old\npr: '#1 — u1'\n"]]);
    const restore = stubGh(tmp, [{ number: 9, state: "OPEN", url: "u9",
      headRefName: "INF-700-new", title: "INF-700: the current work" }]);
    try {
      await reconcile({ root, dryRun: false });
      const f = join(root, "projects", "INF", "in-review", "INF-700-t.md");
      assert.ok(existsSync(f), "an open PR moves a non-terminal ticket to in-review");
      assert.match(readFileSync(f, "utf8"), /#9/, "and its record must follow the live PR");
    } finally { restore(); rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("BLZ-131: the leading anchor, and the house's other multi-id form", () => {
  test("an id that does not START the subject claims nothing", () => {
    // The `^` was as unpinned as the colon was: deleting it left the whole suite green
    // while `revert BLZ-42: undo` shipped BLZ-42.
    assert.deepEqual(idsFromSubject("revert BLZ-42: undo", "BLZ"), []);
    assert.deepEqual(idsFromSubject("chore: bump deps BLZ-99: never shipped", "BLZ"), []);
    assert.deepEqual(idsFromCommitMessage("revert BLZ-42: undo\n\n* BLZ-43: x", "BLZ"), []);
  });

  // THE SIBLING ANCHOR, WHICH "pin the anchors" DID NOT PIN. `idFromSubject` carries the
  // same leading `^` as `idsFromSubject` and gates BRANCH CORROBORATION, and deleting it
  // left the whole suite green. Asserted through `buildBranchMap` rather than the bare
  // function, because the gate is the thing that matters: without the anchor a branch
  // whose only commit is `revert BLZ-42: undo` corroborates BLZ-42 and shadows that
  // ticket's real branch — the id-squatting the function's own comment warns about.
  test("a branch whose commits only MENTION an id does not corroborate it", () => {
    const refs = ["BLZ-42-squatter"];
    const map = buildBranchMap(refs, () => "BLZ-42", {
      key: "BLZ",
      shippedSet: new Set(),
      inspect: () => ({ own: ["revert BLZ-42: undo"], sameTipAsDefault: false }),
    });
    assert.equal(map.has("BLZ-42"), false,
      "a downstream mention must not corroborate a branch");

    const led = buildBranchMap(refs, () => "BLZ-42", {
      key: "BLZ",
      shippedSet: new Set(),
      inspect: () => ({ own: ["BLZ-42: the real work"], sameTipAsDefault: false }),
    });
    assert.equal(led.get("BLZ-42"), "BLZ-42-squatter",
      "a leading id must still corroborate — this is a gate, not a wall");
  });

  test("`/` accepts a repeated key as well as a bare number", () => {
    // Real subject on the board repo: `INF-409/INF-410: log time + move to in-review`.
    // Round 5 narrowed `/` to bare numbers only, which dropped BOTH ids — the anchored
    // match died at the `/` rather than falling back to the first id.
    assert.deepEqual(idsFromSubject("INF-409/INF-410: log time + move to in-review", "INF"),
      ["INF-409", "INF-410"]);
    assert.deepEqual(idsFromSubject("BLZ-286/287/288: config projection", "BLZ"),
      ["BLZ-286", "BLZ-287", "BLZ-288"]);
    assert.deepEqual(idsFromSubject("BLZ-1 + 2026: annual review", "BLZ"), [],
      "a bare number after `+` is still not a ticket id");
  });
});
