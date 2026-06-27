// config.mjs — load blaze.config.json with defaults + env overrides, and derive
// the key-based regexes that reconcile.mjs and new-ticket.sh share.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  key: "TASK",
  boardTitle: "Blaze",
  codeRepo: null,
  provider: "github",
  columns: ["backlog", "todo", "in-progress", "in-review", "done", "canceled", "duplicate"],
  terminal: ["done", "canceled", "duplicate"],
  defaultLabels: ["frontend", "backend", "infra", "docs", "bug", "chore"],
  port: 4321,
  agentCommand: "claude -p",
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

// CLI: `node scripts/config.mjs --get <field>` prints one field (for new-ticket.sh).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--get");
  if (i !== -1) {
    const cfg = loadConfig();
    const v = cfg[process.argv[i + 1]];
    console.log(v === undefined || v === null ? "" : v);
  }
}
