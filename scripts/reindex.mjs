// scripts/reindex.mjs — rebuild the derived index from projects/ markdown and
// cache it to .blaze/index.json, and rebuild the transitions cache (status-move
// history derived from git rename history) to .blaze/transitions.json. Both are
// derived, regenerable caches — safe to delete; `blaze reindex` rebuilds them.
// Run: node scripts/reindex.mjs [projectsDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex } from "./model/index.mjs";
import { buildTransitions } from "./model/transitions.mjs";
import { resolveRoots } from "./config.mjs";

const { dataRoot, projectsDir: defaultProjectsDir } = resolveRoots();
const projectsDir = process.argv[2] || defaultProjectsDir;
const dbDir = process.env.BLAZE_DB_DIR || join(dataRoot, ".blaze");

try {
  mkdirSync(dbDir, { recursive: true });
  const idx = buildIndex(projectsDir);
  const out = join(dbDir, "index.json");
  writeFileSync(out, JSON.stringify(idx.toJSON(), null, 2));
  const c = idx.count();
  console.log(`indexed ${c} ticket${c === 1 ? "" : "s"} → ${out}`);

  const built = buildTransitions({ root: dataRoot });
  const transitionsOut = join(dbDir, "transitions.json");
  writeFileSync(transitionsOut, JSON.stringify(built));
  console.log(`indexed ${built.transitions.length} transition${built.transitions.length === 1 ? "" : "s"} → ${transitionsOut}`);
} catch (e) {
  console.error(`blaze reindex failed: ${e.message}`);
  process.exit(1);
}
