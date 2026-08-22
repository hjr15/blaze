// scripts/model/field-promotion.mjs — promoting a filterable field to a real column.
//
// Every rule here is a measured number from the ADR-0018 benchmark, not a guess.
//
//   plain ALTER TABLE ADD COLUMN  ->  9.0 ms on 100k rows (metadata-only, PG 11+)
//   STORED generated column       ->  2,002 ms rewrite, and IMPOSSIBLE on SQLite
//   promoting a POPULATED field   ->  6.5 s PG / 2.1 s SQLite  (hence: at definition time)
//   indexing knee                 ->  200-400 indexed fields (insert p95 3.15 -> 51.4 ms)
//   Postgres hard column limit    ->  1,600
//
// promotionPlan is PURE and SYNCHRONOUS: it returns SQL, it never executes it.
export const FILTERABLE_CAP = 200;
export const PG_COLUMN_CEILING = 1590;   // refuse before Postgres refuses at 1,600

const SAFE_IDENT = /^[a-z][a-z0-9_]{0,50}$/;

const SQL_TYPE = {
  postgres: { text: "text", number: "numeric", date: "date", boolean: "boolean", enum: "text" },
  sqlite:   { text: "TEXT", number: "REAL",    date: "TEXT", boolean: "INTEGER", enum: "TEXT" },
};

// Exported: artifact-api.mjs's defineField needs the same table lookup to key its
// own-computed filterableCount/existingColumns by target table (BLZ-321 C5) --
// retyping it there would create a second copy that could silently drift from this one.
export const TARGET_TABLE = { requirement: "artifact", architecture: "artifact" };

export function promotionPlan({ field, existingColumns = [], filterableCount = 0, engine }) {
  if (!SQL_TYPE[engine]) return { ok: false, sql: null, error: `unknown engine ${engine}` };
  if (!SAFE_IDENT.test(String(field?.key ?? ""))) {
    return { ok: false, sql: null,
      error: `${JSON.stringify(field?.key)} is not a safe identifier — expected /^[a-z][a-z0-9_]{0,50}$/` };
  }
  if (!field.is_filterable) return { ok: true, sql: null, error: null };  // JSON tail

  const col = `cf_${field.key}`;
  if (existingColumns.includes(col)) {
    // ADR-0018's consequence that "will surprise people", surfaced at the moment it bites:
    // fields are DEFINED per project but promoted columns live on one SHARED table, so
    // another project having promoted this key already is enough to refuse. field_definition's
    // UNIQUE (project_key, key, applies_to_kind) permits two projects to define `risk`, and
    // promotion maps both to one `artifact.cf_risk` — the DDL and the promotion rule disagree,
    // and before BLZ-335 that disagreement surfaced as a raw `duplicate column name` from the
    // driver rather than a refusal anyone could act on.
    return { ok: false, sql: null, error:
      `column ${col} already exists on this table — promoted columns are shared across every `
      + "project in the installation, so another project may already have promoted this key. "
      + "Rename the field, or mark it unfilterable so it lives in the JSON tail." };
  }
  if (filterableCount >= FILTERABLE_CAP) {
    return { ok: false, sql: null, error:
      `refusing to promote ${field.key}: this installation already has ${filterableCount} `
      + `filterable fields, and the cap is ${FILTERABLE_CAP}. Past roughly 200 indexed fields `
      + `insert p95 degrades from 3.15ms to 51.4ms. Mark the field unfilterable, or retire one.` };
  }
  if (engine === "postgres" && existingColumns.length >= PG_COLUMN_CEILING) {
    return { ok: false, sql: null, error:
      `refusing to promote ${field.key}: this table has ${existingColumns.length} columns and `
      + `Postgres hard-refuses at 1600.` };
  }

  const table = TARGET_TABLE[field.applies_to_kind] ?? "ticket";
  const type = SQL_TYPE[engine][field.data_type];
  // Plain ADD COLUMN. Never GENERATED ... STORED.
  return { ok: true, error: null, sql: `ALTER TABLE ${table} ADD COLUMN ${col} ${type};` };
}
