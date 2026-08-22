// tests/model/matrix.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildMatrix } from "../../scripts/model/matrix.mjs";

const rows = [{ id: "r1", ref: "REQ-001" }, { id: "r2", ref: "REQ-002" }];
const cols = [{ id: "d1", ref: "ADR-0001" }];
const linkTypes = [{ name: "Addresses", inverse_name: "Addressed by" }];

describe("the matrix is a QUERY over typed links, never a maintained artefact", () => {
  test("a cell exists where a link exists, and carries the link type", () => {
    const links = [{ type_name: "Addresses", source_id: "d1", target_id: "r1" }];
    const m = buildMatrix({ rows, cols, links, linkTypes });
    assert.equal(m.cells["r1"]["d1"].type, "Addresses");
  });

  test("the cell reads correctly in BOTH directions from one table", () => {
    const links = [{ type_name: "Addresses", source_id: "d1", target_id: "r1" }];
    const m = buildMatrix({ rows, cols, links, linkTypes });
    assert.equal(m.cells["r1"]["d1"].inverse, "Addressed by");
  });

  test("a requirement with no link is UNTRACED AND COUNTED, not hidden", () => {
    // Untraced work is legal. Inventing a requirement to close a gap makes the
    // matrix a lie, so the count has to be visible instead.
    const links = [{ type_name: "Addresses", source_id: "d1", target_id: "r1" }];
    const m = buildMatrix({ rows, cols, links, linkTypes });
    assert.deepEqual(m.untraced, ["REQ-002"]);
  });

  test("an empty cell is absent rather than falsely present", () => {
    const m = buildMatrix({ rows, cols, links: [], linkTypes });
    assert.equal(m.cells["r1"]?.["d1"], undefined);
  });

  test("a link type with no declared inverse still renders, without inventing one", () => {
    const links = [{ type_name: "Mystery", source_id: "d1", target_id: "r1" }];
    const m = buildMatrix({ rows, cols, links, linkTypes });
    assert.equal(m.cells["r1"]["d1"].type, "Mystery");
    assert.equal(m.cells["r1"]["d1"].inverse, null);
  });
});
