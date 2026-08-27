// config.mjs — load blaze.config.json with defaults + env overrides, and derive
// the key-based regexes that reconcile.mjs and new-runner.mjs share.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkSchemaVersion } from "./model/schema-version.mjs";
import { SCHEMA_BLOCK_DROPPED } from "./model/schema-marker.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  key: "TASK",
  projects: [],
  codeRepos: [],
  boardTitle: "Blaze",
  columns: ["backlog", "todo", "in-progress", "in-review", "done", "canceled", "duplicate"],
  defaultLabels: ["frontend", "backend", "infra", "docs", "bug", "chore"],
  port: 4321,
  agentCommand: "claude -p",
  commitMode: "per-op",
  loops: {
    reconcile: { enabled: true, intervalSec: 60 },
    // BLZ-347 — the groomer ships DISABLED, deliberately. It was `enabled: true`, and the
    // supervisor auto-starts every enabled loop, so every default install spawned the
    // configured `agentCommand` with the full inherited environment every 300s without the
    // operator ever asking for it. Containment (groomer.mjs) now detects and reverts
    // out-of-bounds writes, but detection is after the fact and cannot see a network call
    // or a process that outlives the pass — and `spawnSync` still blocks the supervisor's
    // HTTP server for the duration of every run. Launching an arbitrary agent CLI on a
    // timer is an opt-in, not a default. Turn it on with
    // `"loops": { "groomer": { "enabled": true } }`.
    // timeoutSec/maxBufferMb bound that subprocess: no unbounded run, and no silent kill
    // at Node's 1 MB stdout default misreported as a generic non-zero exit.
    groomer: {
      enabled: false, intervalSec: 300, columns: ["backlog"],
      timeoutSec: 900, maxBufferMb: 16,
    },
  },
  views: { board: true, list: true, live: true, metrics: true, map: true, gantt: true },
  // BLZ-360 §2.3 ("Calendar"); ADR-0022 carries the rule but has no numbered sections. The
  // calendar the scheduler converts estimate_minutes through, and the
  // SAME number spec 2 §3.2's sprint capacity bar divides by. One number, one definition,
  // two consumers — which is why a test greps scripts/ for a hardcoded 480 rather than
  // trusting the convention. working_days uses JS getUTCDay() numbering: 0 = Sunday.
  schedule: { minutes_per_day: 480, working_days: [1, 2, 3, 4, 5] },
};

/** Validate the schedule block. Refusals name the key, per v4 spine §4.2. */
function checkSchedule(s) {
  const mpd = s.minutes_per_day;
  if (!Number.isInteger(mpd) || mpd <= 0) {
    throw new Error(`blaze: schedule.minutes_per_day must be a positive integer, got `
      + `${JSON.stringify(mpd)}. It is the only conversion between estimate minutes and `
      + `calendar time, so a zero or non-numeric value makes every derived date meaningless.`);
  }
  const wd = s.working_days;
  if (!Array.isArray(wd) || wd.length === 0
      || !wd.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    throw new Error(`blaze: schedule.working_days must be a non-empty array of day numbers `
      + `0-6 (0 = Sunday), got ${JSON.stringify(wd)}. A week with no working days is not a `
      + `calendar — every schedule over it would never finish.`);
  }
}

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

  // Config-schema version guard (ADR-0002): checked on the RAW parsed file,
  // before any default-merge or derivation — a board written against a contract
  // outside this engine's window must fail loud before it is interpreted at all.
  const version = checkSchemaVersion(file);
  if (!version.ok) throw new Error(`blaze: ${version.error}`);

  const cfg = { ...DEFAULTS, ...file };
  cfg.loops = {
    reconcile: { ...DEFAULTS.loops.reconcile, ...(file.loops && file.loops.reconcile) },
    groomer: { ...DEFAULTS.loops.groomer, ...(file.loops && file.loops.groomer) },
  };
  cfg.views = { ...DEFAULTS.views, ...(file.views && typeof file.views === "object" ? file.views : {}) };
  cfg.views.board = true; // the shell always needs its default view
  // Deep-merge, like loops: setting one schedule key must not blank the other.
  // Refuse a wrong-SHAPED block rather than silently falling back to defaults. The operator
  // most likely to be wrong — `"schedule": "8h"`, or an array, or a `minutesPerDay` typo —
  // is exactly the one a silent default leaves with no message and a schedule they did not
  // ask for. Absent is fine; present-and-not-an-object is not.
  if (file.schedule !== undefined) {
    if (!file.schedule || typeof file.schedule !== "object" || Array.isArray(file.schedule)) {
      throw new Error(`blaze: schedule must be an object with minutes_per_day and/or `
        + `working_days, got ${JSON.stringify(file.schedule)}`);
    }
    const known = new Set(["minutes_per_day", "working_days"]);
    const unknown = Object.keys(file.schedule).filter((k) => !known.has(k));
    if (unknown.length) {
      throw new Error(`blaze: schedule has no key ${unknown.map((k) => `'${k}'`).join(", ")}. `
        + `Known keys: minutes_per_day, working_days. A key nothing reads is a promise the `
        + `software does not keep.`);
    }
  }
  cfg.schedule = { ...DEFAULTS.schedule, ...(file.schedule || {}) };
  checkSchedule(cfg.schedule);

  // Env overrides (highest precedence).
  if (env.BLAZE_KEY) cfg.key = env.BLAZE_KEY;
  if (env.BLAZE_PORT) cfg.port = Number(env.BLAZE_PORT);
  if (env.BLAZE_AGENT_COMMAND) cfg.agentCommand = env.BLAZE_AGENT_COMMAND;
  if (env.BLAZE_COMMIT_MODE) cfg.commitMode = env.BLAZE_COMMIT_MODE;

  // Derived values.
  cfg.idRegex = new RegExp("\\b" + cfg.key + "-(\\d+)", "i");
  cfg.idFromRef = (ref) => {
    const m = cfg.idRegex.exec(ref || "");
    return m ? `${cfg.key}-${m[1]}` : null;
  };
  cfg.fileRegex = new RegExp("^" + cfg.key + "-\\d+.*\\.md$");
  cfg.idLineRegex = new RegExp(`^id:\\s*(${cfg.key}-\\d+)`, "m");

  // Declarative schema override block (types/workflows). Passed through verbatim;
  // resolved against the built-in defaults by the model layer. Non-object → null.
  // BLZ-396: remember that a block was DROPPED. Only this function sees the raw value —
  // downstream, a wrong-shaped `schema` and an absent one are both `null` and no consumer
  // can tell them apart, so a whole `"schema": "a string"` was ignored in silence. The
  // marker is the kind that was dropped, or null when nothing was.
  const rawSchema = file.schema;
  cfg.schema = (rawSchema && typeof rawSchema === "object" && !Array.isArray(rawSchema))
    ? rawSchema : null;
  // SYMBOL-keyed: `audit-runner.mjs` passes `auditCorpus` the raw `JSON.parse` of
  // project.json, so a string key would let an operator forge a malformation that is not
  // there. See model/schema-marker.mjs.
  cfg[SCHEMA_BLOCK_DROPPED] = (rawSchema === undefined || rawSchema === null || cfg.schema !== null)
    ? null : (Array.isArray(rawSchema) ? "an array" : typeof rawSchema);

  return Object.freeze(cfg);
}

