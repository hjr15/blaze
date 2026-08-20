// scripts/reindex.mjs — rebuild the derived index from projects/ markdown and
// cache it to .blaze/index.json, and rebuild the transitions cache (status-move
// history derived from git rename history) to .blaze/transitions.json. Both are
// derived, regenerable caches — safe to delete; `blaze reindex` rebuilds them.
// Run: node scripts/reindex.mjs [projectsDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { buildIndex, missingClaimErrors } from "./model/index.mjs";
import { buildTransitions } from "./model/transitions.mjs";
import { resolveRoots, loadConfig } from "./config.mjs";
import { assertWritable } from "./readonly.mjs";

const positional = [];
let allowDuplicateIds = false;
for (const a of process.argv.slice(2)) {
  // BLZ-134 escape hatch. The duplicate-id gate below is deliberately fatal, but
  // a board that ALREADY has collisions would otherwise be unable to rebuild its
  // index at all — and move/edit/log all resolve ids through that index, so a
  // strict-only gate could wedge every board op until the collision is fixed.
  // Opt-in, never silent: the errors are still printed on every run.
  if (a === "--allow-duplicate-ids") { allowDuplicateIds = true; continue; }
  if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
  positional.push(a);
}
// BLZ-133: parse the positional override BEFORE resolving ambient roots. An
// explicit projectsDir is self-sufficient — `blaze reindex /path/to/projects`
// must work from any cwd — so calling resolveRoots() first would make it throw
// on exactly the invocation that doesn't need it. dataRoot mirrors
// BLAZE_PROJECTS_DIR's semantics: the parent of the projects dir.
const explicit = positional[0] ? resolvePath(positional[0]) : null;
const roots = explicit ? null : resolveRoots();
const projectsDir = explicit || roots.projectsDir;
const dataRoot = explicit ? dirname(explicit) : roots.dataRoot;
const dbDir = process.env.BLAZE_DB_DIR || join(dataRoot, ".blaze");

try {
  // Config-schema version guard (ADR-0002): reindex re-validates every ticket
  // against the schema, so it must not run against a board contract it may
  // misread. loadConfig throws `blaze: …` on an incompatible schemaVersion.
  loadConfig({ root: dataRoot });
  // BLZ-121: reindex is the one mutates:true verb with no defence-in-depth of
  // its own — it writes derived, gitignored caches directly (no
  // commitOrQueue in its path at all), so without this it would silently
  // rebuild .blaze/index.json under BLAZE_READONLY. It doesn't dirty the
  // tracked tree, but "zero guard" is still the odd one out among mutating
  // verbs; add the same guard for uniformity. cli.mjs remains the primary
  // gate for the normal `blaze reindex` path.
  assertWritable("rebuild the index/transitions cache");
  mkdirSync(dbDir, { recursive: true });
  const idx = buildIndex(projectsDir);
  // BLZ-274 / ADR-0009: the missing-claim check is path-dependent — it reads the
  // id-claims ledger off disk — so it runs HERE rather than inside the pure index,
  // following the precedent at audit-runner.mjs:64-72. Keeping it in buildIndex made
  // a filesystem-fed and a database-fed index return different `errors` arrays.
  //
  // Separating them also fixes a real mislabelling: buildIndex.errors previously held
  // BOTH kinds while this message called all of them duplicate ids. A board with one
  // unclaimed id and no collisions was told "1 duplicate ticket id — renumber one side
  // of each collision", naming a collision that did not exist.
  const claimErrors = missingClaimErrors(projectsDir, idx.rows);
  for (const e of claimErrors) console.error(`error: ${e}`);
  // BLZ-134: refuse to write an index built over colliding ids. Writing it would
  // bake the collision into every consumer while looking like a clean rebuild —
  // exactly how four duplicate ids sat undetected on the live board. Fail before
  // the write so the on-disk cache keeps its last known-good state.
  const blocking = [...idx.errors, ...claimErrors];
  if (blocking.length) {
    for (const e of idx.errors) console.error(`error: ${e}`);
    if (!allowDuplicateIds) {
      const dupes = idx.errors.length;
      const parts = [];
      if (dupes) parts.push(`${dupes} duplicate ticket id${dupes === 1 ? "" : "s"}`);
      if (claimErrors.length) parts.push(`${claimErrors.length} unclaimed id${claimErrors.length === 1 ? "" : "s"}`);
      throw new Error(
        `${parts.join(" and ")} — refusing to write a corrupt index. ` +
        (dupes ? `Renumber one side of each collision, then re-run ` : `Restore the missing claim(s), then re-run `) +
        `(or --allow-duplicate-ids to rebuild anyway; the shadowed ticket stays invisible).`
      );
    }
    console.error(`warning: --allow-duplicate-ids — rebuilding anyway; ${blocking.length} unresolved finding(s).`);
  }
  const out = join(dbDir, "index.json");
  writeFileSync(out, JSON.stringify(idx.toJSON(), null, 2));
  const c = idx.count();
  console.log(`indexed ${c} ticket${c === 1 ? "" : "s"} → ${out}`);
  for (const w of idx.warnings) console.warn(`warning: ${w}`);

  const built = buildTransitions({ root: dataRoot });
  const transitionsOut = join(dbDir, "transitions.json");
  writeFileSync(transitionsOut, JSON.stringify(built));
  console.log(`indexed ${built.transitions.length} transition${built.transitions.length === 1 ? "" : "s"} → ${transitionsOut}`);
} catch (e) {
  console.error(`blaze reindex failed: ${e.message}`);
  process.exit(1);
}
