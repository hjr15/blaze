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
const PR_RANK = { OPEN: 3, MERGED: 2, CLOSED: 1 };

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
export function decide({ pr, branch, shipped }, currentStatus, type) {
  // Only delivery-workflow types mirror git state; goal/risk stay manual.
  if (!isType(type) || workflowFor(type) !== "delivery") {
    return { target: currentStatus, branchVal: null, prVal: null, moved: false, skip: true,
             resolution: undefined, recordIfAbsentOnly: false };
  }
  let target, branchVal = null, prVal = null;
  if (pr) {
    // Delivery workflow middle statuses ("in-review"/"in-progress") are intentional literals here;
    // this function is already delivery-guarded above, so there's no need to re-derive them from rules.
    target = pr.state === "MERGED" ? "done" : pr.state === "OPEN" ? "in-review" : "in-progress";
    branchVal = pr.headRefName;
    prVal = `#${pr.number} — ${pr.url}`;
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
             resolution: undefined, recordIfAbsentOnly: false };
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
  const moved = target !== currentStatus;
  const resolution = isTerminal(type, target) ? resolutionForTerminal(type, target) : undefined;
  return { target, branchVal, prVal, moved, skip: false, resolution, recordIfAbsentOnly };
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
// repo's own history, where 23 of 312 commits on origin/main carry such a bullet
// under a ticket subject (102 bullet lines), recovering 28 ids no subject names.
//
// TWO CONDITIONS, AND BOTH ARE LOAD-BEARING.
//
//   1. The marker is `* `, which is what GitHub writes and nothing else here does.
//   2. The subject must OPEN with a ticket-id list — `KEY-n:`, and the multi-ticket
//      forms the house also writes, `KEY-a/b/c:` and `KEY-a + KEY-b:`. The commit must
//      itself be a squashed ticket PR, which is BLZ-131's premise: per-ticket commits
//      inside a FEATURE's PR. Every id in that leading list counts, and the list ends
//      at the colon, so `KEY-1: fixes KEY-4` still claims only KEY-1.
//
// Condition 2 exists because the first cut, which honoured any `[*+-]` bullet under any
// subject, turned the board's own ledger into a delivery signal. `commit-runner.mjs`
// writes every batch board commit's body as `- <KEY>-<n>: <board op> [session]`, and
// the board repo is itself a configured codeRepo for its own project — the hazard
// INF-735's comment already names. Measured on the board repo's origin/main: 426 ids
// harvested that had shipped nothing. A review reproduced `decide()` moving 137 tickets
// `defined → done` off lines reading `edit labels` — that count taken against the board's
// local HEAD, the 299-id tree, so it is quoted with its own ref. That is BLZ-130's
// failure at a hundred times the scale, inside the fix for its sibling.
//
// Neither condition alone suffices. The board also carries squashed PRs of ticket-BODY
// edits, subject `blaze: … board + ticket work (#60)`, whose bullets are real `KEY-n:`
// subjects describing an edit rather than a delivery — the subject gate drops those.
// And ledger lines swept into a PR that IS titled for a ticket are what the marker
// drops. On the board repo, origin/main: 426 ids ungated, 49 with the subject gate
// alone, 2 with both — and both survivors (INF-701, INF-672) are genuine bundled
// children of a `KEY-n:` epic PR. On the code repo the rule recovers 28 ids.
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
  // Column 0, not merely "starts with a bullet". All 104 such lines in this repo's
  // history sit at column 0, which is where GitHub writes them; an indented one is a
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
export function buildPrMap(prs, idFromRef, shippedSet) {
  const prMap = new Map();
  for (const pr of prs || []) {
    const id = idFromRef(pr.headRefName);
    if (!id) continue;
    if (!claimCorroborated(id, { title: pr.title, shippedSet })) continue;
    const cur = prMap.get(id);
    const better = !cur || (PR_RANK[pr.state] || 0) > (PR_RANK[cur.state] || 0) ||
      ((PR_RANK[pr.state] || 0) === (PR_RANK[cur.state] || 0) && pr.number > cur.number);
    if (better) prMap.set(id, pr);
  }
  return prMap;
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
    const prs = JSON.parse(res.stdout || "[]");
    return { prs: Array.isArray(prs) ? prs : [], forgeErrors: [] };
  } catch (e) {
    return { prs: [], forgeErrors: [{
      repo: repoPath, remotes: urls, host: askedHost, reason: "gh-unparsable", detail: String(e.message || e),
      message: `\`gh pr list\` returned output Blaze could not parse as JSON in ${repoPath}. ${UNREACHABLE}`,
    }] };
  }
}

