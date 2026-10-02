// scripts/model/seed-counter.mjs — seeding the db-mode id allocator (BLZ-668, BLZ-669).
//
// `project_counter` holds the LAST number issued per project (BLZ-667). db-mode `allocate()`
// hands out `n + 1`, so the counter must sit at or above every number already taken — or the
// database issues an id the board already holds. "Taken" has three sources, and this module
// is the one place all three are read:
//
//   (a) the file corpus — every ticket file's number, INCLUDING one whose frontmatter will
//       not parse (its filename still holds the number), exactly as load-corpus.mjs counts
//       a row the database refused;
//   (b) the `.ids/` claims — a number handed out on the file path that may not have a ticket
//       yet (BLZ-136's ledger; `maxClaim` in claims.mjs reads it);
//   (c) the database's own `ticket` table — rows written in db mode that no file holds.
//
// NEVER LOWERS. `counterUpsertSql` is the only spelling of the upsert: a number already
// issued must not be issued twice, so a seed can only raise a counter.
import { maxId } from "./ids.mjs";
import { maxClaim } from "./claims.mjs";

const KEY_SHAPE = /^[A-Z][A-Z0-9]*$/;
const ID_SHAPE = /^([A-Z][A-Z0-9]*)-(\d+)$/;

/** The never-lower upsert on `project_counter`. Params: (project_key, n). */
export function counterUpsertSql(dialect) {
  if (dialect === "sqlite") {
    return `INSERT INTO project_counter (project_key, n) VALUES (?, ?)
     ON CONFLICT (project_key) DO UPDATE SET n = max(project_counter.n, excluded.n)`;
  }
  if (dialect === "postgres") {
    return `INSERT INTO project_counter (project_key, n) VALUES ($1, $2)
     ON CONFLICT (project_key) DO UPDATE SET n = GREATEST(project_counter.n, excluded.n)`;
  }
  throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
}

/**
 * The highest number per prefix across the file corpus (a) and the claims (b).
 * `readStorage` is REQUIRED — the caller names the reader (ADR-0038); this module never
 * defaults to the filesystem one.
 * @returns Map<prefix, n>
 */
export async function corpusMaxima({ projectsDir, readStorage }) {
  const out = new Map();
  const bump = (key, n) => {
    if (!KEY_SHAPE.test(key) || !Number.isInteger(n) || n <= 0) return;
    if (n > (out.get(key) ?? 0)) out.set(key, n);
  };
  for (const t of await readStorage.listTickets(projectsDir)) {
    const m = ID_SHAPE.exec(String(t.frontmatter?.id ?? "").trim());
    if (m) bump(m[1], Number(m[2]));
  }
  for (const key of await readStorage.listProjects(projectsDir)) {
    if (!KEY_SHAPE.test(key)) continue;
    bump(key, maxId(projectsDir, key));      // (a) by FILENAME: an unparseable ticket still counts
    bump(key, maxClaim(projectsDir, key));   // (b)
  }
  return out;
}

/**
 * Raise every prefix's counter to max(corpus, claims, table). Idempotent; never lowers.
 * `exec` is the {run, all} shape — sync (node:sqlite) or async (pg); both are awaited.
 * @returns [{ project, before, after }] sorted by project
 */
export async function seedCounter(exec, maxima, { dialect }) {
  const upsert = counterUpsertSql(dialect);
  const before = new Map();
  for (const r of await exec.all("SELECT project_key, n FROM project_counter", [])) {
    before.set(r.project_key, Number(r.n));
  }
  const want = new Map(maxima);
  for (const r of await exec.all(
    "SELECT project_key, MAX(num) AS n FROM ticket GROUP BY project_key", [])) {
    const n = Number(r.n);
    if (n > (want.get(r.project_key) ?? 0)) want.set(r.project_key, n);
  }
  for (const key of before.keys()) if (!want.has(key)) want.set(key, 0);
  const out = [];
  for (const key of [...want.keys()].sort()) {
    const b = before.get(key) ?? 0;
    const n = want.get(key);
    if (n > b) await exec.run(upsert, [key, n]);
    out.push({ project: key, before: b, after: Math.max(b, n) });
  }
  return out;
}
