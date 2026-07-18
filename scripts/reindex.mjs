// scripts/reindex.mjs — rebuild the derived index from projects/ markdown and
// cache it to .blaze/index.json, and rebuild the transitions cache (status-move
// history derived from git rename history) to .blaze/transitions.json. Both are
// derived, regenerable caches — safe to delete; `blaze reindex` rebuilds them.
// Run: node scripts/reindex.mjs [projectsDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex } from "./model/index.mjs";
import { buildTransitions } from "./model/transitions.mjs";
import { resolveRoots, loadConfig } from "./config.mjs";
import { assertWritable } from "./readonly.mjs";

const { dataRoot, projectsDir: defaultProjectsDir } = resolveRoots();
const positional = [];
for (const a of process.argv.slice(2)) {
  if (a.startsWith("--")) { console.error(`unknown flag: ${a}`); process.exit(1); }
  positional.push(a);
}
const projectsDir = positional[0] || defaultProjectsDir;
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
