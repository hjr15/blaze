// tests/helpers/db-board.mjs — BLZ-670. Shared by the db-mode tests. Helpers ONLY: a module
// that also declared tests would re-register them in every file that imports it.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scratchRegistry } from "./scratch.mjs";

const scratch = scratchRegistry();
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts");
// `env: {}` — runDb's readonly guard reads `io.env ?? process.env`; tests pass an explicit,
// empty env so an ambient BLAZE_READONLY=1 in the shell running the suite cannot refuse them.
export const QUIET = { log() {}, err() {}, env: {} };

export function dbBoard() {
  const dataRoot = scratch(mkdtempSync(join(tmpdir(), "blz670-board-")));
  const projectsDir = join(dataRoot, "projects");
  mkdirSync(join(projectsDir, "ENG", "defined"), { recursive: true });
  writeFileSync(join(dataRoot, "blaze.config.json"),
    JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  writeFileSync(join(projectsDir, "ENG", "project.json"),
    JSON.stringify({ key: "ENG", components: [], labels: [] }));
  writeFileSync(join(projectsDir, "ENG", "defined", "ENG-1-a.md"),
    ["---", "id: ENG-1", "title: A task", "type: task", "project: ENG",
     "priority: medium", "assignee: unassigned", "estimate: 30",
     "created: 2026-01-01", "updated: 2026-01-01", "links:", "---", "",
     "## Acceptance Criteria", "", "- [ ] one", ""].join("\n"));
  return { dataRoot, projectsDir };
}

export function runner(name, args, { projectsDir }, extraEnv = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, name), ...args], {
    encoding: "utf8",
    env: { ...process.env, BLAZE_PROJECTS_DIR: projectsDir, BLAZE_WRITE_PORT: "db",
           BLAZE_READONLY: "", ...extraEnv },
  });
}
