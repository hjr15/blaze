// reconcile-load-bearing-conditions.test.mjs — BLZ-399.
//
// Three conditions the shipped bullet/subject/branch rules rest on, each of which
// could be deleted without a single test noticing. The code is CORRECT in every case
// below — this file is the missing guard, not a bug report. It was raised by the
// behaviour-scoped adversarial review of BLZ-130/BLZ-131's PR (#123), which returned
// BEHAVIOUR-CLEAN, and kept out of that PR because it had already run ten rounds.
//
// Each mutation was verified to survive the WHOLE suite at blaze 3cf1509 before these
// tests were written — 2,518 pass / 0 fail under every one of them. The premise of
// this ticket is measured, not assumed.
//
// Every test here names the mutation it kills, so the next person to "simplify" one of
// these regexes learns what it was for from the failure message.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { idsFromCommitMessage, idsFromSubject, buildBranchMap } from "../scripts/reconcile.mjs";

const infFromRef = (ref) => {
  const m = /\bINF-(\d+)/i.exec(ref || "");
  return m ? `INF-${m[1]}` : null;
};

// =============================================================================
// 1. The bullet rule's COLON — the silent third condition
// =============================================================================
// `idsFromCommitMessage`'s comment block named two load-bearing conditions (the `* `
// marker and the ticket-subject gate) and relied on a third without saying so: the
// bullet must END AT A COLON, which is what makes it a collapsed commit SUBJECT
// rather than a sentence that happens to start with a bullet and mention a ticket.
//
// MUTATION KILLED: drop the `:` from the `bullet` regex in `idsFromCommitMessage`.

describe("BLZ-399: a bulleted line is a collapsed commit only when it ends at a colon", () => {
  test("prose under a real ticket subject does not claim the ticket it mentions", () => {
    // Both of the two documented conditions are SATISFIED here — the subject opens
    // with a ticket-id list, and the line is a column-0 `* ` bullet. Only the colon
    // stands between this and INF-4 being driven to `done` off a sentence.
    const msg = [
      "INF-645: close the Tier-1 alert gaps (#81)",
      "",
      "* INF-4 is blocked by this and should be picked up next",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), ["INF-645"],
      "a `* INF-4 is blocked by this` line is prose, not a delivered child — " +
      "without the colon in the bullet regex it becomes a claim that ships INF-4");
  });

  test("...while the same line WITH a colon is exactly the signal BLZ-131 reads", () => {
    // The positive twin, so the test above cannot pass by breaking the rule wholesale.
    const msg = [
      "INF-645: close the Tier-1 alert gaps (#81)",
      "",
      "* INF-4: harden the blackhole receiver",
    ].join("\n");
    assert.deepEqual(idsFromCommitMessage(msg, "INF"), ["INF-645", "INF-4"]);
  });
});

// =============================================================================
// 2. The subject list's `,` and `&` separators
// =============================================================================
// `idsFromSubject` accepts four separators — `/`, `+`, `,` and `&`. `/` and `+` were
// pinned by BLZ-131's own tests. `,` and `&` were not, and both mutations survived.
//
// MUTATIONS KILLED: `[+,&]` → `[+&]`, and `[+,&]` → `[+,]`.
//
// The failure mode is much larger than "one id is stranded". The leading list is
// ANCHORED and must end at the colon, so an unrecognised separator does not truncate
// the list — it makes the whole subject fail to match, and `idsFromCommitMessage`
// then returns EARLY on condition 2. Every id in the subject is lost AND the body's
// bullets are never read. Both tests below pin that, because pinning only the first
// id would understate what the separator is holding up.

