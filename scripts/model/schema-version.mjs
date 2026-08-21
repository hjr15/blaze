// scripts/model/schema-version.mjs — the engine's config-schema compat window
// and the pure guard over it (ADR-0002).
//
// Deliberately a ZERO-IMPORT module: config.mjs must be able to import the guard,
// and schema.mjs/workflows.mjs already import config.mjs and call
// ambientSchemaOverride() at module scope — so any import edge from config.mjs
// into the schema/workflows graph is a cycle that would evaluate
// ambientSchemaOverride() before config.mjs's own consts exist (its catch-all
// would then silently drop ambient schema overrides). schema-config.mjs
// re-exports everything here, so consumers still find the schema surface in one
// place.
//
// SCHEMA_VERSION is the contract this engine writes/speaks; MIN_SCHEMA_VERSION is
// the oldest contract it still reads. A board loads iff
// MIN_SCHEMA_VERSION <= schemaVersion <= SCHEMA_VERSION. An absent stamp is the
// pre-versioning baseline, defined as v1.
export const SCHEMA_VERSION = 2;
export const MIN_SCHEMA_VERSION = 1;

/**
 * Keys removed from the config contract, and what to do instead (BLZ-298).
 *
 * Each was accepted by `loadConfig` and read by NOTHING — verified by grep across
 * `scripts/`. A config key nothing reads is a promise the software does not keep: the
 * next person to set `provider: "gitlab"` reasonably expects something to happen.
 *
 * Removal is a hard error rather than a silent drop, because silently dropping it is
 * exactly the behaviour being fixed.
 */
export const REMOVED_KEYS = {
  provider: "nothing read it; reconcile talks to GitHub via `gh` regardless",
  terminal: "nothing read it; terminal statuses come from the workflow registry "
          + "(model/workflows.mjs), per type",
  codeRepo: "nothing read it; set `codeRepos` on the project instead "
          + "(projects/<KEY>/project.json)",
};

/** Pure guard over a parsed config object's schemaVersion stamp.
 *  `current`/`min` are injectable so every branch — including ones unreachable
 *  with the real constants (at MIN === CURRENT === 1 the too-old branch cannot
 *  fire) — stays unit-testable. Returns { ok, error } and never throws. */
export function checkSchemaVersion(cfg, { current = SCHEMA_VERSION, min = MIN_SCHEMA_VERSION,
                                          removed = REMOVED_KEYS } = {}) {
  // Checked before the version, and on the RAW parsed file: a board carrying a key this
  // engine no longer honours must be told, not quietly obeyed in part.
  const present = Object.keys(removed).filter((k) => cfg && cfg[k] !== undefined);
  if (present.length) {
    const lines = present.map((k) => `  ${k} — ${removed[k]}`).join("\n");
    return { ok: false, error:
      `blaze.config.json sets ${present.length === 1 ? "a key" : "keys"} this engine no `
      + `longer reads:\n${lines}\n`
      + `Delete ${present.length === 1 ? "it" : "them"} — nothing else changes. `
      + "See https://github.com/hjr15/blaze/blob/main/docs/schema-versioning.md" };
  }
  const v = cfg ? cfg.schemaVersion : undefined;
  if (v === undefined || v === null) return { ok: true, error: null }; // pre-versioning board = v1
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    // Quote non-numbers (via JSON.stringify) so a stringified digit like "1"
    // renders as `"1"`, not the self-contradictory bare `1`; numbers render
    // via String() so NaN stays `NaN` rather than regressing to `null`
    // under JSON.stringify.
    const shown = typeof v === "number" ? String(v) : JSON.stringify(v);
    return { ok: false, error: `invalid schemaVersion ${shown} — must be a positive integer; see https://github.com/hjr15/blaze/blob/main/docs/schema-versioning.md` };
  }
  if (v > current) {
    return { ok: false, error: `board schemaVersion ${v} is newer than this engine supports (supported: ${min}..${current}); upgrade the engine — see https://github.com/hjr15/blaze/blob/main/docs/schema-versioning.md` };
  }
  if (v < min) {
    return { ok: false, error: `board schemaVersion ${v} is older than this engine supports (supported: ${min}..${current}) — see https://github.com/hjr15/blaze/blob/main/docs/schema-versioning.md` };
  }
  return { ok: true, error: null };
}
