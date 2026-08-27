// reconcile-terminal-open-pr.test.mjs — BLZ-395.
//
// The residual ADR-0023 §1 left open. BLZ-130 made an OPEN pull request veto `done`,
// but the veto is evaluated at RUN TIME and terminal status is sticky, so the board's
// answer depends on WHEN reconcile sampled git:
//
//   run 1, only #80 MERGED exists   -> INF-645: defined -> done
//   #81 then opens
//   run 2, #80 MERGED + #81 OPEN    -> INF-645: done -> done   (moved: false)
//
// Both PRs visible at the first run gives `in-review`, which is correct. The same end
// state reached in two steps gives `done`, which is not.
//
// DECIDED: REPORT, DON'T MOVE — ADR-0023 §1's second option, recorded there. Terminal
// stickiness is preserved DELIBERATELY, not by omission, and the tests below pin both
// halves: nothing moves, and something is said.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile, buildPrMap, decide } from "../scripts/reconcile.mjs";
import { newFindingEvents } from "../scripts/supervisor.mjs";

const idFromRef = (ref) => {
  const m = /\bINF-(\d+)/i.exec(ref || "");
  return m ? `INF-${m[1]}` : null;
};

// The two PRs exactly as recorded on epic INF-645 in hjr15/service-platform.
const PR_80_MERGED = {
  number: 80, state: "MERGED", url: "u80", headRefName: "INF-645-descope-dead-mans-switch",
  title: "INF-645: descope the dead-man's switch for local",
};
const PR_81_OPEN = {
  number: 81, state: "OPEN", url: "u81", headRefName: "INF-645-tier1-alert-gaps",
  title: "INF-645: close the Tier-1 alert gaps",
};

function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
}

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

