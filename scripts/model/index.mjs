// scripts/model/index.mjs — build a queryable read model from all ticket files
// across all projects. The index is DISPOSABLE: rebuild any time from markdown
// (the source of truth). Pure-JS / zero-dep so it runs on blaze's Node floor.
// The Index interface is storage-agnostic — a future node:sqlite implementation
// must satisfy the same shape (spec §13, revised), so the swap stays contained.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { readRegularFileSync } from "./regular-file.mjs";
import { join, dirname } from "node:path";
import { parseTicket } from "./ticket.mjs";
import { lintLinks } from "./links.mjs";
import { loadSprints } from "./sprints.mjs";
import { fsReadStorage } from "./read-storage.mjs";
import { claimedNumbers, readCutover, claimPath } from "./claims.mjs";

function safeReaddir(p) { try { return readdirSync(p); } catch { return []; } }
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// The same read, with the failure kept instead of dropped. `safeReaddir` above is the
// walk's own lossy form and stays exactly as it was — `unreadableTicketDirs` below is
// what turns the dropped error into something an operator is told about (BLZ-470).
function readdirOrError(p) {
  try { return { entries: readdirSync(p), error: null }; }
  catch (e) { return { entries: [], error: e }; }
}

// BLZ-430: a directory that is itself a git repository — a submodule, or a plain clone
// left under `projects/`. `git submodule add` writes `.git` as a FILE holding a
// `gitdir:` pointer; a clone writes it as a directory. Either one is the whole signal,
// and it is deliberately a STAT rather than a `git` call: this runs once per candidate
// directory on a read path that already walks ~2,700 files.
//
// BLZ-470: WHAT the `.git` entry is, not merely THAT one exists, because "a nested
// repository" and "a zero-byte file named .git" are different facts and a report that
// collapses them tells an operator to go looking for a repository that is not there.
// Measured on the live board (blaze-pm BLZ-305-v4-spine, 2026-08-29): 0 of 103 project
// and status directories carry a `.git` entry of any shape, so this reads one extra
// file on exactly no directories there.
//
// Returns `null` when there is nothing to say — including when the stat itself fails,
// which is deliberately UNCHANGED from BLZ-430's `existsSync`-shaped semantics: a stat
// that throws meant "not a nested repo, walk it" then and means the same now. The
// condition that actually loses tickets in that case is the parent's `readdir` failing,
// and `unreadableTicketDirs` reports THAT, once, rather than twice from two layers.
const GIT_FILE_PROBE_BYTES = 256;
function classifyGitEntry(dirPath) {
  const p = join(dirPath, ".git");
  let st;
  try { st = statSync(p); } catch { return null; }
  if (st.isDirectory()) {
    return { reason: "nested-repo", detail: "it holds a `.git` DIRECTORY — a repository cloned here" };
  }
  // BLZ-470 round 2 (REGRESSION, found by review): NEVER OPEN AN ENTRY THAT IS NOT A REGULAR
  // FILE. `readFileSync` on a FIFO BLOCKS FOREVER — no error, no timeout, no exit — and this
  // predicate sits on the path `blaze audit`, `buildIndex`, id resolution, the board view and
  // `reconcile` all share, including a long-lived server. A hang is strictly worse than the
  // wrong sentence this function exists to prevent: nothing reports at all.
  //
  // BLZ-430's stat-only predicate could not hang, and it SKIPPED this shape (any successful
  // stat counted). Both properties are preserved: still skipped, now named, and never opened.
  // A socket, a device node and a symlink to any of them land here too.
  if (!st.isFile()) {
    // The reason is stated per TYPE, not generalised. Measured, not assumed: a FIFO with no
    // writer blocks forever; a socket throws ENXIO immediately; a device node such as
    // /dev/null reads 0 bytes. Only the FIFO hangs — so claiming all three "block forever"
    // would be this lane's own defect in the sentence the operator actually reads.
    return { reason: "git-entry-not-a-file",
             detail: "it holds a `.git` entry that is neither a directory nor a regular file " +
               "(a FIFO, socket or device node) — that is not a repository git would recognise, " +
               "and Blaze will not open it: a FIFO with no writer would block the read forever, " +
               "and the others cannot hold a git pointer" };
  }
  let head;
  try { head = readFileSync(p, "utf8").slice(0, GIT_FILE_PROBE_BYTES); }
  catch (e) {
    return { reason: "git-file-unreadable",
             detail: "it holds a `.git` FILE that could not be read " +
               `(${(e && e.code) || e}), so Blaze cannot tell a submodule pointer from junk` };
  }
  if (/^gitdir:\s*\S/.test(head)) {
    return { reason: "nested-repo-pointer",
             detail: "it holds a `.git` FILE containing " +
               `${JSON.stringify(head.split("\n")[0].trim())} — the pointer \`git submodule add\` ` +
               "and `git worktree add` write" };
  }
  if (st.size === 0) {
    return { reason: "git-file-empty",
             detail: "it holds a ZERO-BYTE `.git` file — git would not recognise that as a " +
               "repository, and Blaze cannot tell whether one was meant" };
  }
  return { reason: "git-file-unrecognised",
           detail: `it holds a ${st.size}-byte \`.git\` file that is not a \`gitdir:\` pointer — ` +
             "Blaze cannot tell a repository from junk" };
}

