// scripts/model/index.mjs — build a queryable read model from all ticket files
// across all projects. The index is DISPOSABLE: rebuild any time from markdown
// (the source of truth). Pure-JS / zero-dep so it runs on blaze's Node floor.
// The Index interface is storage-agnostic — a future node:sqlite implementation
// must satisfy the same shape (spec §13, revised), so the swap stays contained.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { parseTicket } from "./ticket.mjs";
import { lintLinks } from "./links.mjs";
import { loadSprints } from "./sprints.mjs";
import { fsReadStorage } from "./read-storage.mjs";
import { claimedNumbers, readCutover, claimPath } from "./claims.mjs";

function safeReaddir(p) { try { return readdirSync(p); } catch { return []; } }
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// Per-file parse cache: path → { mtimeMs, size, frontmatter, body }.
// Validated by stat on every walk (same freshness semantics as re-reading —
// the board stays a pure view over files); hits skip readFileSync+parse.
// Yielded objects are shared across walks: callers must treat them as
// immutable. Entries for deleted/moved paths are pruned lazily.
const parseCache = new Map();

// Yields every ticket under projectsDir/<KEY>/<status>/<id>.md.
//
// `project` and `status` are yielded FIRST-CLASS rather than left for the caller to
// recover from `file`. For the filesystem store the directory IS the location, so
// the walk already holds both; a database driver supplies them from columns. This is
// what stops move/reconcile doing dirname(dirname(file)) arithmetic that silently
// produced a bogus destination for any non-path handle (BLZ-271). Note frontmatter
// .project is NOT a substitute: it is absent on some boards, while the directory is
// always present.
export function* walkTickets(projectsDir) {
  const seen = new Set();
  for (const project of safeReaddir(projectsDir)) {
    const projPath = join(projectsDir, project);
    if (!isDir(projPath)) continue;
    for (const status of safeReaddir(projPath)) {
      // BLZ-136: `.ids/` holds the allocation ledger, not tickets. Dot-dirs were
      // previously skipped only because claim files carry no .md extension — an
      // accident, not a guard, and one a single renamed file would have undone.
      if (status.startsWith(".")) continue;
      const statusPath = join(projPath, status);
      if (!isDir(statusPath)) continue;
      for (const f of safeReaddir(statusPath)) {
        if (!f.endsWith(".md")) continue;
        const file = join(statusPath, f);
        let s; try { s = statSync(file); } catch { continue; }
        seen.add(file);
        const hit = parseCache.get(file);
        if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) {
          yield { frontmatter: hit.frontmatter, body: hit.body, project, status, file };
          continue;
        }
        const { frontmatter, body } = parseTicket(readFileSync(file, "utf8"));
        parseCache.set(file, { mtimeMs: s.mtimeMs, size: s.size, frontmatter, body });
        yield { frontmatter, body, project, status, file };
      }
    }
  }
  // Lazy prune: drop cache entries whose file vanished (moved/deleted) so a
  // long-lived server doesn't accumulate one stale entry per ticket move.
  // This only runs on a FULL drain of the generator — code here is reached
  // only when the loop above finishes on its own. A caller that breaks early
  // (move/edit/log/resolve all `break` once they find the id they're after)
  // calls the generator's implicit .return(), which unwinds at the last
  // `yield` and skips straight past this block; wrapping it in try/finally
  // would not change that, since `seen` at break time is partial and pruning
  // against a partial `seen` would wrongly evict entries for tickets the walk
  // simply hadn't reached yet, not entries that actually vanished. So partial
  // walks intentionally skip pruning; boardModel's full walk on every page
  // render is the reliable prune point that keeps the cache bounded.
  if (parseCache.size > seen.size) {
    for (const k of parseCache.keys()) if (!seen.has(k)) parseCache.delete(k);
  }
}

