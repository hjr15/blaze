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
//   listTickets(root)            everything, for the index and audit
//
// `listTickets` survives deliberately: `buildIndex` and `auditCorpus` genuinely do
// need every ticket, and pretending otherwise would push a fake filter into them.
// What ADR-0009 rejects is `listTickets` being the ONLY affordance.
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
    listTickets(_root) {
      return rows[Symbol.iterator]();
    },
  };
}
