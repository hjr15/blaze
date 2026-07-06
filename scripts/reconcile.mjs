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
import { writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, listProjects, loadProject, resolveRoots } from "./config.mjs";
import { walkTickets } from "./model/index.mjs";
import { serializeTicket } from "./model/ticket.mjs";
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
export function decide({ pr, branch }, currentStatus, type) {
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
  } else {
    return { target: currentStatus, branchVal: null, prVal: null, moved: false, skip: true, resolution: undefined };
  }
  // Terminal-sticky: never pull a ticket out of a terminal status automatically.
  if (isTerminal(type, currentStatus)) target = currentStatus;
  const moved = target !== currentStatus;
  const resolution = isTerminal(type, target) ? resolutionForTerminal(type, target) : undefined;
  return { target, branchVal, prVal, moved, skip: false, resolution };
}

// --- gather one repo's PR + branch signal, keyed by a project's idFromRef ------
function gatherRepo(repoPath, idFromRef, { fetch }) {
  const empty = { prMap: new Map(), branchMap: new Map() };
  if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) return empty;
  if (fetch) sh("git", ["-C", repoPath, "fetch", "--prune", "--quiet"], { timeout: 30000 });

  const prMap = new Map();
  const prJson = sh("gh", ["pr", "list", "--state", "all", "--limit", "1000",
    "--json", "number,url,headRefName,state"], { cwd: repoPath });
  for (const pr of JSON.parse(prJson || "[]")) {
    const id = idFromRef(pr.headRefName);
    if (!id) continue;
    const cur = prMap.get(id);
    const better = !cur || (PR_RANK[pr.state] || 0) > (PR_RANK[cur.state] || 0) ||
      ((PR_RANK[pr.state] || 0) === (PR_RANK[cur.state] || 0) && pr.number > cur.number);
    if (better) prMap.set(id, pr);
  }

  const branchMap = new Map();
  const refs = sh("git", ["-C", repoPath, "for-each-ref", "--format=%(refname:short)",
    "refs/heads", "refs/remotes/origin"]) || "";
  for (let ref of refs.split("\n")) {
    ref = ref.replace(/^origin\//, "").trim();
    if (!ref || ref === "HEAD") continue;
    const id = idFromRef(ref);
    if (id && !branchMap.has(id)) branchMap.set(id, ref);
  }
  return { prMap, branchMap };
}

// --- aggregate the most-advanced signal across all of a project's repos -------
function gatherProject(project, { fetch }) {
  const prMap = new Map(), branchMap = new Map();
  for (const repo of project.codeRepoPaths) {
    const r = gatherRepo(repo, project.idFromRef, { fetch });
    for (const [id, pr] of r.prMap) {
      const cur = prMap.get(id);
      if (!cur || (PR_RANK[pr.state] || 0) > (PR_RANK[cur.state] || 0)) prMap.set(id, pr);
    }
    for (const [id, b] of r.branchMap) if (!branchMap.has(id)) branchMap.set(id, b);
  }
  return { prMap, branchMap };
}

// --- the reconcile pass -------------------------------------------------------
export function reconcile({
  fetch = false, commit = false, push = false, dryRun = true, root, projectsDir,
} = {}) {
  // root left unset → honour BOTH resolved values (dataRoot + projectsDir, even
  // when custom-named via BLAZE_PROJECTS_DIR). An explicit root (existing
  // callers/tests) keeps the pre-existing join(root, "projects") behaviour.
  const explicitRoot = root !== undefined;
  const resolved = resolveRoots();
  root ??= resolved.dataRoot;
  projectsDir ??= explicitRoot ? join(root, "projects") : resolved.projectsDir;

  const today = new Date().toISOString().slice(0, 10);
  const cfg = loadConfig({ root });
  const keys = listProjects(cfg);
  if (!keys.length) return { ok: true, standalone: true, changes: [], committed: false, pushed: false };

  const sig = new Map();
  for (const key of keys) sig.set(key, gatherProject(loadProject(key, { root }), { fetch }));

  const changes = [];
  for (const t of walkTickets(projectsDir)) {
    const type = t.frontmatter.type;
    const s = sig.get(t.frontmatter.project);
    if (!s) continue;
    const d = decide({ pr: s.prMap.get(t.frontmatter.id), branch: s.branchMap.get(t.frontmatter.id) }, t.status, type);
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
      writeFileSync(t.file, serializeTicket({ frontmatter: fm, body: t.body }));
      if (d.moved) {
        const projectDir = dirname(dirname(t.file));
        const destDir = join(projectDir, d.target);
        mkdirSync(destDir, { recursive: true });
        const dest = join(destDir, basename(t.file));
        if (dest !== t.file) renameSync(t.file, dest);
      }
    }
  }

  let committed = false;
  if (!dryRun && commit && changes.length) {
    sh("git", ["-C", root, "add", "-A"]);
    committed = sh("git", ["-C", root, "commit", "-m",
      `chore(board): reconcile ${changes.length} ticket(s) to git state`]) !== null;
  }
  // push is never performed — hardcoded false regardless of the push param
  return { ok: true, changes, committed, pushed: false };
}

// --- CLI ----------------------------------------------------------------------
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const quiet = args.includes("--quiet");
  const r = reconcile({ fetch: args.includes("--fetch"), commit: apply, push: false, dryRun: !apply });
  if (!r.ok) { console.error(`reconcile: ${r.error}`); process.exit(1); }
  if (r.standalone) { if (!quiet) console.log("reconcile: no projects configured — nothing to reconcile."); process.exit(0); }
  if (!r.changes.length) { if (!quiet) console.log("reconcile: already in sync — nothing to do."); process.exit(0); }
  for (const c of r.changes) console.log(`${apply ? "moved" : "would move"} ${c.id}: ${c.from} → ${c.to}`);
  if (!apply) console.log(`(dry-run: ${r.changes.length} change(s); rerun with --apply to write locally — reconcile never pushes)`);
}