// BLZ-122: resolve an id to the ONE file that is it, or refuse.
//
// Every mutating verb (move/edit/log/link/resolve) used to carry its own copy of a locate()
// that returned the first match and moved on. Ids are unique by construction — the per-project
// `.ids/` ledger issues each number once — so a second file bearing the same id is always
// corruption, never a legitimate alias. Picking one of them silently is how `blaze move
// INF-583 in-progress` came to rewrite a stale `defined/` duplicate of an already-`done`
// ticket and write a transition that never happened into board history.
//
// Which copy is canonical needs judgement (on the seven 2026-08-11 duplicates the `done/` copy
// was right; that is not a general rule) and a wrong auto-pick destroys the real ticket. So
// this refuses and hands back every path. `blaze audit`'s duplicate-status finding is the
// detector; this is the guard that stops a write landing on a guess.
//
// This scans the WHOLE walk rather than returning at the first hit: the ambiguity is only
// visible once every candidate is known, so an early return is precisely the bug.
//
// @returns { found } | { found: null } | { found: null, duplicates: [path, ...] }
export function locateTicket(projectsDir, id, { storage = fsReadStorage } = {}) {
  // ADR-0009: this is now a NAMED read the driver answers, not a walk the caller
  // filters. On the filesystem the driver still walks — that is the fs
  // implementation of the name, not the contract. On a database it is a primary-key
  // lookup, which is the 578x this seam exists to make reachable.
  return storage.getTicket(projectsDir, id);
}

/** The refusal message, shared so every verb names the paths the same way. */
export function ambiguousIdError(id, duplicates) {
  return `${id} resolves to ${duplicates.length} files — refusing to guess which is the ticket:\n` +
    duplicates.map((f) => `  ${f}`).join("\n") +
    `\nStatus is the directory: delete the wrong-directory duplicate (never the ticket, never its id claim), then retry.`;
}

// BLZ-134: `new Map(rows.map(...))` silently keeps the LAST row for a duplicated
// id, so two tickets sharing an id collapsed into one and the other vanished
// from every consumer (board, reconcile, rollup) with no signal at all. Observed
// in production on a real board: four contiguous ids had each been issued twice
// by concurrent sessions, and in two of those pairs the shadowed copy was the
// non-terminal one — so the index was hiding OPEN work behind a closed ticket.
// Collisions are now collected as ERRORS — a separate channel from `warnings`,
// which callers are entitled to tolerate — naming every colliding path so the
// operator can act without hunting for the other copy.
function duplicateIdErrors(rows) {
  const filesById = new Map();
  for (const r of rows) {
    if (!filesById.has(r.id)) filesById.set(r.id, []);
    filesById.get(r.id).push(r.file);
  }
  const errors = [];
  for (const [id, files] of filesById) {
    if (files.length > 1) {
      errors.push(`duplicate id ${id}: ${files.length} files claim it — ${files.join(" , ")}`);
    }
  }
  return errors;
}

// BLZ-274 / ADR-0009: this is a PATH-DEPENDENT check and no longer runs inside
// buildIndex. It reads the id-claims ledger off disk, so leaving it in the pure index
// meant a filesystem-fed and a database-fed buildIndex would return different `errors`
// arrays — the driver leaking through the function that claims to be storage-agnostic.
// It is exported and called by reindex.mjs instead, following the precedent already
// set at audit-runner.mjs:64-72: identity is a property of the WALK, and the pure
// function is a function of frontmatter, which carries no path.
//
// It is also condemned code: Phase 2 (BLZ-254) deletes the allocator, and the READ
// path depending on the claims ledger is exactly the hazard recorded there.
//
// BLZ-136 / ADR-0005. A ticket whose id has no claim reached the board without
// its allocation record — committed by hand, or through a merge strategy that
// auto-resolved the claim conflict away (`-X ours/theirs` merges a colliding
// claim cleanly, which the claim layer alone cannot prevent). Either way the id
// is no longer provably unique, so it is an error, not a warning.
//
// Ids at or below the per-project cutover predate the ledger and are exempt —
// that is what lets ADR-0005 promise no backfill.
export function missingClaimErrors(projectsDir, rows) {
  const claimsByKey = new Map();
  const cutoverByKey = new Map();
  const errors = [];
  for (const r of rows) {
    if (!r.project || !r.id) continue;
    if (!claimsByKey.has(r.project)) {
      claimsByKey.set(r.project, claimedNumbers(projectsDir, r.project));
      cutoverByKey.set(r.project, readCutover(projectsDir, r.project));
    }
    const cutover = cutoverByKey.get(r.project);
    // No cutover marker at all: this project has never allocated through the
    // ledger, so none of its tickets could have a claim. Stay silent until its
    // first allocation establishes the boundary.
    if (cutover === null) continue;
    const n = Number(String(r.id).split("-").pop());
    if (!Number.isFinite(n)) continue;
    if (n <= cutover) continue;
    if (claimsByKey.get(r.project).has(n)) continue;
    errors.push(
      `ticket ${r.id} has no claim (${claimPath(projectsDir, r.project, n)}) — its id is not ` +
      `provably unique; restore or re-create the claim, then re-run \`blaze reindex\``,
    );
  }
  return errors;
}