// --- gather one repo's PR + branch signal, keyed by a project's idFromRef ------
function gatherRepo(repoPath, idFromRef, key, { fetch }) {
  const empty = { prMap: new Map(), branchMap: new Map(), shippedSet: new Set(), forgeErrors: [] };
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

  return { prMap, branchMap, shippedSet, forgeErrors };
}

// --- aggregate the most-advanced signal across all of a project's repos -------
// Tracks which configured repos were actually READABLE (INF-763). A path that
// isn't a git repo used to be skipped in silence, so a board whose repos all
// failed to resolve reported "already in sync" having scanned nothing at all.
function gatherProject(project, { fetch }) {
  const prMap = new Map(), branchMap = new Map(), shippedSet = new Set();
  const missingRepos = [], forgeErrors = [];
  let scannedRepos = 0;
  for (const repo of project.codeRepoPaths) {
    if (!existsSync(repo) || !existsSync(join(repo, ".git"))) { missingRepos.push(repo); continue; }
    scannedRepos += 1;
    const r = gatherRepo(repo, project.idFromRef, project.key, { fetch });
    for (const [id, pr] of r.prMap) {
      const cur = prMap.get(id);
      if (!cur || (PR_RANK[pr.state] || 0) > (PR_RANK[cur.state] || 0)) prMap.set(id, pr);
    }
    for (const [id, b] of r.branchMap) if (!branchMap.has(id)) branchMap.set(id, b);
    for (const id of r.shippedSet) shippedSet.add(id);
    for (const f of r.forgeErrors || []) forgeErrors.push(f);
  }
  return {
    prMap, branchMap, shippedSet, missingRepos, scannedRepos, forgeErrors,
    configuredRepos: project.codeRepoPaths.length,
  };
}

