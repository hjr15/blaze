import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("reindex with BLAZE_PROJECTS_DIR writes the index under the data repo's .blaze", () => {
  // Throwaway engine copy: the pre-rewire (red) run writes .blaze/ into ITS
  // engine tree, which must be disposable — never the real repo's .blaze/.
  const eng = mkdtempSync(join(tmpdir(), "blaze-reindex-eng-"));
  cpSync(join(REPO, "scripts"), join(eng, "scripts"), { recursive: true });
  const data = mkdtempSync(join(tmpdir(), "blaze-reindex-"));
  mkdirSync(join(data, "projects", "ZZZ", "done"), { recursive: true });
  writeFileSync(join(data, "projects", "ZZZ", "done", "ZZZ-1.md"),
    "---\nid: ZZZ-1\ntype: task\nstatus: done\nestimate: 60\n---\n\nbody\n");
  execFileSync(process.execPath, [join(eng, "scripts", "reindex.mjs")],
    { cwd: eng, env: { ...process.env, BLAZE_PROJECTS_DIR: join(data, "projects"), BLAZE_DB_DIR: "" } });
  assert.ok(existsSync(join(data, ".blaze")), "index dir must be under dataRoot");
  rmSync(data, { recursive: true, force: true });
  rmSync(eng, { recursive: true, force: true });
});