// The walk's own predicate, unchanged in behaviour: every shape `classifyGitEntry` names
// is skipped, and a stat that throws is not one of them.
function isNestedRepo(p) { return classifyGitEntry(p) !== null; }

/** BLZ-470: every directory under `projectsDir` whose tickets this board CANNOT read,
 *  and why — the report half of BLZ-430's skip.
 *
 *  BLZ-430 fixed a real crash (a submodule's `README.md` reached `parseTicket`, which
 *  threw, and the throw escaped `walkTickets`'s generator and took down `blaze audit`,
 *  `buildIndex`, the board view, id resolution and `reconcile` together). Its fix skips
 *  any directory carrying a `.git` entry — SILENTLY. Measured on a constructed 8-ticket
 *  board: a zero-byte `.git` file in a PROJECT directory takes 8 ids to 4, and one in a
 *  STATUS directory takes 8 to 6, with no finding and no counter. A `chmod 000` project
 *  directory loses the same 4 through `safeReaddir`'s swallowed error, which is the same
 *  defect arriving by a different route and is reported here too.
 *
 *  WHY THIS IS A SEPARATE FUNCTION AND NOT A PARAMETER ON `walkTickets`. `walkTickets` has
 *  five call sites — `fsReadStorage`'s `getTicket`, `listChildren`, `blockersOf` and
 *  `listTickets`, plus `buildIndex` — and a generator has no out-of-band return channel a
 *  `for…of` can see. The alternatives are recorded in ADR-0030; the short version is that a
 *  sentinel yielded among the tickets is silently dropped by the three operations that
 *  filter on frontmatter (so id resolution, the drill and the blocker check would still say
 *  "nothing there") and lands as a garbage row in the two that do not, and that an `onSkip`
 *  callback would have to be threaded through all four driver operations to serve two
 *  callers. What a skipped directory actually is — a fact about the CORPUS, not about any
 *  ticket in it — is a NAMED QUESTION, which is the shape ADR-0009 says a read must take.
 *
 *  It reads DIRECTORIES only and opens no `.md`, so it costs one `readdir` per project plus
 *  one per status directory — 103 of them on the live board — against the ~2,700 files the
 *  ticket walk itself reads.
 *
 *  It shares `classifyGitEntry` with the walk rather than re-deriving "is this skipped",
 *  because two implementations of one predicate is how the same drift keeps reappearing
 *  here (INF-735, and `gatherPrs`'s `recordablePr` counter one layer up). The traversal is
 *  still written twice, so a test pins the two against each other on ground truth: the
 *  directories this function names must be exactly the directories the walk lost tickets
 *  from.
 *
 *  KNOWN GAP, stated rather than implied: this belongs on the read seam as a sixth named
 *  operation (`fsReadStorage.unreadableTicketDirs`), so a database driver could answer it
 *  with the empty list it structurally is, and `scripts/views/data.mjs` could report it on
 *  the board page. Neither file was in the set this change was scoped to. Until it moves, a
 *  database-fed board reports nothing here — which is the right answer for a database and
 *  wrong only in that it is decided by which module you called, not by the driver.
 *
 *  @returns Array<{ project, status, path, reason, detail, message }>
 */