// --- dataRoot resolution -----------------------------------------------------
// The engine (this install) and the data (blaze.config.json + projects/ +
// .blaze/ + the git repo commits land in) may live in different trees.
// Resolution ladder:
//   1. BLAZE_PROJECTS_DIR env — explicit projects dir; dataRoot is its parent
//   2. ./projects under CWD — running from a data repo checkout
//   3. the engine tree itself — single-tree back-compat (pre-split behaviour),
//      but ONLY when that tree really is a board (it has projects/ of its own);
//      otherwise throw rather than resolve somewhere merely writable
//
// BLZ-133: rung 3 used to gate on `engineRoot.includes("/node_modules/")` — an
// inference about how the engine was INSTALLED, standing in for the question that
// actually matters (is this tree a board?). A symlinked install breaks the
// inference: `fileURLToPath(import.meta.url)` resolves symlinks, so a global
// `blaze` linked to a dev checkout reports an engineRoot with no "/node_modules/"
// in it, sailed past the guard, and made the live engine repo the data root — a
// `blaze new` from an unscaffolded directory committed two tickets onto the
// engine's own main on 2026-08-02. Testing for projects/ asks the real question
// directly, so the install shape stops mattering.
export function resolveRoots({ env = process.env, cwd = process.cwd(), engineRoot = ROOT } = {}) {
  if (env.BLAZE_PROJECTS_DIR) {
    const projectsDir = resolve(cwd, env.BLAZE_PROJECTS_DIR);
    return Object.freeze({ engineRoot, dataRoot: dirname(projectsDir), projectsDir });
  }
  if (existsSync(join(cwd, "projects"))) {
    return Object.freeze({ engineRoot, dataRoot: cwd, projectsDir: join(cwd, "projects") });
  }
  if (existsSync(join(engineRoot, "projects"))) {
    return Object.freeze({ engineRoot, dataRoot: engineRoot, projectsDir: join(engineRoot, "projects") });
  }
  throw new Error("blaze: no data dir found — set BLAZE_PROJECTS_DIR or run from a directory containing projects/");
}

