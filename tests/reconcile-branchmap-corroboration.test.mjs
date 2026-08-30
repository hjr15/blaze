// INF-735 — the branch half of the ref-name-is-not-evidence defect.
//
// Gating only PRs is an incomplete fix. Drop a bogus PR's claim and the branch it
// was opened from is still sitting there, so `decide()` takes the `branch` path
// and moves the ticket to `in-progress` with bogus `branch:` frontmatter. Less
// damaging than a forced `done`, still wrong — and it would immediately re-corrupt
// any ticket repaired by hand.
//
// A branch has no title to read, so its evidence is its own commit subjects
// (`KEY-n: desc`, which `idFromSubject` already parses), the shipped signal, or —
// when it has no commits of its own — whether it is a FRESH branch or a stale
// fully-merged one. Those two look identical to `git log <ref> ^<default>` (both
// empty) but mean opposite things, which is the trap this file pins down.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildBranchMap } from "../scripts/reconcile.mjs";

const idFromRef = (ref) => {
  const m = /\bZZZ-(\d+)/i.exec(ref || "");
  return m ? `ZZZ-${m[1]}` : null;
};

// Stand-in for the per-branch git reads: the subjects unique to the branch
// (`git log <ref> ^<default>`), and whether the branch tip IS the default tip.
//   { own: [...] }   -> branch has its own commits
//   { fresh: true }  -> `git checkout -b X`, tip == default tip, nothing committed
//   {}               -> no own commits AND tip != default tip: a stale merged branch
const inspectFrom = (table) => (ref) => ({
  own: (table[ref] || {}).own || [],
  sameTipAsDefault: Boolean((table[ref] || {}).fresh),
});

test("buildBranchMap: a branch whose own commits name the ticket is claimed", () => {
  const map = buildBranchMap(["ZZZ-13-close"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({ "ZZZ-13-close": { own: ["ZZZ-13: close the retirement epic"] } }),
  });
  assert.equal(map.get("ZZZ-13"), "ZZZ-13-close");
});

test("buildBranchMap: a branch named for a ticket it has no commits for is NOT claimed", () => {
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-28-docs-kickoff-brief": {
        own: ["docs: kickoff brief for the closeout", "ZZZ-19: retire the stale plan docs"],
      },
    }),
  });
  assert.equal(map.has("ZZZ-28"), false, "a ref name alone must not claim ZZZ-28");
  assert.equal(map.size, 0);
});

test("buildBranchMap: shippedSet corroborates a branch with no matching commit subject", () => {
  const map = buildBranchMap(["zzz-10-close"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(["ZZZ-10"]),
    inspect: inspectFrom({ "zzz-10-close": { own: ["docs: capture the epic"] } }),
  });
  assert.equal(map.get("ZZZ-10"), "zzz-10-close");
});

test("buildBranchMap: first corroborated branch wins, as before", () => {
  const map = buildBranchMap(["ZZZ-500-first", "ZZZ-500-second"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-500-first": { own: ["ZZZ-500: first"] },
      "ZZZ-500-second": { own: ["ZZZ-500: second"] },
    }),
  });
  assert.equal(map.get("ZZZ-500"), "ZZZ-500-first");
});

test("buildBranchMap: an uncorroborated branch does not shadow a later corroborated one", () => {
  const map = buildBranchMap(["ZZZ-500-bogus", "ZZZ-500-real"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-500-bogus": { own: ["docs: unrelated"] },
      "ZZZ-500-real": { own: ["ZZZ-500: the actual work"] },
    }),
  });
  assert.equal(map.get("ZZZ-500"), "ZZZ-500-real");
});

test("buildBranchMap: a FRESH branch (tip == default tip) is claimed on its name", () => {
  // `git checkout -b ZZZ-501-fix` and nothing else. Nothing contradicts the name,
  // and this is the ordinary "branched, about to work" signal the branch path
  // exists to catch. Gating it would delete the feature rather than fix the defect.
  const map = buildBranchMap(["you/ZZZ-501-fix-thing"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({ "you/ZZZ-501-fix-thing": { fresh: true } }),
  });
  assert.equal(map.get("ZZZ-501"), "you/ZZZ-501-fix-thing");
});

