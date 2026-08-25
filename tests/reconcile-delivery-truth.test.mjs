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
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile, buildPrMap, decide, idsFromCommitMessage } from "../scripts/reconcile.mjs";

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
  for (const [id, type, status] of tickets) {
    const dir = join(projectsDir, "INF", status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}-t.md`),
      `---\nid: ${id}\ntype: ${type}\nproject: INF\nestimate: 30\n---\n\nbody\n`);
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
