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
    assert.deepEqual(amb.get("INF-645"),
      [{ number: 10, url: "u10" }, { number: 40, url: "u40" }],
      "refs carry the url: PR numbers are per-repository, so a number alone names nothing");
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
      assert.deepEqual(f.prs.map((r) => r.number), [10, 40],
        "the report names WHICH PRs tied, or it is not actionable");
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
    assert.deepEqual(f.prs.map((r) => r.number), [10, 40]);
  } finally {
    process.env.PATH = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// Review round 2 — the cases the first cut got wrong
// =============================================================================

describe("BLZ-398: an ambiguous set CLEARS a live record, it does not freeze one", () => {
  // Found by the behaviour-scoped review, and it defeated the ticket. An OPEN PR
  // outranks a MERGED one, so while any PR is open the record is chosen by RANK — not
  // by any deliverer rule. `prTitleClaim` never runs on that path. So the docs PR, open
  // at the sample moment, wrote itself into the record during `in-review`; when it later
  // merged, the set became ambiguous and a bare REFUSAL froze that rank-chosen value as
  // the ticket went terminal. The board then held `pr: #40 — u40` permanently — the
  // exact failure this ticket opens with — while the finding beside it claimed nothing
  // had been recorded, and then went silent on the next run.
  const WORK = { number: 10, state: "MERGED", url: "u10",
    headRefName: "INF-645-tier1", title: "INF-645: close the Tier-1 alert gaps" };
  const DOCS_OPEN = { number: 40, state: "OPEN", url: "u40",
    headRefName: "INF-645-docs", title: "INF-645: follow-up docs tidy" };
  const DOCS_MERGED = { ...DOCS_OPEN, state: "MERGED" };

  test("regression, end-to-end: the three-run sequence the review found", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz398-seq-"));
    const root = fixture(tmp, [["INF-645", "epic", "defined"]]);
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const setGh = (prs) => {
      writeFileSync(join(bin, "gh"),
        "#!/usr/bin/env bash\ncat <<'JSON'\n" + JSON.stringify(prs) + "\nJSON\n");
      execFileSync("chmod", ["+x", join(bin, "gh")]);
    };
    const prev = process.env.PATH;
    process.env.PATH = bin + ":" + prev;
    try {
      // RUN 1 — the docs PR is OPEN, so it wins on RANK and writes the record. Correct
      // for a live field on a non-terminal ticket, and the seed of the whole problem.
      setGh([WORK, DOCS_OPEN]);
      const r1 = await reconcile({ root, dryRun: false });
      assert.deepEqual(r1.forgeErrors, []);
      assert.match(readTicket(root, "in-review"), /pr: '?#40 — u40/,
        "the open docs PR is what rank selects here — this is the setup, not the bug");
      assert.deepEqual(r1.findings, [], "nothing is ambiguous yet: only one PR is merged");

      // RUN 2 — the docs PR merges. Two merged PRs, equal title claim, no deliverer.
      setGh([WORK, DOCS_MERGED]);
      const r2 = await reconcile({ root, dryRun: false });
      assert.deepEqual(r2.forgeErrors, []);
      const t2 = readTicket(root, "done");
      assert.doesNotMatch(t2, /^pr:/m,
        "the rank-chosen record must be CLEARED as the ticket goes terminal, not frozen");
      assert.doesNotMatch(t2, /^branch:/m, "and the record is one unit");
      const f2 = r2.findings.find((x) => x.kind === "ambiguous-deliverer");
      assert.ok(f2, "and the refusal is reported");
      assert.deepEqual(f2.prs.map((r) => r.number), [10, 40]);

      // RUN 3 — it must keep saying so. Freezing a record made `keep()` true, which
      // silenced the finding forever; a cleared record leaves the conflict visible.
      setGh([WORK, DOCS_MERGED]);
      const r3 = await reconcile({ root, dryRun: false });
      assert.doesNotMatch(readTicket(root, "done"), /^pr:/m);
      assert.ok(r3.findings.some((x) => x.kind === "ambiguous-deliverer"),
        "the finding must not go silent while the board is still unresolvable");
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("clearing only ever touches a record write-once does not protect", async () => {
    // A terminal ticket that ALREADY held a record keeps it — `keep()` is checked first,
    // so nothing a previous run legitimately recorded is stripped by the ambiguity path.
    const tmp = mkdtempSync(join(tmpdir(), "blz398-keep-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-tier1\npr: '#10 — u10'\n"]]);
    const restore = stubGh(tmp, [WORK, DOCS_MERGED]);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.forgeErrors, []);
      assert.match(readTicket(root, "done"), /#10 — u10/,
        "write-once protects it, so the ambiguity path must not clear it");
      assert.deepEqual(r.findings.filter((f) => f.kind === "ambiguous-deliverer"), []);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

test("BLZ-398: among equal-claim PRs the LOWER number wins, and that direction is pinned", () => {
  // Unpinned in the first cut: flipping `pr.number < best.number` to `>` left the whole
  // suite green. Among MERGED PRs the choice is invisible (an ambiguous set writes
  // nothing), but among two equal-claim OPEN PRs it decides the record outright.
  const a = { number: 10, state: "OPEN", url: "u10", headRefName: "INF-645-a", title: "INF-645: first" };
  const b = { number: 40, state: "OPEN", url: "u40", headRefName: "INF-645-b", title: "INF-645: second" };
  assert.equal(buildPrMap([a, b], idFromRef, null).get("INF-645").number, 10);
  assert.equal(buildPrMap([b, a], idFromRef, null).get("INF-645").number, 10,
    "and input order must not decide it");
  const c = { ...a, state: "CLOSED" }, d = { ...b, state: "CLOSED" };
  assert.equal(buildPrMap([c, d], idFromRef, null).get("INF-645").number, 10);
});

test("BLZ-398: one repository configured twice is not two deliverers", async () => {
  // `codeRepoPaths` is not deduped, so two entries can name the SAME repository — a
  // duplicate line, an abs/rel pair, or a checkout plus one of its own worktrees. `gh`
  // then returns the same PR for both, and comparing on STATE alone made one PR collide
  // with itself: a healthy single-deliverer ticket declared ambiguous, its record
  // stripped on every run, and a finding claiming "more than one merged PR" while
  // naming exactly one.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-dupe-"));
  const codeRepo = join(tmp, "svc");
  mkdirSync(codeRepo, { recursive: true });
  gitInit(codeRepo);
  execFileSync("git", ["-C", codeRepo, "remote", "add", "origin",
    "https://github.com/hjr15/service-platform.git"]);
  const root = board(tmp, [codeRepo, codeRepo], [["INF-645", "epic", "done"]]);
  const restore = stubGh(tmp, [PR_10_WORK]);
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.deepEqual(r.forgeErrors, []);
    assert.deepEqual(r.findings.filter((f) => f.kind === "ambiguous-deliverer"), [],
      "the same PR seen twice is one PR");
    assert.match(readTicket(root, "done"), /pr: '?#10 — u10/,
      "and the ticket still acquires the record it should");
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-398: two repos whose PR numbers COINCIDE are still two deliverers", async () => {
  // The other half of the identity rule, and it was unpinned until a surviving mutant
  // said so: comparing on `number` alone is not the same as comparing on `url`. PR
  // numbers are PER-REPOSITORY, so two different repos legitimately both have a #10 —
  // and `samePr` lives in `gatherProject`, so only a real repo PAIR exercises it.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-samenum-"));
  const repos = ["alpha", "beta"].map((n) => {
    const d = join(tmp, n);
    mkdirSync(d, { recursive: true });
    gitInit(d);
    execFileSync("git", ["-C", d, "remote", "add", "origin", `https://github.com/hjr15/${n}.git`]);
    return d;
  });
  const root = board(tmp, repos, [["INF-645", "epic", "done"]]);
  const mk = (repo) => ({ number: 10, state: "MERGED",
    url: `https://github.com/hjr15/${repo}/pull/10`,
    headRefName: "INF-645-work", title: "INF-645: the work" });
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$PWD" in
  */alpha) cat <<'JSON'
${JSON.stringify([mk("alpha")])}
JSON
  ;;
  *) cat <<'JSON'
${JSON.stringify([mk("beta")])}
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
    const f = r.findings.find((x) => x.kind === "ambiguous-deliverer");
    assert.ok(f, "identical PR numbers from different repositories are not the same pull request");
    assert.doesNotMatch(readTicket(root, "done"), /^pr:/m,
      "so the record must not be written from whichever repo was scanned first");
  } finally {
    process.env.PATH = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// =============================================================================
// Review round 3 — the defects the round-2 fix introduced
// =============================================================================

describe("BLZ-398: the forge's payload cannot decide PR identity", () => {
  // Round 2 compared identity on `url` with `number` as a FALLBACK. Round 3 found the
  // fallback is the hole: two different repos legitimately both have a #10, so a payload
  // missing its url made them the same PR, the ambiguity went undetected, and the record
  // was settled by `codeRepos` scan order. `sanitisePr` strips control characters from
  // `url`, so a control-char-only url — from exactly the untrusted GHES payload that
  // sanitiser exists for — becomes "" and lands in the same hole. An identity decision
  // must not turn on the PRESENCE of a forge-supplied field.
  const mk = (repo, url, number = 10) => ({ number, state: "MERGED", url,
    headRefName: "INF-645-work", title: "INF-645: the work" });

  async function twoRepos(urlA, urlB, numA = 10, numB = 10) {
    const tmp = mkdtempSync(join(tmpdir(), "blz398-ident-"));
    const repos = ["alpha", "beta"].map((n) => {
      const d = join(tmp, n);
      mkdirSync(d, { recursive: true });
      gitInit(d);
      execFileSync("git", ["-C", d, "remote", "add", "origin", `https://github.com/hjr15/${n}.git`]);
      return d;
    });
    const root = board(tmp, repos, [["INF-645", "epic", "done"]]);
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash
case "$PWD" in
  */alpha) cat <<'JSON'
${JSON.stringify([mk("alpha", urlA, numA)])}
JSON
  ;;
  *) cat <<'JSON'
${JSON.stringify([mk("beta", urlB, numB)])}
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
      return { r, text: readTicket(root, "done") };
    } finally {
      process.env.PATH = prev;
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  test("a MISSING url on one side does not make two PRs one", async () => {
    const { r, text } = await twoRepos("https://github.com/hjr15/alpha/pull/10", undefined);
    assert.ok(r.findings.some((f) => f.kind === "ambiguous-deliverer"),
      "the number fallback silently settled this by codeRepos scan order");
    assert.doesNotMatch(text, /^pr:/m);
  });

  test("an EMPTIED url does not either — that is what sanitisePr produces", async () => {
    const { r, text } = await twoRepos("https://github.com/hjr15/alpha/pull/10",
      String.fromCharCode(27) + String.fromCharCode(7));
    assert.ok(r.findings.some((f) => f.kind === "ambiguous-deliverer"));
    assert.doesNotMatch(text, /^pr:/m);
  });

  test("when NEITHER side has a url, the number is all there is — and it still decides", async () => {
    // The last branch of `samePr`, and it was unpinned until a mutation survived and
    // said so: reducing the function to `a.url === b.url` makes two url-less payloads
    // `undefined === undefined`, i.e. the same PR, collapsing a genuine two-repo
    // ambiguity into one. Reachable exactly where round 1 put it — `sanitisePr` empties
    // a control-char-only url, and it can do that to BOTH sides at once.
    // DIFFERENT numbers, both urls emptied. Same-numbered url-less payloads are
    // genuinely indistinguishable and the engine is right to treat them as one — the
    // number is the only identity left, so it must be the one that decides.
    const esc = String.fromCharCode(27);
    const { r, text } = await twoRepos(esc, esc + String.fromCharCode(7), 10, 40);
    assert.ok(r.findings.some((f) => f.kind === "ambiguous-deliverer"),
      "two url-less merged PRs with different numbers are still two PRs");
    assert.doesNotMatch(text, /^pr:/m);
  });

  test("and the finding NAMES them apart when their numbers collide", async () => {
    const { r } = await twoRepos("https://github.com/hjr15/alpha/pull/10",
      "https://github.com/hjr15/beta/pull/10");
    const f = r.findings.find((x) => x.kind === "ambiguous-deliverer");
    assert.match(f.message, /alpha\/pull\/10/,
      "'more than one merged PR claiming it (#10)' is this ticket's own condemned wording");
    assert.match(f.message, /beta\/pull\/10/);
    assert.equal(f.prs.length, 2, "two PRs, not one deduped by number");
  });
});

test("BLZ-398: a PR the forge did not number is dropped, not written as #NaN", async () => {
  // Round 1's `sanitisePr` coerced with `Number(pr.number)`, so a missing number became
  // NaN and `decide` rendered `pr: #NaN — …` onto a terminal ticket, permanently —
  // through the sanitiser meant to contain the malformed payload. NaN also poisons
  // identity (`NaN === NaN` is false), resurrecting the self-collision round 2 fixed.
  // A PR Blaze cannot number it can neither record nor report, so it is DROPPED: a
  // missed signal, never a corrupted ticket.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-nan-"));
  const root = fixture(tmp, [["INF-645", "epic", "done"]]);
  const restore = stubGh(tmp, [
    { state: "MERGED", url: "https://ghes.corp/hjr15/alpha/pull/10",
      headRefName: "INF-645-work", title: "INF-645: the work" },
  ]);
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.deepEqual(r.forgeErrors, []);
    const text = readTicket(root, "done");
    assert.doesNotMatch(text, /NaN/, "this reached the permanent record");
    assert.doesNotMatch(text, /^pr:/m, "an unusable PR records nothing at all");
    assert.deepEqual(r.findings, []);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-398: clearing does not flap when a storage projects an absent record as \"\"", async () => {
  // `hadRecord` reads "" as absent; the round-2 clear guard read `!== undefined`, which
  // reads "" as PRESENT. Both DB storages project an absent record as `branch: row.branch
  // ?? ""` (`toRecord`, held identical across drivers by driver-conformance.test.mjs), so
  // the pair would clear-and-dirty the same ticket on every tick — a git commit per tick
  // under `blaze start`. Injected through the readStorage seam, which is where the DB
  // drivers plug in.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-flap-"));
  const root = fixture(tmp, [["INF-645", "epic", "done"]]);
  const restore = stubGh(tmp, [PR_10_WORK, PR_40_DOCS]);
  try {
    const { fsReadStorage } = await import("../scripts/model/read-storage.mjs");
    const projecting = {
      listTickets: (dir) => [...fsReadStorage.listTickets(dir)].map((t) => ({
        ...t, frontmatter: { ...t.frontmatter, branch: t.frontmatter.branch ?? "", pr: t.frontmatter.pr ?? "" },
      })),
    };
    const r1 = await reconcile({ root, dryRun: false, readStorage: projecting });
    const r2 = await reconcile({ root, dryRun: false, readStorage: projecting });
    assert.equal(r1.changes.filter((c) => c.cleared).length, 0,
      "an empty-string record is ABSENT, so there is nothing to clear");
    assert.equal(r2.changes.filter((c) => c.cleared).length, 0,
      "and certainly nothing to re-clear on the next tick");
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("BLZ-398: a cleared record is NAMED in changes — a destructive write says so", async () => {
  // `{from:"done", to:"done", moved:false}` is indistinguishable from a `resolution`
  // backfill, so the only machine-readable account of the run never said the delivery
  // record had been deleted. Reconcile deletes nothing else anywhere in the engine.
  const tmp = mkdtempSync(join(tmpdir(), "blz398-named-"));
  const root = fixture(tmp, [["INF-645", "epic", "in-review",
    "branch: INF-645-docs\npr: '#40 — u40'\n"]]);
  const restore = stubGh(tmp, [PR_10_WORK, PR_40_DOCS]);
  try {
    const r = await reconcile({ root, dryRun: false });
    assert.deepEqual(r.forgeErrors, []);
    const c = r.changes.find((x) => x.id === "INF-645");
    assert.ok(c, "the move must still be reported");
    assert.equal(c.cleared, true, "and the deletion must be reported with it");
    assert.doesNotMatch(readTicket(root, "done"), /^pr:/m);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});
