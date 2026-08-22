// scripts/model/link-rules.mjs — PURE endpoint and cardinality decisions.
//
// Pure and synchronous, the same split identity.mjs uses: an async guard cannot serve
// a synchronous driver at all, because .then always defers to a microtask.
//
// DEFAULT DENY. An unknown link type is refused rather than passed through. Jama's
// documented behaviour is the opposite and it is the failure this exists to prevent:
// "If you don't define a rule for a particular item type, that item type can have a
// relationship with anything."
/**
 * @param existingCount  links of this type already out of this source.
 * @param finalCount     BLZ-343 — how many there would be AFTER the operation. `min_card` is
 *   a FLOOR, so creating a link can never violate it; only removing one can. Supplying this
 *   is what gives the floor a caller at all: before this, min_card was declared, defaulted
 *   and CHECKed in the DDL and read by NOTHING, so a type declared `min_card: 1` was
 *   silently unenforced. Omitted, the floor is not checked — a creation path has nothing to
 *   prove.
 */
export function checkLink({ linkType, sourceKind, targetKind, existingCount = 0,
                            finalCount = null }) {
  if (!linkType?.name) {
    return { ok: false, error: "unknown link type — refused (no rule declared)" };
  }
  const src = normalise(linkType.source_kinds);
  const tgt = normalise(linkType.target_kinds);

  if (!src.includes(sourceKind)) {
    return { ok: false, error:
      `${linkType.name} cannot start at a ${sourceKind} — declared sources: ${src.join(", ")}` };
  }
  if (!tgt.includes(targetKind)) {
    return { ok: false, error:
      `${linkType.name} cannot point at a ${targetKind} — declared targets: ${tgt.join(", ")}` };
  }
  if (finalCount == null && linkType.max_card != null && existingCount >= linkType.max_card) {
    return { ok: false, error:
      `${linkType.name} allows at most ${linkType.max_card} from this source (already ${existingCount})` };
  }
  const min = Number(linkType.min_card ?? 0);
  if (finalCount != null && min > 0 && finalCount < min) {
    return { ok: false, error:
      `${linkType.name} requires at least ${min} from this source — `
      + `this would leave ${finalCount}` };
  }
  if (finalCount != null && linkType.max_card != null && finalCount > linkType.max_card) {
    return { ok: false, error:
      `${linkType.name} allows at most ${linkType.max_card} from this source — `
      + `this would leave ${finalCount}` };
  }
  return { ok: true, error: null };
}

function normalise(kinds) {
  if (Array.isArray(kinds)) return kinds;
  return String(kinds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
