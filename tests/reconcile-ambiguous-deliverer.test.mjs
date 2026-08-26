// reconcile-ambiguous-deliverer.test.mjs — BLZ-398.
//
// `buildPrMap`'s equal-rank tie-break was `pr.number > cur.number`. Among MERGED PRs
// that selects the LATEST merge, not the deliverer — and `hadRecord`/`keep()` then makes
// that first write PERMANENT. Reproduced end-to-end on INF-645: `done` with no record,
// two merged PRs carrying the key, #10 (the real work) and #40 (a docs follow-up), and
// the board recorded the docs PR as what delivered the epic. `pr` is not in
// EDITABLE_FIELDS, so `blaze edit` cannot repair it either.
//
// THE FIX HAS TWO HALVES AND BOTH ARE PINNED HERE.
//
//   1. A stronger title claim beats a higher number. The house TITLES a PR for the
//      ticket it delivers, so a title leading with the id outranks one that merely
//      mentions it. This is the ticket's own "stronger variant".
//   2. When that does not separate them — two PRs both titled `KEY-n: …`, which is
//      the reproduced case — reconcile records NOTHING and reports. Rule 7 of the
//      review bar: this record has been wrong in four directions and "prefer the
//      lowest number" is a guess at the deliverer, not a fact. A blank understates and
//      is true and stays fillable; a wrong `pr` overstates and is permanent.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile, buildPrMap, ambiguousDeliverers, prTitleClaim, decide } from "../scripts/reconcile.mjs";

const idFromRef = (ref) => {
  const m = /\bINF-(\d+)/i.exec(ref || "");
  return m ? `INF-${m[1]}` : null;
};

// The reproduction, exactly as measured on the epic.
const PR_10_WORK = {
  number: 10, state: "MERGED", url: "u10", headRefName: "INF-645-tier1-alert-gaps",
  title: "INF-645: close the Tier-1 alert gaps",
};
const PR_40_DOCS = {
  number: 40, state: "MERGED", url: "u40", headRefName: "INF-645-docs",
  title: "INF-645: follow-up docs tidy",
};
// The same follow-up written the other way the house writes it: a chore whose title
// only MENTIONS the key. This is what the claim tier is for.
const PR_40_MENTION = {
  number: 40, state: "MERGED", url: "u40", headRefName: "INF-645-docs",
  title: "chore: tidy the runbook after INF-645",
};

function gitInit(dir) {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "x\n");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed"]);
}

function board(tmp, codeRepos, tickets) {
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
    JSON.stringify({ key: "INF", projects: ["INF"], codeRepos }));
  return root;
}

function stubGh(tmp, prs) {
  const bin = join(tmp, "bin");
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
  return board(tmp, [codeRepo], tickets);
}

const readTicket = (root, status) =>
  readFileSync(join(root, "projects", "INF", status, "INF-645-t.md"), "utf8");

// =============================================================================
// Half 1 — the stronger title claim beats the higher number
// =============================================================================