function makeIndex(rows, links, warnings, errors = []) {
  // First-wins rather than last-wins: with a duplicate present the choice is
  // arbitrary either way, but `errors` above makes the collision loud, so this
  // only decides which row the (already-failing) board happens to show.
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  return {
    rows,
    links,
    warnings,
    errors,
    get: (id) => byId.get(id),
    count: () => rows.length,
    byProject: (project) => rows.filter((r) => r.project === project),
    countByProject: () => rows.reduce((acc, r) => {
      acc[r.project] = (acc[r.project] || 0) + 1; return acc;
    }, {}),
    linksFrom: (id) => links.filter((l) => l.src === id),
    toJSON: () => ({ tickets: rows, links, warnings, errors }),
  };
}

export function buildIndex(projectsDir, { tickets, sprints } = {}) {
  const rows = [];
  const links = [];
  const collected = [];
  for (const t of tickets ?? walkTickets(projectsDir)) {
    const fm = t.frontmatter;
    const worklog_minutes = Array.isArray(fm.worklog)
      ? fm.worklog.reduce((s, w) => s + (Number(w.minutes) || 0), 0) : 0;
    rows.push({
      id: fm.id, project: fm.project ?? null, type: fm.type ?? null, title: fm.title ?? null,
      status: t.status, priority: fm.priority ?? null, resolution: fm.resolution ?? null,
      parent: fm.parent ?? null, assignee: fm.assignee ?? null, estimate: fm.estimate ?? null,
      sprint: fm.sprint ?? null, start: fm.start ?? null, due: fm.due ?? null,
      // BLZ-386. Carried so the migrated constraints do not vanish from every reader the
      // moment the migration runs: `start`/`due` are cleared on the 12 non-terminal dated
      // tickets, and without these two the index would show them as carrying no date at all.
      // Found by adversarial review, which measured the consequence — gantt.mjs reads
      // `r.start`/`r.due` and would render all 12 as `unplanned` bars.
      //
      // This does NOT make the Gantt draw them: that is spec 3's schedule axis, which is
      // deliberately out of BLZ-384's scope. It stops the data disappearing in the meantime.
      not_before: fm.not_before ?? null, deadline: fm.deadline ?? null,
      worklog_minutes, file: t.file,
    });
    for (const link of fm.links ?? []) links.push({ src: fm.id, type: link.type, target: link.target });
    collected.push(fm);
  }
  const knownIds = new Set(rows.map((r) => r.id));
  const warnings = collected.flatMap((fm) => lintLinks(fm, knownIds));
  // Dangling-sprint-ref lint (mirrors lintLinks above): a warning, never an error.
  // Skip entirely for a board that never opted in (no sprints.json AND no ticket
  // carries a `sprint`), so a plain board never sees a sprint warning.
  const taggedRows = rows.filter((r) => r.sprint != null && r.sprint !== "");
  // ADR-0009: sprints arrive through the seam. They still default to the filesystem
  // registry so every existing caller is unchanged, but a database-fed index passes
  // its own — this was buildIndex's second node:fs escape hatch (BLZ-274).
  const sprintList = sprints ?? loadSprints({ root: dirname(projectsDir) }).sprints;
  if (sprintList.length > 0 || taggedRows.length > 0) {
    const knownSprintIds = new Set(sprintList.map((s) => s.id));
    for (const r of taggedRows) {
      if (!knownSprintIds.has(r.sprint)) {
        warnings.push(`${r.id}: sprint '${r.sprint}' not in registry`);
      }
    }
  }
  return makeIndex(rows, links, warnings, [
    ...duplicateIdErrors(rows),
  ]);
}
