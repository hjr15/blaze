// config.mjs — load blaze.config.json with defaults + env overrides, and derive
// the key-based regexes that reconcile.mjs and new-ticket.sh share.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  key: "TASK",
  projects: [],
  codeRepos: [],
  boardTitle: "Blaze",
  codeRepo: null,
  provider: "github",
  columns: ["backlog", "todo", "in-progress", "in-review", "done", "canceled", "duplicate"],
  terminal: ["done", "canceled", "duplicate"],
  defaultLabels: ["frontend", "backend", "infra", "docs", "bug", "chore"],
  port: 4321,
  agentCommand: "claude -p",
  commitMode: "per-op",
  loops: {
    reconcile: { enabled: true, intervalSec: 60 },
    groomer: { enabled: true, intervalSec: 300, columns: ["backlog"] },
  },
};

export function loadConfig({ root = ROOT, env = process.env, fileName = "blaze.config.json" } = {}) {
  const path = join(root, fileName);
  let file = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`blaze: cannot parse ${fileName}: ${e.message}`);
    }
  }

  const cfg = { ...DEFAULTS, ...file };
  cfg.loops = {
    reconcile: { ...DEFAULTS.loops.reconcile, ...(file.loops && file.loops.reconcile) },
    groomer: { ...DEFAULTS.loops.groomer, ...(file.loops && file.loops.groomer) },
  };

  // Env overrides (highest precedence).
  if (env.BLAZE_KEY) cfg.key = env.BLAZE_KEY;
  if (env.BLAZE_PORT) cfg.port = Number(env.BLAZE_PORT);
  if (env.BLAZE_AGENT_COMMAND) cfg.agentCommand = env.BLAZE_AGENT_COMMAND;
  if (env.BLAZE_COMMIT_MODE) cfg.commitMode = env.BLAZE_COMMIT_MODE;
  if (env.BLAZE_CODE_REPO !== undefined) cfg.codeRepo = env.BLAZE_CODE_REPO || null;

  // Derived values.
  cfg.codeRepoPath = cfg.codeRepo
    ? (isAbsolute(cfg.codeRepo) ? cfg.codeRepo : resolve(root, cfg.codeRepo))
    : null;
  cfg.idRegex = new RegExp("\\b" + cfg.key + "-(\\d+)", "i");
  cfg.idFromRef = (ref) => {
    const m = cfg.idRegex.exec(ref || "");
    return m ? `${cfg.key}-${m[1]}` : null;
  };
  cfg.fileRegex = new RegExp("^" + cfg.key + "-\\d+.*\\.md$");
  cfg.idLineRegex = new RegExp(`^id:\\s*(${cfg.key}-\\d+)`, "m");

  return Object.freeze(cfg);
}

// --- dataRoot resolution -----------------------------------------------------
// The engine (this install) and the data (blaze.config.json + projects/ +
// .blaze/ + the git repo commits land in) may live in different trees.
// Resolution ladder:
//   1. BLAZE_PROJECTS_DIR env — explicit projects dir; dataRoot is its parent
//   2. ./projects under CWD — running from a data repo checkout
//   3. the engine tree itself — single-tree back-compat (pre-split behaviour)
export function resolveRoots({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.BLAZE_PROJECTS_DIR) {
    const projectsDir = resolve(cwd, env.BLAZE_PROJECTS_DIR);
    return Object.freeze({ engineRoot: ROOT, dataRoot: dirname(projectsDir), projectsDir });
  }
  if (existsSync(join(cwd, "projects"))) {
    return Object.freeze({ engineRoot: ROOT, dataRoot: cwd, projectsDir: join(cwd, "projects") });
  }
  return Object.freeze({ engineRoot: ROOT, dataRoot: ROOT, projectsDir: join(ROOT, "projects") });
}

// CLI: `node scripts/config.mjs --get <field>` prints one field (for new-ticket.sh).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--get");
  if (i !== -1) {
    const cfg = loadConfig();
    const v = cfg[process.argv[i + 1]];
    console.log(v === undefined || v === null ? "" : v);
  }
}

// --- multi-project layer (Phase 3) -----------------------------------------
// The legacy single-board config above is retained as harmless defaults so the
// existing loops keep loading; the project API below is authoritative for the
// projects/<KEY>/<status>/ layout.
import { isAbsolute as _isAbsolute, resolve as _resolve } from "node:path";

const PROJECT_DEFAULTS = {
  components: [],
  labels: [],
  codeRepos: [],
  requireWorklogBeforeTerminal: false,
  workflowOverrides: null,
};

export function listProjects(cfg, { root = ROOT } = {}) {
  const c = cfg || loadConfig({ root });
  return Array.isArray(c.projects) ? c.projects.slice() : [];
}

export function loadProject(key, { root = ROOT } = {}) {
  const cfg = loadConfig({ root });
  const path = join(root, "projects", key, "project.json");
  let file = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new Error(`blaze: cannot parse projects/${key}/project.json: ${e.message}`); }
  }
  const merged = { ...PROJECT_DEFAULTS, ...file, key };
  const repos = merged.codeRepos.length ? merged.codeRepos : (cfg.codeRepos || []);
  merged.codeRepoPaths = repos.map((r) => (_isAbsolute(r) ? r : _resolve(root, r)));
  merged.idRegex = new RegExp("\\b" + key + "-(\\d+)", "i");
  merged.idFromRef = (ref) => { const m = merged.idRegex.exec(ref || ""); return m ? `${key}-${m[1]}` : null; };
  merged.fileRegex = new RegExp("^" + key + "-\\d+.*\\.md$");
  return Object.freeze(merged);
}