describe("BLZ-399: `,` and `&` are separators the anchored list depends on", () => {
  test("`,` — dropping it loses three real moves on the live board", () => {
    // Measured on the board: `BLZ-230, BLZ-231, BLZ-232, BLZ-233: …` is a real subject,
    // and dropping `,` loses BLZ-231 and BLZ-232 from it; `CRP-86, CRP-87: …` loses
    // CRP-87. Named here as the reason this separator is not cosmetic.
    assert.deepEqual(
      idsFromSubject("BLZ-230, BLZ-231, BLZ-232, BLZ-233: close the engine gaps", "BLZ"),
      ["BLZ-230", "BLZ-231", "BLZ-232", "BLZ-233"]);
  });

  test("`,` — and the whole subject goes with it, not just the later ids", () => {
    // The anchor is why: with `,` unrecognised, `^KEY-\d+…(?=\s*:)` cannot reach the
    // colon from `BLZ-230`, so `head` does not match at all and the FIRST id is lost too.
    const msg = "BLZ-230, BLZ-231: close the engine gaps\n\n* BLZ-232: the child\n";
    assert.deepEqual(idsFromCommitMessage(msg, "BLZ"), ["BLZ-230", "BLZ-231", "BLZ-232"],
      "dropping `,` makes this commit claim NOTHING — subject ids and bullets alike");
  });

  test("`&` — kept, not deleted, and this is the test that records why", () => {
    // BLZ-399 asked for a decision: pin `&` or delete it. KEPT. It is unobserved — 0
    // subjects across all 19 configured repo/key pairs use it (scanned 2026-08-26) —
    // but "unobserved" argues for deleting a separator only if the cost of a miss is
    // bounded to that separator, and it is not. `&` is one of four spellings of ONE
    // construct, and the guard against over-claiming is the contiguity anchor and the
    // colon, never the separator inventory: removing `&` does not make the parse
    // stricter, it makes a subject that uses it unreadable. See the twin below for
    // what that costs. Deleting it would also be a behaviour change shipped inside a
    // ticket whose own premise is that the shipped code is correct.
    assert.deepEqual(idsFromSubject("BLZ-1 & BLZ-2: the joint fix", "BLZ"), ["BLZ-1", "BLZ-2"]);
  });

  test("`&` — the twin: dropping it silently unreads the entire squash body", () => {
    const msg = "BLZ-1 & BLZ-2: the joint fix\n\n* BLZ-7: the bundled child\n";
    assert.deepEqual(idsFromCommitMessage(msg, "BLZ"), ["BLZ-1", "BLZ-2", "BLZ-7"],
      "an unrecognised separator fails condition 2, so the bullets are never reached");
  });

  test("the separators do not widen what ends the list — a mention is still a mention", () => {
    // Guards the direction: these tests must not be satisfiable by loosening the anchor.
    assert.deepEqual(idsFromSubject("BLZ-1: fixes BLZ-4 & BLZ-5", "BLZ"), ["BLZ-1"]);
  });
});

// =============================================================================
// 3. `buildBranchMap` corroborates on a LEADING id, deliberately
// =============================================================================
// A branch has no title, so its evidence is the subjects unique to it. It uses
// `idFromSubject` — the leading id ALONE — and not `idsFromSubject(...).includes(id)`,
// which the rest of the file switched to for the shipped signal. That asymmetry is
// deliberate and was unrecorded and unpinned: swapping in the list parse left the
// whole suite green.
//
// MUTATION KILLED: `idFromSubject(sub, key) === id` → `idsFromSubject(sub, key).includes(id)`.

describe("BLZ-399: a branch is corroborated by a commit that LEADS with its id", () => {
  const inspect = (own) => () => ({ own, sameTipAsDefault: false });

  test("a commit that merely LISTS the id does not corroborate the branch named for it", () => {
    // `INF-2-fix` carries one commit, `INF-1 + INF-2: joint work`. The shipped signal
    // would read both ids from that subject; the BRANCH signal reads only INF-1.
    const map = buildBranchMap(["INF-2-fix"], infFromRef,
      { key: "INF", shippedSet: null, inspect: inspect(["INF-1 + INF-2: joint work"]) });
    assert.equal(map.has("INF-2"), false,
      "the branch signal takes the LEADING id only — accepting the list here is the mutation");
  });

  test("a joint subject corroborates NEITHER branch — the rule is stricter than it looks", () => {
    // Not a milder version of the test above: `idFromSubject` anchors on `^KEY-n:`, so
    // the colon must follow the id IMMEDIATELY. `INF-1 + INF-2: joint work` therefore
    // has no leading id at all by that reading, and corroborates INF-1 no more than
    // INF-2. The list parse would have corroborated BOTH. Recorded because the
    // asymmetry is wider than "the first id wins", and a reader who assumed the milder
    // rule would write a passing test that proves nothing.
    const map = buildBranchMap(["INF-1-fix"], infFromRef,
      { key: "INF", shippedSet: null, inspect: inspect(["INF-1 + INF-2: joint work"]) });
    assert.equal(map.has("INF-1"), false);
  });

  test("...and a SOLO `KEY-n:` subject is what does corroborate it", () => {
    // The positive direction, so none of the above can pass by refusing everything.
    const map = buildBranchMap(["INF-1-fix"], infFromRef,
      { key: "INF", shippedSet: null, inspect: inspect(["INF-1: the actual work"]) });
    assert.equal(map.get("INF-1"), "INF-1-fix");
  });

  test("the asymmetry costs a missed signal, never a corrupted ticket", () => {
    // Why it is safe to be strict here, recorded so the next reader does not "fix" it:
    // the branch signal only ever reaches `in-progress`, so a dropped claim delays a
    // move that a PR will make anyway. The list parse, by contrast, would let a branch
    // named for any id mentioned in a joint commit claim work it never carried — and
    // `buildBranchMap` skips uncorroborated refs WITHOUT reserving the id, so the
    // strict reading leaves the ticket's real branch free to claim it.
    const map = buildBranchMap(["INF-2-fix", "INF-2-real-work"], infFromRef, {
      key: "INF", shippedSet: null,
      inspect: (ref) => ref === "INF-2-fix"
        ? { own: ["INF-1 + INF-2: joint work"], sameTipAsDefault: false }
        : { own: ["INF-2: the actual work"], sameTipAsDefault: false },
    });
    assert.equal(map.get("INF-2"), "INF-2-real-work");
  });
});