test("buildBranchMap: a STALE fully-merged branch is NOT claimed, though it also has no own commits", () => {
  // The live regression the first cut of this fix missed. `origin/INF-728-…` was
  // fully merged, so `git log <ref> ^<default>` came back empty — identical to a
  // fresh branch — and reconcile re-claimed the ticket and moved it back to
  // `in-progress`, undoing a hand repair.
  //
  // The discriminator is the tip: a fresh branch sits AT the default tip, a merged
  // one sits behind it. A fully-merged branch has nothing outstanding and is never
  // evidence of work in progress.
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({ "ZZZ-28-docs-kickoff-brief": {} }), // no own commits, behind default
  });
  assert.equal(map.has("ZZZ-28"), false,
    "a merged-and-behind branch must not signal in-progress");
  assert.equal(map.size, 0);
});

test("buildBranchMap: a branch WITH commits, none naming the ticket, is still rejected", () => {
  const map = buildBranchMap(["ZZZ-28-docs-kickoff-brief"], idFromRef, {
    key: "ZZZ",
    shippedSet: new Set(),
    inspect: inspectFrom({
      "ZZZ-28-docs-kickoff-brief": { own: ["docs: kickoff brief for the closeout"] },
    }),
  });
  assert.equal(map.has("ZZZ-28"), false);
});

test("buildBranchMap: a ref with no id is ignored", () => {
  const map = buildBranchMap(["chore/tidy"], idFromRef, {
    key: "ZZZ", shippedSet: new Set(), inspect: inspectFrom({}),
  });
  assert.equal(map.size, 0);
});

// =============================================================================
// BLZ-507 — ADR-0026's THIRD WRITE PATH, DRIVEN END TO END
// =============================================================================
// Everything above is `buildBranchMap` in isolation, with `inspect` stubbed. ADR-0026
// enumerates three paths that reach reconcile's `branch:`/`pr:` write, and the third is the
// `shippedSet && shippedSet.has(id)` arm right here: a wider shipped set newly admits a
// BRANCH, one layer below `claimCorroborated`. ADR-0026 settled the first two by running
// reconcile against a real board and reading the ticket back off disk, precisely because
// reasoning from the rules had already been wrong twice — and left this one pinned only at
// unit level. BLZ-489 was comment-scoped and did not close that.
//
// The gap matters because the arm's two ends differ. On a TERMINAL ticket terminal-sticky
// nulls `branchVal` and `prVal` (nothing MERGED could have delivered it — a branch
// recovered by the shipped set brings no PR at all), which is why ADR-0026's conclusion for
// its twelve record-less ids holds. On a NON-TERMINAL ticket the same arm writes `branch:`
// and moves the ticket to `in-progress`: `decide`'s `branch` arm is tested BEFORE its
// `shipped` arm, so the branch signal, not the shipped one, is what lands. That is a real
// state change and nothing drove it end to end.
//
// The construction isolates the arm. The branch's own commit claims NOTHING and its tip is
// not the default tip, so neither `own.some(...)` nor `sameTipAsDefault` can corroborate
// it; `gh` answers with no pull requests, so no PR path is in play. The ONLY thing that can
// admit the branch is the shipped set, and the only thing that puts the id in the shipped
// set is the default branch's commit subject — which is the control's single difference.
//
// THREE HUNKS, REVERTED SEPARATELY, because two of them sit in `decide` and would otherwise
// look pinned by one test between them:
//
//   `buildBranchMap`'s `shippedSet.has(id)` arm  -> PATH 3 on a NON-TERMINAL ticket, red
//                                                   (and the unit test above it, red)
//   terminal-sticky's `branchVal = prVal = null`  -> PATH 3 on a TERMINAL ticket, red
//   `decide`'s branch arm placed before shipped   -> PATH 3 on a NON-TERMINAL ticket, red
//                                                   (it lands in `done` with no record)

