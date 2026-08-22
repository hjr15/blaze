// scripts/model/artifact-store.mjs — the I/O half of the v4 artifact API (BLZ-325).
//
// The POLICY lives in artifact-api.mjs's decision functions (checkLink, checkGate,
// promotionPlan, evaluateCoverage, lintStatement) and stays pure and synchronous. This
// is the part that touches a database, and it is deliberately thin: every method here
// is a single INSERT/UPDATE against a table one of the thirteen schema modules defines
// — it never decides anything a pure function already decided.
//
// Same split BLZ-297 and identity-store.mjs (BLZ-304) arrived at, for the same hard
// reason: `exec` is a {run, all} pair, synchronous against node:sqlite and
// asynchronous against `pg`, and `await` on a plain value is a no-op — so one code
// path serves both engines without a synchronous guard ever trying to await.
//
// This module is optional from artifact-api.mjs's point of view: every mutating
// method there accepts a `store` as its second argument, and when it is omitted the
// API behaves exactly as it always has (in-memory `state` arrays only). Wiring a
// store is what makes the API's writes land in the real schema instead of stopping at
// the in-memory façade — the defect this ticket exists to close.
import { claimRef, claimedRefs } from "./ref-claim.mjs";

const ph = (dialect, i) => (dialect === "postgres" ? `$${i + 1}` : "?");

// Promoted custom-field columns are named `cf_<key>` where <key> already passed
// promotionPlan's SAFE_IDENT. Re-checked at the point of interpolation regardless.
const SAFE_COLUMN = /^cf_[a-z][a-z0-9_]{0,50}$/;

/**
 * The tail is an OBJECT in memory and JSON text in the column. An artifact with no custom
 * values stores a real empty object — never NULL (the column is NOT NULL) and never the
 * string "undefined", which JSON.stringify(undefined) produces and which would then fail
 * the column's own json_valid CHECK.
 */
function jsonTail(v) {
  if (typeof v === "string") return v;
  return JSON.stringify(v ?? {});
}

/** JS booleans need translating: Postgres takes them natively, SQLite INTEGER wants 0/1. */
function boolVal(v, dialect) {
  if (typeof v !== "boolean") return v;
  return dialect === "postgres" ? v : (v ? 1 : 0);
}

/**
 * @param exec     { run, all } — sync for node:sqlite, async for pg
 * @param dialect  'sqlite' | 'postgres'
 */
