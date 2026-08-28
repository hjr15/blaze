// reconcile-terminal-record-unverifiable.test.mjs — BLZ-403.
//
// ADR-0023's "residual, stated rather than papered over" paragraph named this and left
// it open: PR #128 (BLZ-398) made reconcile CLEAR a rank-chosen record when the merged
// set later turns out unresolvable — but both the clear and the `ambiguous-deliverer`
// finding are gated on the SAME condition, `d.recordAmbiguous && !keep()`, where
// `keep = () => d.recordIfAbsentOnly && hadRecord`.
//
// A ticket HAND-MOVED to a terminal status while a follow-up PR is still open arrives at
// terminal-with-a-record by a route reconcile() never sees. `keep()` then reads true, so
// neither the clear nor the report fires, and the wrong record is frozen permanently —
// `pr` is not in EDITABLE_FIELDS, so `blaze edit` cannot repair it.
//
// THE DECISION (measured at blaze-pm 57212799269cb946c3949da459c04e0e4e765afb,
// BLZ-305-v4-spine, NCA excluded): 73 terminal-with-record tickets have an unresolvable
// merged set; 72 of the 73 hold a record that IS one of the plausible deliverers.
// Clearing those would destroy 72 probably-correct records nothing can restore, to fix
// the 1 that is provably wrong (OBA-773). So: REPORT, NEVER OVERWRITE. Write-once on a
// terminal ticket stands.
//
// This finding is on the STATE, not the ROUTE — reconcile cannot see that a ticket was
// hand-moved, only that a terminal ticket holds an unverifiable record. The tests below
// therefore construct that STATE directly (an already-terminal ticket already holding a
// record before the run that discovers the ambiguity), which is a superset of "hand-move"
// and is what the fix can actually observe.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile, decide } from "../scripts/reconcile.mjs";
import { newFindingEvents } from "../scripts/supervisor.mjs";

const idFromRef = (ref) => {
  const m = /\bINF-(\d+)/i.exec(ref || "");
  return m ? `INF-${m[1]}` : null;
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
  return board(tmp, [codeRepo], tickets);
}

const ticketPath = (root, id, status) => join(root, "projects", "INF", status, `${id}-t.md`);
const readTicket = (root, id, status) => readFileSync(ticketPath(root, id, status), "utf8");

/** Simulate `blaze move` (or `blaze resolve`) hand-moving a ticket to a terminal status:
 *  move the FILE and set `resolution` — the two things a hand-move actually changes.
 *  `branch`/`pr` are untouched: AGENTS.md says they are "filled by reconcile; don't
 *  hand-edit", and a hand-move does not. */
function handMoveToDone(root, id, fromStatus, resolution = "done") {
  const from = ticketPath(root, id, fromStatus);
  const toDir = join(root, "projects", "INF", "done");
  mkdirSync(toDir, { recursive: true });
  const to = join(toDir, `${id}-t.md`);
  let text = readFileSync(from, "utf8");
  text = text.replace(/^---\n/, `---\nresolution: ${resolution}\n`);
  writeFileSync(to, text);
  rmSync(from);
  return to;
}

// The reproduction PRs: a real work PR and a follow-up equally titled for the same
// ticket — the same shape BLZ-398's own reproduction uses, so the merged set is
// genuinely unresolvable once both are merged.
const WORK = { number: 10, state: "MERGED", url: "u10",
  headRefName: "INF-645-tier1", title: "INF-645: close the Tier-1 alert gaps" };
const DOCS_OPEN = { number: 40, state: "OPEN", url: "u40",
  headRefName: "INF-645-docs", title: "INF-645: follow-up docs tidy" };
const DOCS_MERGED = { ...DOCS_OPEN, state: "MERGED" };

// =============================================================================
// Reachability, at `decide` — the pure function must not skip this path
// =============================================================================

