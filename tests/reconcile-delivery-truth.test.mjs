// reconcile-delivery-truth.test.mjs — BLZ-130.
//
// Reconcile drove a ticket to done off ANY merged PR carrying its key, even while a
// later PR carrying the same key was still OPEN. It over-reports, and it does so
// silently and stickily.
//
// Guarded against the real recorded evidence: hjr15/service-platform epic INF-645,
// its merged docs-only PR #80, and its open PR #81.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile, buildPrMap, decide } from "../scripts/reconcile.mjs";

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
