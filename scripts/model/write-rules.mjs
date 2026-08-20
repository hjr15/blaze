// scripts/model/write-rules.mjs — required fields as a WRITE-PATH rule (BLZ-289).
//
// Design §7.3. The corpus holds 242 tickets that violate their own type's `required`
// list — 165 task, 52 story, 25 bug, every one of them missing `estimate`. They exist
// because `validateTicket` runs on write and never on read, so the engine has always
// tolerated them.
//
// A NOT NULL column or a table-level CHECK would therefore make the migration
// impossible without INVENTING 242 estimates, and an invented estimate does not stay
// in its lane: it flows into every roll-up, every burn-down and every velocity figure,
// where nobody can tell it from a real one. 212 of the 242 are already terminal, so
// the fabrication would be permanent and unreviewable.
//
// So T2 is a trigger on the write path with exactly two escapes:
//
//   1. MIGRATION MODE — `migration_mode(id=1, enabled)`. T2 returns early when set.
//      A table rather than a session GUC (`SET blaze.migrating`) because a GUC is
//      Postgres-only and this rule has to behave the same on both drivers.
//   2. NO-REGRESSION — on UPDATE, T2 raises only when a field is BECOMING empty. A
//      grandfathered estimate-less task can still be retitled, moved, logged against
//      and closed. It just cannot have a populated estimate cleared. On INSERT,
//      outside migration mode, T2 always enforces.
//
// Stated plainly: this is weaker than "the schema guarantees required fields are
// present", and exactly as strong as today's behaviour — which is the actual
// requirement. The migration is lossless and no NEW incomplete ticket can be created.

// The `field` values `resolved_required_field` admits, mapped to the column each one
// actually tests. A required field with no column here is enforced by NOTHING, which
// is the failure mode the design calls "a required field nothing enforces" — so the
// mapping is exhaustive over what the config CHECK allows, and the gaps are named.
export const REQUIRED_FIELD_COLUMNS = {
  title:       { column: "title", empty: (c) => `${c} IS NULL OR length(trim(${c})) = 0` },
  description: { column: "body",  empty: (c) => `${c} IS NULL OR length(trim(${c})) = 0` },
  estimate:    { column: "estimate_minutes", empty: (c) => `${c} IS NULL` },
};

// `likelihood` and `impact` are accepted by blaze_config.type_required_field's CHECK —
// `risk` declares both — but `ticket` has no column for either yet, so they cannot be
// enforced. Named here rather than silently skipped: an unenforceable required field
// is worse than an absent one, because the config claims a guarantee nothing provides.
export const UNENFORCEABLE_REQUIRED_FIELDS = ["likelihood", "impact"];

const MIGRATION_OFF_SQLITE =
  "COALESCE((SELECT enabled FROM migration_mode WHERE id = 1), 0) = 0";

function requiredExists(alias) {
  return `EXISTS (SELECT 1 FROM resolved_required_field r
                   WHERE r.project_key = ${alias}.project_key
                     AND r.type        = ${alias}.type
                     AND r.field       = %FIELD%)`;
}

/** The migration-mode table plus T2, for one dialect. */
export function writeRulesDdl(name) {
  if (name === "sqlite") return sqliteRules();
  if (name === "postgres") return postgresRules();
  throw new Error(`unknown dialect ${JSON.stringify(name)} — expected 'sqlite' or 'postgres'`);
}

function sqliteRules() {
  let out = `
CREATE TABLE IF NOT EXISTS migration_mode (
  id      integer PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  set_at  TEXT,
  set_by  TEXT
);
INSERT OR IGNORE INTO migration_mode (id, enabled) VALUES (1, 0);
`;
  for (const [field, { column, empty }] of Object.entries(REQUIRED_FIELD_COLUMNS)) {
    const req = (a) => requiredExists(a).replace("%FIELD%", `'${field}'`);
    out += `
CREATE TRIGGER IF NOT EXISTS ticket_require_${field}_insert
BEFORE INSERT ON ticket FOR EACH ROW
WHEN ${MIGRATION_OFF_SQLITE}
 AND ${req("NEW")}
 AND (${empty(`NEW.${column}`)})
BEGIN
  SELECT RAISE(ABORT, '${field} is required for this ticket type');
END;

-- No-regression: raises only when the field is BECOMING empty. A grandfathered row
-- that was already empty stays writable in every other respect.
CREATE TRIGGER IF NOT EXISTS ticket_require_${field}_update
BEFORE UPDATE ON ticket FOR EACH ROW
WHEN ${MIGRATION_OFF_SQLITE}
 AND ${req("NEW")}
 AND (${empty(`NEW.${column}`)})
 AND NOT (${empty(`OLD.${column}`)})
BEGIN
  SELECT RAISE(ABORT, '${field} is required and cannot be cleared once set');
END;
`;
  }
  return out.trim() + "\n";
}

function postgresRules() {
  const checks = Object.entries(REQUIRED_FIELD_COLUMNS).map(([field, { column, empty }]) => `
  IF EXISTS (SELECT 1 FROM resolved_required_field r
              WHERE r.project_key = NEW.project_key AND r.type = NEW.type
                AND r.field = '${field}')
     AND (${empty(`NEW.${column}`)}) THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION '${field} is required for this ticket type';
    ELSIF NOT (${empty(`OLD.${column}`)}) THEN
      RAISE EXCEPTION '${field} is required and cannot be cleared once set';
    END IF;
  END IF;`).join("\n");

  return `
CREATE TABLE IF NOT EXISTS migration_mode (
  id      integer PRIMARY KEY CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  set_at  timestamptz,
  set_by  text
);
INSERT INTO migration_mode (id, enabled) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION ticket_required_fields() RETURNS trigger AS $BLZ$
BEGIN
  IF COALESCE((SELECT enabled FROM migration_mode WHERE id = 1), false) THEN
    RETURN NEW;
  END IF;
${checks}
  RETURN NEW;
END;
$BLZ$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_require_fields ON ticket;
CREATE TRIGGER ticket_require_fields
BEFORE INSERT OR UPDATE ON ticket
FOR EACH ROW EXECUTE FUNCTION ticket_required_fields();
`.trim() + "\n";
}

/** Turn migration mode on or off. Portable; the migration sets it inside its own transaction. */
export function setMigrationModeSql(name, enabled) {
  const pg = name === "postgres";
  if (!pg && name !== "sqlite") {
    throw new Error(`unknown dialect ${JSON.stringify(name)} — expected 'sqlite' or 'postgres'`);
  }
  const v = pg ? (enabled ? "true" : "false") : (enabled ? 1 : 0);
  return `UPDATE migration_mode SET enabled = ${v} WHERE id = 1`;
}
