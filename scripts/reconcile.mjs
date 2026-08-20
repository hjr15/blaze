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
import { serializeTicket } from "./model/ticket.mjs";
import { ticketPath, fsStorage } from "./model/storage.mjs";
import { isType, workflowFor } from "./model/schema.mjs";
import { isTerminal, resolutionForTerminal } from "./model/workflows.mjs";

const PR_RANK = { MERGED: 3, OPEN: 2, CLOSED: 1 };

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024, ...opts,
    }).trim();
  } catch { return null; }
}

// --- pure decision: git signal + current status + type → target status --------
export function decide({ pr, branch, shipped }, currentStatus, type) {
  // Only delivery-workflow types mirror git state; goal/risk stay manual.
  if (!isType(type) || workflowFor(type) !== "delivery") {
    return { target: currentStatus, branchVal: null, prVal: null, moved: false, skip: true, resolution: undefined };
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
    return { target: currentStatus, branchVal: null, prVal: null, moved: false, skip: true, resolution: undefined };
  }
  // Terminal-sticky: never pull a ticket out of a terminal status automatically.
  if (isTerminal(type, currentStatus)) target = currentStatus;
  const moved = target !== currentStatus;
  const resolution = isTerminal(type, target) ? resolutionForTerminal(type, target) : undefined;
  return { target, branchVal, prVal, moved, skip: false, resolution };
}

// --- anchored leading-id parse of a commit subject ("<KEY>-<n>: desc") --------
// Only the LEADING id counts — a subject that merely mentions a second ticket
// downstream ("fixes BLZ-4") is attributed to its leading id, never the mention.
export function idFromSubject(subject, key) {
  const m = new RegExp("^" + key + "-(\\d+):", "i").exec((subject || "").trim());
  return m ? `${key}-${m[1]}` : null;
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

// --- gather one repo's PR + branch signal, keyed by a project's idFromRef ------
function gatherRepo(repoPath, idFromRef, key, { fetch }) {
  const empty = { prMap: new Map(), branchMap: new Map(), shippedSet: new Set() };
  if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) return empty;
  if (fetch) sh("git", ["-C", repoPath, "fetch", "--prune", "--quiet"], { timeout: 30000 });

  // Default-branch commit signal: a <KEY>-<n>: commit reachable from the code
  // repo's default-branch HEAD means that ticket shipped (used for bundled
  // epic-children that have no branch/PR of their own). Computed FIRST because
  // buildPrMap corroborates against it (INF-735).
  const shippedSet = new Set();
  const ref = defaultBranchRef(repoPath);
  const subs = sh("git", ["-C", repoPath, "log", ref, "--format=%s"]) || "";
  for (const line of subs.split("\n")) {
    const id = idFromSubject(line, key);
    if (id) shippedSet.add(id);
  }

  const prJson = sh("gh", ["pr", "list", "--state", "all", "--limit", "1000",
    "--json", "number,url,headRefName,state,title"], { cwd: repoPath });
  const prMap = buildPrMap(JSON.parse(prJson || "[]"), idFromRef, shippedSet);

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

  return { prMap, branchMap, shippedSet };
}

// --- aggregate the most-advanced signal across all of a project's repos -------
// Tracks which configured repos were actually READABLE (INF-763). A path that
// isn't a git repo used to be skipped in silence, so a board whose repos all
// failed to resolve reported "already in sync" having scanned nothing at all.
function gatherProject(project, { fetch }) {
  const prMap = new Map(), branchMap = new Map(), shippedSet = new Set();
  const missingRepos = [];
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
  }
  return {
    prMap, branchMap, shippedSet, missingRepos, scannedRepos,
    configuredRepos: project.codeRepoPaths.length,
  };
}

// --- the reconcile pass -------------------------------------------------------
export function reconcile({
  fetch = false, commit = false, push = false, dryRun = true, root, projectsDir,
  readStorage = fsReadStorage, storage = fsStorage,
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

  const today = new Date().toISOString().slice(0, 10);
  const cfg = loadConfig({ root });
  const keys = listProjects(cfg);
  if (!keys.length) return { ok: true, standalone: true, changes: [], committed: false, pushed: false,
    missingRepos: [], scannedRepos: 0, configuredRepos: 0 };

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
    if (d.branchVal && fm.branch !== d.branchVal) { fm.branch = d.branchVal; dirty = true; }
    if (d.prVal && fm.pr !== d.prVal) { fm.pr = d.prVal; dirty = true; }
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
      const text = serializeTicket({ frontmatter: fm, body: t.body });
      if (d.moved) {
        // Same rule as move.mjs: the destination comes from the ticket's own project
        // via the path authority, never from arithmetic on t.file.
        const { file: dest } = ticketPath.relocate(projectsDir, t.project, d.target, t.file);
        // One driver call, not write-then-rename: move() owns that ordering, and it
        // writes the text at the DESTINATION so a crash cannot leave the old body at
        // the new path.
        storage.move(t.file, dest, text);
        touched.push(t.file);
        if (dest !== t.file) touched.push(dest);
      } else {
        storage.write(t.file, text);
        touched.push(t.file);
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
  return { ok: true, changes, committed, pushed: false, missingRepos, scannedRepos, configuredRepos };
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
  const r = reconcile({ fetch: fetchFlag, commit: apply, push: false, dryRun: !apply });
  if (!r.ok) { console.error(`reconcile: ${r.error}`); process.exit(1); }
  if (r.standalone) { if (!quiet) console.log("reconcile: no projects configured — nothing to reconcile."); process.exit(0); }
  // INF-763: a repo that could not be read is a misconfiguration, not a quiet
  // skip. Warnings go to stderr regardless of --quiet: --quiet means "print only
  // on change", and this is not a change, it is a reason not to trust the run.
  for (const p of r.missingRepos || []) {
    console.error(`reconcile: WARNING — codeRepo not found, skipped: ${p}`);
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