// --- the reconcile pass -------------------------------------------------------
export async function reconcile({
  fetch = false, commit = false, push = false, dryRun = true, root, projectsDir,
  readStorage = fsReadStorage, storage = fsStorage, writePort = null,
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
  const keys = listProjects(cfg);
  if (!keys.length) return { ok: true, standalone: true, changes: [], committed: false, pushed: false,
    missingRepos: [], scannedRepos: 0, configuredRepos: 0, forgeErrors: [] };

  const sig = new Map();
  for (const key of keys) sig.set(key, gatherProject(loadProject(key, { root, projectsDir }), { fetch }));

  const changes = [];
  const touched = [];
  for (const t of readStorage.listTickets(projectsDir)) {
    const type = t.frontmatter.type;
    const s = sig.get(t.frontmatter.project);
    if (!s) continue;
    const d = decide({ pr: s.prMap.get(t.frontmatter.id), branch: s.branchMap.get(t.frontmatter.id), shipped: s.shippedSet.has(t.frontmatter.id) }, t.status, type);
    if (d.skip) continue;

    const fm = { ...t.frontmatter };
    let dirty = false;
    // Terminal: fill a blank RECORD, never replace one. See `recordIfAbsentOnly` in
    // decide(). The record is one unit, not two fields: ADR-0023 and the guide both say a
    // terminal ticket "may ACQUIRE a delivery record it never had, and may never have one
    // replaced". Judged per-field it was neither. A `done` ticket with `branch` set and
    // `pr` blank had its `pr` filled from whatever PR ranked top — and ranking breaks ties
    // on PR NUMBER, so that is the LATEST merged PR, not the one that delivered the work.
    // A follow-up docs PR merged under the same key therefore stamped itself onto half the
    // record while `branch` still named the deliverer: one record naming two different PRs,
    // which is round 3's bug wearing fill clothing. 8 done tickets on the board are in that
    // shape today.
    //
    // Computed EAGERLY — before either write below — and that, not which object it reads,
    // is the load-bearing property. `fm` is a fresh copy and is unmutated at this line, so
    // `Boolean(fm.branch || fm.pr)` here would be exactly equivalent. What breaks is making
    // it LAZY: evaluated inside `keep()`, the pr check would see the branch just written by
    // the line above, skip the pr write, and re-create round 2's write-nothing direction on
    // the 1,141 done tickets that carry neither field. Reading `t.frontmatter` says
    // "the state before this loop touched anything" out loud, which is the intent.
    const hadRecord = Boolean(t.frontmatter.branch || t.frontmatter.pr);
    const keep = () => d.recordIfAbsentOnly && hadRecord;
    if (d.branchVal && !keep() && fm.branch !== d.branchVal) { fm.branch = d.branchVal; dirty = true; }
    if (d.prVal && !keep() && fm.pr !== d.prVal) { fm.pr = d.prVal; dirty = true; }
    if (d.resolution !== undefined && fm.resolution !== d.resolution) { fm.resolution = d.resolution; dirty = true; }
    if (d.moved) { fm.updated = today; dirty = true; }
    if (!dirty) continue;

    // Always record the would-be change; only write files when not a dry-run
    changes.push({ id: t.frontmatter.id, from: t.status, to: d.target, moved: d.moved });

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
  if (commit && !dryRun && touched.length) {
    sh("git", ["-C", root, "add", "--", ...touched]);
    committed = sh("git", ["-C", root, "commit", "-m",
      `chore(board): reconcile ${changes.length} ticket(s) to git state`, "--", ...touched]) !== null;
  }
  // push is never performed — hardcoded false regardless of the push param
  // INF-763: surface repo reachability so a caller can tell "scanned everything,
  // nothing to change" from "scanned nothing, so of course nothing changed".
  const missingRepos = [...new Set([...sig.values()].flatMap((g) => g.missingRepos))];
  const scannedRepos = [...sig.values()].reduce((n, g) => n + g.scannedRepos, 0);
  const configuredRepos = [...sig.values()].reduce((n, g) => n + g.configuredRepos, 0);
  // BLZ-350: the forge outcome travels with the result. An empty prMap now means
  // "no pull requests"; anything else that happened is named here instead.
  const forgeErrors = [...sig.values()].flatMap((g) => g.forgeErrors || []);
  return { ok: true, changes, committed, pushed: false, missingRepos, scannedRepos, configuredRepos,
           forgeErrors };
}

// --- CLI ----------------------------------------------------------------------
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let apply = false, fetchFlag = false, quiet = false;
  for (const a of args) {
    switch (a) {
      case "--apply": apply = true; break;
      case "--fetch": fetchFlag = true; break;
      case "--quiet": quiet = true; break;
      default: console.error(`unknown flag: ${a}`); process.exit(1);
    }
  }
  const r = await reconcile({ fetch: fetchFlag, commit: apply, push: false, dryRun: !apply });
  if (!r.ok) { console.error(`reconcile: ${r.error}`); process.exit(1); }
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
    console.error(`reconcile: FORGE UNREADABLE — ${f.message}`);
  }
  if (r.configuredRepos > 0 && r.scannedRepos === 0) {
    console.error(`reconcile: FAILED — none of the ${r.configuredRepos} configured codeRepo(s) could be read, so NOTHING was scanned.`);
    console.error("reconcile: this is a misconfiguration, not an in-sync board. If you are in a git worktree, relative codeRepos may be resolving against the wrong parent.");
    process.exit(1);
  }
  if (!r.changes.length) { if (!quiet) console.log("reconcile: already in sync — nothing to do."); process.exit(0); }
  for (const c of r.changes) console.log(`${apply ? "moved" : "would move"} ${c.id}: ${c.from} → ${c.to}`);
  if (!apply) console.log(`(dry-run: ${r.changes.length} change(s); rerun with --apply to write locally — reconcile never pushes)`);
}
