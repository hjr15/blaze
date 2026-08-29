#!/usr/bin/env node
// reconcile.mjs — make the board mirror git/PR state across every project and
// every repo a project spans. Git is the source of truth; the board is a live
// mirror. The join key is the <KEY>-<n> in each branch/PR head ref, resolved
// per project. (Phase-3 design §3.)
//
//   node scripts/reconcile.mjs            # dry-run: print would-be moves (default)
//   node scripts/reconcile.mjs --apply    # commit locally (never pushes)
//   node scripts/reconcile.mjs --fetch    # fetch from remotes before reconciling
//   node scripts/reconcile.mjs --quiet    # print only on change
//
// Only DELIVERY-workflow types (epic/story/task/bug) mirror git state; goal/risk
// are manual. A ticket with no branch and no PR is never touched. Terminal status
// is sticky (a done ticket stays done). With no projects configured, it's a no-op.
//
// Zero dependencies — Node built-ins + shelling to `git`/`gh`.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, listProjects, loadProject, resolveRoots, InvalidProjectKeyError } from "./config.mjs";
import { fsReadStorage } from "./model/read-storage.mjs";
import { unreadableTicketDirs } from "./model/index.mjs";
import { fsStorage } from "./model/storage.mjs";
import { fsWritePort } from "./model/write-port.mjs";
import { isType, workflowFor } from "./model/schema.mjs";
import { isTerminal, resolutionForTerminal } from "./model/workflows.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
import { commitOutcomeFrom, applySummary } from "./reconcile-commit-report.mjs";
import { assertWritable } from "./readonly.mjs";

// BLZ-130: SELECTION precedence — deliberately NOT "how far along the PR is".
// An OPEN PR outranks a MERGED one, because while any PR carrying the key is still
// open the work is not shipped, whatever an earlier PR did. Epic INF-645 was
// reported done off a docs-only PR #80 that merged while PR #81 — the actual work —
// was open; the merged signal won on rank, and terminal status is sticky, so
// nothing re-opened it when #81 landed later.
//
// This is a veto, not a re-ordering of "progress": MERGED still beats CLOSED, and a
// ticket whose only PR is merged still reaches done. It costs a delayed done (the
// ticket sits in in-review until the last PR carrying its key closes) and buys back
// the failure that biases toward saying shipped when it is not.
//
// Type-independent on purpose. The ticket asks whether `story` shares the failure;
// every delivery type does, because ranking never sees the type.
export const PR_RANK = { OPEN: 3, MERGED: 2, CLOSED: 1 };

// --- shelling out, in two layers (BLZ-350) ------------------------------------
// `shResult` is the honest one: it reports WHAT happened — exit status, stderr,
// whether the binary was even found — so a caller can tell "succeeded with no
// output" from "failed". `sh` is the lossy convenience wrapper that collapses
// that into "trimmed stdout, or null", which is what the git probes below
// actually want (`rev-parse --verify` failing IS the answer to "does this ref
// exist?").
//
// Every `sh` call site was audited before this split; all ten are `git` probes
// whose failure is either meaningless or already handled by the `|| ""` /
// `!== null` idiom around them. Their behaviour is unchanged, deliberately.
// The ONE call that must not be lossy is the forge call, and it uses `shResult`.
export function shResult(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024, ...opts,
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: "", status: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: e && e.stdout ? String(e.stdout).trim() : "",
      // ENOENT (binary not installed) has no stderr — fall back to the error's own text.
      stderr: (e && e.stderr ? String(e.stderr).trim() : "") || (e && e.message ? String(e.message).trim() : ""),
      status: e && typeof e.status === "number" ? e.status : null,
    };
  }
}

function sh(cmd, args, opts = {}) {
  const r = shResult(cmd, args, opts);
  return r.ok ? r.stdout : null;
}

// --- BLZ-484: A PROBE THAT COULD NOT LOOK IS NOT A PROBE THAT LOOKED AND FOUND NOTHING ---
//
// The comment above says every `sh` call site is a git probe "whose failure is either
// meaningless or already handled". That was measured wrong, and the review demonstrated it
// end to end: with the `git log --format=%x00%B` probe below unable to RUN, reconcile went
// from `moved ZZZ-1: defined -> done` to `no code-bound change found - nothing to do.` —
// exit 0, and not one word on stderr. An empty commit log and a `git` that could not be
// forked produced the same sentence.
//
// This is the production sibling of the defect shipped in PR #150 one layer up, where a
// test guard resolved a git ref locally and read CI's shallow, ref-less checkout as "the
// ref does not exist". Its fix is the shape reused here: THREE OUTCOMES, NOT TWO.
//
//   ran, exit 0          — the answer.
//   ran, exit non-zero   — an answer ONLY where the question is "does this ref exist";
//                          `exitIsAnAnswer` is that opt-in, and it is per call site
//                          because it is a property of the QUESTION, not of `git`.
//   did not run          — never an answer. `shResult` reports `status: null` for exactly
//                          this: ENOENT (no `git`), EAGAIN (cannot fork), ETIMEDOUT, a
//                          signal. It is the discriminator the whole ticket turns on.
//
// The forge half of this file has been loud since BLZ-350 (`FORGE UNREADABLE`, INF-763):
// the condition travels with the result in `forgeErrors` and the CLI prints it every run.
// This is the same mechanism for git — `gitErrors`, same per-repo collection, same journey
// up through `gatherProject` to `reconcile()`'s result — plus the one thing the forge half
// does not need: a run that could not complete a probe DOES NOT GET TO REPORT A CLEAN
// BOARD. See the CLI's `GIT UNREADABLE` block.
function gitProbe(errors, repoPath, args, opts = {}) {
  const { exitIsAnAnswer = false, severity = "error", what = "", consequence = "", ...spawnOpts } = opts;
  const r = shResult("git", ["-C", repoPath, ...args], spawnOpts);
  if (r.ok) return r.stdout;
  const ran = r.status !== null;
  if (ran && exitIsAnAnswer) return null;
  const detail = (r.stderr || "").split("\n").filter(Boolean)[0] || (ran ? `exit ${r.status}` : "the process produced no output at all");
  const cmd = `git ${args.join(" ")}`;
  errors.push({
    repo: repoPath, reason: ran ? "git-failed" : "git-unrunnable", severity,
    command: cmd, status: r.status, detail,
    message: (ran
      ? `\`${cmd}\` failed in ${repoPath}: ${detail}.`
      : `\`${cmd}\` COULD NOT RUN in ${repoPath}: ${detail}. Blaze never got an answer — this is not \`git\` saying no.`) +
      (what ? ` ${what}` : "") + (consequence ? ` ${consequence}` : ""),
  });
  return null;
}

// --- pure decision: git signal + current status + type → target status --------
export function decide({ pr, branch, shipped, delivererAmbiguous = false }, currentStatus, type) {
  // Only delivery-workflow types mirror git state; goal/risk stay manual.
  if (!isType(type) || workflowFor(type) !== "delivery") {
    return { target: currentStatus, branchVal: null, prVal: null, moved: false, skip: true,
             resolution: undefined, recordIfAbsentOnly: false, openPrOnTerminal: false,
             recordAmbiguous: false };
  }
  // BLZ-440 round 2: AN UNCORROBORATED CLAIM MAY ONLY EVER HOLD A TICKET BACK.
  //
  // `buildPrMap` deliberately keeps uncorroborated claims in the ranking pool so they
  // keep whatever veto their STATE earns — dropping them is a SUBSTITUTION that promotes
  // the next-ranked PR (see the comment there). The other half of that bargain is here:
  // a claim that never corroborated may supply neither a delivery RECORD nor a forward
  // TARGET, so reaching the top of the rank buys it the power to WITHHOLD a move and
  // nothing else.
  //
  // Returning `skip` rather than falling through to the `branch`/`shipped` arms is
  // deliberate and is the point of the rule. Falling through would let `shipped` drive
  // `done` while an OPEN PR sits in the pool, which is precisely the BLZ-130 veto this
  // is meant to preserve. Masking a corroborated BRANCH signal is the accepted cost: a
  // missed advance, in the not-shipped direction ADR-0023 biases toward.
  //
  // Both required cases fall out of this one clause:
  //   - PR #140 (MERGED, uncorroborated) for BLZ-408 in `defined` → no record, no move.
  //   - an uncorroborated OPEN PR out-ranking a corroborated MERGED one on an
  //     `in-review` ticket → the merged PR never becomes the winner, and the winner
  //     moves nothing, so the ticket stays `in-review`.
  if (pr && pr.uncorroborated) {
    // `openPrOnTerminal` stays FALSE here, which keeps the doctrine below true as
    // written: the finding reports on the veto, and it must not be noisier than the
    // veto is. An uncorroborated claim moves nothing, so there is no wrong move to
    // report — only a signal deliberately not taken.
    return { target: currentStatus, branchVal: null, prVal: null, moved: false, skip: true,
             resolution: undefined, recordIfAbsentOnly: false, openPrOnTerminal: false,
             recordAmbiguous: false };
  }
  let target, branchVal = null, prVal = null;
  if (pr) {
    // Delivery workflow middle statuses ("in-review"/"in-progress") are intentional literals here;
    // this function is already delivery-guarded above, so there's no need to re-derive them from rules.
    target = pr.state === "MERGED" ? "done" : pr.state === "OPEN" ? "in-review" : "in-progress";
    // The STATUS comes from the state and is always available. The RECORD needs a number
    // Blaze can stand behind, and `sanitisePr` sets `number: null` when the forge did not
    // supply one. Both fields are clamped together, never one — the record is one unit,
    // and half of it naming a PR the other half cannot identify is ADR-0023's fourth
    // shape of wrong reached through a new door.
    if (recordablePr(pr)) {
      branchVal = pr.headRefName;
      prVal = `#${pr.number} — ${pr.url}`;
    }
  } else if (branch) {
    target = "in-progress";
    branchVal = branch;
  } else if (shipped && !isTerminal(type, currentStatus)) {
    // A bundled epic-child has no branch/PR of its own; a <KEY>-<n>: commit
    // reachable from the default branch is the signal that it shipped. Gate on
    // NOT-already-terminal: a shipped signal on a terminal ticket must take the
    // skip path below (not widen behaviour), so terminal-sticky doesn't recompute
    // an existing `resolution` on a ticket that's already in a terminal status.
    target = "done";
  } else {
    return { target: currentStatus, branchVal: null, prVal: null, moved: false, skip: true,
             resolution: undefined, recordIfAbsentOnly: false, openPrOnTerminal: false,
             recordAmbiguous: false };
  }
  // Terminal-sticky: never pull a ticket out of a terminal status automatically.
  //
  // The branch and PR are clamped WITH the status, which the first cut of BLZ-130 did
  // not do. Clamping `target` alone suppressed the move and rewrote the record anyway:
  // a done epic delivered by merged PR #80 had its frontmatter replaced with the later
  // OPEN #81 that now wins the rank, reported as `moved: false`. A terminal ticket's
  // branch and PR are the HISTORY of what delivered it, not live fields, and silently
  // repointing them at work that has not landed destroys the only record there is.
  if (isTerminal(type, currentStatus)) {
    target = currentStatus;
    // Record only what could have DELIVERED it. An open or closed PR could not, so it
    // may not write the record at all — that was the defect: a done epic delivered by
    // merged #80, silently repointed at open #81.
    //
    // Three attempts, three shapes of wrong, which is why both halves of the rule are
    // spelled out. Overwrite-anything was the original bug. Nulling both fields for
    // EVERY terminal ticket then stopped the first write too — reconcile is the only
    // producer of `branch`/`pr` (nothing else in scripts/ originates them, and they are
    // not in EDITABLE_FIELDS), so a done ticket that never had them recorded could never
    // acquire them: 1,056 of 1,594 done tickets CARRYING NEITHER FIELD at blaze-pm
    // ff5f36c2, permanently. (The neighbouring 1,064 is a DIFFERENT population — those
    // MISSING A PR at that same ref — and the two read alike, which is how the figure was
    // wrong here and in ADR-0023. Name the quantity and pin the ref, never `origin/main`,
    // which moves.) Gating on MERGED alone then let the LATEST merge win the rank
    // tie-break, so a follow-up docs PR repointed the record again. Hence also the
    // write-once rule below.
    if (!pr || pr.state !== "MERGED") {
      branchVal = null;
      prVal = null;
    }
  }
  // The write-once half. `decide` cannot see the current frontmatter, so it says the
  // rule APPLIES and the caller — which holds it — enforces it. A terminal ticket may
  // acquire a delivery record it never had, and may never have one replaced: gating on
  // MERGED alone still let the LATEST merge win the rank tie-break, so a follow-up docs
  // PR repointed a done epic away from the PR that delivered it.
  const recordIfAbsentOnly = isTerminal(type, currentStatus);
  // BLZ-395: REPORT, DON'T MOVE. The conflict this names is the residual ADR-0023 §1
  // left open, and it is a REPORT because the alternative is to weaken terminal-
  // stickiness, which is a separate design rule with its own blast radius.
  //
  // The window: BLZ-130's veto is evaluated at RUN TIME, so the board's answer depends
  // on WHEN reconcile sampled git. One run seeing only the early merged PR writes
  // `done`; a later run seeing that PR AND the open one that carries the real work
  // would have written `in-review`, but terminal status is sticky so it changes
  // nothing and reports `moved: false`. Same end state, two answers, decided by run
  // history — and `blaze start`'s loop samples that window routinely.
  //
  // Why not un-stick it. Stickiness exists to stop reconcile fighting a human's
  // hand-move; a terminal ticket that a person deliberately closed would be dragged
  // back to `in-review` by any open PR whose branch merely carries the key. That
  // trades a silent over-report for a silent over-write, which is the same class of
  // bug in the other direction — and this record's history (ADR-0023 §1, four shapes
  // of wrong) is the argument for not adding a fourth inference path. Reporting
  // surfaces the conflict, moves nothing, and leaves the correction to a person.
  //
  // `pr` here is always CORROBORATED, so this is "a CORROBORATED open PR" — an
  // uncorroborated claim must not be visible to this finding, or the report would be
  // noisier than the veto it is reporting on. Since BLZ-440 round 2 that is no longer
  // true of `buildPrMap`, which keeps uncorroborated claims in the pool; it is the
  // early return at the top of this function that guarantees it here.
  const openPrOnTerminal = Boolean(pr) && pr.state === "OPEN" && isTerminal(type, currentStatus);
  const moved = target !== currentStatus;
  const resolution = isTerminal(type, target) ? resolutionForTerminal(type, target) : undefined;
  // BLZ-398: the record it is about to offer comes from a merged set git cannot
  // resolve into a deliverer. Reported the same way `recordIfAbsentOnly` is — this
  // function says the RULE APPLIES, and the caller, which holds the current
  // frontmatter, enforces it. That split is ADR-0023's own, and keeping this on the
  // same side of it is what stops the record having two owners.
  //
  // Gated on the TARGET being terminal, not the current status: a ticket moving
  // `defined -> done` locks its record in on that very move, so the ambiguity has to
  // be caught before the first write, not after the ticket is already terminal.
  const recordAmbiguous = Boolean(delivererAmbiguous) && isTerminal(type, target);
  return { target, branchVal, prVal, moved, skip: false, resolution, recordIfAbsentOnly,
           openPrOnTerminal, recordAmbiguous };
}

// --- anchored leading-id parse of a commit subject ("<KEY>-<n>: desc") --------
// Only the LEADING id counts — a subject that merely mentions a second ticket
// downstream ("fixes BLZ-4") is attributed to its leading id, never the mention.
export function idFromSubject(subject, key) {
  const m = new RegExp("^" + key + "-(\\d+):", "i").exec((subject || "").trim());
  return m ? `${key}-${m[1]}` : null;
}