// Read the ambient data root's top-level schema override, guarded: any failure
// (packaged install with no data dir, unreadable/malformed config) yields null so
// the model layer falls back to its built-in defaults. resolveRoots/loadConfig are
// injectable so the failure path is testable.
export function ambientSchemaOverride({
  resolveRoots: rr = resolveRoots,
  loadConfig: lc = loadConfig,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  try {
    const { dataRoot } = rr({ env, cwd });
    const cfg = lc({ root: dataRoot, env });
    return cfg.schema || null;
  } catch {
    return null;
  }
}

// CLI: `node scripts/config.mjs --get <field>` prints one resolved config field —
// for scripts/tooling that need a config value directly in shell.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--get");
  if (i !== -1) {
    const cfg = loadConfig({ root: resolveRoots().dataRoot });
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
  requireComponents: false,
  requireLabels: false,
  codeRepos: [],
  requireWorklogBeforeTerminal: false,
  schema: null,
};

// --- INF-763: resolve relative codeRepos against the MAIN working tree --------
// `codeRepos` are stored relative (`../service-platform`). Resolved against the
// invoking root they break in a linked worktree: every path becomes a sibling of
// the WORKTREE, which does not exist, so reconcile silently scans nothing and
// still reports "already in sync". The board-main worktree is the documented
// INF-673 workaround, so this is the normal path, not an exotic one.
//
// `git rev-parse --git-common-dir` names the shared .git for any worktree —
// relative (`.git`) from the main tree, absolute from a linked one — so resolving
// it against `root` handles both. Its parent is the main working tree.
//
// Redirect ONLY when that parent actually looks like a board (`projects/` there).
// A non-git root, a packaged install, or an unusual layout falls through to the
// previous behaviour rather than guessing.
//
// Memoised: loadProject is on the hot path for every board command, and a repo's
// worktree layout does not change within a process.
const _mainWorktreeCache = new Map();
function mainWorktreeFor(root) {
  if (_mainWorktreeCache.has(root)) return _mainWorktreeCache.get(root);
  let out = root;
  const r = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (r.status === 0) {
    const raw = (r.stdout || "").trim();
    if (raw) {
      const commonDir = isAbsolute(raw) ? raw : resolve(root, raw);
      const parent = dirname(commonDir);
      if (parent !== root && existsSync(join(parent, "projects"))) out = parent;
    }
  }
  _mainWorktreeCache.set(root, out);
  return out;
}

export function listProjects(cfg, { root = ROOT } = {}) {
  const c = cfg || loadConfig({ root });
  return Array.isArray(c.projects) ? c.projects.slice() : [];
}

// `allowMissing` is for the ONE legitimate caller that may name a project which
// doesn't exist yet: `blaze new`, which bootstraps a project by creating its
// first ticket. Every other caller (move/edit/log/resolve/reconcile) is acting
// on a ticket that already exists, so a missing project dir there is a real
// misconfiguration and must throw.
export function loadProject(key, { root = ROOT, projectsDir = join(root, "projects"), allowMissing = false } = {}) {
  const cfg = loadConfig({ root });
  // BLZ-140: a missing project DIRECTORY is a misconfiguration (typo'd --project,
  // an unscaffolded key), not an empty taxonomy. Returning PROJECT_DEFAULTS for it
  // is a false-empty fail-open: the caller reads "exists, declares nothing" and
  // proceeds to write into a project that was never created. A directory that
  // exists WITHOUT project.json is a different, legitimate state — no taxonomy
  // declared — and still resolves to defaults below.
  const dir = join(projectsDir, key);
  if (!allowMissing && !existsSync(dir)) {
    throw new Error(`blaze: unknown project '${key}' — no such directory ${dir}`);
  }
  const path = join(dir, "project.json");
  let file = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new Error(`blaze: cannot parse projects/${key}/project.json: ${e.message}`); }
  }
  const merged = { ...PROJECT_DEFAULTS, ...file, key };
  const repos = merged.codeRepos.length ? merged.codeRepos : (cfg.codeRepos || []);
  merged.codeRepoPaths = repos.map((r) => (_isAbsolute(r) ? r : _resolve(mainWorktreeFor(root), r)));
  merged.idRegex = new RegExp("\\b" + key + "-(\\d+)", "i");
  merged.idFromRef = (ref) => { const m = merged.idRegex.exec(ref || ""); return m ? `${key}-${m[1]}` : null; };
  merged.fileRegex = new RegExp("^" + key + "-\\d+.*\\.md$");
  const rawProjSchema = merged.schema;
  merged.schema = (rawProjSchema && typeof rawProjSchema === "object" && !Array.isArray(rawProjSchema))
    ? rawProjSchema : null;
  // `null` here is the value PROJECT_DEFAULTS seeds, not something the operator wrote —
  // treating it as a dropped block refused every ordinary board, which the "a NON-EXEMPT
  // verb runs clean on an ordinary good board" test caught at once.
  merged[SCHEMA_BLOCK_DROPPED] = (rawProjSchema === undefined || rawProjSchema === null || merged.schema !== null)
    ? null : (Array.isArray(rawProjSchema) ? "an array" : typeof rawProjSchema);
  return Object.freeze(merged);
}
