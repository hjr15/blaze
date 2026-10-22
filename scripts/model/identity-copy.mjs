// scripts/model/identity-copy.mjs — `blaze db migrate --identity-from`: a board's identity.db
// copied into Postgres VERBATIM, inside the migrate transaction, and verified row for row before
// it commits (BLZ-706, spec §3).
//
// Verbatim is the point. Token hashes, password verifiers and live sessions travel unchanged,
// so every bearer token and every browser session the board issued keeps working: nothing is
// reissued, and nobody is locked out by the cutover.
//
// CREDENTIALS NEVER REACH OUTPUT. Every message here names a table, a column, a primary key or a
// path — never a value. A Postgres error on insert is reduced to its code and constraint,
// because its own text can quote the value it refused.
//
// The source is opened READ-ONLY, and `existsSync` is the only filesystem call: this module
// writes nothing to disk. node:sqlite is imported lazily, so `blaze db` without the flag never
// loads it.
import { existsSync } from "node:fs";

/** The six identity tables, in FK order (parents first), with primary keys and timestamp columns. */
export const IDENTITY_TABLES = [
  { name: "app_user", pk: ["id"], ts: ["created_at"] },
  { name: "user_identity", pk: ["provider", "subject"], ts: ["created_at"] },
  { name: "membership", pk: ["user_id", "scope_key"], ts: ["created_at"] },
  { name: "api_token", pk: ["id"], ts: ["created_at", "last_used_at", "expires_at", "revoked_at"] },
  { name: "local_password", pk: ["user_id"], ts: ["created_at", "updated_at"] },
  { name: "user_session", pk: ["id"], ts: ["created_at", "last_used_at", "expires_at", "revoked_at"] },
];

const IDENT = /^[a-z_][a-z0-9_]*$/;

/**
 * Every identity table of the SQLite roster at `path`. A table the roster does not have is
 * `{ rows: [], absent: true }`: a roster from before BLZ-566 has no local_password or
 * user_session, and that is a real, copyable state.
 */
export async function readIdentityRows(path) {
  if (!existsSync(path)) throw new Error(`blaze: no identity database at ${path}`);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((r) => r.name));
    const out = {};
    for (const t of IDENTITY_TABLES) {
      out[t.name] = present.has(t.name)
        ? { rows: db.prepare(`SELECT * FROM ${t.name}`).all().map((r) => ({ ...r })), absent: false }
        : { rows: [], absent: true };
    }
    return out;
  } finally { db.close(); }
}

/** One row as the verify compares it: keys sorted, every timestamp as UTC epoch milliseconds. */
export function canonicalIdentityRow(row, ts) {
  const out = {};
  for (const k of Object.keys(row).sort()) {
    const v = row[k];
    if (!ts.includes(k)) { out[k] = v; continue; }
    if (v === null || v === undefined || v === "") { out[k] = null; continue; }
    const ms = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isNaN(ms)) throw new Error(`identity verify: unreadable timestamp in ${k}`);
    out[k] = ms;
  }
  return out;
}

const pkOf = (t, row) => t.pk.map((k) => row[k]);
const pkLabel = (t, row) => pkOf(t, row).join("/");

function columnsOf(table, row) {
  const cols = Object.keys(row);
  for (const c of cols) {
    if (!IDENT.test(c)) throw new Error(`identity copy refused: ${table} has a column whose name is not a plain identifier`);
  }
  return cols;
}

/**
 * Insert every source row into the (empty) Postgres identity tables, in FK order. Runs inside
 * the caller's transaction. Refuses a non-empty app_user: the verify is exact only when the copy
 * is all the tables hold.
 *
 * @returns {{ [table]: number }} rows copied per table
 */
export async function copyIdentity(exec, source) {
  const held = Number((await exec.all("SELECT count(*) AS n FROM app_user", []))[0].n);
  if (held > 0) {
    throw new Error(`identity copy refused: app_user already holds ${held} row(s) in Postgres — `
      + "the copy must land in empty tables for its verify to be exact");
  }
  const counts = {};
  for (const t of IDENTITY_TABLES) {
    const rows = source[t.name]?.rows ?? [];
    for (const row of rows) {
      const cols = columnsOf(t.name, row);
      const sql = `INSERT INTO ${t.name} (${cols.map((c) => `"${c}"`).join(", ")}) `
        + `VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`;
      try { await exec.run(sql, cols.map((c) => row[c])); }
      catch (e) {
        // e.message can quote the refused value; only its code and constraint are safe to show.
        const why = [e.code, e.constraint && `constraint ${e.constraint}`].filter(Boolean).join(", ");
        throw new Error(`identity copy: Postgres refused ${t.name} row ${pkLabel(t, row)}`
          + (why ? ` (${why})` : ""));
      }
    }
    counts[t.name] = rows.length;
  }
  return counts;
}

/** Rows keyed by primary key (review M8): never paired by position, which depends on collation. */
function keyed(t, rows) {
  const m = new Map();
  for (const r of rows) m.set(JSON.stringify(pkOf(t, r)), canonicalIdentityRow(r, t.ts));
  return m;
}

/**
 * Re-read every identity table from Postgres and compare it with the source, row by row. Throws
 * on the first difference, naming table, primary key and column — never a value.
 */
export async function verifyIdentity(exec, source) {
  for (const t of IDENTITY_TABLES) {
    const src = source[t.name]?.rows ?? [];
    const pg = await exec.all(`SELECT * FROM ${t.name}`, []);
    if (pg.length !== src.length) {
      throw new Error(`identity verify: ${t.name} has ${pg.length} row(s) in Postgres, ${src.length} in the source`);
    }
    if (!src.length) continue;
    const a = Object.keys(src[0]).sort().join(",");
    const b = Object.keys(pg[0]).sort().join(",");
    if (a !== b) throw new Error(`identity verify: ${t.name} columns differ (source: ${a}; Postgres: ${b})`);
    const left = keyed(t, src);
    const right = keyed(t, pg);
    for (const [key, want] of left) {
      const label = JSON.parse(key).join("/");
      const got = right.get(key);
      if (!got) throw new Error(`identity verify: ${t.name} row ${label} is in the source but not in Postgres`);
      for (const col of Object.keys(want)) {
        if (!Object.is(want[col], got[col])) {
          throw new Error(`identity verify: ${t.name} row ${label} differs in ${col}`);
        }
      }
    }
  }
}