// --- BLZ-131: what ONE commit message says shipped ---------------------------
// The shipped signal used to read commit SUBJECTS only. These repos are squash-only
// — blaze-pm by deliberate design (INF-556/INF-557), service-platform by convention
// — and a squash collapses a branch into one commit whose subject is the PR TITLE.
// Every bundled child's `KEY-n:` subject is destroyed by the merge, so six children
// of epic INF-645 sat in `defined/` with their work live in production. Reconcile
// said nothing: the failure is silent and biased toward under-reporting.
//
// What survives is the BODY. GitHub's default squash message concatenates the
// collapsed commits' messages, each subject as a `* ` bullet — verified on this
// repo's own history at blaze 7a5ddb0 (its origin/main when this was measured; the
// name `origin/main` is not a ref, it moves, and 312 self-invalidates on the next
// merge). 23 of those 312 commits carry such a bullet under a ticket subject, 102
// such bullet lines in all, recovering 28 ticket ids no subject at that ref names.
//
// THREE CONDITIONS, AND ALL THREE ARE LOAD-BEARING.
//
//   1. The marker is `* `, which is what GitHub writes and nothing else here does.
//   2. The subject must OPEN with a ticket-id list — `KEY-n:`, and the multi-ticket
//      forms the house also writes, `KEY-a/b/c:`, `KEY-a + KEY-b:`, `KEY-a, KEY-b:`
//      and `KEY-a & KEY-b:`. The commit must itself be a squashed ticket PR, which is
//      BLZ-131's premise: per-ticket commits inside a FEATURE's PR. Every id in that
//      leading list counts, and the list ends at the colon, so `KEY-1: fixes KEY-4`
//      still claims only KEY-1.
//   3. The BULLET must end at a colon too. This one shipped unstated and untested
//      (BLZ-399): with conditions 1 and 2 both satisfied, `* KEY-4 is blocked by this`
//      is a sentence, not a collapsed commit subject, and reading it as one drives
//      KEY-4 to `done` off prose. Deleting the `:` from the `bullet` regex left the
//      whole suite green at blaze 3cf1509 — 2,518 pass / 0 fail — which is why it is
//      named here rather than left to be inferred from the regex.
//
// Condition 2's separator inventory is load-bearing in a way that is easy to
// under-read, and is pinned in tests/reconcile-load-bearing-conditions.test.mjs. The
// list is ANCHORED and must reach the colon, so an unrecognised separator does not
// truncate the list — it makes the subject fail to match at all, condition 2 then
// returns early, and the ids AND every bullet in the body are lost together. `&` is
// unobserved across all 19 configured repo/key pairs (scanned 2026-08-26) and is KEPT
// for that reason: it is one of four spellings of one construct, and the guard against
// over-claiming is the anchor and the colon, never which separators are listed.
//
// Condition 2 exists because the first cut, which honoured any `[*+-]` bullet under any
// subject, turned the board's own ledger into a delivery signal. `commit-runner.mjs`
// writes every batch board commit's body as `- <KEY>-<n>: <board op> [session]`, and
// the board repo is itself a configured codeRepo for its own project — the hazard
// INF-735's comment already names. Measured on the board repo at blaze-pm ff5f36c2
// (its origin/main, 156 commits) for the INF key alone: 426 ids harvested beyond the
// subjects, 386 of them named by nothing but a ledger line. Re-run at that same ref,
// the first cut drives `decide()` to move 141 INF tickets `defined → done`, every one
// of them named by a `- INF-<n>: <board op> [session]` line (268 across all eleven
// project keys the board configures, 266 of those named by such a line). An earlier
// draft quoted 137 against "the board's local HEAD, the 299-id tree", which is not a
// ref anyone else can resolve. That is BLZ-130's failure at a hundred times the scale,
// inside the fix for its sibling.
//
// Neither condition alone suffices. The board also carries squashed PRs of ticket-BODY
// edits, subject `blaze: … board + ticket work (#60)`, whose bullets are real `KEY-n:`
// subjects describing an edit rather than a delivery — the subject gate drops those.
// And ledger lines swept into a PR that IS titled for a ticket are what the marker
// drops. At blaze-pm ff5f36c2, across all eleven project keys the board configures:
// 1,323 ids ungated, 63 with the subject gate alone, 3 with both — BLZ-259, INF-672
// and INF-701, each harvested from a genuine `* KEY-n:` bullet under a squashed ticket
// PR's subject. For the INF key alone the same three rules read 426 / 49 / 2. Both are
// snapshots that move as the board grows: at blaze-pm bd1d151d (131 commits, an
// ancestor of ff5f36c2) the third rule read 2 across all keys, and BLZ-259 joined it
// when commit e3beaec3 landed. ADR-0023 §2 records the drift. On the code repo at
// blaze 7a5ddb0 the rule recovers 28 ids.
//
// The multi-ticket forms in condition 2 were themselves missed once: reading only the
// leading id discarded two of the three tickets that `BLZ-286/287/288: … (#71)`
// delivered, and would have stranded BLZ-131 on the PR that introduced this function.
//
// What this deliberately does NOT claim: a bullet is not proof of work. A squashed
// ticket PR whose body lists a ticket it did not implement will be believed. The two
// conditions make that narrow rather than common, and the safe direction holds
// elsewhere — the commit must be reachable from the default branch, so an open PR
// strands nothing.
//
// This reads git and nothing else. A PR BODY listing its bundled tickets was the other
// candidate and was rejected: it widens trust to the forge for a claim that moves a
// ticket to DONE, and a PR body naming a ticket is weaker evidence than a commit
// demonstrably on the default branch. The cost is a configuration dependency, recorded
// in docs/guide/how-it-works.md — a repo whose squash message is set to "Pull request
// title" alone destroys the bullets, and its bundled children need a manual move.
export function idsFromCommitMessage(message, key) {
  const lines = String(message || "").split("\n");
  // No ticket in the subject means this is not a squashed ticket PR, so its body is
  // not a bundle manifest — whatever it happens to list. Returning early is the whole
  // of condition 2.
  const ids = idsFromSubject(lines[0], key);
  if (!ids.length) return [];
  // Column 0, not merely "starts with a bullet". All 104 `* <KEY>-<n>:` lines in this
  // repo's history at blaze 7a5ddb0 sit at column 0 and none is indented. That 104 is a
  // WIDER population than the 102 counted above: it is every such line in the history,
  // including those under a non-ticket subject, where 102 counts only the ones under a
  // ticket subject. Column 0 is where GitHub writes them; an indented one is a
  // sub-bullet inside some commit's prose, and reading it as a delivered child is a guess.
  const bullet = new RegExp("^\\*\\s+" + key + "-(\\d+):", "i");
  for (let i = 1; i < lines.length; i += 1) {
    const m = bullet.exec(lines[i]);
    if (!m) continue;
    const id = `${key}-${m[1]}`;
    // A child listed in the body of the PR that also names it in the subject is one
    // ticket, not two.
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// --- every ticket a commit SUBJECT claims, not merely the first ---------------
// The house titles a feature PR for the ticket it delivers, and sometimes for several:
// `BLZ-286/287/288: config projection … (#71)` and `BLZ-96/97: close batch-mode commit
// bypasses` are both real squashed feature PRs on this repo's default branch.
//
// `idFromSubject` returns only the leading id, which is right for its own callers and
// wrong as a gate: reading only the first id threw away two of the three tickets that
// PR delivered, and would have stranded BLZ-131 on the very PR that introduced this
// function.
//
// The list must be CONTIGUOUS and end at a TERMINATOR, which is what preserves
// `idFromSubject`'s rule that a downstream mention is never a claim — `BLZ-1: fixes
// BLZ-4` still yields only BLZ-1. Separators are the ones the house actually uses.
//
// --- BLZ-455, DECIDED (operator, 2026-08-28). ADR-0026. --------------------------
// THE TERMINATOR SET IS `:` AND `—` (U+2014 EM DASH), AND NOTHING ELSE.
//
// An em-dash immediately after the id is an unambiguous SEPARATOR, exactly like the
// colon: there is no reading of `INF-327 — Author the three diagrams` on which the
// title is about anything but INF-327. Ten merged PRs in `docs-central` are titled that
// way and supplied no title signal at all until now; thirteen of the twenty records
// BLZ-456 flagged become valid under this line.
//
// WORDS BETWEEN THE ID AND THE COLON STAY REJECTED, AND THAT IS THE LOAD-BEARING HALF.
// `INF-889 to INF-892: corpus landing` is a real merged PR title. Admitting
// words-before-colon would make it claim INF-889 — a RANGE, and therefore precisely the
// defect BLZ-440 exists to stop, readmitted through the front door. `OBA-809 backfill +
// OBA-811: …` and `CRP-51 (bundle 3/3): …` are the same shape. Also still rejected:
// `feat(KEY-n):`, `[KEY-n]`, `KEY-n desc`, `Revert "KEY-n: …"`, `WIP: KEY-n: …`,
// `KEY-n and KEY-m:`, and every dash that is not U+2014 — en-dash, hyphen, minus,
// horizontal bar. One code point, decided; its neighbours are not it.
//
// BLAST RADIUS, STATED: this is the SAME predicate `idsFromCommitMessage` runs over a
// commit SUBJECT, so the shipped-commit signal widens by exactly the em-dash case too.
// That is accepted and intended — an em-dash-separated commit subject claims its ticket
// as plainly as a colon-separated one.
//
// MEASURED (BLZ-353), AND THE FIRST MEASUREMENT WAS WRONG. Round 1 measured `blaze` and
// `blaze-pm`, found 0 additional ids, and excused it with "the population lives in
// `docs-central`, which is a codeRepo of neither" — a CATEGORY ERROR. The relation is
// project→codeRepo, not repo→repo: `docs-central` is a configured codeRepo of BOTH
// `projects/INF` and `projects/CRP`, so it is squarely inside the blast radius. Two true
// figures did the rhetorical work of a false conclusion.
//
// Redone across every project key and every codeRepo it configures, the way
// `gatherProject` actually unions them (14 repos, board config at blaze-pm 80dd9ccb):
//
//     key    before   after   delta          key    before   after   delta
//     ACA         6       6      0           KPA        24      24      0
//     BLZ       237     239     +2 (manifest) NCA       16      16      0
//     CRP        41      41      0           OBA       465     465      0
//     FL          1       1      0           OMA        23      23      0
//     INF       453     475    +22 (em-dash) SN          4       4      0
//                                            TOTAL    1270    1294    +24
//
// So the em-dash widening harvests +22 ids, all under INF, all from `docs-central` at
// 98f2fa8 (421 commits). CRP: 0. And IT COMPOUNDS, which round 1 never stated: only 10
// SUBJECTS newly qualify, but a qualifying subject also unlocks the body-manifest reader
// above for that commit, and its `* KEY-n:` bullets contribute the other 12. The widening
// is not subject-only.
//
// All 22 are already terminal, so nothing moves — but 12 of them hold no `pr:` record,
// and ADR-0023 lets a terminal ticket ACQUIRE an absent one. THREE paths reach that write
// and they answer differently. The first two are settled by end-to-end tests in
// tests/reconcile-title-claim-oracle.test.mjs rather than by argument:
//   - shipped ALONE cannot write a record (the `shipped` arm sets neither field, and on a
//     terminal ticket it is not even reached) — REFUTED;
//   - shipped as CORROBORATION can, because `claimCorroborated`'s first arm is
//     `shippedSet.has(id)`: a wider set promotes a weak-titled MERGED PR from
//     uncorroborated to corroborated, and that PR may fill an absent record — REAL. No
//     such PR exists on `docs-central` today (0 of its 204 PRs has a branch deriving any
//     of the 12), so the path is live but untriggered. See ADR-0026.
//   - BLZ-489, THE THIRD, which this comment enumerated as two until ADR-0026 named it:
//     `buildBranchMap` carries its OWN `shippedSet && shippedSet.has(id)` corroboration,
//     one layer below `claimCorroborated`, so a wider set newly admits a BRANCH rather
//     than a PR. It is GUARDED, not absent — on a terminal ticket, terminal-sticky nulls
//     `branchVal` and `prVal` for anything whose top-ranked PR is not MERGED, and a
//     branch recovered by the shipped set brings no PR at all. On a NON-terminal ticket
//     the same arm writes `branch:` and moves the ticket to `in-progress`. The arm itself
//     is pinned by "buildBranchMap: shippedSet corroborates a branch with no matching
//     commit subject" in tests/reconcile-branchmap-corroboration.test.mjs.
//
// So the two-path answer for the 22 holds BECAUSE OF terminal-sticky, not in spite of
// needing it: every one of the 22 is already `done`, which is a fact about THAT
// population and not a property of the widening. A future widening that reaches a
// non-terminal id makes the third path live, and it moves a ticket rather than merely
// recording one — which is the louder of the two outcomes, not the quieter.
//
// --- BLZ-469: the MULTI-TICKET MANIFEST form -------------------------------------
// `KEY-n + N more: desc` claims KEY-n and NOTHING ELSE from the subject; the squash
// body's `* KEY-m:` bullets claim the rest (`idsFromCommitMessage`, above). PR #144 —
// `BLZ-414 + 15 more: the oracles are non-vacuous` — claimed nothing at all, not even
// BLZ-414, because after `+` the key must be repeated and `15` is not `BLZ-15`; all
// sixteen tickets had to be hand-moved. `N` is a COUNT and is never read as an id: it
// sits exactly where a bare list element sits after `/`, and reading it as one would
// claim a ticket that does not exist — the same trap the bare-number rule already
// refused for `BLZ-1 + 2026: annual review`. Hence the CAPTURE GROUP: ids come from the
// id-list alone, never from the whole head.
//
// A RANGE STILL CLAIMS NOTHING under this form. `BLZ-408..439 + 15 more:` fails the
// head match on the `..` before the manifest tail is ever reached, and `BLZ-408 + 15
// others:` — a bundle marker Blaze does not know — claims nothing rather than silently
// falling back to its leading id.
//
// WHAT THIS DOES AND DOES NOT RECOVER, measured rather than asserted. On `blaze` at
// 86619d4 the manifest form harvests 2 shipped ids that nothing else named — BLZ-414 and
// BLZ-458 — from the one commit in 337 whose subject carries it (b318d7b, PR #144); a
// third, BLZ-427, is recovered too but was already named by PR #146's spelled-out title.
// On blaze-pm 80dd9ccb it harvests 0, because no board commit uses the form. THREE of
// #144's SIXTEEN tickets, not sixteen: the body manifest is only ever as complete as the
// squash's commit list, and #144 squashed five commits naming three tickets. The
// go-forward contract is therefore a contract on the AUTHOR as much as on the parser —
// a `+ N more` title is a promise that the bundle's commits each open with their own
// `KEY-n:` subject, which is already the house commit rule. A title that promises N more
// and a body that does not name them recovers only what the body actually carries, and
// the merged-PR warning below is what tells the operator which case they are in.
export function idsFromSubject(subject, key) {
  // A bare number continues the list only after `/` — `KEY-a/b/c:` is the house's own
  // shorthand. After `+`, `,` or `&` the key must be repeated, which is how the house
  // writes those. Allowing a bare number everywhere let `BLZ-1 + 2026: annual review`
  // claim a ticket BLZ-2026 that does not exist; nothing documented that latitude.
  const list = key + "-\\d+(?:(?:\\s*/\\s*(?:" + key + "-)?\\d+)|(?:\\s*[+,&]\\s*" + key + "-\\d+))*";
  // The manifest tail is OUTSIDE the captured list, so its count can never become an id.
  const head = new RegExp("^(" + list + ")(?:\\s*\\+\\s*\\d+\\s+more)?(?=\\s*[:\u2014])", "i")
    .exec(String(subject || "").trim());
  if (!head) return [];
  const ids = [];
  const each = new RegExp("(?:" + key + "-)?(\\d+)", "gi");
  for (const m of head[1].matchAll(each)) {
    const id = `${key}-${m[1]}`;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// --- INF-735: a ref-derived claim needs a SECOND signal to count --------------
// `idFromRef` is an unanchored `\bKEY-(\d+)` run over every branch/PR head ref in
// every one of a project's codeRepos. When a repo that carries board or docs work
// is itself a codeRepo for a project, its own branches claim that project's
// tickets they never touched — and a MERGED PR outranks the ticket's real repo,
// driving an unworked ticket to `done`. Terminal status is sticky and a MERGED
// signal never changes, so it re-asserts on every `reconcile --apply`.
//
// A ref name is a naming convention, not evidence. Corroborate it with something
// that describes the WORK: the id in the PR title (the house `KEY-n: desc` title
// convention), or a `KEY-n:` commit reachable from the default branch (the
// shippedSet we already compute). Fail closed — an uncorroborated claim is dropped
// rather than trusted, so a misnamed branch costs a missed signal, not a corrupted
// ticket.
//
// BLZ-440: the title arm used to be `new RegExp("\\b" + id + "\\b", "i").test(title)` —
// a bare MENTION anywhere in the title. That is not the house rule, and it re-opened
// the very hole INF-735 closed one axis over. `\bBLZ-408\b` matches inside
// `BLZ-408..439` (the `.` is a non-word character, so the right-hand boundary holds),
// so PR #140 — branch `docs-successor-kickoff-blz-408-439`, title `docs: successor
// kickoff for the BLZ-408..439 follow-up lane` — corroborated its own range expression
// and proposed `BLZ-408: defined → done` for a ticket that had never been worked.
// A range, a `supersedes KEY-n`, a `follow-up to KEY-n`: all mentions, none claims.
//
// The house already decides this question, once, in `idsFromSubject`: a subject claims
// a ticket only when it OPENS with `KEY-n` followed by `:` (with the `+` `,` `&` `/`
// list forms), because "a downstream mention is never a claim". That rule reached
// commit subjects and `prTitleClaim`'s RANKING but never this GATE, and two
// implementations of "does this subject claim this ticket" is precisely how the two
// paths drifted apart. So the gate now calls the same function rather than carrying a
// second regex. The key is derived from the id, not taken as a parameter, so a caller
// cannot silently degrade this by forgetting to pass it — the same guard `prTitleClaim`
// uses, for the same reason.
//
// The shippedSet arm above is UNCHANGED: it is built from `idsFromCommitMessage`, which
// is already strict, and it is what lets a legitimately non-conventional title still
// corroborate when a real `KEY-n:` commit shipped.
export function claimCorroborated(id, { title = "", shippedSet = null } = {}) {
  if (shippedSet && shippedSet.has(id)) return true;
  const dash = String(id || "").lastIndexOf("-");
  // No `-` means no key to parse a claim with. Fail closed rather than slicing a
  // negative index into a plausible-looking key (`id.slice(0, -1)`), which would send
  // a garbage key into a RegExp constructor.
  if (dash <= 0) return false;
  const key = id.slice(0, dash);
  return idsFromSubject(title, key).includes(id);
}

// --- resolve a repo's default-branch LOG REF, preferring the remote-tracking ---
// branch. prMap comes from live `gh pr list` and branchMap reads
// refs/remotes/origin, so the shipped signal must read the SAME freshness — the
// remote-tracking default branch — not local `main` (which `blaze reconcile
// --fetch` does not update). A bundled child merged on origin/main would
// otherwise be missed while a solo merged-PR ticket flips to done: asymmetric
// under-reporting. Order: origin/HEAD → origin/main|master → local main|master
// (remote-less repos: fixtures + blaze-pm itself) → "main" fallback.
//
// BLZ-484: `resolved` is the CONTROL, and it is what lets the probes below tell an answer
// from a silence. Every candidate here is asked "does this ref exist", and for THAT question
// a non-zero exit is the answer — measured across the 330 reconcile tests, `rev-parse
// --verify --quiet` exits 1 on 474 occasions and `rev-parse --abbrev-ref origin/HEAD` exits
// 128 on 239, every one of them an ordinary "no such ref" on a fixture repo. So those exits
// stay silent (`exitIsAnAnswer`), and only a probe that could not RUN is reported.
//
// What must NOT stay silent is the fall-through. Returning the bare string "main" told every
// caller "the default branch is main" when what happened is that nothing resolved — so
// `git log main` then failed, `|| ""` turned that into an empty commit log, and the run
// reported no shipped tickets. `resolved: false` is that distinction, carried instead of
// laundered.
function defaultBranchRef(repoPath, gitErrors = []) {
  const asks = { exitIsAnAnswer: true, what: "This probe asks whether a ref exists, and a non-zero exit is its answer; no answer is not." };
  const head = gitProbe(gitErrors, repoPath, ["rev-parse", "--abbrev-ref", "origin/HEAD"], asks);
  if (head && head !== "origin/HEAD") return { ref: head, resolved: true }; // e.g. "origin/main" — keep the remote-tracking ref verbatim
  for (const b of ["origin/main", "origin/master", "main", "master"]) {
    if (gitProbe(gitErrors, repoPath, ["rev-parse", "--verify", "--quiet", b], asks) !== null) {
      return { ref: b, resolved: true };
    }
  }
  return { ref: "main", resolved: false };
}

// --- group a repo's PRs by the ticket their ref claims --------------------------
// `includeUncorroborated` is the difference between the two questions asked of this
// grouping, and they are NOT the same question:
//
//   - DELIVERER candidates (`ambiguousDeliverers`, and the `candidates` that travel
//     upward for the cross-repo ambiguity check) must be CORROBORATED. "Which of these
//     PRs delivered the ticket" is meaningless for a PR that never claimed it, and
//     admitting one would invent ambiguity out of an unrelated branch name.
//   - The RANKING pool (`buildPrMap`) must include uncorroborated claims — see the
//     comment on `buildPrMap`. They are tagged, not silently mixed in.
//
// The tag goes on a COPY. The originals flow into `samePr`/`namePr`/the activity feed,
// and marking a shared object would leak this run's verdict into all of them.
function claimantsByTicket(prs, idFromRef, shippedSet, { includeUncorroborated = false } = {}) {
  const byId = new Map();
  for (const pr of prs || []) {
    const id = idFromRef(pr.headRefName);
    if (!id) continue;
    const corroborated = claimCorroborated(id, { title: pr.title, shippedSet });
    if (!corroborated && !includeUncorroborated) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(corroborated ? pr : { ...pr, uncorroborated: true });
  }
  return byId;
}

function corroboratedByTicket(prs, idFromRef, shippedSet) {
  return claimantsByTicket(prs, idFromRef, shippedSet);
}

// --- BLZ-398: how strongly a PR's TITLE claims to have delivered this ticket ---
// Corroboration (INF-735) is a yes/no gate: does anything beyond the ref name tie this
// PR to the id at all. That is the right question for "may this PR speak"; it is the
// wrong one for "which of two PRs delivered the work", because a follow-up that merely
// MENTIONS the key passes it just as a `KEY-n: …` titled PR does.
//
// The house convention is that a PR delivering a ticket is TITLED for it, in the same
// leading-id-list form `idsFromSubject` already parses. So a title that LEADS with the
// id is a stronger claim than one that mentions it downstream, and that is the whole
// of the ranking below. The key comes from the id rather than a parameter, so a caller
// cannot silently degrade this to the old behaviour by forgetting to pass it.
export function prTitleClaim(pr, id) {
  const key = id.slice(0, id.lastIndexOf("-"));
  return idsFromSubject(pr && pr.title, key).includes(id) ? 2 : 1;
}

// --- rank a repo's PRs into id → best-PR, uncorroborated claims INCLUDED --------
// AN UNCORROBORATED PR IS NEUTERED, NOT DROPPED. This is the same lesson the
// unnumberable-PR block below states in capitals, re-learned here: `decide` reads the
// TOP-RANKED PR and `PR_RANK` puts OPEN above MERGED, so removing a candidate is not a
// subtraction, it is a SUBSTITUTION — the next-ranked PR is promoted.
//
// BLZ-440's first cut dropped uncorroborated claims here, on INF-735's reasoning that
// "an uncorroborated claim is dropped rather than trusted, so a misnamed branch costs a
// missed signal, not a corrupted ticket". That reasoning is FALSE in this direction, and
// review caught it: dropping an uncorroborated OPEN PR deletes BLZ-130's veto and hands
// the ticket to an earlier merged one. Measured on this repo's own test pool,
// `in-review` went to `done` with `resolution: done` and a WRITE-ONCE `pr:` record naming
// the wrong PR, while the open PR carrying the real work was still open — and
// `openPrOnTerminal` was false, so nothing reported it. `pr` is not in EDITABLE_FIELDS;
// there is no route back.
//
// The rule, which satisfies both directions at once:
//
//   AN UNCORROBORATED CLAIM MAY ONLY EVER HOLD A TICKET BACK. IT MAY NEVER ADVANCE ONE.
//
// So it stays in the pool and keeps whatever veto its STATE earns (BLZ-130), and
// `decide` refuses to take either a delivery RECORD or a forward TARGET from it. Note
// that neutering as the unnumberable case does it (`number: null`, record suppressed)
// is necessary but NOT sufficient here: that PR genuinely belongs to the ticket and
// merely has a broken number, so its state signal is still real. An uncorroborated PR
// does not belong to the ticket at all, so its MERGED state must not drive anything
// either — otherwise PR #140 still takes BLZ-408 to `done`, just without a `pr:` line,
// which is no better.
//
// This is ADR-0023's own bias made explicit: uncorroborated evidence pushes only
// toward NOT-shipped.
//
// BLZ-398 changed the EQUAL-RANK tie-break from "higher PR number" to "stronger title
// claim, then LOWER number". That is safe to change and it is worth stating why,
// because it looks like it should move tickets: `decide` derives the target status
// from `pr.state` ALONE, and PR_RANK is one-to-one with the state, so every candidate
// at equal rank yields the identical status. The tie-break therefore decides only
// which PR's `headRefName`/`url` land in the delivery RECORD — never where a ticket
// goes. `pr.number > cur.number` selected the LATEST merge among equals, which the
// shipped comments named as a hazard while the protection built on it covered only
// tickets that already had a record.
/** Is `pr` a better answer than `best` for this id? ONE comparator, used by
 *  `buildPrMap` within a repo and by `gatherProject` across repos — they had drifted,
 *  and the cross-repo half was deciding by `codeRepos` scan order.
 *
 *  Order: RANK, then CORROBORATED, then TITLE CLAIM, then RECORDABLE, then lower number.
 *
 *  CORROBORATED sits directly under RANK and above everything else, and the position is
 *  load-bearing in BOTH directions (BLZ-440 round 2). Under it, because rank is the ONLY
 *  thing an uncorroborated claim is allowed to win on — that is its BLZ-130 veto, the
 *  whole reason it is still in the pool. Above the claim tier, because within one rank
 *  there is no reason to prefer it: an uncorroborated PR always scores `prTitleClaim` 1
 *  (a title that CLAIMED the id would have corroborated it), so without this tier it
 *  ties with a shippedSet-corroborated weak-titled peer and the tie falls through to
 *  LOWER NUMBER — handing the selection to the claim that cannot record, and suppressing
 *  a delivery record that was sitting right there. That is the unnumberable-PR defect
 *  the recordable tier exists for, re-entered on the corroboration axis.
 *
 *  The claim tier sits ABOVE recordable, and review found out why the hard way. With
 *  recordable first, a *weak* claimant that happens to carry a number beat a *strong*
 *  one the forge could not number — so a PR titled `chore: tidy the runbook after
 *  INF-645` was recorded as having delivered the epic while `INF-645: close the
 *  Tier-1 alert gaps` sat beside it, and `ambiguousDeliverers` could not see it
 *  (it filters unrecordable PRs out first, so only one merged candidate remained and
 *  nothing was ambiguous). That is the INF-645 failure this whole ticket exists to
 *  stop, re-entered through the tier meant to protect the record.
 *
 *  With the claim first, the strong claimant wins and — being unrecordable — writes
 *  NOTHING. Blank and true, instead of filled and false, which is this record's
 *  standing doctrine. Recordable still breaks a tie BETWEEN EQUAL CLAIMS, which is
 *  the case it was added for: `null < 10` is true, so without it an unusable PR won
 *  an equal-claim tie-break and suppressed a knowable record.
 *
 *  Rank comes from `state` alone, so none of this can move a ticket — it decides only
 *  which PR the delivery record is taken from. */
export function betterPr(pr, best, id) {
  if (!best) return true;
  const rank = (x) => PR_RANK[x.state] || 0;
  const recordable = (x) => (recordablePr(x) ? 1 : 0);
  const corroborated = (x) => (x.uncorroborated ? 0 : 1);
  if (rank(pr) !== rank(best)) return rank(pr) > rank(best);
  if (corroborated(pr) !== corroborated(best)) return corroborated(pr) > corroborated(best);
  const claim = [prTitleClaim(pr, id), prTitleClaim(best, id)];
  if (claim[0] !== claim[1]) return claim[0] > claim[1];
  if (recordable(pr) !== recordable(best)) return recordable(pr) > recordable(best);
  return pr.number < best.number;
}

export function buildPrMap(prs, idFromRef, shippedSet) {
  const prMap = new Map();
  for (const [id, candidates] of claimantsByTicket(prs, idFromRef, shippedSet,
    { includeUncorroborated: true })) {
    let best = null;
    for (const pr of candidates) {
      if (betterPr(pr, best, id)) best = pr;
    }
    if (best) prMap.set(id, best);
  }
  return prMap;
}

// --- BLZ-398: when git cannot say WHICH merge delivered the ticket ------------
// A record-less `done` ticket carrying two MERGED PRs acquired the LATEST one and
// write-once made that permanent — the board recording a follow-up docs PR as what
// delivered an epic, with no route back (`pr` is not in EDITABLE_FIELDS, so `blaze
// edit` cannot repair it either).
//
// The tie-break above answers this whenever one merged PR claims the ticket more
// strongly than the others. When it does NOT — two PRs both titled `KEY-n: …`, which
// is exactly the reproduced INF-645 case of #10 (the real work) and #40 (a docs
// follow-up) — there is nothing in git that says which one delivered it, and the
// honest answer is to say so rather than to pick.
//
// Rule 7 of the review bar is why this is a refusal and not a heuristic. This record
// has already been wrong in FOUR directions (overwrite-anything, write-nothing,
// overwrite-with-the-latest-merge, per-field), and "prefer the lowest number when both
// are MERGED" is a guess at "the deliverer", not a fact — a ticket delivered by a
// rewrite after an abandoned first attempt would be recorded backwards by it. What is
// asymmetric here is the COST, and it is what decides the direction: a blank `pr`
// understates and is TRUE, and a blank stays fillable because write-once locks in a
// written value and not an absent one; a `pr` naming the wrong PR overstates, is
// FALSE, and is permanent. So an ambiguous deliverer writes nothing and reports.
//
// Scoped to MERGED deliberately. The record is only ever locked in from a merged PR:
// the terminal path nulls a non-merged one outright, and a ticket moving to `done`
// does so because its winning PR is MERGED. An open or closed PR's record is live
// state that a later run corrects.
// Returns id -> the numbers of the merged PRs that tied, so the report can NAME them.
// A finding that says "this is ambiguous" without saying between what is not
// actionable, and the whole point of refusing to write is to hand a person the choice.
/** The tied top-claim merged PRs for one id, or null when a deliverer is knowable.
 *
 *  DETECTION COUNTS EVERY MERGED CLAIMANT; SELECTION STILL ONLY WRITES A RECORDABLE ONE.
 *  Keeping those two questions apart is the whole of round 6's finding. The previous cut
 *  filtered unrecordable PRs out BEFORE testing the tie, on the reasoning that one which
 *  can never be written is not an answer to "which PR delivered this". It is not an
 *  answer — but it is still a RIVAL, and dropping it turned a genuine two-claimant tie
 *  into an apparent single deliverer: two PRs both titled for the ticket, one of them
 *  unnumberable, and the board permanently recorded the other with no finding at all.
 *  One unusable number flipped it from "refuses to name a deliverer" to "names one
 *  forever". `pr` is not in EDITABLE_FIELDS, so there is no route back.
 *
 *  That is the same shape as rounds 4 and 5 — a rule that reads the candidate set
 *  disagreeing with the rule that ranks it — which is why detection now shares ONE
 *  entry point across repos too. */
function tiedDeliverers(candidates, id) {
  // Unrecordable rivals are deliberately KEPT. They cannot be written, but they can still
  // be the deliverer, and dropping them turned a genuine tie into an apparent lone
  // deliverer (round 6's F1). Recordability gates the WRITE, never the vote.
  const merged = candidates.filter((pr) => pr.state === "MERGED");
  if (merged.length < 2) return null;
  const top = Math.max(...merged.map((pr) => prTitleClaim(pr, id)));
  const tied = merged.filter((pr) => prTitleClaim(pr, id) === top);
  if (tied.length < 2) return null;
  // Carry the url, not just the number. PR numbers are per-repository, so a cross-repo
  // tie can be "#10 and #10" — and a finding naming one number is the exact wording this
  // ticket condemns. An unrecordable rival has no number at all, so the url is the only
  // thing that can name it.
  // Missing urls sort LAST by rank, never by their string form. `String(a.url)` compared
  // "null" against "" against "undefined", so the order of two number-less rivals depended
  // on HOW the url was missing rather than on anything true — which is also why calling
  // the url-normalisation an equivalent mutant was wrong: this was its fourth consumer.
  const key = (r) => (typeof r.url === "string" && r.url.trim() ? r.url : null);
  return tied.map((pr) => ({ number: pr.number, url: pr.url, headRefName: pr.headRefName })).sort(
    (a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) ||
      (key(a) === null) - (key(b) === null) ||
      String(key(a) ?? "").localeCompare(String(key(b) ?? "")));
}

export function ambiguousDeliverers(prs, idFromRef, shippedSet) {
  const out = new Map();
  for (const [id, candidates] of corroboratedByTicket(prs, idFromRef, shippedSet)) {
    const tied = tiedDeliverers(candidates, id);
    if (tied) out.set(id, tied);
  }
  return out;
}

// --- rank a repo's branches into id → first-corroborated-branch (INF-735) -----
// A branch has no title, so its evidence is its own commits — the subjects unique
// to it (`KEY-n: desc`, the house convention `idFromSubject` already parses) — or
// the shipped signal.
//
// When a branch has NO commits of its own, two very different situations look
// identical to `git log <ref> ^<default>` (both empty):
//
//   FRESH  — `git checkout -b KEY-1-fix` and nothing yet. Tip == default tip.
//            Nothing contradicts the name, and this is the ordinary "branched,
//            about to work" signal the branch path exists to catch.
//   STALE  — a fully-merged branch left behind after its PR landed. Tip is BEHIND
//            the default tip. It has nothing outstanding and is never evidence of
//            work in progress.
//
// The tip is the discriminator. Conflating them re-claimed a ticket whose bogus
// PR claim had just been dropped, moving it back to `in-progress` and undoing a
// hand repair — observed live on 2026-08-03.
//
// Uncorroborated refs are skipped WITHOUT reserving the id, so a bogus ref cannot
// squat an id and shadow the ticket's real branch.
export function buildBranchMap(refs, idFromRef, { key, shippedSet, inspect }) {
  const branchMap = new Map();
  for (const ref of refs || []) {
    const id = idFromRef(ref);
    if (!id || branchMap.has(id)) continue;
    const { own = [], sameTipAsDefault = false } = inspect(ref) || {};
    const corroborated = (shippedSet && shippedSet.has(id)) ||
      (own.length > 0
        ? own.some((sub) => idFromSubject(sub, key) === id)
        : sameTipAsDefault);
    if (!corroborated) continue;
    branchMap.set(id, ref);
  }
  return branchMap;
}

// --- the forge, such as it is: `gh` speaks GitHub and nothing else (BLZ-350) ---
// Blaze is GitHub-only. That is a stated non-goal, not an oversight (docs/design.md
// "Non-goals"), and this code does NOT widen it. What it does is stop the narrowing
// from being invisible: on a non-GitHub remote `gh pr list` fails, and the old
// `sh()` turned that failure into `null`, which `JSON.parse(null || "[]")` turned
// into "this repo has no pull requests". Since `decide()` reaches "in-review" only
// through its `pr` branch, the delivery workflow quietly lost a state and reported
// a clean run.
//
// Hosts we can name, we classify BEFORE spending a subprocess on them; hosts we
// cannot, we hand to `gh` and report whatever it says. GitHub Enterprise Server is
// self-hosted under an arbitrary hostname, so "unknown" must stay optimistic —
// guessing "unsupported" for a GHES host would break working boards.
//
// CRITICAL (review regression, caught before merge): classify EVERY remote, not
// just `origin`. `gh` resolves its base repo from ANY GitHub remote it finds, so a
// repo whose only GitHub remote is named `upstream` — or one with `origin` on
// GitLab and `upstream` on GitHub — reads its PRs perfectly today. An origin-only
// check refused those repos a `gh` call and told them, falsely, that they had no
// forge: this ticket's own defect, re-introduced on the remote-name axis. The
// short-circuit is therefore an ALL quantifier — every remote must be unreadable
// before we decline to ask `gh`. One github-or-unknown remote is enough to ask.

/** Hostnames that are definitely a forge `gh` cannot talk to. Deliberately a
 *  short, precise list: a wrong "unsupported" verdict silently disables PR
 *  reading, so anything not listed falls through to `gh` itself. */
const NON_GITHUB_HOST = [
  /(^|\.)gitlab\./, /(^|\.)bitbucket\./, /(^|\.)gitea\./, /(^|\.)forgejo\./,
  /^codeberg\.org$/, /^git\.sr\.ht$/, /(^|\.)dev\.azure\.com$/, /\.visualstudio\.com$/,
  /^git\.launchpad\.net$/, /^gitee\.com$/,
];

/** Pure: a git remote URL → the host it names, or null for a local path remote.
 *  Handles the three shapes git accepts: scheme URLs, scp-style `git@host:path`,
 *  and bare filesystem paths. */
export function remoteHost(url) {
  const u = (url || "").trim();
  if (!u) return null;
  // scheme://[user@]host[:port]/path
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/?#]+)/i.exec(u);
  if (scheme) return scheme[1].toLowerCase();
  if (u.startsWith("file://")) return null;
  // scp-style: [user@]host:path — a colon with no leading slash before it.
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)/.exec(u);
  if (scp) return scp[1].toLowerCase();
  return null; // /abs/path, ../rel/path — a local remote has no host
}

/** Pure: a git remote URL → { host, kind }, where kind is one of
 *  "github"      — `gh` can read it (github.com, a *github* hostname, or $GH_HOST)
 *  "unsupported" — a forge `gh` provably cannot read
 *  "unknown"     — could be GitHub Enterprise Server; let `gh` answer
 *  "none"        — no remote, or a local-path remote: there is no forge at all */
export function classifyRemote(url, { ghHost = process.env.GH_HOST } = {}) {
  const host = remoteHost(url);
  if (!host) return { host: null, kind: "none" };
  if (ghHost && host === String(ghHost).trim().toLowerCase()) return { host, kind: "github" };
  if (NON_GITHUB_HOST.some((re) => re.test(host))) return { host, kind: "unsupported" };
  if (host === "github.com" || host.endsWith(".github.com") || host.includes("github")) {
    return { host, kind: "github" };
  }
  return { host, kind: "unknown" };
}

const UNREACHABLE = 'PR state could not be read, so "in-review" is unreachable for this repo '
  + "(branch and merged-commit signals are unaffected).";

/** Pure: `git config --get-regexp` output → the remote URLs it lists, in order.
 *  Lines look like `remote.origin.url https://github.com/o/r.git`. */
export function parseRemoteUrls(configOutput) {
  return (configOutput || "").split("\n")
    .map((line) => /^remote\.(?:.+)\.url\s+(.+)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter(Boolean);
}

/** Read one repo's pull requests, reporting failure AS failure.
 *  Returns `{ prs, forgeErrors }` — an empty `prs` with an empty `forgeErrors`
 *  means "this repo genuinely has no pull requests", and nothing else does.
 *  `run` is injectable so the classification can be tested without `gh` present. */
export function gatherPrs(repoPath, { run = shResult, ghHost = process.env.GH_HOST } = {}) {
  // EVERY remote, not just origin — see the note above the host table.
  const cfg = run("git", ["-C", repoPath, "config", "--get-regexp", "^remote\\..*\\.url"]);
  const urls = cfg.ok ? parseRemoteUrls(cfg.stdout) : [];
  const seen = urls.map((u) => ({ url: u, ...classifyRemote(u, { ghHost }) }));
  // "unknown" could be a GHES install under any hostname, so it counts as askable.
  const askable = seen.some((r) => r.kind === "github" || r.kind === "unknown");
  const hosted = seen.filter((r) => r.host);

  if (!askable && !hosted.length) {
    return { prs: [], forgeErrors: [{
      repo: repoPath, remotes: urls, host: null, reason: "no-remote",
      message: `${repoPath} has no git remote on a forge (${urls.length ? "its remotes are local paths" : "it has no remotes configured"}), `
        + "and Blaze reads pull requests through the GitHub CLI (`gh`). " + UNREACHABLE,
    }] };
  }
  if (!askable) {
    const hosts = [...new Set(hosted.map((r) => r.host))];
    return { prs: [], forgeErrors: [{
      repo: repoPath, remotes: urls, host: hosts[0], hosts, reason: "unsupported-forge",
      message: `${repoPath} has git remotes on ${hosts.join(", ")} and nowhere else, but Blaze reads `
        + "pull requests through the GitHub CLI (`gh`), which supports GitHub.com and GitHub "
        + `Enterprise Server only. ${UNREACHABLE} Blaze is GitHub-only by design — see `
        + 'docs/design.md "Non-goals".',
    }] };
  }

  const askedHost = (seen.find((r) => r.kind === "github") || seen.find((r) => r.kind === "unknown")).host;
  const res = run("gh", ["pr", "list", "--state", "all", "--limit", "1000",
    "--json", "number,url,headRefName,state,title"], { cwd: repoPath });
  if (!res.ok) {
    const detail = (res.stderr || "").split("\n").filter(Boolean)[0] || `exit ${res.status}`;
    return { prs: [], forgeErrors: [{
      repo: repoPath, remotes: urls, host: askedHost, reason: "gh-failed", status: res.status, detail,
      message: `\`gh pr list\` failed in ${repoPath} (remote host: ${askedHost || "unknown"}): ${detail}. `
        + `${UNREACHABLE} A failed forge call is not an empty pull-request list.`,
    }] };
  }
  try {
    const parsed = JSON.parse(res.stdout || "[]");
    const prs = (Array.isArray(parsed) ? parsed.map(sanitisePr) : []).filter(Boolean);
    // A PR the forge could not number still RANKS (so an open one keeps its veto) but
    // can never be recorded. Say so: a repo whose PRs are all unusable must not read as
    // a repo with no pull requests — that is the laundering BLZ-350 exists to stop, and
    // it is just as wrong arriving through a SUCCESSFUL call as through a failed one.
    // `recordablePr`, the same predicate the deciders use. This counter read
    // `pr.number === null` while `decide` and `betterPr` had moved on to "number AND url",
    // so a PR with a good number and no url was silently withheld from the record and
    // reported by nothing — the drift shape this branch keeps producing, arriving one
    // layer over: unify the predicate, leave the reporter behind.
    const unusable = prs.filter((pr) => !recordablePr(pr)).length;
    return { prs, forgeErrors: unusable ? [{
      // `severity: "warning"`, and it is the whole point of the field. The forge was read
      // PERFECTLY here — what is wrong is one field inside a successful response. Every
      // other entry in this list means Blaze could not read the forge at all, and the
      // consumers say so in those words. `newFindingEvents` beside this makes the same
      // argument for the same reason: calling a correct run an engine error is the
      // over-statement this lane exists to stop, and it is no better pointed at the forge.
      severity: "warning",
      repo: repoPath, remotes: urls, host: askedHost, reason: "gh-unusable-pr", detail: String(unusable),
      message: `${unusable} pull request(s) in ${repoPath} cannot supply a delivery record — ` +
        `Blaze needs both a usable number and a url — so they can rank but can never be ` +
        `recorded as having delivered a ticket. The forge itself was read fine — this is ` +
        `one field inside a successful response, so PR state and "in-review" are unaffected.`,
    }] : [] };
  } catch (e) {
    return { prs: [], forgeErrors: [{
      repo: repoPath, remotes: urls, host: askedHost, reason: "gh-unparsable", detail: String(e.message || e),
      message: `\`gh pr list\` returned output Blaze could not parse as JSON in ${repoPath}. ${UNREACHABLE}`,
    }] };
  }
}

/** A PR number Blaze can put in a record, or `null`. STRICT: this is a whitelist, not a
 *  parse. `Number.parseInt` is prefix-parsing wearing validation's clothes — it turns
 *  `"12abc"` into 12, `"1e3"` into 1, `"007"` into 7 and `[5]` into 5, so a malformed
 *  payload produced `pr: #12 — …/pull/999`: a permanent record naming one PR beside
 *  another's url. Plausible-looking is worse than obviously garbage, because nobody
 *  checks it. */
function prNumber(raw) {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

// --- the forge's JSON is UNTRUSTED input, and it was trusted verbatim ---------
// `gh pr list` output is parsed and its fields flow into three places that render or
// persist them: the CLI's stderr warnings, the activity feed, and a ticket's
// `branch`/`pr` frontmatter. `serializeTicket` quotes and escapes, so the file on disk
// was never at risk — but a terminal is not an escaping context.
//
// AN UNUSABLE PR IS NEUTERED, NOT DROPPED, AND THAT DISTINCTION IS THE WHOLE POINT.
// The first cut dropped it, on the reasoning that "a dropped claim costs a missed
// signal, never a corrupted ticket". That reasoning is FALSE HERE, and review caught it:
// `decide` reads the TOP-RANKED PR and `PR_RANK` puts OPEN above MERGED, so removing a
// candidate is not a subtraction, it is a SUBSTITUTION — the next-ranked PR is promoted.
// Dropping an unnumberable OPEN PR therefore deleted BLZ-130's veto and handed the
// ticket to an earlier merged PR: measured end to end, `in-progress` went to `done`
// with `resolution: done` and the early docs PR recorded as the deliverer, while the
// real work was still open, and with no finding and no forge error to say so. That is
// the exact failure this whole lane exists to stop, reintroduced by its own fix.
//
// So the PR stays in the ranking, keeping whatever veto its STATE earns, and only loses
// the ability to supply a RECORD — `number: null` is the marker, and `decide` clamps
// both fields on it, because the record is one unit. The condition is reported through
// `forgeErrors` rather than swallowed: a repo whose PRs are all unusable must not look
// identical to a repo with no pull requests, which is the laundering BLZ-350 fixed.
function clean(v) { return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "") : v; }

// BLZ-403 (review): `clean` above is hoisted to module scope so a fourth
// operator-facing text site can reuse it. `sanitisePr` was its only caller; the
// terminal-record-unverifiable finding below reads a TICKET FILE's own `pr:` line
// rather than a `gh` payload, and interpolated it into stderr/the feed/the preview
// JSON verbatim, unsanitised. The three EXISTING renderers (stderr, the activity
// feed, `serializeTicket`'s escaping) all sit downstream of a `gh` payload that
// already passed through this function; the ticket file is a fourth source that fed
// none of them until now, and gets the SAME treatment rather than a fourth renderer.
function sanitisePr(pr) {
  if (!pr || typeof pr !== "object") return null;
  // A url that arrives absent, or that `clean` empties (the control-char-only case this
  // sanitiser exists for), becomes `null` — the same marker `number` uses. Leaving it as
  // `undefined` or `""` is what let `decide` persist the literal string "undefined" into
  // a ticket's frontmatter, permanently, and made "is this recordable" two questions.
  const url = clean(pr.url);
  return { ...pr, number: prNumber(pr.number), url: url || null,
           title: clean(pr.title), headRefName: clean(pr.headRefName), state: clean(pr.state) };
}

// --- gather one repo's PR + branch signal, keyed by a project's idFromRef ------
function gatherRepo(repoPath, idFromRef, key, { fetch }) {
  const empty = { prMap: new Map(), branchMap: new Map(), shippedSet: new Set(),
                  forgeErrors: [], gitErrors: [], candidates: new Map() };
  if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) return empty;
  // BLZ-484: the git half of `forgeErrors`. Same shape, same journey, same rule — the
  // condition travels with the result instead of being laundered into an empty signal.
  const gitErrors = [];
  // A fetch whose result was DISCARDED ENTIRELY: `sh(...)` with no assignment. `--fetch`
  // exists to make the branch and merged-commit signals current, so a failed fetch means
  // the run reconciled against a tree it believed was fresh and was not. A warning rather
  // than an error: the run is still correct about what it CAN see (an unfetched remote is
  // the ordinary state of every run without `--fetch`), it is just not as current as the
  // flag promised.
  //
  // BLZ-494: THE SEVERITY IS LOAD-BEARING AND WAS UNPINNED — mutating it to `error` left
  // the whole suite green. Re-measured at 1b00f3a by instrumenting every `git` invocation
  // across `tests/reconcile*.test.mjs` (371 tests): `fetch --prune --quiet` runs 9 times
  // and exits 128 on FOUR of them — `blz404-oracle-applied`, `blz404-oracle-preview`, and
  // twice in `blz421-oracle-equiv`, each a fixture whose `origin` does not exist. At
  // `error` those four land in `unreadableProbes`, print `GIT UNREADABLE` and `FAILED`,
  // and exit 1. Now pinned by "the condition travels as severity: warning" and "the CLI
  // says GIT DEGRADED, exits 0, and still reports the move it found" in
  // tests/reconcile-git-probe-unreadable.test.mjs.
  if (fetch) {
    gitProbe(gitErrors, repoPath, ["fetch", "--prune", "--quiet"], {
      timeout: 30000, severity: "warning",
      what: "`--fetch` asked for a current view of the remote and did not get one.",
      consequence: "Branch and merged-commit signals below are as stale as the last successful fetch.",
    });
  }

  // Default-branch commit signal: a <KEY>-<n>: commit reachable from the code
  // repo's default-branch HEAD means that ticket shipped (used for bundled
  // epic-children that have no branch/PR of their own). Computed FIRST because
  // buildPrMap corroborates against it (INF-735).
  const shippedSet = new Set();
  const probesBefore = gitErrors.length;
  const { ref, resolved } = defaultBranchRef(repoPath, gitErrors);
  // BLZ-484: nothing resolved, so `ref` is a GUESS. Said once, here, rather than left to
  // surface as a mystified `git log` failure below — and the dependent probes are told the
  // ref may not exist (`exitIsAnAnswer: !resolved`) so one condition produces one line.
  //
  // GATED ON HAVING BEEN ABLE TO LOOK, and that gate is this ticket in miniature. The
  // message below asserts that none of five refs EXISTS. A run whose `rev-parse` calls
  // could not fork has established nothing of the kind, and saying it anyway would be the
  // same overstatement one layer in from the one being fixed — a report that could not
  // look, saying what a report that looked and found nothing says. When the probes
  // themselves failed to run they have already said so, by name, and this stays quiet.
  if (!resolved && gitErrors.length === probesBefore) {
    gitErrors.push({
      repo: repoPath, reason: "no-default-branch", severity: "warning",
      command: "git rev-parse --verify --quiet origin/HEAD|origin/main|origin/master|main|master",
      status: null, detail: "no candidate resolved",
      message: `no default branch could be resolved in ${repoPath} — none of origin/HEAD, ` +
        `origin/main, origin/master, main or master exists there. Blaze reads that branch's ` +
        `commit log to learn which tickets shipped, so the merged-commit signal for this repo ` +
        `is UNAVAILABLE, not empty: a bundled child whose only evidence is a \`KEY-n:\` commit ` +
        `will not move, and this run's silence about it is not evidence that it did not ship.`,
    });
  }
  // BLZ-131: read whole messages, not subjects. `%x00%B` prefixes each commit with
  // a NUL, which is the one byte a commit message cannot contain — so splitting on
  // it recovers exact commit boundaries, and boundaries are what make line 1 (the
  // subject, unbulleted) distinguishable from a body line (bullet required).
  // BLZ-484: THE PROBE THE REVIEW DEMONSTRATED THE DEFECT WITH. `|| ""` turned every kind
  // of failure into "this repo has shipped nothing", and `decide` reads `shipped` to move a
  // bundled child to `done` — so a `git` that could not fork produced a board that looked
  // in sync. A non-zero exit is NOT an answer here: "I could not enumerate the commits on
  // this ref" is never "this ref has no commits". Measured across the 330 reconcile tests,
  // this probe fails zero times today, so nothing in the suite relied on the laundering.
  // The one expected failure — `ref` is the "main" guess because nothing resolved — is
  // already reported above, so it is not reported twice.
  const log = gitProbe(gitErrors, repoPath, ["log", ref, "--format=%x00%B"], {
    exitIsAnAnswer: !resolved,
    what: "Blaze reads the default branch's whole commit log to learn which tickets shipped.",
    consequence: "That signal is UNKNOWN for this repo, not empty — a ticket that shipped will not move, and this run's silence is not evidence.",
  }) || "";
  for (const record of log.split("\u0000")) {
    if (!record.trim()) continue;
    for (const id of idsFromCommitMessage(record, key)) shippedSet.add(id);
  }

  // BLZ-350: `gh` is the only forge call in the tree, and it is the one call whose
  // failure must NOT be laundered into an empty result — see gatherPrs.
  const { prs, forgeErrors } = gatherPrs(repoPath);
  const prMap = buildPrMap(prs, idFromRef, shippedSet);
  // BLZ-398: the corroborated candidates themselves travel upward, not a per-repo
  // verdict. Ambiguity is a property of ALL of a project's PRs for an id, so deciding it
  // per repo and merging the answers cannot be right — `gatherProject` unions these and
  // asks once. That also deletes the cross-repo special case that had drifted twice.
  const candidates = corroboratedByTicket(prs, idFromRef, shippedSet);

  // BLZ-484: same rule. "I could not list the refs" is never "this repo has no branches",
  // and an empty branch set is what makes every branch-derived signal disappear. Zero
  // failures across the 330 reconcile tests.
  const listed = (gitProbe(gitErrors, repoPath, ["for-each-ref", "--format=%(refname:short)",
    "refs/heads", "refs/remotes/origin"], {
    what: "Blaze lists every local and origin ref to find the branches carrying ticket ids.",
    consequence: "The branch set is UNKNOWN for this repo, not empty — no branch signal reaches `decide`, and the absence of one is not evidence.",
  }) || "")
    .split("\n").map((r) => r.trim()).filter(Boolean);
  // BLZ-492: A NAME AND A QUESTION ARE NOT THE SAME STRING.
  //
  // `origin/` is stripped because the stripped form is the BRANCH'S NAME: it is what
  // `decide` writes into a ticket's `branch:` field, and it is what makes a branch that
  // exists both locally and on the remote one branch rather than two. That is right, and it
  // is unchanged. What was wrong is that the same stripped string was then handed to `git`
  // as a REVISION, and no local ref answers to it for a branch that exists only under
  // `refs/remotes/origin`: `git log INF-1-work ^origin/main` and `git rev-parse INF-1-work`
  // both exit 128, `ambiguous argument`. Measured across the reconcile suite at 1b00f3a: 52
  // occurrences each, and `buildBranchMap` read the resulting `own: []` /
  // `sameTipAsDefault: false` as evidence about the BRANCH rather than as the failure to
  // ask that it was.
  //
  // So the two are kept apart. `refs` carries the names, in the order `for-each-ref`
  // produced them; `askable` carries, per name, the ref `git` will actually answer about.
  //
  // ROUND 2 — AND THE FIRST VERSION OF THIS PARAGRAPH WAS WRONG IN A WAY THAT COST A
  // BRANCH ITS CORROBORATION. It said a branch present in both namespaces is asked about
  // through its LOCAL ref "because `for-each-ref` sorts `refs/heads/…` before
  // `refs/remotes/…`", and took the FIRST raw ref to claim each stripped name. The sort is
  // on the FULL refname, so `refs/heads/origin/task/…` sorts before `refs/heads/task/…` —
  // before ANY local head whose name starts after `o`. A stale local branch literally
  // called `origin/task/INF-1-work` therefore captured the slot for `task/INF-1-work`, and
  // the real branch was probed through the wrong ref and silently stopped corroborating:
  // `[["INF-1","in-progress"]]` at 1b00f3a, `[]` with `ok: true` and `gitErrors: []` under
  // round 1. Precisely the class of failure this file exists to end.
  //
  // The rule is therefore ordering-independent: AN EXACT LOCAL HEAD OUTRANKS A STRIPPED
  // COLLISION for the same name. `raw === name` identifies one, because a ref under
  // `refs/remotes/origin` always renders with the prefix.
  //
  // RESIDUAL, STATED RATHER THAN IMPLIED FIXED: a local head named `origin/<x>` sitting
  // beside a remote-tracking `origin/<x>` renders ONE string for two different refs, and
  // `%(refname:short)` cannot separate them at all. That needs the full namespace split
  // (`%(refname)`), which is BLZ-506's job and not this ticket's.
  //
  // MEASURED BEFORE IT SHIPPED (BLZ-353), because this changes WHICH branches corroborate.
  // Every `buildBranchMap` result across the reconcile suite, at 1b00f3a and at round 2:
  // 344 -> 356 corroborated (id -> branch) entries, and on the PRE-EXISTING suite exactly
  // ONE branch changes — `INF-574 -> INF-574-blaze-config-and-chart`, in the two fixtures
  // that really fetch a remote. The other 25 remote-only branches in that fixture were
  // already corroborated by `shippedSet`, which is exactly why the defect stayed invisible:
  // the one branch whose work had not landed on the default branch is the one the silence
  // cost. The ref list for that repo also goes 33 -> 32 — `refs/heads/main` and
  // `refs/remotes/origin/main` both stripped to `main`, and the old list carried it twice.
  //
  // WHAT THAT MEASUREMENT COULD NOT SEE, said here because round 1 let an ARGUMENT stand
  // where BLZ-353 asks for a measurement. Round 1 read the delta as one-directional "by
  // construction", on the ground that the old code could only ever read `own: []` and
  // `sameTipAsDefault: false`. That is true of a REMOTE-ONLY branch and false in general:
  // where a real local `<x>` existed the old code probed it correctly, and round 1
  // redirected that probe. ZERO of the 259 `buildBranchMap` invocations in the suite at
  // 1b00f3a involve a branch named `origin/*` — no fixture created one — so the suite-wide
  // figure was structurally incapable of showing the regression, and a suite-wide figure is
  // not a proof about shapes the suite does not contain. The shape is measured directly
  // instead, on the construction below: 1b00f3a moves INF-1, round 1 moves nothing, round 2
  // moves INF-1 again. Pinned by the "BLZ-492 round 2" suite.
  const refs = [];
  const askable = new Map();
  for (const raw of listed) {
    const name = raw.replace(/^origin\//, "");
    if (!name || name === "HEAD") continue;
    if (!askable.has(name)) { askable.set(name, raw); refs.push(name); }
    // ROUND 2 (review). `raw === name` means nothing was stripped, and a ref under
    // `refs/remotes/origin` always renders WITH the prefix — so this raw ref is an exact
    // local head, and it outranks any stripped ref that claimed the same slot before it.
    else if (raw === name) askable.set(name, raw);
  }

  // What the branch itself says: the subjects unique to it (not already on the
  // default branch), plus whether its tip IS the default tip — the fresh-vs-stale
  // discriminator, since both have zero unique subjects.
  const defaultTip = gitProbe(gitErrors, repoPath, ["rev-parse", ref], {
    exitIsAnAnswer: !resolved,
    what: "Blaze resolves the default branch's tip to tell a fresh branch from a stale one.",
    consequence: "Every branch is treated as NOT sharing the default tip, which is a guess, not a reading.",
  });
  // BLZ-492 (was BLZ-484's "stated rather than fixed"): both probes ask about `askable`,
  // the ref `for-each-ref` actually listed, not the display name derived from it. The 52
  // laundered exits above are gone — re-measured at the fix: 0 of each across the reconcile
  // suite — and `buildBranchMap` now reads a remote-only branch's own commits.
  //
  // `exitIsAnAnswer: true` STAYS, and it is not vestigial. `git log <branch> ^<ref>` names
  // `ref`, so it is a DEPENDENT probe on the default-branch resolution, exactly like
  // `defaultTip` and the `%x00%B` walk above which are told `exitIsAnAnswer: !resolved` for
  // that reason. When nothing resolved, `ref` is the guess "main", no such ref exists, and
  // every branch on the repo fails this probe for the ONE condition `no-default-branch` has
  // already reported by name — one condition, one line. Without the opt-in a repo whose
  // default branch is called `trunk` raises a `git-failed` ERROR per branch and exits 1;
  // pinned by "an unresolved default branch is ONE warning, not one warning plus a
  // git-failed per branch".
  //
  // REACHABILITY, STATED: the opt-in on the `rev-parse` half is a different case. It only
  // runs when `defaultTip` resolved, and it is asked about a ref `for-each-ref` listed in
  // the same run, so no construction in this suite makes it fire; mutating that one alone
  // is not killable by any test here. It is kept because the listing and the probe are two
  // separate `git` invocations and a ref can be pruned between them — a race no test can
  // stage deterministically. Said plainly rather than left to look pinned.
  //
  // `askable.get(name) || name` falls back to the name itself for a ref that was never
  // listed. `buildBranchMap` only ever passes names from `refs`, so that fallback is not
  // reached today.
  const inspect = (branchRef) => {
    const rev = askable.get(branchRef) || branchRef;
    return {
      own: (gitProbe(gitErrors, repoPath, ["log", rev, `^${ref}`, "--format=%s"],
        { exitIsAnAnswer: true }) || "")
        .split("\n").filter(Boolean),
      sameTipAsDefault: Boolean(defaultTip) &&
        gitProbe(gitErrors, repoPath, ["rev-parse", rev], { exitIsAnAnswer: true }) === defaultTip,
    };
  };
  const branchMap = buildBranchMap(refs, idFromRef, { key, shippedSet, inspect });

  return { prMap, branchMap, shippedSet, forgeErrors, gitErrors, candidates };
}

/** Can this PR supply a delivery record? BOTH halves or neither — the record is
 *  `#<number> — <url>` and half of it is not a record, it is a defect that outlives the
 *  run. Review found `pr: #10 — undefined` written permanently from a payload with a
 *  usable number and no url; `pr` is not in EDITABLE_FIELDS, so there is no route back. */
export function recordablePr(pr) {
  // `.trim()`, because `clean()` strips only control characters: a url of "\u0001 \u0002"
  // sanitises to " ", which is non-empty and would persist as `pr: #10 —  ` forever. The
  // same hole this predicate was written to close, one character wider.
  return Boolean(pr) && pr.number !== null && pr.number !== undefined &&
    typeof pr.url === "string" && pr.url.trim().length > 0;
}

/** Name a pull request with whatever identifier actually exists.
 *
 *  Every field here can be missing at once. `sanitisePr` sets `number` to null when the
 *  forge did not supply a usable one, and `clean()` reduces a control-char-only `url` to
 *  the empty string — the untrusted-GHES case that sanitiser exists for. The previous cut
 *  made `url` the primary identifier and produced "the pull request at  carrying its key
 *  is still OPEN": a report naming no pull request at all, and "at undefined" when the
 *  field was absent. `headRefName` was in the payload and unused; it is the last resort. */
function namePr(pr) {
  const bits = [];
  if (pr.number !== null && pr.number !== undefined) bits.push(`#${pr.number}`);
  if (pr.url) bits.push(pr.url);
  if (!bits.length && pr.headRefName) bits.push(`branch ${pr.headRefName}`);
  return bits.length ? `the pull request ${bits.join(" — ")}` : "an unidentifiable pull request";
}

/** Two PR payloads are the same pull request. `url` is unique across repositories;
 *  `number` alone is not, and two different repos legitimately share PR numbers. */
function samePr(a, b) {
  // If EITHER side carries a url, identity is decided by url alone. Falling back to
  // `number` when only one has one was a regression: two different repos legitimately
  // both have a #10, so a payload missing its url made them the same PR, the ambiguity
  // went undetected, and the record was settled by `codeRepos` scan order — the exact
  // thing the caller's comment calls "not evidence". Worse, `sanitisePr` strips control
  // characters from `url`, so a control-char-only url from the untrusted GHES payload
  // that sanitiser exists for becomes "" and lands in the same hole. An identity
  // decision must not turn on the PRESENCE of a forge-supplied field.
  if (a.url || b.url) return Boolean(a.url) && a.url === b.url;
  return a.number === b.number;
}

/** BLZ-403: the url half of a terminal ticket's FROZEN `pr: "#N — url"` record, or
 *  `null` when there is none to parse. `decide`/the write loop always write that exact
 *  shape (see `prVal` above), and `url` is the one identifier `samePr` already treats as
 *  unique across repositories — so this is what lets the residual finding ask "is the
 *  record we already hold even one of the tied candidates", the same question `samePr`
 *  answers for two live PR payloads, asked instead of a frozen string and a live one.
 *
 *  KNOWN BLIND SPOT (review): `\S+` cannot match a url containing an embedded space
 *  (e.g. `"u40 x"`) — `\s*$` then has no way to consume the remainder, the whole regex
 *  fails to match, and this returns `null`. `recordOutsideCandidates` below reads that
 *  as "nothing to check" and silently falls back to `outside=false`. That failure mode
 *  is deliberately one-directional: a `null` here can only suppress the per-ticket
 *  "not even among the tied candidates" finding (the ticket still lands in the
 *  aggregate, via `unverifiableRecords`, so nothing is dropped) — it can never
 *  FABRICATE that accusation against a record this function failed to parse. */
function recordedPrUrl(pr) {
  const m = /—\s*(\S+)\s*$/.exec(String(pr || ""));
  return m ? m[1] : null;
}

/** BLZ-403 (review): does a live candidate's url match the FROZEN record's url? Both
 *  sides are routed through `samePr` — the actual identity notion this file already
 *  has, rather than a bespoke `===` this docstring merely claimed matched it. Before
 *  this fix the record side was trimmed of trailing whitespace by `recordedPrUrl`'s own
 *  regex (`\s*$` absorbs it) while the live side was not (`sanitisePr`'s `clean()`
 *  strips control characters, never whitespace), so a forge url with trailing
 *  whitespace survived into both the record and the live candidate and the two sides
 *  disagreed — the record was falsely reported as "not even among the tied
 *  candidates" when it WAS one of them. Trimming both sides here, once, before the
 *  comparison, is what makes them agree again. */
function recordMatchesCandidate(recordedUrl, ref) {
  const liveUrl = typeof ref.url === "string" ? ref.url.trim() : ref.url;
  return samePr({ url: recordedUrl }, { url: liveUrl });
}

// --- aggregate the most-advanced signal across all of a project's repos -------
// Tracks which configured repos were actually READABLE (INF-763). A path that
// isn't a git repo used to be skipped in silence, so a board whose repos all
// failed to resolve reported success having scanned nothing at all.
//
// BLZ-433: the wording INF-763 quoted here — "already in sync — nothing to do." — is
// NOT what the product says any more. BLZ-404 round 5 deleted that claim because it
// asserted more than reconcile knows (see the CLI tail: reconcile knows whether THIS
// pass found a code-bound change, and nothing about the state of the git tree). Today
// a clean pass prints "no code-bound change found — nothing to do." and this case
// prints "FAILED — none of the N configured codeRepo(s) could be read, so NOTHING was
// scanned." on stderr and exits 1. The DEFECT this counter records is unchanged; only
// the sentence it used to be reported through has gone.
function gatherProject(project, { fetch }) {
  const prMap = new Map(), branchMap = new Map(), shippedSet = new Set();
  const missingRepos = [], forgeErrors = [], gitErrors = [];
  const allCandidates = new Map();
  let scannedRepos = 0;
  for (const repo of project.codeRepoPaths) {
    if (!existsSync(repo) || !existsSync(join(repo, ".git"))) { missingRepos.push(repo); continue; }
    scannedRepos += 1;
    const r = gatherRepo(repo, project.idFromRef, project.key, { fetch });
    // The SAME comparator as within a repo. This used to be rank alone, so across repos
    // an unusable PR still won and the record was decided by which path came first in
    // `codeRepos` — scan order, which is not evidence.
    for (const [id, pr] of r.prMap) {
      if (betterPr(pr, prMap.get(id), id)) prMap.set(id, pr);
    }
    // Union the candidates, deduped by IDENTITY. `codeRepoPaths` is not deduped, so two
    // entries can name the SAME repository (a duplicate line, an abs/rel pair, a checkout
    // plus one of its own worktrees); `gh pr list` then returns the same PR twice, and
    // without this one PR collides with itself and a healthy single-deliverer ticket is
    // declared ambiguous. `samePr` decides identity by url, which GitHub makes unique
    // across repositories.
    for (const [id, prs] of r.candidates || []) {
      const seen = allCandidates.get(id) || [];
      for (const pr of prs) if (!seen.some((x) => samePr(x, pr))) seen.push(pr);
      allCandidates.set(id, seen);
    }
    for (const [id, b] of r.branchMap) if (!branchMap.has(id)) branchMap.set(id, b);
    for (const id of r.shippedSet) shippedSet.add(id);
    for (const f of r.forgeErrors || []) forgeErrors.push(f);
    // BLZ-484: the git conditions travel exactly the way BLZ-350's forge conditions do.
    for (const f of r.gitErrors || []) gitErrors.push(f);
  }
  // Asked ONCE, over every repo's candidates at once. Deciding per repo and merging the
  // verdicts is what let an unrecordable PR promoted into the running best shield every
  // later repo from the check — and made the finding depend on `codeRepos` order, which
  // is exactly what the record was fixed to stop depending on.
  const ambiguous = new Map();
  for (const [id, candidates] of allCandidates) {
    const tied = tiedDeliverers(candidates, id);
    if (tied) ambiguous.set(id, tied);
  }
  return {
    prMap, branchMap, shippedSet, missingRepos, scannedRepos, forgeErrors, gitErrors, ambiguous,
    configuredRepos: project.codeRepoPaths.length,
  };
}

/** BLZ-403 / BLZ-459: file the `terminal-record-unverifiable` report for ONE terminal
 *  ticket whose already-held delivery record cannot be tied to a deliverer.
 *
 *  Extracted so the TWO states that reach it build the SAME finding rather than two that
 *  drift: the ordinary `d.recordAmbiguous && keep()` branch, and the uncorroborated-winner
 *  case (BLZ-459) that the loop's `if (d.skip) continue;` used to carry past it.
 *
 *  @param refs                the tied merged candidates for this ticket
 *  @param findings            the per-ticket findings list, for the provably-wrong case
 *  @param unverifiableRecords the aggregate's id list, for everything else
 */
function fileUnverifiableRecord(t, refs, findings, unverifiableRecords) {
  const named = refs.map((r) => namePr(r));
  // BLZ-403 (review): sanitised ONCE, here, and every downstream use — the message,
  // the structured `pr.raw`/`pr.branch` (served verbatim over `/api/reconcile-preview`
  // JSON), and the url extraction below — reads this sanitised value, never
  // `t.frontmatter.pr`/`t.frontmatter.branch` directly. A TICKET FILE's `pr:` line is
  // free-form text nothing here has ever constrained (unlike `t.frontmatter.id`,
  // which only reaches this branch because it matched a git ref), so it gets the
  // same treatment `sanitisePr` already gives a `gh` payload before namePr/samePr or
  // any operator-facing text sees it — reusing `clean`, not adding a fourth renderer.
  const rawPr = clean(t.frontmatter.pr) || null;
  const rawBranch = clean(t.frontmatter.branch) || null;
  // The one case worth naming on its own: the record this ticket already holds is
  // not even a candidate in the tied set — not merely unresolvable but provably
  // pointed at a PR nothing here claims delivered it. 1 of the 73 measured above
  // (OBA-773: records #336, tied set {#339, #341}).
  const recordedUrl = recordedPrUrl(rawPr);
  // BLZ-403 (round 2 review, blocking): `samePr`/`recordMatchesCandidate` answer
  // "is this candidate PROVABLY the same PR as the record" — and `samePr`'s own
  // comment says identity must never be decided by the PRESENCE of a forge-supplied
  // field, so a candidate with no usable url (control-characters-only, or the field
  // absent entirely — the ordinary degraded-forge payload `sanitisePr`/`namePr`
  // exist for) makes `recordMatchesCandidate` answer `false` for that candidate no
  // matter what the record says. That `false` means UNPROVEN, not DISPROVEN. Reading
  // "none of the candidates provably match" as "the record is not even among the
  // tied candidates" silently upgrades unproven into disproved the moment one
  // candidate is uncomparable — accusing a record that may well be exactly that
  // candidate, in a sentence that names the candidate in the tied set while denying
  // it is in it. So `recordOutsideCandidates` may only fire when every tied
  // candidate is actually comparable (carries a usable, non-empty url); if even one
  // does not, the honest answer is UNKNOWN, and it fails CLOSED — toward the
  // aggregate (`unverifiableRecords`, below), never toward a per-ticket accusation.
  const allCandidatesComparable =
    refs.every((r) => typeof r.url === "string" && r.url.trim().length > 0);
  const recordOutsideCandidates = refs.length > 0 && recordedUrl !== null &&
    allCandidatesComparable && !refs.some((r) => recordMatchesCandidate(recordedUrl, r));
  const entry = {
    kind: "terminal-record-unverifiable",
    id: t.frontmatter.id,
    status: t.status,
    pr: { raw: rawPr, branch: rawBranch },
    prs: refs,
    recordOutsideCandidates,
    message: `${t.frontmatter.id} is ${t.status} and already holds a delivery record ` +
      `(${rawPr || "no pr recorded"}), but git now shows ${refs.length || "more than one"} ` +
      `merged PRs tied for having delivered it` + (named.length ? ` (${named.join(", ")})` : "") +
      `, and none claims it more strongly than the rest. The record is write-once ` +
      `protected on a terminal ticket, so reconcile reports this rather than ` +
      `overwriting it` +
      (recordOutsideCandidates
        ? " — and the recorded PR is not even among the tied candidates."
        : ".") +
      ` Verify by hand which PR actually delivered it.`,
  };
  // VOLUME CONTROL: 73 `NEEDS ATTENTION` lines on every run would bury the findings
  // that matter (`scripts/model/audit.mjs`'s own warning: a gate that fires on the
  // fill queue is a gate people learn to skip). Only the provably-wrong case is
  // named per ticket; the rest are aggregated below into ONE finding that still
  // names every one of them in `ids`, so nothing is hidden, only not repeated.
  if (recordOutsideCandidates) findings.push(entry);
  else unverifiableRecords.push(entry.id);
}

/** BLZ-398 / BLZ-475: file the `ambiguous-deliverer` report for ONE ticket whose merged
 *  candidates are tied.
 *
 *  Extracted for the same reason `fileUnverifiableRecord` above was: TWO states reach it and
 *  they must build the SAME finding rather than two that drift — the ordinary
 *  `d.recordAmbiguous && !keep()` branch, which clears the record and says so, and the
 *  uncorroborated-winner case (BLZ-475) that the loop's `if (d.skip) continue;` carried past
 *  it entirely.
 *
 *  `vetoed` is not decoration: THE TWO RUNS DID DIFFERENT THINGS and one sentence cannot
 *  honestly describe both. On the ordinary path reconcile refused to guess and CLEARED the
 *  record. On the vetoed path BLZ-440 held the run back before it ever reached the record,
 *  so nothing was cleared and whatever the ticket already held is still there. Saying
 *  "reconcile recorded NO branch/pr" on that path would be the thing this programme keeps
 *  finding: a sentence asserting more than the run did.
 */
function fileAmbiguousDeliverer(t, refs, findings, { vetoed = false } = {}) {
  // Named through `namePr`, exactly like the sibling finding. This site had its own
  // formatter, and round 6 gave `refs` a shape it had never seen — an entry whose `number`
  // is null — so it printed `#null`, and suppressed the url in precisely the case where the
  // url is the only identifier there is. Three places in this file turn a PR into
  // operator-facing text; unifying the three DECIDERS and leaving the three RENDERERS apart
  // is how the same drift reappeared one layer down.
  const named = refs.map((r) => namePr(r));
  findings.push({
    kind: "ambiguous-deliverer",
    id: t.frontmatter.id,
    status: t.status,
    prs: refs,
    vetoed,
    message: `${t.frontmatter.id} has ${refs.length || "more than one"} merged PRs claiming it` +
      (named.length ? ` (${named.join(", ")})` : "") +
      `, and none claims it more strongly than the rest. ` +
      (vetoed
        ? `Reconcile took no delivery decision on this ticket at all: the top-ranked PR's ` +
          `title does not claim it, so BLZ-440's rule held the run back before it reached ` +
          `the record. Nothing was written and nothing was cleared — whatever branch/pr this ` +
          `ticket already held is exactly as it was. The tie is real and reconcile cannot ` +
          `settle it; set the record by hand if it matters.`
        : `Reconcile recorded NO branch/pr rather than guess which one delivered it — a ` +
          `wrong delivery record is permanent, a blank one is not. Set it by hand if it matters.`),
  });
}

// --- the reconcile pass -------------------------------------------------------
// BLZ-451: the shape a `--ticket` value must have before it can scope anything. STRICT,
// and deliberately NOT normalising: ADR-0025 rules that a project key is refused, never
// normalised, and the key half of a ticket id is a project key. `inf-1` is therefore not
// a lowercase spelling of `INF-1` — it names a project this board does not configure, and
// it is refused by the scope check below rather than quietly corrected.
const TICKET_ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export async function reconcile({
  fetch = false, commit = false, dryRun = true, root, projectsDir,
  readStorage = fsReadStorage, storage = fsStorage, writePort = null, projects = null,
  tickets = null,
} = {}) {
  // root left unset → honour BOTH resolved values (dataRoot + projectsDir, even
  // when custom-named via BLAZE_PROJECTS_DIR). An explicit root (existing
  // callers/tests) keeps the pre-existing join(root, "projects") behaviour.
  // BLZ-133: only resolve ambient roots when the caller didn't supply one.
  // resolveRoots() now throws outside a board, so resolving unconditionally
  // would make an explicitly-rooted reconcile (every programmatic caller and
  // test) fail on the ambient cwd it was never going to use.
  const explicitRoot = root !== undefined;
  const resolved = explicitRoot ? null : resolveRoots();
  root ??= resolved.dataRoot;
  projectsDir ??= explicitRoot ? join(root, "projects") : resolved.projectsDir;

  // Built here, not in the signature: projectsDir is only final at this point.
  const port = writePort ?? fsWritePort(projectsDir, storage);

  const today = new Date().toISOString().slice(0, 10);
  const cfg = loadConfig({ root });
  const configured = listProjects(cfg);

  // BLZ-394: restrict the scan AND the write to the named projects.
  //
  // ADR-0023 §3 already ruled that `--apply` stays a DIRECT WRITE and is not session-scoped:
  // the session-queue machinery serialises divergent INTENTS, and reconcile has none — it
  // derives its answer from git rather than from anything a session wants, so scoping it to
  // a session would add a merge step to reach a result neither session authored. What the
  // original observation actually reports is BLAST RADIUS, not correctness: a session that
  // owns three tickets should not author a commit moving fifteen it never touched. That is
  // this filter, and nothing more.
  //
  // An unknown key REFUSES THE WHOLE RUN rather than scanning the subset it understood. A
  // typo'd `--project` that quietly reconciles nothing is indistinguishable from an in-sync
  // board — the INF-763 lesson in a new place — and a partial run would write half the
  // change its caller asked for while reporting failure.
  const wanted = projects === null ? null
    : [...new Set((Array.isArray(projects) ? projects : [projects]).map((k) => String(k).trim()).filter(Boolean))];
  // BLZ-451: normalised exactly as `--project` is — deduped, trimmed, blanks dropped —
  // so that "the flag was GIVEN" and "the flag yielded a value" stay two different
  // questions. `null` means unfiltered; `[]` means given-and-empty, which refuses.
  const wantedTickets = tickets === null ? null
    : [...new Set((Array.isArray(tickets) ? tickets : [tickets]).map((k) => String(k).trim()).filter(Boolean))];
  if (wanted && !wanted.length) {
    // `configuredRepos: 0`, not `configured.length`: that field counts REPOS, and putting a
    // project count in it was a wrong value in a named field, unreachable or not.
    // BLZ-404: `dryRun` on every return site, refusals included — `changes` is a PROPOSAL
    // list on a dry run and a RECORD of writes on an applied run, and a caller reading a
    // refusal's (empty) `changes` could not previously tell which sense it would have been.
    return { ok: false, error: "--project was given no project key", changes: [], committed: false,
      commitOutcome: "none", commitError: null,
      pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0,
      forgeErrors: [], gitErrors: [], findings: [], scannedProjects: [], scopedTickets: null, dryRun };
  }
  if (wantedTickets && !wantedTickets.length) {
    return { ok: false, error: "--ticket was given no ticket id", changes: [], committed: false,
      commitOutcome: "none", commitError: null,
      pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0,
      forgeErrors: [], gitErrors: [], findings: [], scannedProjects: [], scopedTickets: null, dryRun };
  }
  const unknown = (wanted || []).filter((k) => !configured.includes(k));
  // Checked BEFORE the standalone return below, deliberately. Behind it, a typo'd key on a
  // board with no projects configured reported `ok: true, standalone: true` — a clean,
  // empty, successful run, which is the exact shape this refusal exists to prevent.
  if (unknown.length) {
    return { ok: false,
      // "configures: " with an empty tail told a person nothing; a board with no projects
      // says so in words.
      error: `unknown project key(s): ${unknown.join(", ")}. This board configures: ` +
        (configured.length ? configured.join(", ") : "no projects at all"),
      changes: [], committed: false, commitOutcome: "none", commitError: null,
      pushed: false, missingRepos: [], scannedRepos: 0,
      configuredRepos: 0, forgeErrors: [], gitErrors: [], findings: [], scannedProjects: [],
      scopedTickets: null, dryRun };
  }
  // Hoisted ABOVE the standalone return so the ticket-scope check below can use it. A
  // board with no projects configured has `keys === []`, which is what makes every
  // `--ticket` id out of scope there — a typo'd scope on an empty board must refuse, not
  // report the clean successful run the unknown-key check above already refuses to give.
  const keys = wanted || configured;
  // --- BLZ-451: `--ticket`, the filter finer than `--project` --------------------
  // Same rule as `--project`, for the same reason, and it is the rule BLZ-394 had to
  // learn twice: A FILTER THAT WAS GIVEN AND YIELDED NOTHING REFUSES THE WHOLE RUN. It
  // never falls back to unfiltered. `--project=$PROJ` with `$PROJ` unset once reconciled
  // and committed the entire board in silence; a second filter that keeps the fallback
  // reintroduces that failure through a new door, and a shell script produces it by
  // accident.
  //
  // Why this exists at all: `--apply` is all-or-nothing WITHIN a project, and reconcile
  // writes `pr`/`branch` records that ADR-0023 makes WRITE-ONCE — `pr` is not in
  // EDITABLE_FIELDS, so a wrong one has no route back. Live on 2026-08-28 a `--project
  // BLZ` run proposed four correct moves and one wrong one, and there was no way to take
  // the four without also writing a false terminal record on the fifth. This is a
  // blast-radius control, the same kind `--project` is, one level finer.
  if (wantedTickets) {
    // MALFORMED IS REFUSED, NOT IGNORED. A value that is not `<KEY>-<n>` can never match
    // a ticket, so accepting it would reconcile NOTHING and report a clean run — which is
    // indistinguishable from an in-sync board, the INF-763 lesson that already makes
    // `--project NOPE` a refusal rather than an empty scan.
    const malformed = wantedTickets.filter((id) => !TICKET_ID_RE.test(id));
    if (malformed.length) {
      return { ok: false,
        error: `--ticket was given ${malformed.length} value(s) that are not ticket ids: ` +
          `${malformed.join(", ")}. A ticket id is <KEY>-<number>, e.g. --ticket INF-1.`,
        changes: [], committed: false, commitOutcome: "none", commitError: null,
        pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0,
        forgeErrors: [], gitErrors: [], findings: [], scannedProjects: [], scopedTickets: null, dryRun };
    }
    // An id whose project the run does not cover is REFUSED, not silently dropped. Both
    // shapes land here: a key this board does not configure at all, and a key it does
    // configure but that THIS run's `--project` scope excludes. Dropping either would
    // narrow the run to less than the caller asked for while reporting success.
    const outside = wantedTickets.filter((id) => !keys.includes(id.slice(0, id.lastIndexOf("-"))));
    if (outside.length) {
      return { ok: false,
        error: `--ticket names ticket(s) outside this run's projects: ${outside.join(", ")}. ` +
          `This run covers: ${keys.length ? keys.join(", ") : "no projects at all"}` +
          (wanted ? " (narrowed by --project)." : "."),
        changes: [], committed: false, commitOutcome: "none", commitError: null,
        pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0,
        forgeErrors: [], gitErrors: [], findings: [], scannedProjects: [], scopedTickets: null, dryRun };
    }
  }
  if (!configured.length) return { ok: true, standalone: true, changes: [], committed: false,
    commitOutcome: "none", commitError: null,
    pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0, forgeErrors: [], gitErrors: [],
    findings: [], scannedProjects: [], scopedTickets: null, dryRun };

  // BLZ-404 (review finding 1): every other board git writer gates its write through
  // `assertWritable` before it touches disk (BLZ-121 defence-in-depth — cli.mjs is the
  // primary gate and refuses to even spawn this file under BLAZE_READONLY, but a direct
  // `reconcile({ dryRun: false })` library call, or `node scripts/reconcile.mjs --apply`,
  // bypasses that). reconcile() never carried this guard at all.
  //
  // Gated on `!dryRun`, not on `commit`: the per-ticket loop below writes/renames ticket
  // files through the write port whenever `dryRun` is false, REGARDLESS of whether a git
  // commit was even requested. Hoisted to run BEFORE that loop, for the reason
  // new-runner.mjs documents under its own assertWritable call: a refusal placed at the
  // commit block instead would let the writes happen and only then decline to commit —
  // the "dirty-tree failure, not a clean refusal" hazard, not a clean one.
  if (!dryRun) {
    try {
      assertWritable("reconcile: apply board state");
    } catch (e) {
      return { ok: false, error: e.message, changes: [], committed: false,
        commitOutcome: "none", commitError: null, pushed: false, missingRepos: [],
        scannedRepos: 0, configuredRepos: 0, forgeErrors: [], gitErrors: [], findings: [],
        scannedProjects: [], scopedTickets: null, dryRun };
    }
  }

  // BLZ-451: MATERIALISED, because the existence check below has to run BEFORE anything
  // is written and the loop has to read the same list it was checked against. Reading the
  // walk twice would let a concurrent write make the check and the loop disagree.
  const allTickets = [...readStorage.listTickets(projectsDir)];
  if (wantedTickets) {
    // An id naming no ticket on this board is the TYPO case, and it refuses for the same
    // reason `--project NOPE` does: a scoped run that quietly reconciles nothing is
    // indistinguishable from an in-sync board. One bad id refuses the WHOLE run — a
    // partial run writes half of what its caller asked for while reporting failure, which
    // is the shape the unknown-project-key refusal already rejects.
    const present = new Set(allTickets.map((t) => t.frontmatter.id));
    const missing = wantedTickets.filter((id) => !present.has(id));
    if (missing.length) {
      return { ok: false,
        error: `--ticket names ticket(s) that do not exist on this board: ${missing.join(", ")}.`,
        changes: [], committed: false, commitOutcome: "none", commitError: null,
        pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0,
        forgeErrors: [], gitErrors: [], findings: [], scannedProjects: [], scopedTickets: null, dryRun };
    }
  }

  const sig = new Map();
  for (const key of keys) sig.set(key, gatherProject(loadProject(key, { root, projectsDir }), { fetch }));

  const changes = [];
  const touched = [];
  // BLZ-395: what reconcile can SEE but must not ACT on. `changes` says what moved;
  // this says what a person needs to look at. It is deliberately not an error — the
  // run is healthy, the board is not — and it is emitted on dry runs too, because a
  // dry run is exactly where someone would look before believing the board.
  const findings = [];
  // BLZ-470: WHAT THIS RUN COULD NOT READ, raised before a word about what it did read —
  // and unconditionally, on every run, filtered or not, for exactly the reason BLZ-406's
  // `project-mismatch` is: a directory the walk skipped is invisible to EVERY scope, so
  // gating this on `wanted` would make it the silent skip the finding exists to report.
  //
  // `--ticket` makes that sharper rather than softer. `--ticket BLZ-9` on a board whose
  // BLZ status directory was skipped refuses with "names ticket(s) that do not exist on
  // this board" (see above) — a run that could not look, reporting what a run that looked
  // and found nothing reports. This finding is what turns that refusal from a lie into a
  // half-truth beside an explanation.
  for (const u of unreadableTicketDirs(projectsDir)) {
    findings.push({
      kind: "unreadable-ticket-directory",
      id: null,
      project: u.project,
      status: u.status,
      path: u.path,
      reason: u.reason,
      message: u.message,
    });
  }
  // BLZ-403: ids of terminal tickets whose FROZEN record is unverifiable but IS one of
  // the tied candidates — the common case (72 of 73 measured at blaze-pm 57212799).
  // Collected here rather than pushed straight into `findings` so the volume can be
  // aggregated into ONE finding after the loop; the ONE genuinely wrong case
  // (`recordOutsideCandidates`) is rare enough, and important enough, to still name on
  // its own — see the per-ticket push below.
  const unverifiableRecords = [];
  for (const t of allTickets) {
    const type = t.frontmatter.type;
    // BLZ-406: raised BEFORE the scope guard below, and unconditionally — on every
    // run, filtered or not. `t.project` is the DIRECTORY (first-class from the walk,
    // BLZ-271) and `t.frontmatter.project` is whatever the file's own frontmatter
    // claims; ADR-0001 makes the directory authoritative for where a write lands, but
    // that does not make the ticket reconcilable. The signal map (`sig`) is keyed by
    // the FRONTMATTER project, so a ticket like this is invisible to a `--project`
    // run naming its directory (the signal map for that key has no entry keyed by the
    // frontmatter's project) AND to one naming its frontmatter's key (the directory
    // guard below excludes it before `sig` is even consulted) — only an unfiltered run
    // reaches it at all, via the frontmatter key. No single-project run can ever
    // reconcile it, and the honest answer is to say so, not to silently pick a side.
    // Gating this on `wanted` (or putting it after the guard) would make it exactly
    // the silent skip this finding exists to report.
    if (t.frontmatter.project != null && t.frontmatter.project !== t.project) {
      findings.push({
        kind: "project-mismatch",
        id: t.frontmatter.id,
        directory: t.project,
        frontmatterProject: t.frontmatter.project,
        message: `${t.frontmatter.id} sits under projects/${t.project}/ but its frontmatter names ` +
          `project: ${t.frontmatter.project}. The directory is authoritative for where a write ` +
          `lands (ADR-0001), but no single-project run will reconcile it: a --project ${t.project} ` +
          `run has no ${t.frontmatter.project}-keyed signal for it, and a --project ` +
          `${t.frontmatter.project} run excludes it by directory before it ever reaches that signal. ` +
          `Fix it by moving the file to projects/${t.frontmatter.project}/ if the frontmatter is ` +
          `right, or by correcting its \`project:\` field to ${t.project} if the directory is right.`,
      });
    }
    // Scope on the DIRECTORY as well as the frontmatter. `sig` is keyed by the
    // frontmatter's project, but the write lands by `t.project` — the directory the
    // ticket sits in — so a ticket at `projects/OBA/…` carrying `project: INF` was
    // selected by an `INF` filter and then written into `projects/OBA/`, producing a
    // commit that names its scope as (INF) while touching another project's files.
    // Blast radius, which is all this ticket is about, is a property of the path.
    if (wanted && !keys.includes(t.project)) continue;
    // BLZ-451: the finer scope, applied at the same seam and AFTER the project-mismatch
    // finding — which BLZ-406 raises unconditionally on every run, filtered or not,
    // precisely so a narrowed scope can never turn it into the silent skip it exists to
    // report. Matched on `t.frontmatter.id`, which is the id the operator typed and the
    // id every refusal above was validated against.
    if (wantedTickets && !wantedTickets.includes(t.frontmatter.id)) continue;
    const s = sig.get(t.frontmatter.project);
    if (!s) continue;
    const d = decide({
      pr: s.prMap.get(t.frontmatter.id),
      branch: s.branchMap.get(t.frontmatter.id),
      shipped: s.shippedSet.has(t.frontmatter.id),
      delivererAmbiguous: s.ambiguous ? s.ambiguous.has(t.frontmatter.id) : false,
    }, t.status, type);
    // --- BLZ-469: SAY IT, DON'T MOVE IT ------------------------------------------
    // The operator's PR #144 delivered sixteen tickets, reconcile moved none of them,
    // and NOTHING SAID SO — the failure is silent and in the safe direction, which is
    // exactly what makes it expensive: all sixteen had to be found by noticing the
    // board had not changed, then hand-moved through statuses the `blaze` skill
    // otherwise forbids touching by hand.
    //
    // This changes no decision. The refusal above is BLZ-440 working correctly and
    // stays exactly as it is; what is added is that the run reports the one shape a
    // person can act on — "your title bought you nothing".
    //
    // THREE SCOPE CONDITIONS, and each is volume control with a reason. `gh pr list`
    // reads `--state all --limit 1000`, so an unscoped version of this finding would
    // emit a line for every historically non-conventional title in the repo's whole
    // history — the failure mode `fileUnverifiableRecord` already argues against
    // ("73 NEEDS ATTENTION lines on every run would bury the findings that matter").
    //
    //   MERGED only        — an OPEN uncorroborated PR is BLZ-130's veto, a signal
    //                        working as designed, not a delivery that failed to land.
    //   non-terminal only  — a ticket already in a terminal status missed nothing.
    //   uncorroborated only— if a `KEY-n:` commit corroborated it, the ticket MOVED and
    //                        the title gap cost nothing. `pr.uncorroborated` is the tag
    //                        `buildPrMap` already computes, so this asks the SAME
    //                        question the gate asked rather than a second one that can
    //                        drift from it (the INF-735 lesson about two implementations
    //                        of "does this subject claim this ticket").
    //
    // Raised from the WINNER, not from every candidate: `decide` reads the top-ranked
    // PR, so the winner is the PR that actually determined this ticket's (non-)outcome.
    const winner = s.prMap.get(t.frontmatter.id);
    if (winner && winner.uncorroborated && winner.state === "MERGED" &&
        isType(type) && workflowFor(type) === "delivery" && !isTerminal(type, t.status)) {
      findings.push({
        kind: "merged-pr-title-claims-nothing",
        id: t.frontmatter.id,
        status: t.status,
        pr: winner.number,
        title: clean(winner.title) || null,
        headRefName: clean(winner.headRefName) || null,
        message: `${t.frontmatter.id} is ${t.status} and ${namePr(winner)} is MERGED on a branch ` +
          `that derives its id (${clean(winner.headRefName) || "unknown branch"}), but its TITLE ` +
          `does not claim it: ${JSON.stringify(clean(winner.title) || "")}. A branch name is a ` +
          `naming convention, not evidence, so reconcile moved nothing and recorded nothing — ` +
          `this is BLZ-440 working as designed, reported rather than left silent. To make the ` +
          `title claim the ticket, open it with \`${t.frontmatter.id}:\` or \`${t.frontmatter.id} —\`; ` +
          `for a bundle, \`${t.frontmatter.id} + N more:\` with the rest as \`* KEY-n:\` bullets in ` +
          `the squash body. Otherwise move it by hand.`,
      });
    }
    if (d.skip) {
      // BLZ-459: THE SKIP SUPPRESSES THE WRITE, NOT THE REPORT.
      //
      // BLZ-440's rule — an uncorroborated claim may only hold a ticket back — returns
      // `skip` with `recordAmbiguous: false`, and this `continue` used to carry the run
      // straight past the `terminal-record-unverifiable` collection as well as past every
      // write. The neighbouring `openPrOnTerminal` suppression HAS a soundness argument
      // (see `decide`: that finding reports on the VETO, and an uncorroborated claim takes
      // no veto, so there is no wrong move to report). THIS finding has no such argument
      // available and the comment was silent on it: it reports on the STATE — a terminal
      // ticket holding a record git cannot tie to a deliverer — which is decided by the
      // CORROBORATED tied set and is entirely unaffected by which PR happens to rank top.
      // The condition stayed exactly as true; only the report vanished.
      //
      // The conditions are the ones `decide`+`keep()` would have applied, restated here
      // because `decide` deliberately reports no ambiguity on this path: a DELIVERY type
      // (so the goal/risk skip at the top of `decide` stays a full skip), already
      // terminal, already holding a record, and in the tied set. Nothing is written and
      // nothing is cleared — `write()`/`keep()` are never consulted, and this branch
      // still `continue`s.
      //
      // Live incidence measured at ZERO by the BLZ-440 review (all 8 board tickets with
      // an uncorroborated top-ranked PR have a single candidate), so the shape is
      // constructed in tests rather than sampled.
      //
      // BLZ-475: AND THE OTHER HALF OF THE SAME SUPPRESSION. BLZ-459 closed the terminal
      // case; the `continue` still carried a NON-TERMINAL ticket past the
      // `ambiguous-deliverer` finding, and such a run reported nothing at all — not the
      // tie, not the veto, not a move. The argument is the one BLZ-459 already made and it
      // does not weaken on this side: the tie is decided by the CORROBORATED candidate set
      // (`s.ambiguous`, built by `corroboratedByTicket`), which is entirely unaffected by
      // which PR happens to rank top, so the condition stays exactly as true when the
      // winner is uncorroborated. Only the report vanished.
      //
      // The contrast is `openPrOnTerminal`, and it is the one suppression here that IS
      // sound: `decide` returns `openPrOnTerminal: false` on this path deliberately,
      // because that finding reports on the VETO — a signal reconcile declined to act on —
      // and an uncorroborated claim takes no veto, so there is no wrong move to report.
      // These two report on the STATE, which is why they must survive the skip.
      //
      // The finding says what the run actually did (`vetoed: true`), which is NOT what the
      // ordinary path does: nothing is written and nothing is CLEARED here, because
      // `write()`/`keep()` are never consulted on this branch.
      //
      // Live incidence measured at ZERO by the BLZ-440 review (all 8 board tickets with an
      // uncorroborated top-ranked PR have a single candidate), so the shape is constructed
      // in tests rather than sampled.
      if (isType(type) && workflowFor(type) === "delivery" &&
          s.ambiguous && s.ambiguous.has(t.frontmatter.id)) {
        if (isTerminal(type, t.status)) {
          if (t.frontmatter.branch || t.frontmatter.pr) {
            fileUnverifiableRecord(t, s.ambiguous.get(t.frontmatter.id), findings,
              unverifiableRecords);
          }
        } else {
          fileAmbiguousDeliverer(t, s.ambiguous.get(t.frontmatter.id), findings, { vetoed: true });
        }
      }
      continue;
    }

    // BLZ-395: recorded BEFORE the dirty check below, because this ticket's whole point
    // is that nothing is dirty — terminal-stickiness clamps the status and the MERGED
    // gate clamps the record, so the loop would `continue` and say nothing at all. A
    // finding whose condition is "no change was made" cannot be gated on a change having
    // been made. (An earlier draft of this comment said `changes` is "empty by
    // construction" here. That is false and is corrected rather than quietly dropped: a
    // `done` ticket with a blank `resolution` has it backfilled, which sets `dirty` and
    // emits a change. The PLACEMENT is still load-bearing — moving this below the dirty
    // check turns the end-to-end sequence test red — but the reason is that nothing is
    // dirty in THIS ticket's case, not that nothing ever is.)
    if (d.openPrOnTerminal) {
      const pr = s.prMap.get(t.frontmatter.id);
      findings.push({
        kind: "open-pr-on-terminal",
        id: t.frontmatter.id,
        status: t.status,
        pr: { number: pr.number, state: pr.state, url: pr.url, headRefName: pr.headRefName },
        // Name the PR by number when there is one and by url when there is not. Round 3
        // dropped unnumberable PRs so this never fired; round 4 kept them for their veto,
        // which is exactly when a terminal ticket is vetoed by one — and the message read
        // "PR #null carrying its key is still OPEN", on stderr, the feed and the preview.
        message: `${t.frontmatter.id} is ${t.status}, but ${namePr(pr)} carrying its key ` +
          `is still OPEN. Reconcile moved nothing: a terminal status is never reversed ` +
          `automatically. If the work is not shipped, move it back by hand.`,
      });
    }

    const fm = { ...t.frontmatter };
    let dirty = false;
    // BLZ-398: reconcile can now DELETE a delivery record, which nothing else in the
    // engine does. A destructive direction that reports itself as `{from:"done",
    // to:"done", moved:false}` is indistinguishable from a `resolution` backfill, so
    // the only machine-readable account of the run never says the record was removed.
    let cleared = false;
    // BLZ-401: the other two ways this loop can be dirty WITHOUT the status moving.
    // `changes` used to gate its render on `dirty` alone, so a `done` ticket that only
    // had its `resolution` backfilled (or its record filled in for the first time)
    // landed on `r.changes` with `from === to` and the CLI printed it as a move that
    // never happened — "would move INF-645: done → done". These two flags are what let
    // the RENDERER (below, and in the CLI block) tell that case apart from a real move,
    // without dropping the entry: `r.changes` still says "what this run did to the
    // file", `moved` still says whether the status changed, and now the caller can say
    // WHICH non-move thing happened instead of merely "backfilled clothing" over a
    // silent no-op.
    let resolutionBackfilled = false;
    let recordFilled = false;
    // Terminal: fill a blank RECORD, never replace one. See `recordIfAbsentOnly` in
    // decide(). The record is one unit, not two fields: ADR-0023 and the guide both say a
    // terminal ticket "may ACQUIRE a delivery record it never had, and may never have one
    // replaced". Judged per-field it was neither. A `done` ticket with `branch` set and
    // `pr` blank had its `pr` filled from whatever PR ranked top — and ranking breaks ties
    // on PR NUMBER, so that is the LATEST merged PR, not the one that delivered the work.
    // A follow-up docs PR merged under the same key therefore stamped itself onto half the
    // record while `branch` still named the deliverer: one record naming two different PRs,
    // which is round 3's bug wearing fill clothing. 8 of the 1,594 `done` tickets at
    // blaze-pm ff5f36c2 are in that shape — `branch` recorded, `pr` blank. ("today" is
    // not a ref; the ADR and the test twin of this sentence quote the same one.)
    //
    // Computed EAGERLY — before either write below — and that, not which object it reads,
    // is the load-bearing property. `fm` is a fresh copy and is unmutated at this line, so
    // `Boolean(fm.branch || fm.pr)` here would be exactly equivalent. What breaks is making
    // it LAZY: evaluated inside `keep()`, the pr check would see the branch just written by
    // the line above, skip the pr write, and re-create round 2's write-nothing direction on
    // the 1,056 of 1,594 `done` tickets that carry NEITHER field at blaze-pm ff5f36c2 —
    // the same population and the same figure decide()'s own comment quotes above, which
    // is the point: one file may not print two numbers for one population. Reading
    // `t.frontmatter` says "the state before this loop touched anything" out loud, which
    // is the intent.
    const hadRecord = Boolean(t.frontmatter.branch || t.frontmatter.pr);
    const keep = () => d.recordIfAbsentOnly && hadRecord;
    // BLZ-398: the second reason not to write, and it gates BOTH fields for the same
    // reason `keep()` does — the record is ONE UNIT. Writing `branch` from an
    // unresolvable merged set while leaving `pr` blank would rebuild ADR-0023's fourth
    // shape of wrong out of the fix for its third.
    const write = () => !keep() && !d.recordAmbiguous;
    // BLZ-398: a refusal to write is reported, not swallowed. ADR-0023's round 2 is the
    // reason — turning a corruption into a SILENT omission was itself judged not a fix,
    // and a blank the board cannot explain is indistinguishable from one reconcile
    // never got to. Gated on `!keep()` so it fires only where a write would actually
    // have happened: a terminal ticket that already holds a record is protected by
    // write-once regardless, and has nothing to look at.
    //
    // REFUSING IS NOT ENOUGH — THE LIVE RECORD MUST BE CLEARED. Found by review, and it
    // defeated the whole ticket: an OPEN PR outranks a MERGED one, so while any PR is
    // open the record is set by RANK, not by any deliverer rule. A ticket whose docs PR
    // was open at the sample moment carries `pr: #<docs>` through `in-review`; when that
    // PR merges the set becomes ambiguous, and a bare refusal froze that rank-chosen
    // value as the ticket went terminal. The board then held exactly the record this
    // ticket exists to prevent — permanently, since `pr` is not in EDITABLE_FIELDS — and
    // the finding beside it claimed nothing had been recorded. Two promises broken at
    // once: the record named neither the deliverer nor nothing, and the report was false.
    //
    // Clearing is safe precisely where it applies. `!keep()` means the record is NOT
    // write-once protected, which means either the ticket is not yet terminal — so the
    // record is live state reconcile itself wrote and may replace — or it is terminal
    // and blank, where there is nothing to clear. Nothing a person authored is touched:
    // reconcile is the only producer of these two fields.
    if (d.recordAmbiguous && !keep()) {
      // Truthiness, to match `hadRecord` exactly. The disagreement is real: `hadRecord`
      // reads an EMPTY record as absent, while a `!== undefined` guard here would read it
      // as present. Both spellings of empty occur — `parseTicket` renders a valueless
      // `branch:` line as `null`, and both DB storages project an absent record as
      // `branch: row.branch ?? ""` (`toRecord`, kept identical across drivers by
      // driver-conformance.test.mjs) — and neither is `undefined`, so the mutant fires on
      // both. The pair would then clear-and-dirty a ticket whose record was never there:
      // one false `cleared: true` change entry, one commit, and an `ambiguous-deliverer`
      // finding, all about a record that did not exist.
      //
      // BLZ-424: THE SYMPTOM IS ONCE PER TICKET, NOT ONCE PER TICK. An earlier revision of
      // this comment said "a git commit per tick under `blaze start`". Measured directly by
      // applying the `!== undefined` mutant and running three consecutive
      // `reconcile({ dryRun: false })` passes over such a ticket: pass 1 emits
      // `cleared: true`, passes 2 and 3 emit nothing. The clear DELETES both keys, the
      // rewritten file no longer carries them, and the next pass reads them as `undefined`.
      // A per-tick repeat needs the empty value to come BACK every pass, which requires a
      // READ driver that re-projects an absent record as `""` while the write lands
      // somewhere it cannot see — and no shipped caller does that: `readStorage` defaults
      // to `fsReadStorage` and serve.mjs, supervisor.mjs and this file's own CLI all pass
      // none. Still worth the guard, and still stated at the size it actually is.
      if (fm.branch || fm.pr) {
        delete fm.branch;
        delete fm.pr;
        dirty = true;
        cleared = true;
      }
      const refs = (s.ambiguous && s.ambiguous.get(t.frontmatter.id)) || [];
      fileAmbiguousDeliverer(t, refs, findings);
    } else if (d.recordAmbiguous && keep()) {
      // BLZ-403 — the residual ADR-0023's "residual" paragraph named and left open. The
      // clear and the finding above are both gated on write-once NOT applying; `keep()`
      // reading true means this ticket was ALREADY terminal, and already held a record,
      // before this run — most often because it was HAND-MOVED to a terminal status
      // while a follow-up PR was still open, arriving at terminal-with-a-record by a
      // route reconcile never sees. Write-once then protects that rank-chosen record
      // forever: `pr` is not in `EDITABLE_FIELDS`, so nothing but a person can fix it.
      //
      // THIS IS A FINDING ON THE STATE, NOT THE ROUTE. Reconcile cannot see that a
      // ticket was hand-moved — it can only see a terminal ticket holding a record it
      // cannot verify — so this reports the SUPERSET reconcile can actually observe,
      // never the narrower "hand-moved" claim the ticket that opened this is titled for.
      //
      // Measured at blaze-pm 57212799269cb946c3949da459c04e0e4e765afb (BLZ-305-v4-spine,
      // NCA excluded): 73 terminal-with-record tickets whose merged set is unresolvable.
      // 72 of the 73 hold a record that IS one of the plausible deliverers — reconcile
      // simply cannot prove which one. Clearing those would destroy 72 probably-correct
      // records that NOTHING can restore (reconcile is the only producer of `branch`/
      // `pr`), to fix the 1 that is provably wrong. That trade is refused: the DECISION
      // (ADR-0023) is report, never overwrite — write-once on a terminal ticket stands.
      const refs = (s.ambiguous && s.ambiguous.get(t.frontmatter.id)) || [];
      fileUnverifiableRecord(t, refs, findings, unverifiableRecords);
    }
    if (d.branchVal && write() && fm.branch !== d.branchVal) { fm.branch = d.branchVal; dirty = true; recordFilled = true; }
    if (d.prVal && write() && fm.pr !== d.prVal) { fm.pr = d.prVal; dirty = true; recordFilled = true; }
    if (d.resolution !== undefined && fm.resolution !== d.resolution) {
      fm.resolution = d.resolution; dirty = true; resolutionBackfilled = true;
    }
    if (d.moved) { fm.updated = today; dirty = true; }
    if (!dirty) continue;

    // Always record the would-be change; only write files when not a dry-run. BLZ-401:
    // `resolutionBackfilled`/`recordFilled` are meaningful only when `moved` is false —
    // on a real move they describe part of the same transition the move already
    // reports, so the renderer (and the CLI below) reads them ONLY on the non-move
    // branch. They stay on the object unconditionally rather than being reset when
    // `moved` is true, because a change entry is a record of what the run actually did
    // to the file, not a value pre-shaped for one particular reader.
    changes.push({
      id: t.frontmatter.id, from: t.status, to: d.target, moved: d.moved, cleared,
      resolutionBackfilled, recordFilled,
    });

    if (!dryRun) {
      // BLZ-276: the last direct node:fs ticket write in the engine, and the only one
      // BLZ-267 deliberately left behind — it is interleaved inside this per-ticket
      // loop rather than sitting at the tail of a pure function, so lifting it out
      // would have changed the semantics. It stays in the loop and goes through the
      // driver, which is what the write-seam map called for.
      // The verb states WHAT it wants persisted; the adapter decides where that lives.
      // move() also owns the write-then-rename ordering, so the text lands at the
      // DESTINATION and a crash cannot leave the old body at the new path.
      const target = { project: t.project, status: d.moved ? d.target : t.status,
                       frontmatter: fm, body: t.body, currentFile: t.file };
      if (d.moved) {
        const { file: dest } = await port.move(target);
        touched.push(t.file);
        if (dest !== t.file) touched.push(dest);
      } else {
        const { file } = await port.write(target);
        touched.push(file);
      }
    }
  }

  // BLZ-403: the aggregated half of the volume control above — ONE finding for every
  // terminal ticket whose already-held record is unverifiable but IS a plausible
  // deliverer, carrying the exact count and the full `ids` array so every affected
  // ticket is still named in the JSON (nothing hidden, only not repeated once per
  // ticket on a terminal). Deliberately no `id` field: this finding is about MANY
  // tickets, not one, and `newFindingEvents` (scripts/supervisor.mjs) passes `id`
  // through unchanged — `undefined` travels the same path a per-ticket finding's real
  // id does, pinned by a test rather than assumed.
  //
  // BLZ-403 (review): the message used to say "none of them was changed", about the
  // TICKET. That is false whenever the loop above also backfills a blank `resolution`
  // on the same terminal ticket (the comment near `changes.push` already names this: "a
  // `done` ticket with a blank `resolution` has it backfilled, which sets `dirty` and
  // emits a change") — that write happens in THIS SAME run, on THIS SAME ticket, and is
  // committed. Write-once guarantees only that `branch`/`pr` were not touched; it says
  // nothing about the rest of the file. Narrowed to the one thing this code path
  // actually guarantees.
  if (unverifiableRecords.length) {
    findings.push({
      kind: "terminal-record-unverifiable",
      count: unverifiableRecords.length,
      ids: unverifiableRecords,
      message: `${unverifiableRecords.length} terminal ticket(s) already hold a delivery record ` +
        `reconcile cannot verify — the merged set is unresolvable, and none claims it more ` +
        `strongly than the rest: ${unverifiableRecords.join(", ")}. Write-once protects a ` +
        `terminal ticket's record: none of their branch/pr fields was changed. (The ticket ` +
        `itself may still have been written this run — e.g. a blank resolution backfilled ` +
        `— that is a separate write and is reported in \`changes\`.) Verify by hand if it matters.`,
    });
  }

  let committed = false;
  // BLZ-404 (review finding 1 + 2): reconcile used to shell straight to `git add`/`git
  // commit`, the one board git writer answering to neither the advisory commit lock nor
  // `commitMode`. It could commit THROUGH a held lock, and on a `commitMode: "batch"`
  // board it committed ticket moves out from under a pending `blaze commit` batch instead
  // of queueing them. Routed through the same single decision point every other verb uses
  // (move/edit/log/resolve/new/link/sprint-runner): `acquireLock` in `per-op` mode, the
  // pending ledger (with its branch record, INF-673) in `batch` mode.
  //
  // `commitFile` returns `{ ok, locked, status }` and treats "nothing to commit" as a
  // benign no-op (`ok: true`) — that shape is carried out here as `commitOutcome`, not
  // flattened into a bare boolean, so a caller (the CLI, the supervisor) can tell
  // "committed" apart from "queued" apart from "locked" apart from "failed" rather than
  // reading every non-commit as an indistinguishable `committed: false`.
  //
  // `id` names the WHOLE op, not a single ticket: reconcile can touch many tickets in one
  // pass, and a null-ish id would make an unreadable pending-ledger entry (and a
  // meaningless name in `checkBranch`'s refusal message, which lists ids by this field).
  // BLZ-422: "no-op" joined this list — see reconcile-commit-report.mjs, which owns
  // both the classification and the wording. Reconcile itself cannot REACH "no-op": a
  // change entry requires either a byte difference or a rename, so the staged tree is
  // never clean by the time `commitFile` runs. It is carried here as a contract, the
  // same way BLZ-405 carried `reconcilePreview`'s unreachable refusals, and it is
  // pinned where it IS reachable — `commitFile`'s other callers.
  let commitOutcome = "none"; // one of COMMIT_OUTCOMES (reconcile-commit-report.mjs)
  let commitError = null;
  // BLZ-404 round 5: this commit block only ever files THIS PASS's own decisions
  // (`touched`) — it makes no attempt to recover a previous pass's uncommitted ticket
  // writes, and reconcile makes no attempt to DETECT that condition either (round 2's
  // recovery write and round 3/4's detect-and-report boolean were both tried and both
  // deleted — see the PR body for why). Whether the board's ticket tree also carries
  // leftover uncommitted dirt from an earlier pass is invisible to this function; a
  // person notices it the same way they always have, via `git status`.
  if (commit && !dryRun && touched.length) {
    // BLZ-401: the message counts TICKETS WHOSE STATUS ACTUALLY MOVED, not
    // `changes.length` — `changes` also carries entries where a resolution was
    // backfilled or a record cleared/filled with `from === to`, and a commit touching
    // three files that says "1 ticket" replaces one understatement with another. Both
    // quantities are named: a run that also wrote non-moving updates says so rather
    // than folding them into (or hiding them from) the moved count.
    const movedCount = changes.filter((c) => c.moved).length;
    const nonMovedCount = changes.length - movedCount;
    const c = commitOrQueue({
      root, mode: cfg.commitMode, op: "reconcile",
      id: `reconcile:${keys.join(",")}` + (wantedTickets ? `:${wantedTickets.join(",")}` : ""),
      // BLZ-427: one reconcile op covers EVERY ticket this pass wrote. `id` names the
      // op (it has to — a pass has no single ticket), so without this list `blaze
      // commit` counted the whole pass as one and a flush of twelve moved tickets read
      // "1 reconcile". Every other verb queues one ticket per op and passes none.
      ids: changes.map((ch) => ch.id),
      message: `chore(board): reconcile ${movedCount} ticket(s) moved to git state` +
        (nonMovedCount ? `, ${nonMovedCount} ticket(s) updated without a status change` : "") +
        (wanted ? ` (${keys.join(", ")})` : "") +
        // BLZ-451: a ticket-scoped commit says so. The message is what a person reads
        // months later when asking why this pass moved three tickets and not thirty.
        (wantedTickets ? ` [--ticket ${wantedTickets.join(", ")}]` : ""),
      files: touched,
    });
    // BLZ-422: the classification lives in reconcile-commit-report.mjs so it can be
    // driven directly — see that file for why `ok: true` alone was not enough.
    ({ outcome: commitOutcome, error: commitError } = commitOutcomeFrom(c));
    committed = commitOutcome === "committed";
  }
  // BLZ-404 AC-4: `push` is answered by DELETING it, not by refusing it. `reconcile()`
  // never reads a `push` option and `pushed: false` is unconditional below — accepting a
  // `push` PARAMETER that nothing reads told every caller a run might push when it never
  // could, and `supervisor.mjs` passed exactly that. A removed parameter cannot be pinned
  // by a mutation (there is nothing left to flip), so what is pinned instead is the
  // CONTRACT this line states: `pushed` is `false` on every applied, committing run —
  // see tests/reconcile-pertype.test.mjs.
  const pushed = false;
  // INF-763: surface repo reachability so a caller can tell "scanned everything,
  // nothing to change" from "scanned nothing, so of course nothing changed".
  const missingRepos = [...new Set([...sig.values()].flatMap((g) => g.missingRepos))];
  const scannedRepos = [...sig.values()].reduce((n, g) => n + g.scannedRepos, 0);
  const configuredRepos = [...sig.values()].reduce((n, g) => n + g.configuredRepos, 0);
  // BLZ-350: the forge outcome travels with the result. An empty prMap now means
  // "no pull requests"; anything else that happened is named here instead.
  const forgeErrors = [...sig.values()].flatMap((g) => g.forgeErrors || []);
  // BLZ-484: and so does the git outcome. An empty `shippedSet` or `branchMap` now means
  // "git said so"; a probe that never got an answer is named here instead of vanishing.
  const gitErrors = [...sig.values()].flatMap((g) => g.gitErrors || []);
  // BLZ-394 AC-5: a filtered run must not be mistakable for an in-sync board, so the result
  // says which projects it looked at — on every run, not only filtered ones, because the
  // caller cannot tell the difference from a `changes: []` alone.
  // BLZ-404: `dryRun` travels with the result too — `changes` is a PROPOSAL list on a dry
  // run and a RECORD of writes on an applied run, and until now no consumer could tell
  // which sense it was looking at without already knowing what it had passed in.
  // BLZ-451: `scopedTickets` is `null` on an unfiltered run and the id list on a scoped
  // one — never `[]`, because a consumer must be able to tell "looked at everything" from
  // "looked at these" from the field alone. That is BLZ-394 AC-5's rule, extended to the
  // second filter rather than restated for it.
  return { ok: true, changes, committed, commitOutcome, commitError, pushed,
           missingRepos, scannedRepos, configuredRepos, forgeErrors, gitErrors, findings,
           scannedProjects: keys, scopedTickets: wantedTickets, dryRun };
}

// --- CLI ----------------------------------------------------------------------
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let apply = false, fetchFlag = false, quiet = false;
  // BLZ-394: `--project KEY`, repeatable, and comma-separated, and `--project=KEY`. All
  // three because all three are what a person types, and a filter that silently ignores
  // the spelling it did not expect is worse than no filter.
  const projectKeys = [];
  // Whether the flag was SEEN, not whether it yielded a key. `projectKeys.length ? … : null`
  // meant `--project=` and `--project ,` fell back to an UNFILTERED run: `blaze reconcile
  // --project=$PROJ --apply` with `$PROJ` unset reconciled and committed the whole board,
  // silently, and with `--quiet` nothing on stderr said so. That is precisely the failure
  // this ticket exists to prevent, produced by a shell script by accident. The library
  // already refuses an empty list; the CLI simply never reached it.
  let sawProject = false;
  const addKeys = (v) => { for (const k of String(v).split(",")) if (k.trim()) projectKeys.push(k.trim()); };
  // BLZ-451: `--ticket ID`, repeatable, comma-separated, and `--ticket=ID`. The SAME three
  // spellings `--project` accepts, deliberately — a filter that silently ignores the
  // spelling it did not expect is worse than no filter, and a second flag that accepts a
  // different subset of them is worse again. `sawTicket` tracks whether the flag was
  // GIVEN, not whether it yielded an id, for the reason spelled out above `sawProject`:
  // `--ticket=$T` with `$T` unset must refuse, never widen.
  const ticketIds = [];
  let sawTicket = false;
  const addTickets = (v) => { for (const k of String(v).split(",")) if (k.trim()) ticketIds.push(k.trim()); };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--apply") { apply = true; continue; }
    if (a === "--fetch") { fetchFlag = true; continue; }
    if (a === "--quiet") { quiet = true; continue; }
    if (a.startsWith("--project=")) { sawProject = true; addKeys(a.slice("--project=".length)); continue; }
    if (a === "--project") {
      // A missing value must NOT swallow the next flag. `--project --apply` scoping the run
      // to a project named "--apply" would refuse every ticket on the board and report a
      // clean, empty, successful run.
      const v = args[i + 1];
      if (!v || v.startsWith("-")) { console.error("--project needs a project key, e.g. --project BLZ"); process.exit(1); }
      sawProject = true; addKeys(v); i += 1; continue;
    }
    if (a.startsWith("--ticket=")) { sawTicket = true; addTickets(a.slice("--ticket=".length)); continue; }
    if (a === "--ticket") {
      // Same trap `--project` has: a missing value must not swallow the next flag. Unlike
      // `--project`'s, this guard changes only the MESSAGE, not the outcome — and that is
      // stated here rather than implied, because a mutation run proved it. No flag can
      // pass `TICKET_ID_RE` (every flag starts with `-`, the pattern starts with a
      // letter), so `--ticket --apply` is refused by the malformed-id check either way
      // and the run still exits 1 having written nothing. What this buys is a refusal
      // that names the typo — "--ticket needs a ticket id" — instead of one reporting
      // "--apply" as a malformed ticket id, which sends the reader looking for a ticket.
      // That wording is what the test pins, because it is the only thing this line owns.
      const v = args[i + 1];
      if (!v || v.startsWith("-")) { console.error("--ticket needs a ticket id, e.g. --ticket BLZ-451"); process.exit(1); }
      sawTicket = true; addTickets(v); i += 1; continue;
    }
    console.error(`unknown flag: ${a}`); process.exit(1);
  }
  // BLZ-402 review finding 3: `reconcile()` -> `loadConfig({ root })` throws `blaze: …` on
  // a malformed BOARD key too, since BLZ-402 — `cli.mjs`'s preflight already catches this
  // for the normal `blaze reconcile` path, but a direct `node reconcile.mjs` bypasses it
  // entirely, and this CLI block previously let the throw reach the top level unwrapped.
  // (`push` is gone as of BLZ-404: reconcile never pushed, and the parameter said it might.)
  let r;
  try {
    r = await reconcile({ fetch: fetchFlag, commit: apply, dryRun: !apply,
      projects: sawProject ? projectKeys : null,
      tickets: sawTicket ? ticketIds : null });
  } catch (e) {
    if (e instanceof InvalidProjectKeyError) { console.error(e.message); process.exit(1); }
    throw e;
  }
  if (!r.ok) { console.error(`reconcile: ${r.error}`); process.exit(1); }
  // AC-5: say what was looked at BEFORE saying what was found, so "nothing to do" can never
  // be read as "the board is in sync" when it means "I only looked at one project".
  if (!quiet || projectKeys.length) {
    console.error(`reconcile: scanned project(s): ${(r.scannedProjects || []).join(", ") || "(none)"}`);
  }
  // BLZ-451, extending BLZ-394 AC-5 to the finer filter: say what was looked at BEFORE
  // saying what was found. Unconditional on `--quiet` — `--quiet` means "print only on
  // change", and a narrowed scope is precisely a reason not to read the absence of a
  // change as an in-sync board.
  if (r.scopedTickets) {
    console.error(`reconcile: scoped to ticket(s): ${r.scopedTickets.join(", ")}`);
  }
  if (r.standalone) { if (!quiet) console.log("reconcile: no projects configured — nothing to reconcile."); process.exit(0); }
  // INF-763: a repo that could not be read is a misconfiguration, not a quiet
  // skip. Warnings go to stderr regardless of --quiet: --quiet means "print only
  // on change", and this is not a change, it is a reason not to trust the run.
  for (const p of r.missingRepos || []) {
    console.error(`reconcile: WARNING — codeRepo not found, skipped: ${p}`);
  }
  // BLZ-350: an unreadable forge is a degraded run, not a clean one. It is NOT
  // fatal — branch and merged-commit signals still reconcile, and on an
  // unsupported forge the condition is permanent, so exiting non-zero on every
  // run would be a nuisance rather than information. It is said, every time,
  // on stderr, regardless of --quiet (same rule as the missing-repo warning:
  // --quiet means "print only on change", and this is a reason not to trust
  // the run rather than a change).
  for (const f of r.forgeErrors || []) {
    console.error(f.severity === "warning"
      ? `reconcile: FORGE DATA — ${f.message}`
      : `reconcile: FORGE UNREADABLE — ${f.message}`);
  }
  // BLZ-484: the git half of the block above, and it obeys the same rule for the same
  // reason — stderr, every run, regardless of `--quiet`, because `--quiet` means "print
  // only on change" and an unreadable probe is precisely a reason not to trust the absence
  // of one. `GIT DEGRADED` is the warning tier (a stale fetch, a repo with no default
  // branch): the run is correct about what it could see and says what it could not.
  // `GIT UNREADABLE` is the other tier, and unlike the forge it is NOT survivable — see
  // the FAILED block below.
  for (const f of r.gitErrors || []) {
    console.error(f.severity === "warning"
      ? `reconcile: GIT DEGRADED — ${f.message}`
      : `reconcile: GIT UNREADABLE — ${f.message}`);
  }
  // BLZ-395: a conflict reconcile can see and deliberately will not act on. Same rule
  // as the two warnings above — stderr, every run, regardless of --quiet, because
  // `--quiet` means "print only on change" and this is precisely a reason not to trust
  // the absence of a change. Not fatal: the run is correct, the board is not, and
  // exiting non-zero on a condition only a human can clear would break every loop that
  // calls this verb.
  for (const f of r.findings || []) {
    console.error(`reconcile: NEEDS ATTENTION — ${f.message}`);
  }
  if (r.configuredRepos > 0 && r.scannedRepos === 0) {
    console.error(`reconcile: FAILED — none of the ${r.configuredRepos} configured codeRepo(s) could be read, so NOTHING was scanned.`);
    console.error("reconcile: this is a misconfiguration, not an in-sync board. If you are in a git worktree, relative codeRepos may be resolving against the wrong parent.");
    process.exit(1);
  }
  // BLZ-484 AC-3: A RUN THAT COULD NOT COMPLETE ITS PROBES DOES NOT REPORT A CLEAN BOARD.
  //
  // This is the half the forge does not have, and the difference is deliberate. An
  // unsupported forge is a PERMANENT property of the repo, so exiting non-zero on it every
  // run would be a nuisance the operator learns to ignore. A `git` that could not fork, or
  // is not installed, or timed out, is an ENVIRONMENT failure — transient, actionable, and
  // the exact state in which "nothing to do" is a lie. So it takes the same shape as the
  // missing-codeRepo FAILED line directly above: named, and non-zero.
  //
  // The exit is split rather than unconditional because a run that DID find changes must
  // still print them — hiding real work behind a probe failure would be a second silence.
  //
  // BOTH HALVES ARE REACHABLE, and an earlier revision of this comment said otherwise. It
  // claimed the falling-through half could not be reached deterministically, on the ground
  // that every signal which can become a change comes from `git`, so a `git` that cannot run
  // takes them all down and `changes` is empty by construction. THAT REASONING SILENTLY
  // ASSUMED PROBE FAILURES ARE ALL-OR-NOTHING, and they are not: a probe fails on its own
  // merits while its siblings answer. Delete one commit object and `rev-parse` exits 0,
  // `for-each-ref` exits 0, and `git log` exits 128 — an ordinary damaged object store, an
  // interrupted fetch, a partial clone. The run then reports a real move AND a failed probe,
  // which is exactly this split. Caught by review; the claim was this lane's own defect class
  // — a sentence asserting more than had been established — written into the fix for it.
  // Both halves are now pinned; see tests/reconcile-git-probe-unreadable.test.mjs, "a run
  // that DID find work prints it BEFORE exiting 1".
  const unreadableProbes = (r.gitErrors || []).filter((f) => f.severity !== "warning");
  if (unreadableProbes.length) {
    console.error(`reconcile: FAILED — ${unreadableProbes.length} git probe(s) could not be completed, so what this run did NOT find is not evidence of an in-sync board.`);
    process.exitCode = 1;
    if (!r.changes.length) process.exit(1);
  }
  // BLZ-404 round 5: "already in sync" was a positive claim about the WHOLE board's git
  // tree — more than reconcile ever knows. Rounds 2 through 4 each tried to make that
  // claim true by either recovering (round 2) or detecting (round 3, round 4) a dirty
  // tree left by some earlier pass, and each attempt was itself refuted (see the PR
  // body): a recovery write with an unbounded blast radius, then a boolean detector that
  // conflated a genuinely failed prior commit with a healthy `commitMode: "batch"` queue
  // and with a human's own untracked file, while still missing the symlinked-`projects/`
  // case it was written to catch. There is no version of this that works from the tree
  // alone — telling those apart needs the pending ledger, not `git status` — so nothing
  // here attempts it any more. Reconcile knows exactly one thing: whether THIS pass found
  // any code-bound change to make. It says exactly that, and nothing about the state of
  // the git tree, which may be dirty for reasons this pass neither caused nor can see.
  if (!r.changes.length) {
    if (!quiet) console.log("reconcile: no code-bound change found — nothing to do.");
    process.exit(0);
  }
  // BLZ-401: a `moved: false` entry never claims a move — `from === to` for every one
  // of them (moved = target !== currentStatus), so the ticket's status is unchanged
  // and the line says what DID change instead: a resolution backfilled, a delivery
  // record recorded for the first time, and/or (mirroring `cleared`'s existing suffix,
  // unchanged in both branches) a record CLEARED because no single PR delivered it.
  for (const c of r.changes) {
    if (c.moved) {
      const what = `${apply ? "moved" : "would move"} ${c.id}: ${c.from} → ${c.to}`;
      console.log(c.cleared
        ? `${what} (and ${apply ? "CLEARED" : "would CLEAR"} its branch/pr — no single PR delivered it)`
        : what);
      continue;
    }
    const verb = apply ? "updated" : "would update";
    const bits = [];
    if (c.resolutionBackfilled) bits.push("its resolution was backfilled");
    if (c.recordFilled) bits.push("its branch/pr was recorded");
    const base = bits.length
      ? `${verb} ${c.id} (still ${c.to}): ${bits.join(" and ")}`
      : `${verb} ${c.id} (still ${c.to})`;
    console.log(c.cleared
      ? `${base} (and ${apply ? "CLEARED" : "would CLEAR"} its branch/pr — no single PR delivered it)`
      : base);
  }
  // BLZ-401: the dry-run tail states BOTH quantities `r.changes` actually carries —
  // `r.changes.length` alone was a change-report count that silently included
  // non-moving writes, so "N change(s)" overstated how many tickets would MOVE.
  const movedCount = r.changes.filter((c) => c.moved).length;
  const nonMovedCount = r.changes.length - movedCount;
  if (!apply) {
    console.log(`(dry-run: ${movedCount} move(s)` +
      (nonMovedCount ? `, ${nonMovedCount} other update(s)` : "") +
      "; rerun with --apply to write locally — reconcile never pushes)");
  }
  // BLZ-404 (review finding 1): the CLI's own commit block is the same code path the
  // supervisor loop now uses, and its output must stay truthful about queued-vs-committed
  // rather than reusing "moved" wording (which only ever described the file, never the
  // commit) for every outcome alike.
  if (apply) {
    // BLZ-401: named the same way the commit message itself now is — a moved count and,
    // only when it is non-zero, a second quantity for the writes that did not move a
    // ticket. `r.changes.length` alone repeats the same overstatement the commit
    // message used to make, one line lower.
    // BLZ-422: the wording (and the exit code each outcome demands) lives in
    // reconcile-commit-report.mjs beside the classifier that produced the outcome, so
    // a new outcome cannot be added to one without the other.
    const line = applySummary({
      outcome: r.commitOutcome, error: r.commitError, movedCount, nonMovedCount,
    });
    if (line) {
      if (line.stream === "err") console.error(line.text); else console.log(line.text);
      if (line.exit) process.exit(line.exit);
    }
  }
}