/** Put a `gh` on PATH answering `pr list` with `prs`. Returns a restore fn. */
function stubGh(tmp, prs, name = "bin") {
  const bin = join(tmp, name);
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(prs)}\nJSON\n`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  return () => { process.env.PATH = prev; };
}

function fixture(tmp, tickets) {
  const codeRepo = join(tmp, "svc");
  mkdirSync(codeRepo, { recursive: true });
  gitInit(codeRepo);
  execFileSync("git", ["-C", codeRepo, "remote", "add", "origin",
    "https://github.com/hjr15/service-platform.git"]);
  return board(tmp, codeRepo, tickets);
}

const ticketAt = (root, status) => join(root, "projects", "INF", status, "INF-645-t.md");

// =============================================================================
// The two-run sequence — the AC's own reproduction
// =============================================================================

describe("BLZ-395: the window is opened by WHEN reconcile sampled git", () => {
  test("regression, end-to-end: run 1's `done` is what makes run 2 wrong", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz395-seq-"));
    const root = fixture(tmp, [["INF-645", "epic", "defined"]]);
    let restore = stubGh(tmp, [PR_80_MERGED], "bin1");
    try {
      // RUN 1 — only the early docs PR exists. Nothing here is wrong yet: a lone
      // merged PR reaching `done` is the behaviour BLZ-130 deliberately preserved.
      const r1 = await reconcile({ root, dryRun: false });
      assert.deepEqual(r1.forgeErrors, [], "the gh stub must be read or this proves nothing");
      assert.ok(existsSync(ticketAt(root, "done")), "run 1 moves INF-645 to done/");
      assert.deepEqual(r1.findings, [], "nothing to report yet — no PR is open");
      restore();

      // #81 opens. RUN 2 sees both, and the veto that WOULD have said `in-review`
      // arrives too late: terminal status is sticky.
      restore = stubGh(tmp, [PR_80_MERGED, PR_81_OPEN], "bin2");
      const r2 = await reconcile({ root, dryRun: false });
      assert.deepEqual(r2.forgeErrors, []);
      assert.ok(existsSync(ticketAt(root, "done")),
        "stickiness is PRESERVED — this is the decision, not the bug");
      assert.ok(!existsSync(ticketAt(root, "in-review")));
      assert.equal(r2.changes.length, 0, "and nothing moved, so `changes` says nothing at all");

      // ...which is exactly why the finding exists.
      assert.equal(r2.findings.length, 1);
      assert.equal(r2.findings[0].kind, "open-pr-on-terminal");
      assert.equal(r2.findings[0].id, "INF-645");
      assert.equal(r2.findings[0].status, "done");
      assert.equal(r2.findings[0].pr.number, 81);
      assert.match(r2.findings[0].message, /INF-645 is done/);
      assert.match(r2.findings[0].message, /#81/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the control: both PRs visible at the FIRST run needs no finding at all", async () => {
    // The same end state reached in ONE step is correct, and must stay silent — or the
    // finding would fire on every healthy in-review ticket in the board.
    const tmp = mkdtempSync(join(tmpdir(), "blz395-ctl-"));
    const root = fixture(tmp, [["INF-645", "epic", "defined"]]);
    const restore = stubGh(tmp, [PR_80_MERGED, PR_81_OPEN]);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.forgeErrors, []);
      assert.ok(existsSync(ticketAt(root, "in-review")));
      assert.deepEqual(r.findings, [],
        "a ticket that correctly reached in-review is not a conflict");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a dry run reports it too — that is where a person looks before believing the board", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz395-dry-"));
    const root = fixture(tmp, [["INF-645", "epic", "done"]]);
    const restore = stubGh(tmp, [PR_80_MERGED, PR_81_OPEN]);
    try {
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.forgeErrors, []);
      assert.equal(r.findings.length, 1);
      assert.equal(r.findings[0].id, "INF-645");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// The rule itself, at `decide`
// =============================================================================

describe("BLZ-395: `decide` names the conflict without acting on it", () => {
  test("a terminal ticket with an open PR is flagged, and still does not move", () => {
    const pr = buildPrMap([PR_80_MERGED, PR_81_OPEN], idFromRef, null).get("INF-645");
    const d = decide({ pr }, "done", "epic");
    assert.equal(d.openPrOnTerminal, true);
    assert.equal(d.target, "done", "REPORT, DON'T MOVE — stickiness is deliberately intact");
    assert.equal(d.moved, false);
    assert.equal(d.branchVal, null, "and an open PR still cannot write the record");
    assert.equal(d.prVal, null);
  });

  test("a NON-terminal ticket with an open PR is not a conflict — it is just in-review", () => {
    const pr = buildPrMap([PR_80_MERGED, PR_81_OPEN], idFromRef, null).get("INF-645");
    const d = decide({ pr }, "defined", "epic");
    assert.equal(d.openPrOnTerminal, false);
    assert.equal(d.target, "in-review");
  });

  test("a terminal ticket whose only PR is MERGED is not a conflict either", () => {
    const pr = buildPrMap([PR_80_MERGED], idFromRef, null).get("INF-645");
    assert.equal(decide({ pr }, "done", "epic").openPrOnTerminal, false);
  });

  test("a CLOSED PR on a terminal ticket is not a conflict — it delivered nothing and claims nothing", () => {
    const closed = { ...PR_81_OPEN, state: "CLOSED" };
    const pr = buildPrMap([closed], idFromRef, null).get("INF-645");
    assert.equal(decide({ pr }, "done", "epic").openPrOnTerminal, false);
  });

  test("the flag is type-independent, exactly as the veto it reports on is", () => {
    const pr = buildPrMap([PR_80_MERGED, PR_81_OPEN], idFromRef, null).get("INF-645");
    for (const type of ["epic", "story", "task", "bug"]) {
      assert.equal(decide({ pr }, "done", type).openPrOnTerminal, true, type);
    }
  });

  test("a non-delivery type is never flagged — goal and risk do not mirror git at all", () => {
    const pr = buildPrMap([PR_80_MERGED, PR_81_OPEN], idFromRef, null).get("INF-645");
    for (const type of ["goal", "risk"]) {
      const d = decide({ pr }, "done", type);
      assert.equal(d.skip, true);
      assert.equal(d.openPrOnTerminal, false, type);
    }
  });
});

// =============================================================================
// An UNCORROBORATED open PR must be invisible here too
// =============================================================================

test("BLZ-395: an open PR the INF-735 gate drops is not reported", async () => {
  // ADR-0023 §1's second qualifier: "no PR is open" is really "no CORROBORATED PR is
  // open". A branch merely NAMED for a ticket, with a title that never mentions it, is
  // not visible to the veto — so it must not be visible to the finding either, or the
  // report would be noisier than the rule it reports on.
  const tmp = mkdtempSync(join(tmpdir(), "blz395-unc-"));
  const root = fixture(tmp, [["INF-645", "epic", "done"]]);
  const bogus = { number: 99, state: "OPEN", url: "u99",
    headRefName: "INF-645-typo-in-a-branch-name", title: "chore: unrelated tidy" };
  const restore = stubGh(tmp, [bogus]);
  try {
    const r = await reconcile({ root, dryRun: true });
    assert.deepEqual(r.forgeErrors, []);
    assert.deepEqual(r.findings, []);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// Surfacing — the loop that actually samples the window
// =============================================================================

describe("BLZ-395: the finding reaches the loop that creates the condition", () => {
  test("it is published once, not on every tick", () => {
    const said = new Set();
    const findings = [{ kind: "open-pr-on-terminal", id: "INF-645", message: "INF-645 is done, but PR #81 is OPEN" }];
    const first = newFindingEvents(findings, said);
    assert.equal(first.length, 1);
    assert.equal(first[0].id, "INF-645");
    assert.equal(first[0].loop, "reconcile");
    assert.deepEqual(newFindingEvents(findings, said), [],
      "reconcile runs on a timer and this condition persists until a person clears it");
  });

  test("it is a WARNING, not an error — the run is fine, the board is not", () => {
    // The over-statement this lane exists to stop, in the other direction: calling a
    // correct run an engine error is as wrong as calling an unshipped ticket done.
    const ev = newFindingEvents([{ id: "INF-645", message: "m" }], new Set());
    assert.equal(ev[0].type, "warning");
  });

  test("a distinct second finding is still said", () => {
    const said = new Set();
    newFindingEvents([{ id: "INF-645", message: "a" }], said);
    assert.equal(newFindingEvents([{ id: "INF-700", message: "b" }], said).length, 1);
  });

  test("a finding with no message is dropped rather than published blank", () => {
    assert.deepEqual(newFindingEvents([{ id: "INF-1" }, null], new Set()), []);
  });
});