describe("BLZ-403: `d.recordAmbiguous && keep()` is reachable, not merely theoretical", () => {
  test("a ticket already terminal, with an ambiguous merged set, reports BOTH flags keep() needs", () => {
    const d = decide({ pr: WORK, delivererAmbiguous: true }, "done", "epic");
    assert.equal(d.skip, false, "decide must not skip a delivery type on a terminal status");
    assert.equal(d.recordAmbiguous, true);
    assert.equal(d.recordIfAbsentOnly, true,
      "isTerminal(type, currentStatus) — the ticket was ALREADY terminal before this run");
    // keep() = recordIfAbsentOnly && hadRecord. Both flags decide() reports are true, so
    // keep() is true whenever the caller's frontmatter already held a record — which is
    // exactly the state a hand-move (or any other route reconcile never sees) produces.
  });

  test("the same call on a NOT-yet-terminal ticket does not co-occur — recordIfAbsentOnly is false", () => {
    const d = decide({ pr: WORK, delivererAmbiguous: true }, "in-review", "epic");
    assert.equal(d.recordAmbiguous, true, "recordAmbiguous is gated on the TARGET, not current status");
    assert.equal(d.recordIfAbsentOnly, false,
      "so keep() is false here regardless of hadRecord — this is BLZ-398's own path, unchanged");
  });
});

// =============================================================================
// The hand-move sequence, end-to-end (AC-3) — reproduce it, don't shortcut it
// =============================================================================

