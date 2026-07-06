// scripts/reindex.mjs — rebuild the derived index from projects/ markdown and
// cache it to .blaze/index.json. Run: node scripts/reindex.mjs [projectsDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex } from "./model/index.mjs";
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
} catch (e) {
  console.error(`blaze reindex failed: ${e.message}`);
  process.exit(1);
}
