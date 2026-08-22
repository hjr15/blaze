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

  test("an unrelated artifact's revision does not make the link stale", () => {
    const links = [{ id: "l1", source_id: "a1", target_id: "a2", reviewed_at: "2026-01-01" }];
    const revisions = [{ artifact_id: "zzz", at: "2026-09-01" }];
    assert.deepEqual(staleLinks({ links, revisions }), []);
  });
});
