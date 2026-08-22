import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { artifactDdl } from "../../scripts/model/artifact-schema.mjs";
import { documentDdl } from "../../scripts/model/document-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(artifactDdl("sqlite"));
  db.exec(documentDdl("sqlite"));
  db.exec(`INSERT INTO artifact VALUES ('a1','BLZ','requirement','REQ-001','T',NULL,NULL,'proposed','t','t');`);
  db.exec(`INSERT INTO artifact VALUES ('a2','BLZ','requirement','REQ-002','U',NULL,NULL,'proposed','t','t');`);
  db.exec(`INSERT INTO document VALUES ('d1','BLZ','Safety case','requirements','draft','t','t');`);
  db.exec(`INSERT INTO document VALUES ('d2','BLZ','Subsystem spec','requirements','draft','t','t');`);
  return db;
}
const use = (db, doc, art, ord, depth = 0) => db.prepare(
  "INSERT INTO artifact_usage (document_id, artifact_id, ord, depth) VALUES (?,?,?,?)")
  .run(doc, art, ord, depth);

describe("a document contains USAGES, not artifacts", () => {
  test("THE CENTRAL CASE: one artifact appears in two documents", () => {
    // A safety requirement belongs in the safety case AND the subsystem spec. Under a
    // copy model those drift. Here it is one row, used twice.
    const db = open();
    use(db, "d1", "a1", 1);
    use(db, "d2", "a1", 1);
    assert.equal(db.prepare("SELECT count(*) n FROM artifact_usage WHERE artifact_id='a1'").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM artifact").get().n, 2);
  });

  test("the same artifact cannot be used twice in ONE document", () => {
    const db = open();
    use(db, "d1", "a1", 1);
    assert.throws(() => use(db, "d1", "a1", 2), /UNIQUE|constraint/i);
  });

  test("two artifacts cannot occupy the same position", () => {
    const db = open();
    use(db, "d1", "a1", 1);
    assert.throws(() => use(db, "d1", "a2", 1), /UNIQUE|constraint/i);
  });

  test("depth carries the hierarchy, so the same artifact nests differently per document", () => {
    const db = open();
    use(db, "d1", "a1", 1, 0);
    use(db, "d2", "a1", 1, 2);
    const rows = db.prepare("SELECT document_id, depth FROM artifact_usage WHERE artifact_id='a1' ORDER BY document_id").all();
    assert.deepEqual(rows.map(r => r.depth), [0, 2]);
  });

  test("DELETING A DOCUMENT DELETES ITS USAGES AND NEVER ITS ARTIFACTS", () => {
    const db = open();
    use(db, "d1", "a1", 1);
    use(db, "d2", "a1", 1);
    db.exec("DELETE FROM document WHERE id='d1'");
    assert.equal(db.prepare("SELECT count(*) n FROM artifact WHERE id='a1'").get().n, 1,
      "the requirement itself must survive");
    assert.equal(db.prepare("SELECT count(*) n FROM artifact_usage WHERE artifact_id='a1'").get().n, 1,
      "only the usage in the deleted document goes");
  });

  test("deleting an artifact that is still used is REFUSED", () => {
    const db = open();
    use(db, "d1", "a1", 1);
    assert.throws(() => db.exec("DELETE FROM artifact WHERE id='a1'"), /constraint|FOREIGN KEY/i);
  });
});