describe("BLZ-398: a title that LEADS with the id outranks one that merely mentions it", () => {
  test("prTitleClaim scores the two forms apart", () => {
    assert.equal(prTitleClaim(PR_10_WORK, "INF-645"), 2);
    assert.equal(prTitleClaim(PR_40_MENTION, "INF-645"), 1);
  });

  test("the deliverer wins the record even though the follow-up merged later", () => {
    const chosen = buildPrMap([PR_10_WORK, PR_40_MENTION], idFromRef, null).get("INF-645");
    assert.equal(chosen.number, 10,
      "`pr.number > cur.number` picked #40 here — the LATEST merge, not the deliverer");
  });

  test("input order does not decide it — the ranking does", () => {
    assert.equal(buildPrMap([PR_40_MENTION, PR_10_WORK], idFromRef, null).get("INF-645").number, 10);
  });

  test("a clear deliverer is not ambiguous, so the record IS written", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz398-clear-"));
    const root = fixture(tmp, [["INF-645", "epic", "done"]]);
    const restore = stubGh(tmp, [PR_10_WORK, PR_40_MENTION]);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.forgeErrors, []);
      const text = readTicket(root, "done");
      assert.match(text, /pr: '?#10 — u10/, "the deliverer is recorded — AC direction 1");
      assert.doesNotMatch(text, /#40/, "and never the later unrelated merge");
      assert.match(text, /branch: INF-645-tier1-alert-gaps/);
      assert.deepEqual(r.findings, [], "nothing ambiguous happened, so nothing is reported");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Half 2 — when nothing separates them, record nothing and say so
// =============================================================================

describe("BLZ-398: two equally-titled merged PRs name no deliverer", () => {
  test("ambiguousDeliverers names them, and names WHICH", () => {
    const amb = ambiguousDeliverers([PR_10_WORK, PR_40_DOCS], idFromRef, null);
    assert.deepEqual(amb.get("INF-645"), [10, 40]);
  });

  test("one merged PR is never ambiguous", () => {
    assert.equal(ambiguousDeliverers([PR_10_WORK], idFromRef, null).has("INF-645"), false);
  });

  test("a merged PR plus an OPEN one is not ambiguous — only merges lock a record in", () => {
    const open = { ...PR_40_DOCS, state: "OPEN" };
    assert.equal(ambiguousDeliverers([PR_10_WORK, open], idFromRef, null).has("INF-645"), false);
  });

  test("regression, end-to-end: the record-less done epic acquires NOTHING, not #40", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz398-amb-"));
    const root = fixture(tmp, [["INF-645", "epic", "done"]]);
    const restore = stubGh(tmp, [PR_10_WORK, PR_40_DOCS]);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.forgeErrors, []);
      const text = readTicket(root, "done");
      assert.doesNotMatch(text, /^pr:/m, "this is the bug: `pr: #40 — u40`, permanently");
      assert.doesNotMatch(text, /^branch:/m, "and the record is one unit — neither half is written");

      const f = r.findings.find((x) => x.kind === "ambiguous-deliverer");
      assert.ok(f, "a refusal to write is reported, never swallowed");
      assert.equal(f.id, "INF-645");
      assert.deepEqual(f.prs, [10, 40], "the report names WHICH PRs tied, or it is not actionable");
      assert.match(f.message, /#10, #40/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the status is untouched — the tie-break decides the record, never the move", async () => {
    // The safety argument for changing the tie-break at all: `decide` derives the
    // target from `pr.state` alone, so every candidate at equal rank yields the same
    // status. A `defined` ticket with two merged PRs still ships.
    const tmp = mkdtempSync(join(tmpdir(), "blz398-status-"));
    const root = fixture(tmp, [["INF-645", "epic", "defined"]]);
    const restore = stubGh(tmp, [PR_10_WORK, PR_40_DOCS]);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.forgeErrors, []);
      const text = readTicket(root, "done");
      assert.doesNotMatch(text, /^pr:/m,
        "a ticket moving INTO done locks its record on that move — the ambiguity is " +
        "caught before the first write, not after");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// AC direction 2 — a blank is still filled
// =============================================================================

test("BLZ-398: a lone merged PR still fills a blank record — the fix must not disable it", async () => {
  // ADR-0023's round 2 was exactly this failure: stopping the overwrite stopped the
  // first write with it, leaving 1,056 of 1,594 done tickets at blaze-pm ff5f36c2
  // carrying neither field, permanently. Pinned so it cannot happen a second time.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-fill-"));
  const root = fixture(tmp, [["INF-645", "epic", "done"]]);
  const restore = stubGh(tmp, [PR_10_WORK]);
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.deepEqual(r.forgeErrors, []);
    const text = readTicket(root, "done");
    assert.match(text, /pr: '?#10 — u10/);
    assert.match(text, /branch: INF-645-tier1-alert-gaps/);
    assert.deepEqual(r.findings, []);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-398: a ticket that already HOLDS a record is protected by write-once, and is not reported", async () => {
  // Nothing to look at: write-once already refuses the write, so an ambiguity finding
  // here would be noise on a ticket that is not at risk.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-held-"));
  const root = fixture(tmp, [["INF-645", "epic", "done",
    "branch: INF-645-tier1-alert-gaps\npr: '#10 — u10'\n"]]);
  const restore = stubGh(tmp, [PR_10_WORK, PR_40_DOCS]);
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.deepEqual(r.forgeErrors, []);
    assert.match(readTicket(root, "done"), /#10 — u10/);
    assert.deepEqual(r.findings.filter((f) => f.kind === "ambiguous-deliverer"), []);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// The rule at `decide`, and across repos
// =============================================================================

describe("BLZ-398: the rule, stated where the caller can enforce it", () => {
  test("decide reports the record is unresolvable, and still reports the status", () => {
    const d = decide({ pr: PR_10_WORK, delivererAmbiguous: true }, "done", "epic");
    assert.equal(d.recordAmbiguous, true);
    assert.equal(d.target, "done");
  });

  test("it applies to a ticket MOVING to terminal, not only one already there", () => {
    assert.equal(decide({ pr: PR_10_WORK, delivererAmbiguous: true }, "defined", "epic").recordAmbiguous, true);
  });

  test("a non-terminal target is unaffected — that record is live state a later run corrects", () => {
    const open = { ...PR_10_WORK, state: "OPEN" };
    assert.equal(decide({ pr: open, delivererAmbiguous: true }, "defined", "epic").recordAmbiguous, false);
  });

  test("no ambiguity, no rule", () => {
    assert.equal(decide({ pr: PR_10_WORK }, "done", "epic").recordAmbiguous, false);
  });
});

test("BLZ-398: two repos each holding a merged PR for one ticket is ambiguous too", async () => {
  // Otherwise the strict `>` in gatherProject settles it by which repo comes first in
  // `codeRepos`, which is scan order, which is not evidence.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-xrepo-"));
  const repos = ["a", "b"].map((n) => {
    const d = join(tmp, n);
    mkdirSync(d, { recursive: true });
    gitInit(d);
    execFileSync("git", ["-C", d, "remote", "add", "origin", `https://github.com/hjr15/${n}.git`]);
    return d;
  });
  const root = board(tmp, repos, [["INF-645", "epic", "done"]]);
  // Both repos answer with one merged PR each, under the same title convention.
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$PWD" in
  */a) cat <<'JSON'
${JSON.stringify([PR_10_WORK])}
JSON
  ;;
  *) cat <<'JSON'
${JSON.stringify([PR_40_DOCS])}
JSON
  ;;
esac
`);
  execFileSync("chmod", ["+x", join(bin, "gh")]);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}:${prev}`;
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.deepEqual(r.forgeErrors, []);
    assert.doesNotMatch(readTicket(root, "done"), /^pr:/m);
    const f = r.findings.find((x) => x.kind === "ambiguous-deliverer");
    assert.ok(f, "two repos, two merges, one ticket — scan order must not settle it");
    assert.deepEqual(f.prs, [10, 40]);
  } finally {
    process.env.PATH = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});
