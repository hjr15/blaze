// tests/model/staleness.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { staleLinks } from "../../scripts/model/staleness.mjs";

describe("staleness is COMPUTED, never stored", () => {
  // IBM removed suspicion profiles at DNG 7.0.0 (CS-015) and Polarion's flag is
  // invisible to its own API (CS-018). We store no flag; we compare revisions.
  test("a link whose source changed after the link was reviewed is stale", () => {
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-01-01" }];
    const revisions = [{ artifact_id: "a1", at: "2026-02-01" }];
    const out = staleLinks({ links, revisions });
    assert.equal(out.length, 1);
    assert.equal(out[0].linkId, "l1");
    assert.equal(out[0].changedAt, "2026-02-01");
  });

  test("a link reviewed AFTER the last change is not stale", () => {
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-03-01" }];
    const revisions = [{ artifact_id: "a1", at: "2026-02-01" }];
    assert.deepEqual(staleLinks({ links, revisions }), []);
  });

  test("a never-reviewed link is stale as soon as the source has any revision", () => {
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: null }];
    const revisions = [{ artifact_id: "a1", at: "2026-02-01" }];
    assert.equal(staleLinks({ links, revisions }).length, 1);
  });

  test("only the LATEST revision matters, not the count", () => {
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-06-01" }];
    const revisions = [{ artifact_id: "a1", at: "2026-02-01" },
                       { artifact_id: "a1", at: "2026-03-01" }];
    assert.deepEqual(staleLinks({ links, revisions }), []);
  });

  test("the LATEST revision decides, not the first — the only case where they disagree", () => {
    // reviewed_at falls BETWEEN the two revisions. Tracking the max sees 2026-03-01,
    // which is later than the review, so the link IS stale. Tracking the first sees
    // 2026-02-01, which predates the review, so it would report not-stale. This
    // arrangement is the only one where the two implementations differ.
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-02-15" }];
    const revisions = [{ artifact_id: "a1", at: "2026-02-01" },
                       { artifact_id: "a1", at: "2026-03-01" }];
    const out = staleLinks({ links, revisions });
    assert.equal(out.length, 1, "the 2026-03-01 revision postdates the review — this link is stale");
    assert.equal(out[0].changedAt, "2026-03-01", "and it must report the LATEST change, not the first");
  });

  test("the LATEST revision decides even when revisions are in descending order", () => {
    // Same as above but revisions provided in reverse order, proving we don't
    // accidentally depend on input order.
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-02-15" }];
    const revisions = [{ artifact_id: "a1", at: "2026-03-01" },
                       { artifact_id: "a1", at: "2026-02-01" }];
    const out = staleLinks({ links, revisions });
    assert.equal(out.length, 1, "the 2026-03-01 revision postdates the review — this link is stale");
    assert.equal(out[0].changedAt, "2026-03-01", "and it must report the LATEST change, not the first seen");
  });

  test("an unrelated artifact's revision does not make the link stale", () => {
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-01-01" }];
    const revisions = [{ artifact_id: "zzz", at: "2026-09-01" }];
    assert.deepEqual(staleLinks({ links, revisions }), []);
  });
});
