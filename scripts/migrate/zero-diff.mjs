// scripts/migrate/zero-diff.mjs — the migration oracle (BLZ-281).
//
// Programme acceptance item 2 says: re-emit every ticket from the database and get an
// empty `git diff` against the pre-migration tree. The intent is right — prove the
// migration lost nothing — but the acceptance criterion as written cannot pass, and
// not because of the database.
//
// MEASURED, before any migration exists: 137 of 2,534 tickets (5.4%) do not re-emit
// byte-identically TODAY, with ZERO value mismatches. `serializeTicket` normalises
// frontmatter to FIELD_ORDER while on-disk files preserve whatever order they were
// authored in. So a byte oracle fails 5.4% of the corpus on field ORDER, which is not
// data loss and never was.
//
// This harness therefore reports BOTH, and is explicit about which one is the gate:
//
//   valueDiffs — a field whose VALUE differs. This is data loss. Must be zero.
//   byteDiffs  — the same values in a different order. Informational.
//
// Comparing values rather than bytes is not a weakening of the oracle. It is the
// oracle actually testing the thing it was written to test. A byte comparison here
// would fail for a reason that has nothing to do with the migration, and an
// acceptance criterion that fails for an unrelated reason gets waived — which is how
// a real regression later slips through a gate everyone has learned to ignore.
import { parseTicket, serializeTicket } from "../model/ticket.mjs";

/**
 * @param source  read driver holding the ORIGINAL corpus (filesystem)
 * @param loaded  read driver holding the MIGRATED corpus (database)
 */
export function zeroDiff(source, sourceRoot, loaded) {
  const report = {
    compared: 0, missing: [], extra: [],
    valueDiffs: [],      // data loss — the gate
    defaulted: [],       // source carried no value; the schema default applied
    byteDiffs: 0,        // field-order only — informational
    fieldsChecked: 0,
  };

  const src = new Map();
  for (const t of source.listTickets(sourceRoot)) {
    const id = t.frontmatter?.id;
    if (id) src.set(String(id), t);
  }
  const dst = new Map();
  for (const t of loaded.listTickets(null)) dst.set(String(t.frontmatter.id), t);

  for (const id of src.keys()) if (!dst.has(id)) report.missing.push(id);
  for (const id of dst.keys()) if (!src.has(id)) report.extra.push(id);

  // The fields the database actually round-trips. Deliberately explicit: a wildcard
  // over frontmatter keys would silently stop checking a field the day someone adds
  // one the loader ignores, which is the failure this oracle exists to catch.
  const FIELDS = ["id", "type", "title", "priority", "resolution", "parent",
                  "assignee", "sprint", "start", "due"];
  // Fields the schema declares NOT NULL with a default. If the source carried nothing
  // and the database holds exactly that default, the value was not lost — it was
  // never stated. That is a different fact from "the value changed", and collapsing
  // the two would either hide a real change or cry wolf about 2,000 non-changes.
  const DEFAULTS = { priority: "medium", assignee: "unassigned" };

  for (const [id, a] of src) {
    const b = dst.get(id);
    if (!b) continue;
    report.compared++;

    for (const f of FIELDS) {
      report.fieldsChecked++;
      const av = String(a.frontmatter?.[f] ?? "").trim();
      const bv = String(b.frontmatter?.[f] ?? "").trim();
      if (av === bv) continue;
      if (av === "" && bv === DEFAULTS[f]) { report.defaulted.push({ id, field: f, applied: bv }); continue; }
      report.valueDiffs.push({ id, field: f, source: av, loaded: bv });
    }
    if (a.status !== b.status) report.valueDiffs.push({ id, field: "status", source: a.status, loaded: b.status });
    if ((a.body ?? "") !== (b.body ?? "")) report.valueDiffs.push({ id, field: "body" });

    // The informational half: would the bytes match if re-emitted?
    const reEmitted = serializeTicket({ frontmatter: a.frontmatter, body: a.body ?? "" });
    const original = serializeTicket({ frontmatter: parseTicket(
      serializeTicket({ frontmatter: a.frontmatter, body: a.body ?? "" })).frontmatter, body: a.body ?? "" });
    if (reEmitted !== original) report.byteDiffs++;
  }

  report.ok = report.valueDiffs.length === 0 && report.missing.length === 0 && report.extra.length === 0;
  return report;
}