describe("BLZ-507: ADR-0026's third write path, end to end", () => {
  const KEY = "SHP";
  const ID = `${KEY}-9`;

  /** One repo, one ticket, one branch that can only be corroborated by the shipped set. */
  function build(tmp, { shipped, status }) {
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    const g = (...a) => execFileSync("git", ["-C", repo, ...a]);
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    writeFileSync(join(repo, "seed.md"), "x\n");
    g("add", "-A");
    g("commit", "-q", "-m", "seed");
    // THE ONE DIFFERENCE between the case and its control: whether the default branch's
    // log names the ticket, which is the whole of `shippedSet`.
    writeFileSync(join(repo, "more.md"), "y\n");
    g("add", "-A");
    g("commit", "-q", "-m", shipped ? `${ID}: the work, landed on main` : "chore: an unrelated tidy-up");
    // A branch whose own commits claim nothing, sitting BEHIND the default tip: the two
    // corroborations that do not need the shipped set are both refused for it.
    g("checkout", "-q", "-b", `${ID}-work`, "HEAD~1");
    writeFileSync(join(repo, "w.md"), "w\n");
    g("add", "-A");
    g("commit", "-q", "-m", "wip: no ticket named here");
    g("checkout", "-q", "main");

    const root = join(tmp, "board");
    const dir = join(root, "projects", KEY, status);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID}-t.md`),
      `---\nid: ${ID}\ntype: task\nproject: ${KEY}\nestimate: 30\n`
      + (status === "done" ? "resolution: done\n" : "") + "---\n\nbody\n");
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: KEY, projects: [KEY], codeRepos: [repo] }));
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho '[]'\n");
    execFileSync("chmod", ["+x", join(bin, "gh")]);
    return { root, bin };
  }

  /** Run a real applying reconcile and read the ticket back off disk. */
  async function apply(label, opts) {
    const tmp = mkdtempSync(join(tmpdir(), `blaze-blz507-${label}-`));
    const prev = process.env.PATH;
    try {
      const { root, bin } = build(tmp, opts);
      process.env.PATH = `${bin}:${prev}`;
      const { reconcile } = await import("../scripts/reconcile.mjs");
      const r = await reconcile({ root, dryRun: false });
      const projectDir = join(root, "projects", KEY);
      let landed = null, text = null;
      for (const st of readdirSync(projectDir)) {
        try { text = readFileSync(join(projectDir, st, `${ID}-t.md`), "utf8"); landed = st; }
        catch { /* not here */ }
      }
      return { r, landed, text };
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("PATH 3 on a NON-TERMINAL ticket: the shipped set admits the BRANCH, which writes branch: and moves to in-progress", async () => {
    const { r, landed, text } = await apply("nonterminal", { shipped: true, status: "defined" });
    assert.equal(landed, "in-progress",
      "`decide` tests its `branch` arm before its `shipped` arm, so the branch is what lands");
    assert.match(text, new RegExp(`^branch: ${ID}-work$`, "m"),
      "the write ADR-0026 names — and it is permanent: `branch` is not in EDITABLE_FIELDS");
    assert.doesNotMatch(text, /^pr:/m, "a branch recovered by the shipped set brings no PR");
    assert.deepEqual(r.changes.map((c) => c.id), [ID]);
  });

  test("CONTROL: without the shipped signal the same branch corroborates nothing and nothing is written", async () => {
    // Identical in every other respect. Without this, the test above could be passing
    // because the branch corroborated on its own evidence, which is the arm it is NOT about.
    const { r, landed, text } = await apply("control", { shipped: false, status: "defined" });
    assert.equal(landed, "defined");
    assert.doesNotMatch(text, /^branch:/m,
      "a branch whose own commits claim nothing, behind the default tip, is not evidence");
    assert.deepEqual(r.changes, []);
  });

  test("PATH 3 on a TERMINAL ticket: terminal-sticky blocks it — no move and no record", async () => {
    // ADR-0026's conclusion for its twelve record-less ids depends on this, and depends on
    // it being terminal-sticky rather than the arm being absent: `!pr || pr.state !== "MERGED"`
    // nulls both fields, and a branch recovered by the shipped set brings no PR at all.
    const { r, landed, text } = await apply("terminal", { shipped: true, status: "done" });
    assert.equal(landed, "done");
    assert.doesNotMatch(text, /^branch:/m,
      "terminal-sticky nulls branchVal: a done ticket's record is history, not a live field");
    assert.doesNotMatch(text, /^pr:/m);
    assert.deepEqual(r.changes, [], "and it is not even reported as a change");
  });
});