export function unreadableTicketDirs(projectsDir) {
  const out = [];
  const label = (project, status) =>
    project === null ? String(projectsDir) : `projects/${project}${status ? `/${status}` : ""}`;
  const push = (project, status, path, reason, detail) => out.push({
    project, status, path, reason, detail,
    message: `${label(project, status)} was NOT read: ${detail}. Every ticket under it is ` +
      "missing from this run, so the ticket count is a floor, not a total. Move the " +
      "directory out from under projects/, or remove the stray `.git` entry if it is not " +
      "a repository.",
  });
  const root = readdirOrError(projectsDir);
  if (root.error) {
    // A projects directory that is simply absent is not a board with unread tickets — it
    // is a board with no tickets, which every caller already handles. Anything else (a
    // permission, an I/O error) hid a corpus this run could not see.
    if (root.error.code !== "ENOENT") {
      push(null, null, projectsDir, "directory-unreadable",
        `Blaze could not list it (${root.error.code || root.error})`);
    }
    return out;
  }
  for (const project of root.entries) {
    const projPath = join(projectsDir, project);
    if (!isDir(projPath)) continue;
    const g = classifyGitEntry(projPath);
    if (g) { push(project, null, projPath, g.reason, g.detail); continue; }
    const sub = readdirOrError(projPath);
    if (sub.error) {
      push(project, null, projPath, "directory-unreadable",
        `Blaze could not list it (${sub.error.code || sub.error})`);
      continue;
    }
    for (const status of sub.entries) {
      if (status.startsWith(".")) continue;
      const statusPath = join(projPath, status);
      if (!isDir(statusPath)) continue;
      const gs = classifyGitEntry(statusPath);
      if (gs) { push(project, status, statusPath, gs.reason, gs.detail); continue; }
      const files = readdirOrError(statusPath);
      if (files.error) {
        push(project, status, statusPath, "directory-unreadable",
          `Blaze could not list it (${files.error.code || files.error})`);
      }
    }
  }
  return out;
}

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
    // BLZ-430: a NESTED REPOSITORY is another repository's working tree, not a project.
    // Skipped at both levels because the walk reaches a `.md` at both: as a project its
    // subdirectories are read as statuses, and as a status (below) its top-level files
    // are read as tickets. A vendored `README.md` then hits `parseTicket`, which THROWS
    // "missing frontmatter" — and the throw escapes this generator, so it does not
    // degrade one ticket, it takes the whole walk down and with it `blaze audit`,
    // `buildIndex`, the board view, id resolution and `reconcile`. One neighbouring
    // directory made a whole board unreadable.
    //
    // Narrow ON PURPOSE. The alternative — skipping any `.md` that fails to parse —
    // would make a genuinely CORRUPTED TICKET vanish from the board, the index and the
    // audit in silence, which is a worse defect than this one. A malformed ticket must
    // still throw, and a test pins that it does.
    if (isNestedRepo(projPath)) continue;
    for (const status of safeReaddir(projPath)) {
      // BLZ-136: `.ids/` holds the allocation ledger, not tickets. Dot-dirs were
      // previously skipped only because claim files carry no .md extension — an
      // accident, not a guard, and one a single renamed file would have undone.
      if (status.startsWith(".")) continue;
      const statusPath = join(projPath, status);
      if (!isDir(statusPath)) continue;
      if (isNestedRepo(statusPath)) continue;   // BLZ-430, see above
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
        // BLZ-493: REFUSE a `.md` that is not a regular file, rather than opening it.
        // `readFileSync` on a FIFO named `X.md` blocks forever and takes the whole walk —
        // and with it `blaze audit`, `buildIndex`, id resolution, the board view and
        // `reconcile` — down in silence. A SKIP here was rejected: it would make a
        // ticket-shaped entry vanish from every consumer with no finding and no counter,
        // which is the exact drop BLZ-470 exists to close and which BLZ-430 refused to
        // introduce for malformed `.md` files. Those still throw from `parseTicket`, and a
        // `.md` that is a DIRECTORY already threw EISDIR from this very line (measured at
        // 1b00f3a) — so this is the walk applying one rule to all three unreadable shapes,
        // not a new refusal. ADR-0031.
        const { frontmatter, body } = parseTicket(readRegularFileSync(file));
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
