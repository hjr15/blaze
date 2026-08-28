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

// --- BLZ-402: one project-key shape check, shared by every load path ---------------
// `idRegex`/`fileRegex`/`idLineRegex` (here and in loadProject) interpolate the project
// key RAW into `new RegExp(...)`. Escaping the key would stop it crashing the regex
// engine, but it would NOT stop a key that is valid regex but not a valid key — e.g.
// "A.*" — from being built into a working matcher that is silently too broad (it then
// matches ids belonging to other projects). The fix is a SHAPE check, applied before the
// key ever reaches `new RegExp(...)`, not quoting.
//
// `scripts/init.mjs`'s first-run wizard held its own private copy of this same shape
// (`KEY_RE`) but only checked the `--project` wizard answer — nothing on the config-LOAD
// path (this file) ever ran it, so a key that slipped in some other way (hand-edited
// `blaze.config.json`, `BLAZE_KEY`) reached the regex builders unchecked. KEY_RE now
// lives here as the one shared definition; init.mjs imports it instead of holding its
// own copy.
export const KEY_RE = /^[A-Z][A-Z0-9]*$/;

export class InvalidProjectKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidProjectKeyError";
  }
}

// BLZ-402 round-2 review finding 3, narrowed by round-3. `loadConfig` can throw for
// several reasons, and `scripts/audit-runner.mjs` needs to tell them apart: BLZ-392
// deliberately tolerates EXACTLY TWO of them (an unparseable `blaze.config.json`, and a
// `schemaVersion` stamp genuinely outside the engine's supported window) by treating the
// board as though it had no config at all and still reporting `ok=true` over the corpus.
// Every OTHER `loadConfig` throw — a malformed `schedule` block (wrong shape, an unknown
// key, a bad `minutes_per_day` or `working_days`), a bad `key`/`projects[]` entry
// (`InvalidProjectKeyError`), OR a config that sets a REMOVED key (`provider`, `terminal`,
// `codeRepo`; BLZ-298) — is a genuine load failure that already makes every non-exempt CLI
// verb refuse, and audit must not call that board clean. A removed key is semantically
// unrelated to the schemaVersion stamp (the stamp can be exactly current while a removed
// key is set), so round-3 stopped `checkSchemaVersion` filing it under the same `kind` as
// a version-window failure — see `scripts/model/schema-version.mjs` — and it now throws a
// plain `Error` below, same as the malformed-`schedule` family, instead of
// `IncompatibleSchemaVersionError`. These two classes exist so audit-runner.mjs can name
// the two tolerated cases by `e.name`, the same string-comparison pattern cli.mjs already
// uses for `InvalidProjectKeyError` (so exempt verbs never pay for importing the class),
// instead of matching on message text, which is for humans, not control flow.
export class ConfigParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigParseError";
  }
}

export class IncompatibleSchemaVersionError extends Error {
  constructor(message) {
    super(message);
    this.name = "IncompatibleSchemaVersionError";
  }
}

/**
 * Throws InvalidProjectKeyError unless `key` is a valid project-key shape. `source`
 * names where the value came from, for the refusal message — e.g. "blaze.config.json's
 * 'key' field", "the BLAZE_KEY environment variable", "a --project argument", "ticket
 * ENG-1's 'project' field".
 *
 * BLZ-408: `source` is the CALLER'S to supply and must describe what the caller actually
 * holds. `loadProject` used to hardcode "a --project argument" for every one of its
 * callers, and most of them hold no such thing — `edit.mjs` and `move.mjs` pass a ticket's
 * own `project:` frontmatter, `cli.mjs`'s preflight passes a directory name off a disk
 * listing. An operator with one corrupt ticket file was told to fix a flag they never
 * typed, which sends them to the wrong file.
 *
 * BLZ-409: the message was 70 words, and ~50 of them explained why a regex shape check is
 * the right mechanism. That is the reasoning behind the rule, not the rule, and it is
 * almost never what the reader needs: the overwhelmingly common cause of landing here is a
 * typo or a lower-case key. The refusal now states WHICH value, WHERE it came from, and
 * WHAT shape is expected, and points at ADR-0025 for everything else. The reasoning is not
 * deleted — it is one link away, and the KEY_RE comment above still carries it in full.
 *
 * BLZ-460: that link is a URL, not a repo-relative path. `package.json`'s `files`
 * whitelist ships `scripts/`, `AGENTS.md`, `LICENSE` and `README.md` — `docs/` ships ZERO files
 * (`npm pack --dry-run --json`: 149 files, 0 of them under `docs/`). BLZ-409 made this
 * pointer load-bearing by deleting the 34 words of rationale it replaced, so for anyone
 * who installed `@hjr15/blaze-board` the one route from the refusal to the reasoning
 * resolved to nothing — and a bare path is not clickable in a terminal either. The same
 * constant is what `AGENTS.md` links and what `blaze init --help` prints, so the three
 * cannot drift apart. `tests/config-key-validation.test.mjs` pins reachability against
 * the PACKED FILE LIST rather than the working tree, which always has the file.
 */
export const KEY_RULE_DOC =
  "https://github.com/hjr15/blaze/blob/main/docs/decisions/0025-a-project-key-is-refused-never-normalised.md";

