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
import { loadConfig, listProjects, loadProject, resolveRoots } from "./config.mjs";
import { fsReadStorage } from "./model/read-storage.mjs";
import { fsStorage } from "./model/storage.mjs";
import { fsWritePort } from "./model/write-port.mjs";
import { isType, workflowFor } from "./model/schema.mjs";
import { isTerminal, resolutionForTerminal } from "./model/workflows.mjs";
import { commitOrQueue } from "./commit-or-queue.mjs";
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

// --- pure decision: git signal + current status + type → target status --------
export function decide({ pr, branch, shipped, delivererAmbiguous = false }, currentStatus, type) {
  // Only delivery-workflow types mirror git state; goal/risk stay manual.
  if (!isType(type) || workflowFor(type) !== "delivery") {
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
  // `pr` here has already passed INF-735's corroboration gate in `buildPrMap`, so this
  // is "a CORROBORATED open PR" — an uncorroborated claim is not visible to the veto
  // and must not be visible to this finding either, or the report would be noisier
  // than the veto it is reporting on.
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
// The list must be CONTIGUOUS and end at the colon, which is what preserves
// `idFromSubject`'s rule that a downstream mention is never a claim — `BLZ-1: fixes
// BLZ-4` still yields only BLZ-1. Separators are the ones the house actually uses.
export function idsFromSubject(subject, key) {
  // A bare number continues the list only after `/` — `KEY-a/b/c:` is the house's own
  // shorthand. After `+`, `,` or `&` the key must be repeated, which is how the house
  // writes those. Allowing a bare number everywhere let `BLZ-1 + 2026: annual review`
  // claim a ticket BLZ-2026 that does not exist; nothing documented that latitude.
  const head = new RegExp(
    "^" + key + "-\\d+(?:(?:\\s*/\\s*(?:" + key + "-)?\\d+)|(?:\\s*[+,&]\\s*" + key + "-\\d+))*(?=\\s*:)", "i",
  ).exec(String(subject || "").trim());
  if (!head) return [];
  const ids = [];
  const each = new RegExp("(?:" + key + "-)?(\\d+)", "gi");
  for (const m of head[0].matchAll(each)) {
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
export function claimCorroborated(id, { title = "", shippedSet = null } = {}) {
  if (shippedSet && shippedSet.has(id)) return true;
  return new RegExp("\\b" + id + "\\b", "i").test(title || "");
}

// --- resolve a repo's default-branch LOG REF, preferring the remote-tracking ---
// branch. prMap comes from live `gh pr list` and branchMap reads
// refs/remotes/origin, so the shipped signal must read the SAME freshness — the
// remote-tracking default branch — not local `main` (which `blaze reconcile
// --fetch` does not update). A bundled child merged on origin/main would
// otherwise be missed while a solo merged-PR ticket flips to done: asymmetric
// under-reporting. Order: origin/HEAD → origin/main|master → local main|master
// (remote-less repos: fixtures + blaze-pm itself) → "main" fallback.
function defaultBranchRef(repoPath) {
  const head = sh("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (head && head !== "origin/HEAD") return head; // e.g. "origin/main" — keep the remote-tracking ref verbatim
  for (const b of ["origin/main", "origin/master", "main", "master"]) {
    if (sh("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", b]) !== null) return b;
  }
  return "main";
}

// --- rank a repo's PRs into id → best-PR, gated on corroboration (INF-735) -----
// Ranking is unchanged for claims that survive the gate; the gate runs FIRST, so
// an uncorroborated MERGED PR is dropped rather than merely out-ranked — it can
// no longer beat a corroborated OPEN PR from the ticket's real repo.
function corroboratedByTicket(prs, idFromRef, shippedSet) {
  const byId = new Map();
  for (const pr of prs || []) {
    const id = idFromRef(pr.headRefName);
    if (!id) continue;
    if (!claimCorroborated(id, { title: pr.title, shippedSet })) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(pr);
  }
  return byId;
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

// --- rank a repo's PRs into id → best-PR, gated on corroboration (INF-735) -----
// Ranking is unchanged for claims that survive the gate; the gate runs FIRST, so
// an uncorroborated MERGED PR is dropped rather than merely out-ranked — it can
// no longer beat a corroborated OPEN PR from the ticket's real repo.
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
 *  Order: RANK, then TITLE CLAIM, then RECORDABLE, then lower number.
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
  if (rank(pr) !== rank(best)) return rank(pr) > rank(best);
  const claim = [prTitleClaim(pr, id), prTitleClaim(best, id)];
  if (claim[0] !== claim[1]) return claim[0] > claim[1];
  if (recordable(pr) !== recordable(best)) return recordable(pr) > recordable(best);
  return pr.number < best.number;
}

export function buildPrMap(prs, idFromRef, shippedSet) {
  const prMap = new Map();
  for (const [id, candidates] of corroboratedByTicket(prs, idFromRef, shippedSet)) {
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
function sanitisePr(pr) {
  if (!pr || typeof pr !== "object") return null;
  const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "") : v);
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
  const empty = { prMap: new Map(), branchMap: new Map(), shippedSet: new Set(), forgeErrors: [],
                  candidates: new Map() };
  if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) return empty;
  if (fetch) sh("git", ["-C", repoPath, "fetch", "--prune", "--quiet"], { timeout: 30000 });

  // Default-branch commit signal: a <KEY>-<n>: commit reachable from the code
  // repo's default-branch HEAD means that ticket shipped (used for bundled
  // epic-children that have no branch/PR of their own). Computed FIRST because
  // buildPrMap corroborates against it (INF-735).
  const shippedSet = new Set();
  const ref = defaultBranchRef(repoPath);
  // BLZ-131: read whole messages, not subjects. `%x00%B` prefixes each commit with
  // a NUL, which is the one byte a commit message cannot contain — so splitting on
  // it recovers exact commit boundaries, and boundaries are what make line 1 (the
  // subject, unbulleted) distinguishable from a body line (bullet required).
  const log = sh("git", ["-C", repoPath, "log", ref, "--format=%x00%B"]) || "";
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

  const refs = (sh("git", ["-C", repoPath, "for-each-ref", "--format=%(refname:short)",
    "refs/heads", "refs/remotes/origin"]) || "")
    .split("\n")
    .map((r) => r.replace(/^origin\//, "").trim())
    .filter((r) => r && r !== "HEAD");

  // What the branch itself says: the subjects unique to it (not already on the
  // default branch), plus whether its tip IS the default tip — the fresh-vs-stale
  // discriminator, since both have zero unique subjects.
  const defaultTip = sh("git", ["-C", repoPath, "rev-parse", ref]);
  const inspect = (branchRef) => ({
    own: (sh("git", ["-C", repoPath, "log", `${branchRef}`, `^${ref}`, "--format=%s"]) || "")
      .split("\n").filter(Boolean),
    sameTipAsDefault: Boolean(defaultTip) &&
      sh("git", ["-C", repoPath, "rev-parse", branchRef]) === defaultTip,
  });
  const branchMap = buildBranchMap(refs, idFromRef, { key, shippedSet, inspect });

  return { prMap, branchMap, shippedSet, forgeErrors, candidates };
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

// --- aggregate the most-advanced signal across all of a project's repos -------
// Tracks which configured repos were actually READABLE (INF-763). A path that
// isn't a git repo used to be skipped in silence, so a board whose repos all
// failed to resolve reported "already in sync" having scanned nothing at all.
function gatherProject(project, { fetch }) {
  const prMap = new Map(), branchMap = new Map(), shippedSet = new Set();
  const missingRepos = [], forgeErrors = [];
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
    prMap, branchMap, shippedSet, missingRepos, scannedRepos, forgeErrors, ambiguous,
    configuredRepos: project.codeRepoPaths.length,
  };
}

// --- BLZ-404 round 2 (blocking 1): finish an unfinished pass, don't call it in sync ---
// The commit block below used to gate on `touched.length` alone — the tickets THIS PASS
// decided to write. That is right for "did this pass find anything new", and wrong for
// "is there anything left to commit": a previous pass that wrote ticket files and then
// FAILED to commit them (a held lock, a failing pre-commit hook) leaves those files on
// disk, at their target status, uncommitted. The very next pass samples git+PR state,
// finds the board already where it should be, and so decides nothing and writes nothing
// of its own — `touched` is empty — even though the tree is still dirty from before.
// Gating the commit on `touched.length` alone then made reconcile — the one verb whose
// whole job is "make the board match git state" — silently leave that job undone and
// report a healthy run.
//
// Scoped to `projectsDir`, never the whole repo: this is deliberately NOT `git add -A`.
// A human's unrelated uncommitted work sitting elsewhere in the same board repo (a draft
// doc, an unrelated config edit) must never be swept into a reconcile commit — only the
// board's own ticket tree is this verb's business, exactly as `--project`'s blast-radius
// scoping already established for the SELECTION half of this same verb.
function dirtyTicketPaths(root, projectsDir) {
  // Deliberately NOT `shResult`/`sh`: both `.trim()` the WHOLE captured blob, and
  // porcelain's own unstaged-change marker is a LEADING space (" D path" — the first
  // column is the index status, blank; the second is the worktree status, D). Trimming
  // the blob eats exactly that leading space off the FIRST line only, shifting every
  // fixed-offset slice on it by one column and truncating the path's first character
  // ("projects/…" read as "rojects/…") — caught by this function's own pinning test
  // reproducing the exact " D …" line the bug this whole fix exists for produces.
  let stdout;
  try {
    stdout = execFileSync("git", ["-C", root, "status", "--porcelain", "--", projectsDir],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const out = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    // Porcelain v1: two status chars, a space, then the path. A rename/copy line reads
    // "old -> new"; the file that exists on disk NOW (and so is what `git add` needs) is
    // the one after the arrow.
    const path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    out.push(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return out;
}

// --- the reconcile pass -------------------------------------------------------
export async function reconcile({
  fetch = false, commit = false, dryRun = true, root, projectsDir,
  readStorage = fsReadStorage, storage = fsStorage, writePort = null, projects = null,
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
  if (wanted && !wanted.length) {
    // `configuredRepos: 0`, not `configured.length`: that field counts REPOS, and putting a
    // project count in it was a wrong value in a named field, unreachable or not.
    // BLZ-404: `dryRun` on every return site, refusals included — `changes` is a PROPOSAL
    // list on a dry run and a RECORD of writes on an applied run, and a caller reading a
    // refusal's (empty) `changes` could not previously tell which sense it would have been.
    return { ok: false, error: "--project was given no project key", changes: [], committed: false,
      commitOutcome: "none", commitError: null,
      pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0,
      forgeErrors: [], findings: [], scannedProjects: [], dryRun };
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
      configuredRepos: 0, forgeErrors: [], findings: [], scannedProjects: [], dryRun };
  }
  if (!configured.length) return { ok: true, standalone: true, changes: [], committed: false,
    commitOutcome: "none", commitError: null,
    pushed: false, missingRepos: [], scannedRepos: 0, configuredRepos: 0, forgeErrors: [],
    findings: [], scannedProjects: [], dryRun };
  const keys = wanted || configured;

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
        scannedRepos: 0, configuredRepos: 0, forgeErrors: [], findings: [],
        scannedProjects: [], dryRun };
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
  for (const t of readStorage.listTickets(projectsDir)) {
    const type = t.frontmatter.type;
    // Scope on the DIRECTORY as well as the frontmatter. `sig` is keyed by the
    // frontmatter's project, but the write lands by `t.project` — the directory the
    // ticket sits in — so a ticket at `projects/OBA/…` carrying `project: INF` was
    // selected by an `INF` filter and then written into `projects/OBA/`, producing a
    // commit that names its scope as (INF) while touching another project's files.
    // Blast radius, which is all this ticket is about, is a property of the path.
    if (wanted && !keys.includes(t.project)) continue;
    const s = sig.get(t.frontmatter.project);
    if (!s) continue;
    const d = decide({
      pr: s.prMap.get(t.frontmatter.id),
      branch: s.branchMap.get(t.frontmatter.id),
      shipped: s.shippedSet.has(t.frontmatter.id),
      delivererAmbiguous: s.ambiguous ? s.ambiguous.has(t.frontmatter.id) : false,
    }, t.status, type);
    if (d.skip) continue;

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
      // Truthiness, to match `hadRecord` exactly. `!== undefined` disagreed with it on
      // the empty string, and both DB storages project an absent record as
      // `branch: row.branch ?? ""` (`toRecord`, kept identical across drivers by
      // driver-conformance.test.mjs). `hadRecord` reads "" as absent while a
      // `!== undefined` guard reads it as present, so the pair would clear-and-dirty
      // the same ticket on every tick — a git commit per tick under `blaze start`.
      if (fm.branch || fm.pr) {
        delete fm.branch;
        delete fm.pr;
        dirty = true;
        cleared = true;
      }
      const refs = (s.ambiguous && s.ambiguous.get(t.frontmatter.id)) || [];
      // Named through `namePr`, exactly like the sibling finding. This site had its own
      // formatter, and round 6 gave `refs` a shape it had never seen — an entry whose
      // `number` is null — so it printed `#null`, and suppressed the url in precisely the
      // case where the url is the only identifier there is. Three places in this file turn
      // a PR into operator-facing text; unifying the three DECIDERS and leaving the three
      // RENDERERS apart is how the same drift reappeared one layer down.
      const named = refs.map((r) => namePr(r));
      findings.push({
        kind: "ambiguous-deliverer",
        id: t.frontmatter.id,
        status: t.status,
        prs: refs,
        message: `${t.frontmatter.id} has ${refs.length || "more than one"} merged PRs claiming it` +
          (named.length ? ` (${named.join(", ")})` : "") +
          `, and none claims it more strongly than the rest. Reconcile recorded NO ` +
          `branch/pr rather than guess which one delivered it — a wrong delivery record ` +
          `is permanent, a blank one is not. Set it by hand if it matters.`,
      });
    }
    if (d.branchVal && write() && fm.branch !== d.branchVal) { fm.branch = d.branchVal; dirty = true; }
    if (d.prVal && write() && fm.pr !== d.prVal) { fm.pr = d.prVal; dirty = true; }
    if (d.resolution !== undefined && fm.resolution !== d.resolution) { fm.resolution = d.resolution; dirty = true; }
    if (d.moved) { fm.updated = today; dirty = true; }
    if (!dirty) continue;

    // Always record the would-be change; only write files when not a dry-run
    changes.push({ id: t.frontmatter.id, from: t.status, to: d.target, moved: d.moved, cleared });

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
  let commitOutcome = "none"; // "none" | "committed" | "queued" | "locked" | "failed"
  let commitError = null;
  // BLZ-404 round 2 (blocking 1): when THIS pass wrote nothing (`touched` empty), that is
  // not yet "nothing to commit" — a previous pass may have written ticket files and then
  // failed to commit them. `recoveredCount` says which case this run landed in, so the
  // CLI and the supervisor can tell "genuinely nothing outstanding" from "just finished
  // someone else's unfinished write" without re-deriving it themselves.
  let recoveredCount = 0;
  if (commit && !dryRun) {
    let files = touched;
    let message = `chore(board): reconcile ${changes.length} ticket(s) to git state` +
      (wanted ? ` (${keys.join(", ")})` : "");
    if (!files.length) {
      const dirty = dirtyTicketPaths(root, projectsDir).map((p) => join(root, p));
      if (dirty.length) {
        files = dirty;
        recoveredCount = dirty.length;
        message = `chore(board): reconcile recovers ${dirty.length} uncommitted ticket ` +
          "change(s) left by a previous pass" + (wanted ? ` (${keys.join(", ")})` : "");
      }
    }
    if (files.length) {
      const c = commitOrQueue({
        root, mode: cfg.commitMode, op: "reconcile", id: `reconcile:${keys.join(",")}`,
        message, files,
      });
      if (c.queued) {
        commitOutcome = "queued";
      } else if (c.ok) {
        committed = true;
        commitOutcome = "committed";
      } else if (c.locked) {
        commitOutcome = "locked";
        commitError = "the advisory commit lock is held by another writer";
      } else {
        commitOutcome = "failed";
        commitError = `git commit failed (exit status ${c.status})`;
      }
    }
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
  // BLZ-394 AC-5: a filtered run must not be mistakable for an in-sync board, so the result
  // says which projects it looked at — on every run, not only filtered ones, because the
  // caller cannot tell the difference from a `changes: []` alone.
  // BLZ-404: `dryRun` travels with the result too — `changes` is a PROPOSAL list on a dry
  // run and a RECORD of writes on an applied run, and until now no consumer could tell
  // which sense it was looking at without already knowing what it had passed in.
  return { ok: true, changes, committed, commitOutcome, commitError, recoveredCount, pushed,
           missingRepos, scannedRepos, configuredRepos, forgeErrors, findings,
           scannedProjects: keys, dryRun };
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
    console.error(`unknown flag: ${a}`); process.exit(1);
  }
  const r = await reconcile({ fetch: fetchFlag, commit: apply, dryRun: !apply,
    projects: sawProject ? projectKeys : null });
  if (!r.ok) { console.error(`reconcile: ${r.error}`); process.exit(1); }
  // AC-5: say what was looked at BEFORE saying what was found, so "nothing to do" can never
  // be read as "the board is in sync" when it means "I only looked at one project".
  if (!quiet || projectKeys.length) {
    console.error(`reconcile: scanned project(s): ${(r.scannedProjects || []).join(", ") || "(none)"}`);
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
  // BLZ-404 round 2 (blocking 1): "already in sync" is a positive claim about the WHOLE
  // board, and it must not fire merely because THIS pass found nothing NEW to decide.
  // `reconcile()`'s own commit block (see `dirtyTicketPaths` above it) already tried, in
  // this very call, to finish any commit a previous pass left behind — so by the time we
  // get here `r.commitOutcome` is `"none"` only when there is truly nothing outstanding:
  // always true in dry-run mode (which never commits at all), and in apply mode true only
  // when the board really is clean. When it is anything else (`committed`, `queued`,
  // `locked`, `failed`), that outcome is reported below instead — never silently, and
  // never as "in sync".
  if (!r.changes.length && (!apply || r.commitOutcome === "none")) {
    if (!quiet) console.log("reconcile: already in sync — nothing to do.");
    process.exit(0);
  }
  for (const c of r.changes) {
    const what = `${apply ? "moved" : "would move"} ${c.id}: ${c.from} → ${c.to}`;
    console.log(c.cleared
      ? `${what} (and ${apply ? "CLEARED" : "would CLEAR"} its branch/pr — no single PR delivered it)`
      : what);
  }
  if (!apply) console.log(`(dry-run: ${r.changes.length} change(s); rerun with --apply to write locally — reconcile never pushes)`);
  // BLZ-404 (review finding 1): the CLI's own commit block is the same code path the
  // supervisor loop now uses, and its output must stay truthful about queued-vs-committed
  // rather than reusing "moved" wording (which only ever described the file, never the
  // commit) for every outcome alike.
  if (apply) {
    const count = r.changes.length || r.recoveredCount;
    if (r.commitOutcome === "queued") {
      console.log(`reconcile: queued (commitMode: batch) — run \`blaze commit\` to flush ${count} change(s).`);
    } else if (r.commitOutcome === "committed") {
      // BLZ-404 round 2 (blocking 1): a run whose own `changes` is empty but which still
      // committed did NOT decide anything new — it finished a PREVIOUS pass's write. Saying
      // "committed 0 change(s)" there would be its own small lie in the opposite direction.
      console.log(r.recoveredCount
        ? `reconcile: recovered and committed ${r.recoveredCount} ticket change(s) left uncommitted by an earlier pass.`
        : `reconcile: committed ${count} change(s).`);
    } else if (r.commitOutcome === "locked") {
      console.error(`reconcile: FAILED TO COMMIT — ${r.commitError}. Ticket file(s) were already ` +
        "written to disk and are now UNCOMMITTED (a dirty tree), not merely un-applied. " +
        "Re-run once the lock clears, or commit the tree manually.");
      process.exit(1);
    } else if (r.commitOutcome === "failed") {
      // BLZ-404 round 2 (blocking 1, item 3): this branch used to share the lock's own
      // wording ("re-run once the lock clears"), which is FALSE for a failing pre-commit
      // hook or a detached HEAD — outcomes that reach "failed", never "locked", and carry
      // no lock at all. Each outcome gets advice that is true for it.
      console.error(`reconcile: FAILED TO COMMIT — ${r.commitError}. Ticket file(s) were already ` +
        "written to disk and are now UNCOMMITTED (a dirty tree), not merely un-applied. " +
        "No lock is involved in this failure — check for a failing pre-commit hook, a detached " +
        "HEAD, or another reason `git commit` itself refuses, fix it, then commit the tree " +
        "manually or re-run.");
      process.exit(1);
    }
  }
}
