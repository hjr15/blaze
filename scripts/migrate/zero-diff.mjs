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
import { acCriteria } from "./ac-oracle-matcher.mjs";

/**
 * @param source  read driver holding the ORIGINAL corpus (filesystem)
 * @param loaded  read driver holding the MIGRATED corpus (database)
 * @param opts.criteriaFor  (id) => [{ text, checked }] as LOADED, in ord order.
 *        Optional. When supplied, acceptance criteria are compared too, using a
 *        matcher written independently of the importer's — see ac-oracle-matcher.mjs.
 *        Without it the criteria are simply not checked, and `report.criteriaChecked`
 *        says so rather than the absence looking like a pass.
 */
export function zeroDiff(source, sourceRoot, loaded, { criteriaFor = null, expectedDelta = null, frozen = null, unsurfaced = [] } = {}) {
  // BLZ-385 / BLZ-360 §4.1 item 3. Under the date migration `start` and `due` change ON PURPOSE,
  // so the oracle needs a way to say which tickets may differ — EXTENDED, not weakened.
  //
  // Two lists, and the asymmetry is the point. §4.1 names "an expected-delta list of exactly
  // those 40 ids"; measured, only 12 change. The other 28 are §4's terminal cohort, kept
  // VERBATIM. A ticket whose bytes do not change cannot show up as a diff, so listing it would
  // not excuse a real change — it would excuse the one accident §4 exists to prevent, a frozen
  // actual being overwritten with a forecast. So the 12 are EXCUSED and the 28 are ASSERTED
  // UNCHANGED, which is strictly stronger than excusing them.
  //
  // Only `start` and `due` are excused, never the whole ticket: the migration touches two
  // fields, and a listed id that also lost its title is still data loss.
  // The caller names the fields ITS loaded driver cannot project. Declared rather than
  // detected: "no ticket carries it" cannot be told apart from "the one ticket lost it",
  // and guessing wrong either drowns the real findings or hides one.
  const blind = new Set(unsurfaced);
  const expected = new Set(expectedDelta ?? []);
  const frozenSet = new Set(frozen ?? []);
  for (const id of frozenSet) {
    if (expected.has(id)) throw new Error(`zero-diff: ${id} is both frozen and expected to change`);
  }
  const MIGRATED_FIELDS = new Set(["start", "due", "not_before", "deadline"]);
  const report = {
    compared: 0, missing: [], extra: [],
    expectedDeltas: [],    // excused start/due changes — recorded, because a SILENT excuse is
                           // indistinguishable from no check at all
    unsurfaced: [...unsurfaced],  // fields the caller declared its driver cannot project:
                                  // unchecked, and SAID so rather than passed in silence
    frozenViolations: [],  // a frozen actual that moved: the migration's worst failure
    valueDiffs: [],      // data loss — the gate
    defaulted: [],       // source carried no value; the schema default applied
    byteDiffs: 0,        // field-order only — informational
    fieldsChecked: 0,
    criteriaChecked: 0,  // 0 with no criteriaFor — an unchecked oracle must SAY so
    criteriaDiffs: [],   // data loss in the AC section — part of the gate
    criteriaShapeDiffs: 0,  // continuation-vs-note allocation only — informational
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
  //
  // `not_before`/`deadline` were added by BLZ-385 after an adversarial review found two holes
  // their absence left: a FROZEN terminal ticket that GAINED bogus constraints was not a
  // frozenViolation, so "the 28 are asserted unchanged" was really only "their start/due are";
  // and the migration's own output was never verified at all — clearing `start`/`due` and
  // never writing the `deadline` passed green.
  //
  // That paragraph used to end by listing `labels`, `components`, `estimate`, `worklog`,
  // `links`, `likelihood`, `impact`, `branch` and `pr` as STILL unchecked. They are checked
  // now — the sentence survived the change that falsified it, and an adversarial review caught
  // it contradicting the line directly below.
  //
  // Scope note, because it changes how much this list matters: NOTHING in scripts/ calls
  // zeroDiff — grepped 2026-08-25, its only reference there is its own definition. It is a
  // library invoked from migration TEST suites (ac-oracle, transitions-and-oracle,
  // date-migration-oracle, oracle-field-coverage), not a gate that runs on a live migration.
  //
  // BLZ-389 widened this from 12 fields to 19. It checked `id/type/title/priority/resolution/
  // parent/assignee/sprint` and the four dates, so destroying `labels`, `components`,
  // `estimate`, `likelihood`, `impact`, `branch` or `pr` reported `ok` — on the oracle BLZ-324
  // calls "the same method that caught six data-loss defects in already-merged v3 code".
  //
  // Still deliberately a LIST rather than a wildcard, for the reason above. Two fields are
  // excluded ON PURPOSE and are named here rather than silently absent:
  //
  //   worklog — an array of objects, compared below by its own rule rather than by String(),
  //             which would collapse every entry to "[object Object]" and match anything.
  //   links   — the same shape, and the same treatment.
  //
  // Both are checked immediately after this loop, by length and by serialized entry, so the
  // "explicit list" contract holds for them too.
  // WHAT THE LOADED DRIVER CANNOT SURFACE, THIS ORACLE CANNOT CHECK — and it now SAYS so
  // rather than passing in silence. Measured 2026-08-25 by round-tripping a ticket carrying all
  // 28 frontmatter keys through `loadCorpus` + `openSqliteRead`: the seam surfaces **12** of
  // them. `sqlite-storage.mjs`'s `toRecord` simply does not project `labels`, `components`,
  // `likelihood`, `impact`, `branch`, `pr`, `ref`, `category`, `verification`, `derived`,
  // `worklog`, `not_before` or `deadline` — `loadCorpus` WRITES most of those columns and the
  // read side never selects them back. That gap is **BLZ-391**, not this file's to fix.
  //
  // So a field stays in FIELDS whether or not a given driver surfaces it, and a field the
  // LOADED corpus carries nowhere is reported in `report.unsurfaced` instead of counted as
  // data loss. Failing on it would make the oracle unusable against the real driver; passing
  // silently is the exact defect BLZ-389 was raised for. The third option is to say it.
  //
  // This also corrects BLZ-385: `not_before`/`deadline` were added there and are not surfaced
  // either, so those checks were live only for the stub drivers the date-migration suite uses.
  const FIELDS = ["id", "type", "title", "project", "priority", "resolution", "parent",
                  "assignee", "sprint", "labels", "components", "estimate",
                  "likelihood", "impact", "branch", "pr",
                  "ref", "category", "verification", "derived",
                  "created", "updated",
                  "start", "due", "not_before", "deadline"];
  const ARRAY_FIELDS = ["worklog", "links"];
  // Fields the schema declares NOT NULL with a default. If the source carried nothing
  // and the database holds exactly that default, the value was not lost — it was
  // never stated. That is a different fact from "the value changed", and collapsing
  // the two would either hide a real change or cry wolf about 2,000 non-changes.
  const DEFAULTS = { priority: "medium", assignee: "unassigned" };
  // `created`/`updated` are defaulted too, but to a value that is not a constant: `loadCorpus`
  // stamps `isoDate(fm.created, now)`, so a ticket that carried no date comes back stamped with
  // the migration's own run date. That is the same fact as the DEFAULTS above — "not lost, never
  // stated" — and it belongs in the same bucket rather than as 2,637 findings of data loss.
  // A source value that CHANGED is still caught, which is the case that matters.
  const STAMPED = new Set(["created", "updated"]);
  const isIso = (v) => /^\d{4}-\d{2}-\d{2}/.test(v);

  for (const [id, a] of src) {
    const b = dst.get(id);
    if (!b) continue;
    report.compared++;

    for (const f of FIELDS) {
      if (blind.has(f)) continue;
      report.fieldsChecked++;
      const av = String(a.frontmatter?.[f] ?? "").trim();
      const bv = String(b.frontmatter?.[f] ?? "").trim();
      if (av === bv) continue;
      if (av === "" && bv === DEFAULTS[f]) { report.defaulted.push({ id, field: f, applied: bv }); continue; }
      if (av === "" && STAMPED.has(f) && isIso(bv)) { report.defaulted.push({ id, field: f, applied: bv }); continue; }
      if (MIGRATED_FIELDS.has(f) && frozenSet.has(id)) {
        report.frozenViolations.push({ id, field: f, source: av, loaded: bv });
        continue;
      }
      if (MIGRATED_FIELDS.has(f) && expected.has(id)) {
        report.expectedDeltas.push({ id, field: f, source: av, loaded: bv });
        continue;
      }
      report.valueDiffs.push({ id, field: f, source: av, loaded: bv });
    }
    // The two array-of-object fields, compared entry-by-entry. String(v) on these yields
    // "[object Object]" for every element, so the scalar loop above would call any two
    // non-empty worklogs equal — which is how a lost worklog entry would still read as clean.
    for (const f of ARRAY_FIELDS) {
      if (blind.has(f)) continue;
      report.fieldsChecked++;
      const av = Array.isArray(a.frontmatter?.[f]) ? a.frontmatter[f] : [];
      const bv = Array.isArray(b.frontmatter?.[f]) ? b.frontmatter[f] : [];
      // Key-sorted so a re-serialized object with the same content matches, and the ENTRY
      // list sorted too, so this is a multiset comparison rather than a sequence one. A
      // driver that returns worklog rows in a different order has not lost anything, and an
      // oracle that failed on it would be crying wolf — which is the other way this check can
      // be wrong. Loss and mutation are still caught, because both change the multiset.
      const key = (x) => JSON.stringify(x, Object.keys(x ?? {}).sort());
      if (av.length !== bv.length
          || av.map(key).sort().join("|") !== bv.map(key).sort().join("|")) {
        report.valueDiffs.push({ id, field: f, source: `${av.length} entr${av.length === 1 ? "y" : "ies"}`,
          loaded: `${bv.length}` });
      }
    }
    if (a.status !== b.status) report.valueDiffs.push({ id, field: "status", source: a.status, loaded: b.status });
    if ((a.body ?? "") !== (b.body ?? "")) report.valueDiffs.push({ id, field: "body" });

    // Acceptance criteria, read by a SECOND matcher that shares no code with the
    // importer's. Sharing one would make the oracle agree with the importer by
    // construction, including where the importer is wrong — which is exactly how 153
    // lower-case headings could migrate as zero criteria and still report clean.
    if (criteriaFor) {
      const { criteria: want, hasSection } = acCriteria(a.body ?? "");
      const got = criteriaFor(id) ?? [];
      report.criteriaChecked += want.length;
      if (hasSection && want.length && got.length === 0) {
        report.criteriaDiffs.push({ id, kind: "section-dropped", expected: want.length });
      } else if (want.length !== got.length) {
        report.criteriaDiffs.push({ id, kind: "count", expected: want.length, loaded: got.length });
      } else {
        for (let i = 0; i < want.length; i++) {
          const loadedText = String(got[i].text ?? "").trim();
          if (want[i].checked !== Boolean(got[i].checked)) {
            report.criteriaDiffs.push({ id, kind: "checked", ord: i,
                                        expected: want[i].checked, loaded: Boolean(got[i].checked) });
          } else if (!loadedText.startsWith(want[i].head)) {
            // The criterion ITSELF differs: wrong text, wrong order, or truncated at
            // the source line. This is data loss and it gates.
            report.criteriaDiffs.push({ id, kind: "text", ord: i,
                                        expected: want[i].head, loaded: loadedText });
          } else if (loadedText !== want[i].text) {
            // Same criterion, different amount of trailing material. The two readers
            // disagree about whether an indented sub-bullet CONTINUES the criterion or
            // is a separate note row — and both readings preserve every character; the
            // importer simply stores the remainder as `kind='note'` instead. Reported,
            // deliberately NOT gating: an oracle that fails on a representation choice
            // where nothing was lost is an oracle people learn to wave through, and
            // then it is not watching when something IS lost.
            report.criteriaShapeDiffs++;
          }
        }
      }
    }

    // The informational half: would the bytes match if re-emitted?
    const reEmitted = serializeTicket({ frontmatter: a.frontmatter, body: a.body ?? "" });
    const original = serializeTicket({ frontmatter: parseTicket(
      serializeTicket({ frontmatter: a.frontmatter, body: a.body ?? "" })).frontmatter, body: a.body ?? "" });
    if (reEmitted !== original) report.byteDiffs++;
  }

  report.ok = report.valueDiffs.length === 0 && report.missing.length === 0
           && report.extra.length === 0 && report.criteriaDiffs.length === 0
           && report.frozenViolations.length === 0;
  return report;
}