export function assertValidKey(key, { source }) {
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw new InvalidProjectKeyError(
      `blaze: ${source} ${JSON.stringify(key)} is not a valid project key. Expected `
      + `upper-case letters and digits, starting with a letter (e.g. ENG, OBA, BLZ2). `
      + `Why the shape is exact, and why it is never auto-corrected: ${KEY_RULE_DOC}`,
    );
  }
}

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
      throw new ConfigParseError(`blaze: cannot parse ${fileName}: ${e.message}`);
    }
  }

  // Config-schema version guard (ADR-0002): checked on the RAW parsed file,
  // before any default-merge or derivation — a board written against a contract
  // outside this engine's window must fail loud before it is interpreted at all.
  const version = checkSchemaVersion(file);
  // BLZ-402 round-3: `checkSchemaVersion`'s two failure reasons are semantically
  // unrelated (a removed key says nothing about the schemaVersion stamp), so only the
  // version-window kind gets the `IncompatibleSchemaVersionError` class BLZ-392's
  // tolerance keys off. A removed key throws a plain `Error`, same as a malformed
  // `schedule` block — a genuine load failure `scripts/audit-runner.mjs` must not
  // tolerate.
  if (!version.ok) {
    if (version.kind === "removed-key") throw new Error(`blaze: ${version.error}`);
    throw new IncompatibleSchemaVersionError(`blaze: ${version.error}`);
  }

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
  let keySource = "blaze.config.json's 'key' field";
  // BLZ-410: PRESENCE, not truthiness. `if (env.BLAZE_KEY)` discarded `BLAZE_KEY=""` as
  // though no override had been given, so the file key silently won with no message on any
  // stream. An empty override is a CALLER ERROR — BLZ-394 settled exactly this for an empty
  // `--project=` — so it now reaches `assertValidKey` below and is refused by name.
  // `undefined` (genuinely absent) is the only value that still means "no override".
  //
  // BLZ-461: the harm this used to claim — `BLAZE_KEY="$UNSET_VAR" blaze move …` running
  // "against a different board than it asked for" — DOES NOT REPRODUCE, and the correction
  // is recorded here rather than quietly dropped. Measured on identical boards:
  // `BLAZE_KEY=OPS blaze move ENG-1 in-progress` and the same command with no `BLAZE_KEY`
  // both print `ENG-1: defined → in-progress`; `move-runner.mjs` reads `cfg` only for
  // `cfg.commitMode` and `applyMove` never sees it. `blaze new`'s prefix comes from
  // `--project`, not `cfg.key` (`BLAZE_KEY=OPS blaze new --project ENG` created `ENG-3`),
  // and `loadProject` derives its own matchers from the per-project key.
  //
  // `cfg.key`'s derived matchers below have exactly ONE consumer in the engine:
  // `scripts/loops/groomer.mjs:70`, `matchersFor(cfg, null)`, reached only from that
  // file's legacy flat-layout branch — which `statusDirs` takes only on a board whose
  // status directories sit at the ROOT (`<root>/backlog/`). On the `projects/<KEY>/
  // <status>/` layout every board here uses, no call path reaches it at all.
  // `cfg.idRegex` and `cfg.idFromRef` have no consumer on any layout — reconcile derives
  // its own per project from `loadProject`.
  //
  // So this flip is DEFENSIVE. It is correct, and the blast radius of the behaviour it
  // replaced was one call path on one legacy layout — not `move`, not `new`, not
  // reconcile. Its value is that an empty override cannot silently become the file key
  // for a consumer added tomorrow, not that a verb is misbehaving now.
  if (env.BLAZE_KEY !== undefined) {
    cfg.key = env.BLAZE_KEY; keySource = "the BLAZE_KEY environment variable";
  }
  if (env.BLAZE_PORT) cfg.port = Number(env.BLAZE_PORT);
  if (env.BLAZE_AGENT_COMMAND) cfg.agentCommand = env.BLAZE_AGENT_COMMAND;
  if (env.BLAZE_COMMIT_MODE) cfg.commitMode = env.BLAZE_COMMIT_MODE;

  // BLZ-402: ONE call, made AFTER the env override lands on cfg.key and BEFORE any
  // regex is derived from it — this is what makes the env override validated exactly
  // as much as the file key (AC-2), rather than a second, easy-to-forget check.
  assertValidKey(cfg.key, { source: keySource });

  // BLZ-402 review finding 2: `cfg.projects` members are project keys too, and reach
  // `new RegExp(...)` the same way `cfg.key` does — `scripts/loops/groomer.mjs`'s
  // `matchersFor` builds one straight from each entry, with no shape check of its own.
  // Validating `cfg.key` alone left every `projects[]` entry able to reach a regex
  // builder unchecked, which is precisely the crash (a metacharacter key) and the
  // silent over-match (a valid-regex-but-not-a-key value like "A.*") this file's own
  // `assertValidKey` exists to make unreachable. Guarded on Array.isArray: a
  // wrong-shaped `projects` block is a different defect (not this ticket's) and stays
  // whatever it already was rather than a new TypeError from iterating a non-array.
  if (Array.isArray(cfg.projects)) {
    for (const p of cfg.projects) {
      assertValidKey(p, { source: "blaze.config.json's 'projects' array" });
    }
  }

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
// BLZ-408: `source` names where THIS caller's key came from, and defaults to a phrase true
// of every caller rather than to one caller's flag. It used to be hardcoded to "a --project
// argument", which is accurate only for `new.mjs`; `edit.mjs`/`move.mjs` pass a ticket's own
// `project:` frontmatter and `cli.mjs`'s preflight passes a directory name, so the refusal
// pointed those operators at a flag they never typed.
export function loadProject(key, {
  root = ROOT, projectsDir = join(root, "projects"), allowMissing = false,
  source = "a project key",
} = {}) {
  const cfg = loadConfig({ root });
  // BLZ-402: shape-check BEFORE anything else — a malformed key is refused up front
  // rather than surfacing later as "unknown project" (directory-existence) or a raw
  // regex-engine crash once `merged.idRegex` is built from it below.
  assertValidKey(key, { source });
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