describe("BLZ-403: hand-moved-to-terminal freezes the record, and is now reported", () => {
  test("regression: open PR sets the record, hand-move to done, follow-up merges — reported, not corrected", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-seq-"));
    const root = fixture(tmp, [["INF-645", "epic", "defined"]]);
    try {
      // Step 1 — an open follow-up PR sets a rank-chosen record during in-review. This
      // is ordinary, correct behaviour for a LIVE (non-terminal) ticket: OPEN outranks
      // MERGED, so the docs PR's own branch/pr land in the frontmatter.
      let restore = stubGh(tmp, [WORK, DOCS_OPEN], "bin1");
      const r1 = await reconcile({ root, dryRun: false });
      assert.deepEqual(r1.forgeErrors, []);
      const afterStep1 = readTicket(root, "INF-645", "in-review");
      assert.match(afterStep1, /pr: '?#40 — u40/,
        "the open docs PR wins on RANK — this is the setup, not the defect");
      assert.deepEqual(r1.findings, [], "nothing is ambiguous yet — only one PR is merged");
      restore();

      // Step 2 — HAND-MOVE to done (as `blaze move`/`blaze resolve` would), while the
      // follow-up PR is STILL OPEN. This is the route reconcile() never sees: no reconcile
      // run puts this ticket in this state.
      handMoveToDone(root, "INF-645", "in-review");
      const frozen = readTicket(root, "INF-645", "done");
      assert.match(frozen, /pr: '?#40 — u40/, "the record survives the hand-move untouched");

      // Step 3 — the follow-up PR merges. Two merged PRs, equal title claim: the merged
      // set is now genuinely unresolvable.
      restore = stubGh(tmp, [WORK, DOCS_MERGED], "bin2");
      const r2 = await reconcile({ root, dryRun: false });
      assert.deepEqual(r2.forgeErrors, []);

      // BOTH halves, per the brief: the finding fires...
      const f = r2.findings.find((x) => x.kind === "terminal-record-unverifiable");
      assert.ok(f, "on origin/main this fires NOTHING — the residual this ticket closes");
      // ...and it is bundled into the aggregate (this ticket's own record is one of the
      // tied candidates: u40 is in {u10, u40}), so it is named in `ids`, not as its own
      // per-ticket finding.
      assert.equal(f.id, undefined, "the aggregate finding is not about ONE ticket");
      assert.equal(f.count, 1);
      assert.deepEqual(f.ids, ["INF-645"]);

      // ...and the record is UNCHANGED on disk — not cleared, not overwritten with WORK's
      // info. A test that only checks the finding would pass a mutation that also
      // started clearing records; this half catches that.
      const after = readTicket(root, "INF-645", "done");
      assert.equal(after, frozen, "byte-for-byte: nothing about this ticket's file changed");
      assert.match(after, /pr: '?#40 — u40/);
      assert.doesNotMatch(after, /ambiguous-deliverer/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a dry run reports it too, and of course still writes nothing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-dry-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-docs\npr: '#40 — u40'\nresolution: done\n"]]);
    const restore = stubGh(tmp, [WORK, DOCS_MERGED]);
    try {
      const before = readTicket(root, "INF-645", "done");
      const r = await reconcile({ root, dryRun: true });
      assert.deepEqual(r.forgeErrors, []);
      assert.ok(r.findings.some((f) => f.kind === "terminal-record-unverifiable"));
      assert.equal(readTicket(root, "INF-645", "done"), before);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("it must keep saying so — freezing must not silence it on a later run", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-persist-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-docs\npr: '#40 — u40'\nresolution: done\n"]]);
    const restore = stubGh(tmp, [WORK, DOCS_MERGED]);
    try {
      const r1 = await reconcile({ root, dryRun: false });
      assert.ok(r1.findings.some((f) => f.kind === "terminal-record-unverifiable"));
      const r2 = await reconcile({ root, dryRun: false });
      assert.ok(r2.findings.some((f) => f.kind === "terminal-record-unverifiable"),
        "unlike the pre-#128 defect, this is state, not a one-time transition — it must persist");
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("write-once's OWN protected path is unaffected: no ambiguity, no finding at all", async () => {
    // A terminal ticket holding a record with only ONE merged PR in play is not this
    // finding's business — recordAmbiguous itself is false, so neither branch fires.
    const tmp = mkdtempSync(join(tmpdir(), "blz403-ctl-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-tier1\npr: '#10 — u10'\nresolution: done\n"]]);
    const restore = stubGh(tmp, [WORK]);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.findings, []);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// `recordOutsideCandidates` — the 1-of-73 case
// =============================================================================

describe("BLZ-403: a record naming a PR outside the tied set is named on its own", () => {
  test("per-ticket, not aggregated, when the frozen record is not even a candidate", async () => {
    // OBA-773's own shape: records #336 (url u336), tied set is {#10, #40} here — the
    // recorded PR is not a candidate in the ambiguous set at all.
    const tmp = mkdtempSync(join(tmpdir(), "blz403-outside-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-something-else\npr: '#336 — u336'\nresolution: done\n"]]);
    const restore = stubGh(tmp, [WORK, DOCS_MERGED]);
    try {
      const r = await reconcile({ root, dryRun: false });
      const perTicket = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && f.id);
      const aggregate = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && !f.id);
      assert.equal(perTicket.length, 1, "the outside-candidates case is named on its own");
      assert.equal(perTicket[0].id, "INF-645");
      assert.equal(perTicket[0].recordOutsideCandidates, true);
      assert.match(perTicket[0].message, /not even among the tied candidates/);
      assert.equal(aggregate.length, 0, "nothing left to aggregate — this is the only ticket");
      // Still untouched on disk, exactly like the plausible-record case.
      assert.match(readTicket(root, "INF-645", "done"), /#336 — u336/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // BLZ-403 (review, blocking finding 2): `recordedPrUrl` normalises the RECORD side by
  // construction (`\s*$` in its regex absorbs trailing whitespace off the captured
  // url), but the LIVE side (`refs[i].url`, sanitised only by `sanitisePr`'s `clean()`,
  // which strips control characters and never whitespace) was compared with bare
  // `===` and was NOT trimmed. A forge url with trailing whitespace therefore survives
  // untrimmed into both the live candidate and — once reconcile itself writes the
  // record — the frozen `pr:` line, and the two sides of the comparison disagreed:
  // the record IS one of the tied candidates, but the false accusation escalated it
  // out of the aggregate into its own per-ticket "not even among the tied candidates"
  // NEEDS ATTENTION line, sending an operator to hand-repair a correct record.
  test("a trailing-space url in the frozen record still matches its live candidate — aggregate, not accused", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-trailing-ws-"));
    // The record `reconcile` itself would have written from a `gh` payload whose url
    // carried trailing whitespace: `#40 — u40 ` (note the trailing space before the
    // closing quote) — exactly `recordedPrUrl`'s own regex trims off, but the live
    // side below does not.
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-docs\npr: '#40 — u40 '\nresolution: done\n"]]);
    const DOCS_MERGED_TRAILING_WS = { ...DOCS_MERGED, url: "u40 " };
    const restore = stubGh(tmp, [WORK, DOCS_MERGED_TRAILING_WS]);
    try {
      const r = await reconcile({ root, dryRun: false });
      const perTicket = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && f.id);
      const aggregate = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && !f.id);
      assert.equal(perTicket.length, 0,
        "the record IS one of the tied candidates (u40) — it must NOT be accused on its own");
      assert.equal(aggregate.length, 1, "it belongs in the aggregate like any other unresolvable-but-plausible record");
      assert.deepEqual(aggregate[0].ids, ["INF-645"]);
      // Untouched on disk either way — this finding never mutates the record.
      assert.match(readTicket(root, "INF-645", "done"), /pr: '?#40 — u40 ?'?/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // BLZ-403 (round 2 review, the blocking defect): `samePr` deliberately returns
  // `false` when a url is absent — its own comment says an identity decision must not
  // turn on the PRESENCE of a forge-supplied field. `recordMatchesCandidate` routes
  // through it, so a tied candidate whose url is unusable (control-characters-only, the
  // field absent entirely, or a string `sanitisePr` leaves NON-empty despite being
  // unusable — the ordinary degraded-forge payload `sanitisePr`/`namePr` exist for)
  // makes EVERY candidate look like a non-match, including the one that is really the
  // same PR as the frozen record. `recordOutsideCandidates` then converts that
  // "unproven" into "not even among the tied candidates" — a report that NAMES #40 in
  // the tied set while ASSERTING the record is not in it. Three variants of the same
  // input class:
  test("a tied candidate whose url is control-characters-only sanitises to null — aggregate, not accused", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-ctrlurl-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-docs\npr: '#40 — u40'\nresolution: done\n"]]);
    // Two control characters with NO separating character — `clean()` strips both,
    // leaving `""`, so `sanitisePr`'s `url || null` reduces it to `null`. Contrast the
    // sibling test below, where a SPACE survives between the control characters and
    // the url stays truthy.
    const DOCS_MERGED_CTRL_URL = { ...DOCS_MERGED, url: "" };
    const restore = stubGh(tmp, [WORK, DOCS_MERGED_CTRL_URL]);
    try {
      const r = await reconcile({ root, dryRun: false });
      const perTicket = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && f.id);
      const aggregate = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && !f.id);
      assert.equal(perTicket.length, 0,
        "#40 IS in the tied set; an unusable url is unknowable, not disproof");
      assert.equal(aggregate.length, 1, "it belongs in the aggregate like any other unresolvable-but-plausible record");
      assert.deepEqual(aggregate[0].ids, ["INF-645"]);
      // Untouched on disk either way — this finding never mutates the record.
      assert.match(readTicket(root, "INF-645", "done"), /pr: '?#40 — u40'?/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // BLZ-403 (round 3 fix-brief): the load-bearing shape neither variant above
  // exercises. `clean()` strips control characters but NEVER whitespace, so a forge
  // url of one control character, a space, and another control character has only its
  // two control bytes removed, leaving a single space — a string that is non-empty and
  // therefore TRUTHY, so `sanitisePr`'s `url || null` does NOT reduce it to `null`. It
  // survives into `refs[i].url` as " ", and only `allCandidatesComparable`'s
  // `.trim().length > 0` (not the weaker `.length > 0`) recognises it as unusable.
  test("a tied candidate whose url is control-space-control sanitises to a bare space — aggregate, not accused", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-ctrlspacectrl-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-docs\npr: '#40 — u40'\nresolution: done\n"]]);
    // Built via `String.fromCharCode` rather than a literal control byte or a `\u`
    // escape typed into this source file, per this round's own instruction: the fixture
    // must exist without ever putting a raw control byte on disk.
    const CONTROL_SPACE_CONTROL_URL = String.fromCharCode(1) + " " + String.fromCharCode(2);
    const DOCS_MERGED_CTRL_SPACE_URL = { ...DOCS_MERGED, url: CONTROL_SPACE_CONTROL_URL };
    const restore = stubGh(tmp, [WORK, DOCS_MERGED_CTRL_SPACE_URL]);
    try {
      const r = await reconcile({ root, dryRun: false });
      const perTicket = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && f.id);
      const aggregate = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && !f.id);
      assert.equal(perTicket.length, 0,
        "#40 IS in the tied set; a bare-space url is unknowable, not disproof");
      assert.equal(aggregate.length, 1, "it belongs in the aggregate like any other unresolvable-but-plausible record");
      assert.deepEqual(aggregate[0].ids, ["INF-645"]);
      // Untouched on disk either way — this finding never mutates the record.
      assert.match(readTicket(root, "INF-645", "done"), /pr: '?#40 — u40'?/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a tied candidate with no url field at all — aggregate, not accused", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-nourl-"));
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-docs\npr: '#40 — u40'\nresolution: done\n"]]);
    // `namePr`'s own docstring: "Every field here can be missing at once." The url key
    // is absent from the payload entirely, not merely empty — `JSON.stringify` below
    // drops it, so the parsed object never has a `url` property at all.
    const DOCS_MERGED_NO_URL = { ...DOCS_MERGED };
    delete DOCS_MERGED_NO_URL.url;
    const restore = stubGh(tmp, [WORK, DOCS_MERGED_NO_URL]);
    try {
      const r = await reconcile({ root, dryRun: false });
      const perTicket = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && f.id);
      const aggregate = r.findings.filter((f) => f.kind === "terminal-record-unverifiable" && !f.id);
      assert.equal(perTicket.length, 0,
        "#40 IS in the tied set; an unusable url is unknowable, not disproof");
      assert.equal(aggregate.length, 1, "it belongs in the aggregate like any other unresolvable-but-plausible record");
      assert.deepEqual(aggregate[0].ids, ["INF-645"]);
      // Untouched on disk either way — this finding never mutates the record.
      assert.match(readTicket(root, "INF-645", "done"), /pr: '?#40 — u40'?/);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// The aggregate's wording must not be contradicted by the run's own `changes`
// =============================================================================

describe("BLZ-403: the aggregate message claims only what write-once actually guarantees", () => {
  // BLZ-403 (review, blocking finding 3): the aggregate message ended "...so none of
  // them was changed" — about the TICKET. `write()` is structurally false on this
  // branch, so `branch`/`pr` truly are never written; but two lines below, a blank
  // `resolution` on a terminal ticket is STILL backfilled (the comment beside
  // `changes.push` already names this), which sets `dirty` and is written and
  // committed in the SAME run, to the SAME ticket this finding just named. All 10
  // pre-existing tests happened to pre-set a matching `resolution`, so none hit this.
  test("a terminal ticket with no resolution is backfilled AND aggregated — the message must not call it unchanged", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-resbackfill-"));
    // Deliberately NO `resolution:` line — the one field the 10 existing tests all
    // pre-set, which is exactly what let this branch go untested.
    const root = fixture(tmp, [["INF-645", "epic", "done",
      "branch: INF-645-docs\npr: '#40 — u40'\n"]]);
    const restore = stubGh(tmp, [WORK, DOCS_MERGED]);
    try {
      const before = readTicket(root, "INF-645", "done");
      assert.doesNotMatch(before, /resolution:/, "setup: no resolution to backfill from");
      const r = await reconcile({ root, dryRun: false });

      // The backfill actually happened and was committed — the run's own account.
      const change = r.changes.find((c) => c.id === "INF-645");
      assert.ok(change, "the resolution backfill must be recorded in `changes`: " +
        JSON.stringify(r.changes));
      const after = readTicket(root, "INF-645", "done");
      assert.match(after, /resolution: done/, "the backfill actually wrote the file");
      // The RECORD itself is untouched — write-once's actual guarantee, unaffected by
      // this fix.
      assert.match(after, /pr: '?#40 — u40/);
      assert.match(after, /branch: INF-645-docs/);

      const agg = r.findings.find((f) => f.kind === "terminal-record-unverifiable" && !f.id);
      assert.ok(agg, "the aggregate finding must still fire");
      assert.deepEqual(agg.ids, ["INF-645"]);
      // The pinning assertion: on a run that just changed and committed this exact
      // ticket, the aggregate must not claim the ticket ("them"/"it") was unchanged.
      assert.doesNotMatch(agg.message, /none of them was changed/,
        "false on this run: `changes` names this very ticket");
      // What IS guaranteed — the record, not the ticket — must still be said.
      assert.match(agg.message, /record/i);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Volume control — the aggregate, with a GENERATED set (AC-3's second test)
// =============================================================================

describe("BLZ-403: N ambiguous terminal tickets aggregate to exactly one finding", () => {
  test("one recordOutsideCandidates ticket stays per-ticket; the rest fold into one aggregate", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz403-agg-"));
    const N = 4; // INF-1..INF-4; INF-3 is the recordOutsideCandidates case.
    const tickets = [];
    const prs = [];
    for (let n = 1; n <= N; n += 1) {
      const id = `INF-${n}`;
      const workUrl = `u${n}0`, docsUrl = `u${n}1`;
      prs.push(
        { number: n * 10, state: "MERGED", url: workUrl, headRefName: `${id}-work`,
          title: `${id}: the real work` },
        { number: n * 10 + 1, state: "MERGED", url: docsUrl, headRefName: `${id}-docs`,
          title: `${id}: follow-up docs tidy` },
      );
      const recordedUrl = n === 3 ? "u-outside-999" : workUrl;
      tickets.push([id, "epic", "done",
        `branch: ${id}-x\npr: '#999 — ${recordedUrl}'\nresolution: done\n`]);
    }
    const root = board(tmp, [(() => {
      const d = join(tmp, "svc");
      mkdirSync(d, { recursive: true });
      gitInit(d);
      execFileSync("git", ["-C", d, "remote", "add", "origin", "https://github.com/hjr15/service-platform.git"]);
      return d;
    })()], tickets);
    const restore = stubGh(tmp, prs);
    try {
      const r = await reconcile({ root, dryRun: false });
      assert.deepEqual(r.forgeErrors, []);
      const findings = r.findings.filter((f) => f.kind === "terminal-record-unverifiable");
      const perTicket = findings.filter((f) => f.id);
      const aggregate = findings.filter((f) => !f.id);
      assert.equal(perTicket.length, 1, "exactly one per-ticket finding");
      assert.equal(perTicket[0].id, "INF-3");
      assert.equal(perTicket[0].recordOutsideCandidates, true);
      assert.equal(aggregate.length, 1, "exactly one aggregate finding");
      assert.equal(aggregate[0].count, aggregate[0].ids.length);
      assert.equal(aggregate[0].count, N - 1);
      assert.deepEqual([...aggregate[0].ids].sort(), ["INF-1", "INF-2", "INF-4"],
        "every OTHER affected ticket is named in ids exactly once");
      // No duplicate ids.
      assert.equal(new Set(aggregate[0].ids).size, aggregate[0].ids.length);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// The aggregate finding travels through `newFindingEvents` — VERIFY, don't assume
// =============================================================================

describe("BLZ-403: an aggregate finding (no `id`) reaches the activity feed correctly", () => {
  test("it is published once, keyed on its message like any other finding", () => {
    const said = new Set();
    const agg = { kind: "terminal-record-unverifiable", count: 3, ids: ["INF-1", "INF-2", "INF-4"],
      message: "3 terminal ticket(s) already hold a delivery record reconcile cannot verify: INF-1, INF-2, INF-4." };
    const first = newFindingEvents([agg], said);
    assert.equal(first.length, 1);
    assert.equal(first[0].id, undefined, "id passes through as whatever the finding carries — here, nothing");
    assert.equal(first[0].type, "warning");
    assert.equal(first[0].loop, "reconcile");
    assert.equal(first[0].message, agg.message);
    assert.deepEqual(newFindingEvents([agg], said), [],
      "deduped on message exactly like a per-ticket finding — it persists until cleared");
  });

  test("a per-ticket finding and the aggregate are independent messages, both said", () => {
    const said = new Set();
    const perTicket = { kind: "terminal-record-unverifiable", id: "INF-645", message: "a" };
    const agg = { kind: "terminal-record-unverifiable", count: 1, ids: ["INF-2"], message: "b" };
    assert.equal(newFindingEvents([perTicket, agg], said).length, 2);
  });
});