export function artifactStore(exec, { dialect = "sqlite", now = () => new Date().toISOString() } = {}) {
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const p = (i) => ph(dialect, i);

  return {
    dialect,
    exec,
    now,

    /** The one production caller of the ref_claim ledger (BLZ-326) — see claimRef's header. */
    async claimRef({ project_key, kind }) {
      return claimRef(exec, { dialect, project_key, kind, claimedAt: now() });
    },

    /**
     * Register an EXPLICITLY chosen ref in the ledger, so a later omitted-ref
     * allocation can never hand the same number back out. claimRef itself always
     * picks the next number; this is the sibling path for a caller-supplied one.
     * A collision here (the ref was already claimed) surfaces as a thrown error
     * instead of a silent double-issue — loud, not swallowed.
     */
    async registerRef({ project_key, kind, num, ref }) {
      await exec.run(
        `INSERT INTO ref_claim (project_key, kind, num, ref, claimed_at)
         VALUES (${p(0)}, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})`,
        [project_key, kind, num, ref, now()]);
    },

    async claimedRefs({ project_key, kind }) {
      return claimedRefs(exec, p, { project_key, kind });
    },

    /**
     * BLZ-332, §3.4: custom field values have two homes, decided once at definition time.
     * A FILTERABLE field was promoted to a real `cf_<key>` column (BLZ-321); everything
     * else goes to the `custom_fields` JSON tail. Never both — one value, one home.
     *
     * `a.promoted` therefore makes the column list dynamic, which is the only place in
     * this store that builds SQL from data. Every column name is re-validated against
     * SAFE_COLUMN here even though promotionPlan already checked the key at definition
     * time: a store that interpolates an unchecked identifier is one bug away from being
     * an injection point, and "the caller already checked" is exactly the assumption that
     * stops being true later.
     */
    async insertArtifact(a) {
      const cols = ["id", "project_key", "kind", "ref", "title", "statement", "body",
                    "status", "created_at", "updated_at", "custom_fields"];
      const vals = [a.id, a.project_key, a.kind, a.ref, a.title, a.statement ?? null,
                    a.body ?? null, a.status, a.created_at, a.updated_at,
                    jsonTail(a.custom_fields)];
      // BLZ-335 (C2): promoted values live FLAT on the record as `cf_<key>` — the same shape
      // the column has and every reader expects — so they are picked up by prefix here rather
      // than from a separate `promoted` sub-object that only this method knew about.
      for (const [col, v] of Object.entries(a)) {
        if (!col.startsWith("cf_")) continue;
        if (!SAFE_COLUMN.test(col)) {
          throw new Error(`refusing to build SQL with the unsafe column name ${JSON.stringify(col)}`);
        }
        cols.push(col);
        vals.push(boolVal(v, dialect));
      }
      await exec.run(
        `INSERT INTO artifact (${cols.join(", ")})
         VALUES (${cols.map((_, i) => p(i)).join(",")})`, vals);
    },

    async updateArtifactStatus({ id, status, updated_at }) {
      await exec.run(
        `UPDATE artifact SET status = ${p(0)}, updated_at = ${p(1)} WHERE id = ${p(2)}`,
        [status, updated_at, id]);
    },

    /** Append-only per §3.7: every change to an artifact writes a row here. */
    async insertRevision(r) {
      await exec.run(
        `INSERT INTO artifact_revision (id, artifact_id, at, actor, snapshot)
         VALUES (${p(0)},${p(1)},${p(2)},${p(3)},${p(4)})`,
        [r.id, r.artifact_id, r.at, r.actor ?? "unknown", r.snapshot ?? "{}"]);
    },

    async insertLink(l) {
      await exec.run(
        `INSERT INTO link (id, link_type_id, source_id, target_id, created_at, created_by, reviewed_at)
         VALUES (${p(0)},${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
        [l.id, l.link_type_id, l.source_id, l.target_id, l.created_at, l.created_by ?? "api",
         // BLZ-335 (C10): seeded, never NULL on creation. NULL means "never reviewed", which
         // is a real state a migration or import can produce — it is not what a link someone
         // just created means.
         l.reviewed_at ?? l.created_at]);
    },

    /**
     * Mark a link re-reviewed as of `reviewed_at` (BLZ-330). This is the only way a link
     * stops being stale: §5's indicator is computed by comparing this against the source
     * artifact's latest revision, never by clearing a stored suspicion flag — IBM removed
     * suspicion profiles at DNG 7.0.0 and Polarion's flag is invisible to its own API.
     */
    async reviewLink({ id, reviewed_at }) {
      await exec.run(
        `UPDATE link SET reviewed_at = ${p(0)} WHERE id = ${p(1)}`,
        [reviewed_at ?? now(), id]);
    },

    /** BLZ-338: a baseline over a document with no record of being baselined is not one. */
    async updateDocumentStatus({ id, status, updated_at = now() }) {
      await exec.run(
        `UPDATE document SET status = ${p(0)}, updated_at = ${p(1)} WHERE id = ${p(2)}`,
        [status, updated_at, id]);
    },

    /** Project-scoped per §3.6 — no document_id column exists to carry one. */
    async insertBaseline(b) {
      await exec.run(
        `INSERT INTO baseline (id, project_key, name, created_at, created_by, note)
         VALUES (${p(0)},${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
        [b.id, b.project_key, b.name, b.created_at, b.created_by, b.note ?? null]);
    },

    /** Every member pins a specific revision_id — never the live artifact. */
    async insertBaselineMember(m) {
      await exec.run(
        `INSERT INTO baseline_member (baseline_id, artifact_id, revision_id)
         VALUES (${p(0)},${p(1)},${p(2)})`,
        [m.baseline_id, m.artifact_id, m.revision_id]);
    },

    async insertFieldDefinition(f) {
      await exec.run(
        `INSERT INTO field_definition
           (id, project_key, key, label, data_type, applies_to_kind,
            is_filterable, is_required, enum_values, min_value, max_value)
         VALUES (${p(0)},${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)})`,
        [f.id, f.project_key, f.key, f.label ?? f.key, f.data_type, f.applies_to_kind,
         boolVal(Boolean(f.is_filterable), dialect), boolVal(Boolean(f.is_required), dialect),
         f.enum_values ?? null, f.min_value ?? null, f.max_value ?? null]);
    },

    /**
     * §4.4's first-class coverage rule (BLZ-327). `definition` lives in `state` as an
     * object (evaluateCoverage reads it structurally) and in the column as JSON text —
     * serialised here, the one place that knows about the column, rather than making
     * every caller remember. A caller that already handed over a string is passed
     * through untouched, so this can never double-encode.
     */
    async insertCoverageRule(r) {
      const definition = typeof r.definition === "string"
        ? r.definition : JSON.stringify(r.definition ?? {});
      await exec.run(
        `INSERT INTO coverage_rule
           (id, project_key, name, description, subject_kind, definition, enabled)
         VALUES (${p(0)},${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)})`,
        [r.id, r.project_key, r.name, r.description, r.subject_kind, definition,
         boolVal(r.enabled !== false, dialect)]);
    },

    async listCoverageRuleNames({ project_key }) {
      const rows = await exec.all(
        `SELECT name FROM coverage_rule WHERE project_key = ${p(0)}`, [project_key]);
      return rows.map((r) => r.name);
    },

    async setCoverageRuleEnabled({ project_key, name, enabled }) {
      await exec.run(
        `UPDATE coverage_rule SET enabled = ${p(0)} WHERE project_key = ${p(1)} AND name = ${p(2)}`,
        [boolVal(Boolean(enabled), dialect), project_key, name]);
    },

    /** Reading a JSON column back is deserialisation, not policy — the split holds. */
    async listCoverageRules({ project_key }) {
      const rows = await exec.all(
        `SELECT id, project_key, name, description, subject_kind, definition, enabled
           FROM coverage_rule WHERE project_key = ${p(0)} ORDER BY name`,
        [project_key]);
      return rows.map((r) => ({
        ...r,
        definition: typeof r.definition === "string" ? JSON.parse(r.definition) : r.definition,
        enabled: r.enabled === true || r.enabled === 1,
      }));
    },

    /**
     * BLZ-335 (C1). The install-wide field budget and the duplicate-column guard have to
     * count what the DATABASE holds, not what this process happens to remember. Without
     * this, a second process starts with an empty `state`, reports `used: 0` against a
     * table holding 200 rows, and drives promotion straight into a raw
     * `duplicate column name` from the driver. BLZ-329's stated claim — "counts PERSISTED
     * definitions" — was only ever true within one long-lived process.
     */
    async listFieldDefinitions() {
      const rows = await exec.all(
        `SELECT id, project_key, key, label, data_type, applies_to_kind,
                is_filterable, is_required, enum_values, min_value, max_value
           FROM field_definition`, []);
      return rows.map((r) => ({
        ...r,
        is_filterable: r.is_filterable === true || r.is_filterable === 1,
        is_required: r.is_required === true || r.is_required === 1,
      }));
    },

    /**
     * BLZ-343: the REAL column count, so the Postgres 1,600-column ceiling is reachable.
     * Postgres counts through information_schema; SQLite through PRAGMA table_info, which
     * `all()` returns as one row per column.
     */
    async countColumns(table) {
      if (!/^[a-z_][a-z0-9_]*$/.test(String(table))) {
        throw new Error(`refusing to inspect the unsafe table name ${JSON.stringify(table)}`);
      }
      if (dialect === "postgres") {
        const rows = await exec.all(
          `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = ${p(0)}`,
          [table]);
        return Number(rows[0]?.n ?? 0);
      }
      return (await exec.all(`PRAGMA table_info(${table})`, [])).length;
    },

    /** BLZ-343: the removal path min_card exists to constrain. */
    async deleteLink({ id }) {
      await exec.run(`DELETE FROM link WHERE id = ${p(0)}`, [id]);
    },

    /** Executes the ALTER TABLE promotionPlan returned. promotionPlan itself never does. */
    async runDdl(sql) {
      if (!sql) return;
      await exec.run(sql, []);
    },
  };
}
