// scripts/model/link-schema.mjs — the typed link meta-model.
//
// Endpoints are DECLARED, and anything undeclared is refused (ADR-0015). Jama's
// default is the opposite — "if you don't define a rule for a particular item type,
// that item type can have a relationship with anything" — which is maximum
// permissiveness in a governance tool (CS-012).
//
// source_kinds/target_kinds are stored as comma-separated text rather than an array
// type, because Postgres has arrays and SQLite does not, and the read path must be
// identical in both.
import { dialect } from "./sql-dialect.mjs";
/**
 * One override entry, normalised. The KEY is the identity (BLZ-392).
 *
 * The entry also carries a `name`, so identity was expressible twice and the two could
 * disagree. Adversarial review landed both halves of that: `{ Foo: { name: "Precedes" } }`
 * appended a SECOND entry named `Precedes` that `.find` never reached, silently discarding the
 * override; and `{ Precedes: { name: "Preceeds" } }` replaced the real entry with one nothing
 * could look up, which zeroed the whole schedule — every ticket stopped being a node — with no
 * finding, no error, and a `scheduleFindings()` result identical to a healthy board.
 *
 * Taking the name from the key makes both unrepresentable rather than validated.
 *
 * A malformed entry THROWS, by name. The alternative was to ignore it and keep the default,
 * which is silent in the same way: an operator who typed the block believes it took effect.
 * This is config loading, and ADR-0002's precedent for a breaking config shape is a hard,
 * named error carrying its own fix rather than a quiet drop.
 */
function normalizeLinkType(name, def) {
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    throw new Error(`blaze: schema.linkTypes["${name}"] must be an object, got `
      + `${Array.isArray(def) ? "an array" : def === null ? "null" : typeof def} — a link type `
      + "declares source_kinds "
      + "and target_kinds");
  }
  for (const side of ["source_kinds", "target_kinds"]) {
    if (!Array.isArray(def[side])) {
      throw new Error(`blaze: schema.linkTypes["${name}"].${side} must be an array of type `
        + `names, got ${def[side] === undefined ? "nothing" : typeof def[side]}. Without it `
        + `"${name}" declares no endpoints, and nothing would be schedulable through it.`);
    }
  }
  // The key wins. A `name` field that disagrees is overwritten rather than honoured.
  return { ...def, name };
}

/**
 * Layer an override onto the declared link types (BLZ-392).
 *
 * `types` and `workflows` are keyed objects and merge with a shallow spread; this list is an
 * ARRAY, so the override is a keyed object too — `{ Precedes: {...} }` — and the result stays
 * an array. Same layering, same config shape, no third convention.
 *
 * Replacement is WHOLESALE at the link-type name, exactly as `mergeWorkflows` replaces a
 * workflow. That is the deliberate choice: deep-merging `source_kinds` would make "remove a
 * kind" unexpressible. BLZ-361's lesson about wholesale replacement — that it silently drops
 * what it does not restate — is answered by `normalizeLinkType` refusing a malformed entry and
 * by `validateSchema` reporting an endpoint kind that names no declared type.
 *
 * Returns a COPY even when there is nothing to merge. `mergeTypes` and `mergeWorkflows` both
 * return `{ ...defaults }` precisely so a caller cannot corrupt the module constant for every
 * later caller; this returned `defaults` bare, so `resolveSchema({}).linkTypes` WAS
 * `DEFAULT_LINK_TYPES` and pushing to it changed what every subsequent resolve saw.
 */
export function mergeLinkTypes(defaults, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return [...defaults];
  const byName = new Map(
    Object.entries(override).map(([name, def]) => [name, normalizeLinkType(name, def)]));
  const out = defaults.map((d) => (byName.has(d.name) ? byName.get(d.name) : d));
  for (const [name, def] of byName) if (!defaults.some((d) => d.name === name)) out.push(def);
  return out;
}

