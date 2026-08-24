// scripts/model/import-deps.mjs — BLZ-360 §5.5's `blaze schedule import-deps`, as a PURE planner.
//
// THE TOOL NEVER GUESSES. That is the whole design, and §5.5 states the reason in one line:
//
//   "A machine that picks a direction for a mutual pair is right half the time, and the wrong
//    half becomes an invisible schedule error."
//
// Measured on the live board 2026-08-24: 392 directed `Blocks` edges, of which 248 (63.3%) sit
// in 124 mutual pairs. The majority of the corpus carries NO usable direction, because
// frontmatter has no way to write the inverse — `LINK_TYPES` (links.mjs) is a bare Set and
// `lintLinks` refuses anything outside it, so "is blocked by" gets written as a second `Blocks`
// from the other end. The operator resolves those; this reports them.
//
// `Blocks` and `Precedes` COEXIST INDEFINITELY. `Blocks` stays the advisory human signal,
// `Precedes` is the scheduler's input, they are not required to agree, and NOTHING HERE LINTS
// THEM AGAINST EACH OTHER — §5.5: "that would be a rule with no correct answer while §5.5 is in
// progress." ADR-0001 is not reversed.
import { isTerminal } from "./workflows.mjs";
import { DEFAULT_LINK_TYPES } from "./link-schema.mjs";

export const DISPOSITION = {
  PROPOSED: "proposed",
  UNDECIDABLE: "undecidable",
  REFUSED: "refused",
  DANGLING: "dangling",
};

const BLOCKS = "Blocks";
const PRECEDES = "Precedes";
/**
 * The declared `Precedes` endpoint kinds, from ONE link-type list (BLZ-392).
 *
 * Was a pair of module constants. `schedule.mjs` had the identical pair and BLZ-392 made THOSE
 * overridable — and left these, which half-shipped the capability: an operator could make
 * `spike` a node and watch the solve schedule it, then find `blaze schedule import-deps`
 * REFUSING every edge into it with "Precedes declares no such endpoint". The planner that
 * CREATES the edges the solve consumes was still gated on the unoverridable constant, so the
 * feature worked right up to the point of being usable.
 *
 * Same shape as `schedule.mjs`'s `endpointKinds`, deliberately: these two are the readers that
 * must agree, and they now agree by reading the same passed list.
 */
function endpointKinds(linkTypes) {
  const precedes = linkTypes.find((l) => l && l.name === PRECEDES);
  return {
    source: new Set(precedes?.source_kinds ?? []),
    target: new Set(precedes?.target_kinds ?? []),
  };
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param tickets [{ id, type, status }]
 * @param links   [{ type, src, target }] — every link; only `Blocks` is an input here
 * @returns { edges: [{ src, target, disposition, proposed, reason, note, terminal_target }], counts }
 */
export function planDependencyImport({ tickets = [], links = [],
                                       linkTypes = DEFAULT_LINK_TYPES } = {}) {
  const { source: SOURCE_KINDS, target: TARGET_KINDS } = endpointKinds(linkTypes);
  const rows = new Map();
  for (const t of tickets) if (t && t.id != null) rows.set(t.id, t);

  // Deduplicated: the same `Blocks A -> B` written twice was reported twice and counted twice,
  // which inflated every total and would have had the operator resolve one edge two times.
  const blocks = [];
  const seenEdge = new Set();
  for (const l of links) {
    if (l.type !== BLOCKS) continue;
    const k = `${l.src} ${l.target}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    blocks.push(l);
  }
  const seen = new Set(blocks.map((l) => `${l.src} ${l.target}`));
  const isMutual = (a, z) => seen.has(`${z} ${a}`);

  const edges = [];
  const mutualPairs = new Set();
  for (const l of blocks) {
    const src = l.src, target = l.target;
    const out = { src, target, disposition: null, proposed: null, reason: "", note: "", terminal_target: false };

    if (src === target) {
      out.disposition = DISPOSITION.REFUSED;
      out.reason = "a self-edge cannot order anything";
      edges.push(out); continue;
    }
    const a = rows.get(src), z = rows.get(target);
    if (!a || !z) {
      out.disposition = DISPOSITION.DANGLING;
      out.reason = `${!a ? src : target} does not resolve to a ticket`;
      edges.push(out); continue;
    }
    // The endpoint default-deny, read from the RESOLVED link types rather than restated. §5.4: this
    // does most of the cleanup for free — 58 of the 392, 36 of them risk/feature. A risk does
    // not belong in a delivery critical path.
    if (!SOURCE_KINDS.has(a.type) || !TARGET_KINDS.has(z.type)) {
      out.disposition = DISPOSITION.REFUSED;
      const bad = !SOURCE_KINDS.has(a.type) ? `${src} is a ${a.type}` : `${target} is a ${z.type}`;
      out.reason = `Precedes declares no such endpoint — ${bad}`;
      edges.push(out); continue;
    }
    if (isMutual(src, target)) {
      // Both halves are reported, so the operator sees the whole pair rather than half of it.
      out.disposition = DISPOSITION.UNDECIDABLE;
      out.reason = `mutual pair with ${target} to ${src}; the same Blocks written from each end `
        + "carries no direction, and guessing is right half the time";
      mutualPairs.add([src, target].sort(cmp).join(" "));
      edges.push(out); continue;
    }

    out.disposition = DISPOSITION.PROPOSED;
    out.proposed = { type: PRECEDES, src, target, lag_minutes: 0 };
    // DECIDED HERE, and spec 3 §13.4 leaves it genuinely open: an edge whose TARGET is terminal
    // is still offered, flagged. §6.2's node filter means the solve will drop it — but the
    // operator is resolving a half-migrated graph and a target that is `done` today may be
    // reopened tomorrow. Hiding the edge would make that decision for them, which is exactly
    // what §5.5 forbids the tool from doing.
    try {
      if (isTerminal(z.type, z.status)) {
        out.terminal_target = true;
        out.note = `${target} is terminal, so the solve will drop it — offered anyway, because `
          + "whether it is reopened is the operator's call, not the tool's";
      }
    } catch { /* an unresolvable type is not a terminality claim */ }
    edges.push(out);
  }

  edges.sort((a, b) => cmp(a.src, b.src) || cmp(a.target, b.target));
  const n = (d) => edges.filter((e) => e.disposition === d).length;
  return {
    edges,
    counts: {
      total: edges.length,
      proposed: n(DISPOSITION.PROPOSED),
      undecidable: n(DISPOSITION.UNDECIDABLE),
      refused: n(DISPOSITION.REFUSED),
      dangling: n(DISPOSITION.DANGLING),
      mutualPairs: mutualPairs.size,
      terminalTarget: edges.filter((e) => e.terminal_target).length,
    },
  };
}
