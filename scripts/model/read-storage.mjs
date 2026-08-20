// scripts/model/read-storage.mjs — the query-shaped read seam (BLZ-270, ADR-0009).
//
// ADR-0009: the driver answers NAMED questions. It does not hand back the whole
// corpus and leave the caller to filter. Measured on the live 2,534-ticket corpus,
// the walk shape costs 578x on resolving one id and 280x on drilling one parent,
// because a database can answer both from an index and a walk cannot.
//
// The filesystem driver implements the same names over the existing walk, so every
// call site keeps working while files remain the store. That is the point of naming
// the operations now rather than at cutover: the NAMES are the contract, the walk is
// just today's implementation of them.
//
// Operations, chosen from what the engine actually asks:
//
//   getTicket(root, id)          resolve one id, or refuse   — 7 call sites, 6 verbs
//   listChildren(root, parentId) the board drill
//   blockersOf(root, id)         inbound Blocks links — move's advisory check
//   listProjects(root)            the project keys that exist
//   changeToken(root, {project})  opaque "has anything changed?", for the poll
//   listTickets(root)            everything, for the index and audit
//
// `listTickets` survives deliberately: `buildIndex` and `auditCorpus` genuinely do
// need every ticket, and pretending otherwise would push a fake filter into them.
// What ADR-0009 rejects is `listTickets` being the ONLY affordance.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkTickets } from "./index.mjs";

/**
 * Resolve one id, or refuse.
 *
 * BLZ-122: an id that resolves to two files is ambiguous and a write must not land
 * on a guess. This scans the WHOLE corpus — an early return at the first hit cannot
 * see a duplicate that sorts later, and index.mjs records that "an early return is
 * precisely the bug". A database driver gets this for free (id is the primary key,
 * so `duplicates` is structurally unreachable) but must still return the same shape.
 *
 * @returns { found } | { found: null } | { found: null, duplicates: [path, ...] }
 */
export const fsReadStorage = {
  name: "fs",

  getTicket(root, id) {
    const matches = [];
    for (const t of walkTickets(root)) {
      if (t.frontmatter?.id === id) matches.push(t);
    }
    if (matches.length > 1) {
      return { found: null, duplicates: matches.map((t) => t.file).sort() };
    }
    return { found: matches[0] ?? null };
  },

  listChildren(root, parentId) {
    const out = [];
    for (const t of walkTickets(root)) {
      if (t.frontmatter?.parent === parentId) out.push(t);
    }
    return out;
  },


/**
 * Every ticket carrying a `Blocks` link that targets `id`.
 *
 * `move` needs this on any transition to in-progress, and today it is the single
 * worst read in the engine: a full corpus walk to answer a two-row question. On the
 * live 2,534-ticket corpus that is ~22 ms and ~5.6 MiB materialised per invocation,
 * against 0.06 ms from an index — which is exactly the 578x ADR-0009 exists to make
 * reachable. A database driver answers it with
 * `WHERE target_id = ? AND link_type = 'Blocks'`.
 *
 * It returns the LINK SOURCES and nothing more. Deciding whether a blocker is still
 * open is a schema question (`isType`/`isTerminal`) and stays with the caller — a
 * storage driver that knew about terminal statuses would be reaching past its job.
 */
  blockersOf(root, id) {
    const out = [];
    for (const t of walkTickets(root)) {
      if (t.frontmatter?.id === id) continue;
      const blocks = (t.frontmatter?.links ?? [])
        .some((l) => l.type === "Blocks" && l.target === id);
      if (blocks) out.push(t);
    }
    return out;
  },


/**
 * An opaque "has anything changed?" token, for the board's auto-reload poll.
 *
 * This is the fourth read entry point, and the only one that never went through
 * walkTickets: `contentHash` hashed path:size:mtimeMs over every directory, at a
 * measured 35.4 ms per poll per open tab, every 3 seconds. A database has no mtime.
 *
 * It is also the one place the read-seam panel's REJECTED "opaque staleness token"
 * idea is right. The poll does not want the tickets — it wants to know whether to ask
 * for them. A SQLite driver answers with `PRAGMA data_version` (measured 0.009 ms);
 * Postgres with a per-table change counter.
 *
 * KNOWN BLIND SPOT, preserved deliberately: an edit that keeps both the file size and
 * the mtime is invisible to this token. That is the pre-existing behaviour of
 * contentHash — changing the hash would change what the poll fires on, which is a
 * different decision from moving it behind the seam. Pinned by a test so it is a
 * recorded limitation rather than a latent surprise. A database driver has no such
 * blind spot.
 */
  /**
   * The project keys that exist. A different question from "which tickets" — audit
   * and reconcile both need the set of projects before they can scope anything, and
   * audit-runner was answering it with its own readdirSync. On the filesystem a
   * project is a directory; on a database it is `SELECT key FROM resolved_project`.
   */
  listProjects(root) {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name);
    } catch { return []; }
  },

  changeToken(root, { project = null } = {}) {
    let h = 0;
    const stack = [project ? join(root, project) : root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const e of entries) {
        const p = join(dir, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { stack.push(p); continue; }
        const sig = `${p}:${st.size}:${st.mtimeMs}`;
        for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
      }
    }
    return String(h);
  },

  listTickets(root) {
    return walkTickets(root);
  },
};

/**
 * An in-memory read driver over pre-built records. Stands in for a database in
 * tests: ids are unique by construction, exactly as a primary key makes them, so it
 * is also the executable statement that `duplicates` is a filesystem artefact rather
 * than a permanent feature of the contract.
 */
export function memReadStorage(records = []) {
  const rows = records.slice();
  return {
    name: "mem",
    getTicket(_root, id) {
      const hits = rows.filter((r) => r.frontmatter?.id === id);
      if (hits.length > 1) return { found: null, duplicates: hits.map((r) => r.file).sort() };
      return { found: hits[0] ?? null };
    },
    listChildren(_root, parentId) {
      return rows.filter((r) => r.frontmatter?.parent === parentId);
    },
    blockersOf(_root, id) {
      return rows.filter((r) => r.frontmatter?.id !== id &&
        (r.frontmatter?.links ?? []).some((l) => l.type === "Blocks" && l.target === id));
    },
    // Ids are unique and rows are immutable here, so the corpus itself is the token.
    listProjects(_root) {
      return [...new Set(rows.map((r) => r.project).filter(Boolean))].sort();
    },
    changeToken(_root, { project = null } = {}) {
      const scoped = project ? rows.filter((r) => r.project === project) : rows;
      return String(scoped.length) + ":" + scoped.map((r) => r.frontmatter?.id).sort().join(",");
    },
    listTickets(_root) {
      return rows[Symbol.iterator]();
    },
  };
}