export const DEFAULT_LINK_TYPES = [
  { name: "Implements", inverse_name: "Implemented by", source_kinds: ["feature"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Addresses",  inverse_name: "Addressed by",   source_kinds: ["architecture"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Verifies",   inverse_name: "Verified by",    source_kinds: ["story", "feature"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Supersedes", inverse_name: "Superseded by",  source_kinds: ["architecture"],
    target_kinds: ["architecture"], min_card: 0, max_card: 1 },
  { name: "Derives",    inverse_name: "Derived from",   source_kinds: ["requirement"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  // ADR-0022. The scheduler's dependency edge, and deliberately NOT `Blocks`: 248 of the
  // 392 live `Blocks` edges sit in 124 mutual pairs and carry no usable direction, because
  // frontmatter has no way to write the inverse. Enforcing `Blocks` would enforce a
  // direction the corpus does not contain. `Precedes` is new, has never been advisory, and
  // therefore reverses nothing — ADR-0001 stands and no superseding ADR is raised.
  //
  // Both endpoint sets are the five kinds ADR-0022 names. That default-deny refuses 58 of
  // the 392 live edges, 36 of them risk<->feature: a risk does not belong in a delivery
  // critical path.
  //
  // These are NOT "the delivery kinds", and an earlier version of this comment said so while
  // citing gantt.mjs as evidence. There are SIX delivery-workflow types — `epic` is the
  // sixth — and gantt.mjs's isDelivery() is `workflowFor(type) === "delivery"`, so it
  // INCLUDES epic. A retained epic therefore draws a Gantt bar and is not a Precedes endpoint.
  //
  // BLZ-378 CLOSED, under BLZ-388: that is deliberate and it is not a disagreement. An epic is
  // a CONTAINER, and BLZ-360 §8.3 states the rule: "a parent's dates are a roll-up OF the finished
  // schedule, computed afterwards" — so scheduling one computes the same quantity twice by two
  // methods. So a legacy epic is chart-only BY DESIGN: it never appears on
  // the critical path, and the bar it draws comes from whatever start/due it carries — the DATE
  // roll-up that should supply them is spec 4's and is NOT BUILT (BLZ-360 §8.3).
  //
  // This list is the DEFAULT, not the last word: BLZ-392 made it overridable through
  // `schema.linkTypes`, so `resolveSchema` layers it the way it layers types and workflows.
  // `schedule.mjs` and `import-deps.mjs` both take their endpoint kinds from the RESOLVED list —
  // so the two definitions that used to differ by `epic` are one definition, and it is now the
  // one the installation actually declares. `epic` was retired by BLZ-231 and the
  // board holds zero of them; schema.mjs leaves it no legal parent, so no new one can be made.
  { name: "Precedes",   inverse_name: "Follows",        source_kinds: ["feature", "story", "task", "bug", "subtask"],
    target_kinds: ["feature", "story", "task", "bug", "subtask"], min_card: 0, max_card: null },
];


export function linkDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS link_type (
  id           ${d.txt} NOT NULL,
  project_key  ${d.txt} NOT NULL,
  name         ${d.txt} NOT NULL,
  inverse_name ${d.txt} NOT NULL,
  source_kinds ${d.txt} NOT NULL,
  target_kinds ${d.txt} NOT NULL,
  min_card     ${d.int} NOT NULL DEFAULT 0,
  max_card     ${d.int},
  PRIMARY KEY (id),
  UNIQUE (project_key, name),
  CHECK (length(trim(source_kinds)) > 0),
  CHECK (length(trim(target_kinds)) > 0),
  CHECK (min_card >= 0),
  CHECK (max_card IS NULL OR max_card >= min_card)
)${d.tbl};

CREATE TABLE IF NOT EXISTS link (
  id           ${d.txt} NOT NULL,
  link_type_id ${d.txt} NOT NULL REFERENCES link_type (id) ON DELETE RESTRICT,
  source_id    ${d.txt} NOT NULL,
  target_id    ${d.txt} NOT NULL,
  created_at   ${d.ts} NOT NULL,
  created_by   ${d.txt} NOT NULL DEFAULT 'unknown',
  -- BLZ-330: staleness.mjs has always read l.reviewed_at and this column did not exist,
  -- so it was always NULL and EVERY link whose source had any revision reported stale.
  -- An indicator that is on for everything is off. Nullable on purpose: a link nobody
  -- has re-reviewed since the source changed is exactly the case section 5 wants
  -- surfaced, so "never reviewed" must be representable rather than defaulted away.
  reviewed_at  ${d.ts},
  -- ADR-0022's link table. The column itself is BLZ-360 section 5.3's, which calls a
  -- scheduling-specific column on a generic table a smell in as many words.
  -- Keep this comment free of semicolons: sql-dialect.test.mjs splits statements on a
  -- non-greedy match to the first one, so a semicolon here truncates the match before the
  -- table suffix it is checking for. An earlier version of this note also warned against the
  -- word the suffix uses. That was wrong, measured — the test asserts the CONSTRUCT
  -- (a closing paren, the suffix, a semicolon) and its own comment says so, noting that
  -- ON DELETE RESTRICT contains the substring and is a false alarm rather than a finding. Taken anyway: a zero-default column costs nothing now and
  -- retro-fitting one costs a schema-version bump later, and the alternative — a
  -- link_schedule side table for one integer — is worse. Every non-dependency link type
  -- ignores it. No CHECK on the sign: a negative lag is a lead, which finish-to-start
  -- scheduling uses.
  lag_minutes  ${d.int} NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE (link_type_id, source_id, target_id),
  CHECK (source_id <> target_id)
)${d.tbl};

CREATE INDEX IF NOT EXISTS link_source_idx ON link (source_id, link_type_id);
CREATE INDEX IF NOT EXISTS link_target_idx ON link (target_id, link_type_id);
`;
}
