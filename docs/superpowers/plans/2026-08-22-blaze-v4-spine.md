# Blaze v4 Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build requirements and architecture as first-class documents with database-enforced traceability, so one model spans requirements management and delivery instead of two tools bridged by a lossy integration.

**Architecture:** New tables only — `artifact`, `document`, `artifact_usage`, `link`, `link_type`, `field_definition`, `hierarchy`, `hierarchy_membership`, `artifact_revision`, `coverage_rule`, `baseline`. Nothing in this plan modifies the existing `ticket` write path, so **it does not depend on the Phase 2 cutover** except for Task 14 (migration), which does. Every rule is enforced below HTTP and tested through the API.

**Tech Stack:** Node 24 (`node:sqlite` built in), `pg` as optional peer dependency, `node:test`, both dialects everywhere.

**Spec:** `docs/superpowers/specs/2026-08-22-blaze-v4-spine-design.md`

## Global Constraints

- **Node 24 required.** `/home/rnamwoh/.local/node24/bin` must be **first** on `PATH`. System default is Node 20 and lacks `node:sqlite`. Verify with `node --version` before any test run.
- **Both dialects, always.** Every schema module exports `xxxDdl(name)` where `name` is `'sqlite' | 'postgres'`, following `config-schema.mjs:80`. Every test runs SQLite unconditionally and Postgres when `process.env.BLAZE_TEST_PG_URL` is set.
- **SQLite tables holding custom-field values use `STRICT`.** Without it a `REAL` column silently accepts `'oops'` (ADR-0018).
- **Never `STORED` generated columns.** 2,002 ms rewrite on Postgres, impossible on SQLite. Use `ALTER TABLE ADD COLUMN` plus backfill.
- **Never `ALTER TABLE … ADD CHECK` on SQLite.** It works but rides undocumented behaviour (ADR-0018).
- **SQLite table-level CONSTRAINTs come after all column definitions.** Postgres allows interleaving; SQLite does not (`sqlite-schema.mjs:18`).
- **No Postgres-only constructs:** `~`/`!~` → `GLOB`; `btrim(x)` → `length(trim(x)) > 0`.
- **Refs are never reused.** A rejected requirement keeps its ref and leaves a gap.
- **Every guard must be proven to discriminate** by injecting the regression it exists to catch.
- Commit after every task. Never push `blaze-pm` to `origin/main`.

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/model/artifact-schema.mjs` | `artifact`, `artifact_revision` DDL, both dialects |
| `scripts/model/document-schema.mjs` | `document`, `artifact_usage` DDL |
| `scripts/model/link-schema.mjs` | `link_type`, `link` DDL + seeded defaults |
| `scripts/model/link-rules.mjs` | **pure** endpoint/cardinality decisions |
| `scripts/model/field-schema.mjs` | `field_definition` DDL |
| `scripts/model/field-promotion.mjs` | promotion mechanics, budget guards |
| `scripts/model/hierarchy-schema.mjs` | `hierarchy`, `hierarchy_membership` DDL |
| `scripts/model/hierarchy-rollup.mjs` | **pure** dedup rollup |
| `scripts/model/coverage.mjs` | **pure** coverage evaluation |
| `scripts/model/gates.mjs` | gate registry + refusal messages |
| `scripts/model/matrix.mjs` | traceability matrix query |
| `scripts/model/baseline-schema.mjs` | `baseline`, `baseline_member` DDL |
| `scripts/model/ref-allocator.mjs` | `REQ-nnn` / `ADR-nnnn` allocation |

**Pure/IO split follows `identity.mjs` + `identity-store.mjs`:** judgement is pure and exhaustively tested; I/O is thin. A synchronous driver cannot await, so no policy function may be async.

---

### Task 1: Ref allocator

**Files:**
- Create: `scripts/model/ref-allocator.mjs`
- Test: `tests/model/ref-allocator.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `nextRef({ kind, existing })` → `string`; `parseRef(ref)` → `{ kind, num } | null`; `REF_PATTERNS`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/ref-allocator.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { nextRef, parseRef } from "../../scripts/model/ref-allocator.mjs";

describe("ref allocation", () => {
  test("REQ refs are zero-padded to three, ADR to four", () => {
    assert.equal(nextRef({ kind: "requirement", existing: [] }), "REQ-001");
    assert.equal(nextRef({ kind: "architecture", existing: [] }), "ADR-0001");
  });

  test("A GAP IS NEVER FILLED — refs are monotonic, not contiguous", () => {
    // A rejected requirement keeps its ref. Reuse is a bug: a citation in a commit
    // message or code comment would silently point at a different requirement.
    const existing = ["REQ-001", "REQ-002", "REQ-007"];
    assert.equal(nextRef({ kind: "requirement", existing }), "REQ-008");
  });

  test("allocation ignores refs of the other kind", () => {
    assert.equal(nextRef({ kind: "requirement", existing: ["ADR-0042"] }), "REQ-001");
  });

  test("parseRef rejects anything malformed rather than guessing", () => {
    for (const bad of ["REQ-1", "REQ001", "req-001", "ADR-001", "", null]) {
      assert.equal(parseRef(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(parseRef("REQ-014"), { kind: "requirement", num: 14 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH=/home/rnamwoh/.local/node24/bin:$PATH && node --test tests/model/ref-allocator.test.mjs`
Expected: FAIL — `Cannot find module '.../ref-allocator.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/model/ref-allocator.mjs — REQ-nnn / ADR-nnnn allocation.
//
// The ref is the CITATION and the ticket id is the identity. A ref appears in commit
// messages, code comments and audit submissions, so reusing one silently redirects
// every existing citation. Gaps are correct; contiguity is not a goal.
export const REF_PATTERNS = {
  requirement:  { prefix: "REQ", pad: 3 },
  architecture: { prefix: "ADR", pad: 4 },
};

export function parseRef(ref) {
  const s = String(ref ?? "");
  for (const [kind, { prefix, pad }] of Object.entries(REF_PATTERNS)) {
    const m = s.match(new RegExp(`^${prefix}-(\\d{${pad}})$`));
    if (m) return { kind, num: Number(m[1]) };
  }
  return null;
}

export function nextRef({ kind, existing = [] }) {
  const spec = REF_PATTERNS[kind];
  if (!spec) throw new Error(`no ref scheme for kind ${JSON.stringify(kind)}`);
  let max = 0;
  for (const r of existing) {
    const p = parseRef(r);
    if (p?.kind === kind && p.num > max) max = p.num;
  }
  return `${spec.prefix}-${String(max + 1).padStart(spec.pad, "0")}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model/ref-allocator.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Prove the gap guard discriminates**

Temporarily change `nextRef` to `existing.length + 1` (a plausible wrong implementation that fills gaps). Re-run. The gap test MUST fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/ref-allocator.mjs tests/model/ref-allocator.test.mjs
git commit -m "feat(v4): ref allocator — monotonic, never reused

A ref is a citation that appears in commit messages and audit submissions, so
reuse silently redirects every existing reference. Gaps are correct."
```

---

### Task 2: Artifact schema

**Files:**
- Create: `scripts/model/artifact-schema.mjs`
- Test: `tests/model/artifact-schema.test.mjs`

**Interfaces:**
- Consumes: `REF_PATTERNS` from Task 1
- Produces: `artifactDdl(name)` → SQL string; `ARTIFACT_KINDS = ['requirement','architecture']`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/artifact-schema.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { artifactDdl, ARTIFACT_KINDS } from "../../scripts/model/artifact-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(artifactDdl("sqlite"));
  return db;
}
const ins = (db, o) => db.prepare(
  `INSERT INTO artifact (id, project_key, kind, ref, title, statement, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?)`).run(
  o.id, o.project_key ?? "BLZ", o.kind ?? "requirement", o.ref, o.title ?? "T",
  o.statement ?? null, o.status ?? "proposed", "2026-01-01", "2026-01-01");

describe("artifact", () => {
  test("accepts a well-formed requirement", () => {
    const db = open();
    ins(db, { id: "a1", ref: "REQ-001" });
    assert.equal(db.prepare("SELECT count(*) n FROM artifact").get().n, 1);
  });

  test("a ref is unique WITHIN a project, and free across projects", () => {
    const db = open();
    ins(db, { id: "a1", ref: "REQ-001", project_key: "BLZ" });
    ins(db, { id: "a2", ref: "REQ-001", project_key: "OBA" });   // must be allowed
    assert.throws(() => ins(db, { id: "a3", ref: "REQ-001", project_key: "BLZ" }),
      /UNIQUE|constraint/i);
  });

  test("an unknown kind is refused by the database, not by the caller", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "a1", ref: "REQ-001", kind: "epic" }), /CHECK|constraint/i);
  });

  test("an empty title is refused — portable form, not btrim", () => {
    const db = open();
    assert.throws(() => ins(db, { id: "a1", ref: "REQ-001", title: "   " }), /CHECK|constraint/i);
  });

  test("both dialects declare the same columns", () => {
    const cols = (sql) => [...sql.matchAll(/^\s{2}([a-z_]+)\s+/gm)].map(m => m[1]);
    assert.deepEqual(cols(artifactDdl("sqlite")).sort(), cols(artifactDdl("postgres")).sort());
  });

  test("ARTIFACT_KINDS and the CHECK constraint cannot drift apart", () => {
    // A hand-written CHECK stays valid SQL when it goes stale. Derive it.
    for (const k of ARTIFACT_KINDS) assert.match(artifactDdl("sqlite"), new RegExp(`'${k}'`));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/model/artifact-schema.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/model/artifact-schema.mjs — the base entity behind a requirement or an
// architecture decision. NOT a ticket: tickets link TO these.
//
// Table-level constraints come after every column: SQLite requires it, Postgres
// tolerates it (sqlite-schema.mjs:18). btrim() is Postgres-only, so emptiness uses
// the portable length(trim(x)) form.
export const ARTIFACT_KINDS = ["requirement", "architecture"];

function dialect(name) {
  if (name === "postgres") return { ts: "timestamptz", txt: "text", tbl: "" };
  if (name === "sqlite")   return { ts: "TEXT", txt: "TEXT", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function artifactDdl(name) {
  const d = dialect(name);
  const kinds = ARTIFACT_KINDS.map((k) => `'${k}'`).join(", ");
  return `
CREATE TABLE IF NOT EXISTS artifact (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  kind        ${d.txt} NOT NULL,
  ref         ${d.txt} NOT NULL,
  title       ${d.txt} NOT NULL,
  statement   ${d.txt},
  body        ${d.txt},
  status      ${d.txt} NOT NULL,
  created_at  ${d.ts} NOT NULL,
  updated_at  ${d.ts} NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (project_key, ref),
  CHECK (kind IN (${kinds})),
  CHECK (length(trim(title)) > 0)
)${d.tbl};

CREATE INDEX IF NOT EXISTS artifact_project_kind_idx ON artifact (project_key, kind, status);
CREATE INDEX IF NOT EXISTS artifact_ref_idx ON artifact (project_key, ref);
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/model/artifact-schema.test.mjs`
Expected: PASS, 6 tests

- [ ] **Step 5: Run against real Postgres**

Run: `docker run --rm -d -e POSTGRES_PASSWORD=x -p 55433:5432 --name v4pg postgres:17-alpine && sleep 3 && BLAZE_TEST_PG_URL=postgres://postgres:x@localhost:55433/postgres node --test tests/model/artifact-schema.test.mjs`
Expected: PASS. Then `docker rm -f v4pg`.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/artifact-schema.mjs tests/model/artifact-schema.test.mjs
git commit -m "feat(v4): artifact schema, both dialects

The base entity behind a requirement or architecture decision. Ref unique per
project, kind CHECK derived from ARTIFACT_KINDS so it cannot silently go stale."
```

---

### Task 3: Document and artifact_usage

**Files:**
- Create: `scripts/model/document-schema.mjs`
- Test: `tests/model/document-schema.test.mjs`

**Interfaces:**
- Consumes: `artifactDdl` from Task 2
- Produces: `documentDdl(name)`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/document-schema.test.mjs
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/model/document-schema.test.mjs` → FAIL, module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/model/document-schema.mjs — documents as ordered containers of USAGES.
//
// DOORS Next's separation of base artifact from module usage. One requirement can
// appear in the safety case, the subsystem spec and the customer submission without
// three copies that drift. Ordering and indent depth belong to the USAGE, so the same
// requirement is top-level in one document and nested in another.
export const DOCUMENT_KINDS = ["requirements", "architecture"];

function dialect(name) {
  if (name === "postgres") return { ts: "timestamptz", txt: "text", int: "integer", tbl: "" };
  if (name === "sqlite")   return { ts: "TEXT", txt: "TEXT", int: "INTEGER", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function documentDdl(name) {
  const d = dialect(name);
  const kinds = DOCUMENT_KINDS.map((k) => `'${k}'`).join(", ");
  return `
CREATE TABLE IF NOT EXISTS document (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  title       ${d.txt} NOT NULL,
  kind        ${d.txt} NOT NULL,
  status      ${d.txt} NOT NULL,
  created_at  ${d.ts} NOT NULL,
  updated_at  ${d.ts} NOT NULL,
  PRIMARY KEY (id),
  CHECK (kind IN (${kinds})),
  CHECK (length(trim(title)) > 0)
)${d.tbl};

-- ON DELETE CASCADE on document_id only. artifact_id is RESTRICT: deleting a
-- requirement that is still used somewhere must fail loudly rather than silently
-- empty a document.
CREATE TABLE IF NOT EXISTS artifact_usage (
  document_id ${d.txt} NOT NULL REFERENCES document (id) ON DELETE CASCADE,
  artifact_id ${d.txt} NOT NULL REFERENCES artifact (id) ON DELETE RESTRICT,
  ord         ${d.int} NOT NULL,
  depth       ${d.int} NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, artifact_id),
  UNIQUE (document_id, ord),
  CHECK (ord > 0),
  CHECK (depth >= 0)
)${d.tbl};

CREATE INDEX IF NOT EXISTS artifact_usage_artifact_idx ON artifact_usage (artifact_id);
`;
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 5 tests

- [ ] **Step 5: Prove the cascade guard discriminates**

Change `artifact_id` to `ON DELETE CASCADE`. Re-run. The "deleting a document deletes its usages and never its artifacts" test must still pass (it deletes a document, not an artifact) — so **additionally** assert that deleting an in-use artifact throws:

```javascript
test("deleting an artifact that is still used is REFUSED", () => {
  const db = open();
  use(db, "d1", "a1", 1);
  assert.throws(() => db.exec("DELETE FROM artifact WHERE id='a1'"), /constraint|FOREIGN KEY/i);
});
```

Add it, verify it fails under CASCADE and passes under RESTRICT.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/document-schema.mjs tests/model/document-schema.test.mjs
git commit -m "feat(v4): documents as ordered containers of artifact usages

One requirement can appear in several documents without copies that drift.
Deleting a document removes usages, never artifacts; deleting an in-use artifact
is refused rather than silently emptying a document."
```

---

### Task 4: Link meta-model schema

**Files:**
- Create: `scripts/model/link-schema.mjs`
- Test: `tests/model/link-schema.test.mjs`

**Interfaces:**
- Produces: `linkDdl(name)`; `DEFAULT_LINK_TYPES` (array of `{name, inverse_name, source_kinds, target_kinds, min_card, max_card}`)

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/link-schema.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { linkDdl, DEFAULT_LINK_TYPES } from "../../scripts/model/link-schema.mjs";

describe("the default link types encode the standards document's table", () => {
  test("all five trace links are present with the right endpoints", () => {
    const by = Object.fromEntries(DEFAULT_LINK_TYPES.map(t => [t.name, t]));
    assert.deepEqual(by.Implements.source_kinds, ["feature"]);
    assert.deepEqual(by.Implements.target_kinds, ["requirement"]);
    assert.deepEqual(by.Addresses.source_kinds, ["architecture"]);
    assert.deepEqual(by.Addresses.target_kinds, ["requirement"]);
    assert.deepEqual(by.Verifies.source_kinds.sort(), ["feature", "story"]);
    assert.deepEqual(by.Supersedes.source_kinds, ["architecture"]);
    assert.deepEqual(by.Supersedes.target_kinds, ["architecture"]);
    assert.deepEqual(by.Derives.source_kinds, ["requirement"]);
  });

  test("EVERY link type carries an inverse name", () => {
    // The matrix must read correctly in both directions without a second table.
    for (const t of DEFAULT_LINK_TYPES) {
      assert.ok(t.inverse_name && t.inverse_name !== t.name, `${t.name} has no distinct inverse`);
    }
  });

  test("both dialects declare the same columns", () => {
    const cols = (sql) => [...sql.matchAll(/^\s{2}([a-z_]+)\s+/gm)].map(m => m[1]);
    assert.deepEqual(cols(linkDdl("sqlite")).sort(), cols(linkDdl("postgres")).sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/model/link-schema.mjs — the typed link meta-model.
//
// Endpoints are DECLARED, and anything undeclared is refused (ADR-0015). Jama's
// default is the opposite — "if you don't define a rule for a particular item type,
// that item type can have a relationship with anything" — which is maximum
// permissiveness in a governance tool (CS-012).
//
// source_kinds/target_kinds are stored as comma-separated text rather than an array
// type, because Postgres has arrays and SQLite does not, and the read path must be
// identical in both.
export const DEFAULT_LINK_TYPES = [
  { name: "Implements", inverse_name: "Implemented by", source_kinds: ["feature"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Addresses",  inverse_name: "Addressed by",   source_kinds: ["architecture"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Verifies",   inverse_name: "Verified by",    source_kinds: ["story", "feature"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
  { name: "Supersedes", inverse_name: "Superseded by",  source_kinds: ["architecture"],
    target_kinds: ["architecture"], min_card: 0, max_card: 1 },
  { name: "Derives",    inverse_name: "Derived from",   source_kinds: ["requirement"],
    target_kinds: ["requirement"], min_card: 0, max_card: null },
];

function dialect(name) {
  if (name === "postgres") return { ts: "timestamptz", txt: "text", int: "integer", tbl: "" };
  if (name === "sqlite")   return { ts: "TEXT", txt: "TEXT", int: "INTEGER", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function linkDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS link_type (
  id           ${d.txt} NOT NULL,
  project_key  ${d.txt} NOT NULL,
  name         ${d.txt} NOT NULL,
  inverse_name ${d.txt} NOT NULL,
  source_kinds ${d.txt} NOT NULL,
  target_kinds ${d.txt} NOT NULL,
  min_card     ${d.int} NOT NULL DEFAULT 0,
  max_card     ${d.int},
  PRIMARY KEY (id),
  UNIQUE (project_key, name),
  CHECK (length(trim(source_kinds)) > 0),
  CHECK (length(trim(target_kinds)) > 0),
  CHECK (min_card >= 0),
  CHECK (max_card IS NULL OR max_card >= min_card)
)${d.tbl};

CREATE TABLE IF NOT EXISTS link (
  id           ${d.txt} NOT NULL,
  link_type_id ${d.txt} NOT NULL REFERENCES link_type (id) ON DELETE RESTRICT,
  source_id    ${d.txt} NOT NULL,
  target_id    ${d.txt} NOT NULL,
  created_at   ${d.ts} NOT NULL,
  created_by   ${d.txt} NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (id),
  UNIQUE (link_type_id, source_id, target_id),
  CHECK (source_id <> target_id)
)${d.tbl};

CREATE INDEX IF NOT EXISTS link_source_idx ON link (source_id, link_type_id);
CREATE INDEX IF NOT EXISTS link_target_idx ON link (target_id, link_type_id);
`;
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/model/link-schema.mjs tests/model/link-schema.test.mjs
git commit -m "feat(v4): typed link meta-model schema with declared endpoints

Endpoints are declared per link type and every type carries an inverse name, so the
matrix reads both directions from one table. Kinds are comma-separated text because
Postgres has array types and SQLite does not."
```

---

### Task 5: Link endpoint enforcement — default deny

**Files:**
- Create: `scripts/model/link-rules.mjs`
- Test: `tests/model/link-rules.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_LINK_TYPES` from Task 4
- Produces: `checkLink({ linkType, sourceKind, targetKind, existingCount })` → `{ ok, error }` — **pure, synchronous**

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/link-rules.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkLink } from "../../scripts/model/link-rules.mjs";

const ADDRESSES = { name: "Addresses", source_kinds: ["architecture"],
                    target_kinds: ["requirement"], min_card: 0, max_card: null };
const SUPERSEDES = { name: "Supersedes", source_kinds: ["architecture"],
                     target_kinds: ["architecture"], min_card: 0, max_card: 1 };

describe("link endpoint enforcement", () => {
  test("a declared combination is allowed", () => {
    assert.equal(checkLink({ linkType: ADDRESSES, sourceKind: "architecture",
                             targetKind: "requirement" }).ok, true);
  });

  test("a wrong source kind is REFUSED, and the error names both kinds", () => {
    const r = checkLink({ linkType: ADDRESSES, sourceKind: "task", targetKind: "requirement" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Addresses/);
    assert.match(r.error, /task/);
    assert.match(r.error, /architecture/);
  });

  test("a wrong target kind is refused", () => {
    assert.equal(checkLink({ linkType: ADDRESSES, sourceKind: "architecture",
                             targetKind: "task" }).ok, false);
  });

  test("DEFAULT DENY: an unknown link type is refused, never passed through", () => {
    // The Jama failure mode (CS-012): an undeclared type relating to anything.
    const r = checkLink({ linkType: null, sourceKind: "architecture", targetKind: "requirement" });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown link type/i);
  });

  test("max cardinality is enforced against the existing count", () => {
    assert.equal(checkLink({ linkType: SUPERSEDES, sourceKind: "architecture",
                             targetKind: "architecture", existingCount: 0 }).ok, true);
    const r = checkLink({ linkType: SUPERSEDES, sourceKind: "architecture",
                          targetKind: "architecture", existingCount: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /at most 1/);
  });

  test("the check is SYNCHRONOUS — a sync driver cannot await", () => {
    const r = checkLink({ linkType: ADDRESSES, sourceKind: "architecture", targetKind: "requirement" });
    assert.equal(typeof r.then, "undefined");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/model/link-rules.mjs — PURE endpoint and cardinality decisions.
//
// Pure and synchronous, the same split identity.mjs uses: an async guard cannot serve
// a synchronous driver at all, because .then always defers to a microtask.
//
// DEFAULT DENY. An unknown link type is refused rather than passed through. Jama's
// documented behaviour is the opposite and it is the failure this exists to prevent:
// "If you don't define a rule for a particular item type, that item type can have a
// relationship with anything."
export function checkLink({ linkType, sourceKind, targetKind, existingCount = 0 }) {
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
  if (linkType.max_card != null && existingCount >= linkType.max_card) {
    return { ok: false, error:
      `${linkType.name} allows at most ${linkType.max_card} from this source (already ${existingCount})` };
  }
  return { ok: true, error: null };
}

function normalise(kinds) {
  if (Array.isArray(kinds)) return kinds;
  return String(kinds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 6 tests

- [ ] **Step 5: Prove default-deny discriminates**

Change the `!linkType?.name` branch to `return { ok: true, error: null }`. Re-run. The default-deny test MUST fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/link-rules.mjs tests/model/link-rules.test.mjs
git commit -m "feat(v4): link endpoint enforcement, default deny

Pure and synchronous so a sync driver can use it. An unknown link type is refused
rather than passed through — the inverse of Jama's documented default, where an
undeclared item type may relate to anything."
```

---

### Task 6: Custom field definitions and promotion

**Files:**
- Create: `scripts/model/field-schema.mjs`, `scripts/model/field-promotion.mjs`
- Test: `tests/model/field-promotion.test.mjs`

**Interfaces:**
- Produces: `fieldDdl(name)`; `promotionPlan({ field, existingColumns, filterableCount, engine })` → `{ ok, sql, error }`; `FILTERABLE_CAP = 200`; `PG_COLUMN_CEILING = 1590`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/field-promotion.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promotionPlan, FILTERABLE_CAP, PG_COLUMN_CEILING } from "../../scripts/model/field-promotion.mjs";

const f = (o = {}) => ({ key: "risk_score", data_type: "number", is_filterable: true,
                         applies_to_kind: "requirement", ...o });

describe("promotion", () => {
  test("a filterable field becomes a real typed column via ADD COLUMN", () => {
    const p = promotionPlan({ field: f(), existingColumns: [], filterableCount: 0, engine: "postgres" });
    assert.equal(p.ok, true);
    assert.match(p.sql, /ALTER TABLE artifact ADD COLUMN cf_risk_score/);
    assert.match(p.sql, /numeric|double precision/);
  });

  test("NEVER a STORED generated column — 2,002ms rewrite, impossible on SQLite", () => {
    const p = promotionPlan({ field: f(), existingColumns: [], filterableCount: 0, engine: "sqlite" });
    assert.doesNotMatch(p.sql, /GENERATED|STORED/i);
  });

  test("a non-filterable field is NOT promoted — it lives in the JSON tail", () => {
    const p = promotionPlan({ field: f({ is_filterable: false }), existingColumns: [],
                              filterableCount: 0, engine: "postgres" });
    assert.equal(p.ok, true);
    assert.equal(p.sql, null, "no DDL for an unpromoted field");
  });

  test("the 200-filterable cap is REFUSED with a named error, not a raw failure", () => {
    const p = promotionPlan({ field: f(), existingColumns: [], filterableCount: FILTERABLE_CAP,
                              engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /200/);
    assert.match(p.error, /filterable/i);
  });

  test("the Postgres 1,600-column ceiling is refused BEFORE ALTER TABLE fails raw", () => {
    const cols = Array.from({ length: PG_COLUMN_CEILING }, (_, i) => `cf_${i}`);
    const p = promotionPlan({ field: f(), existingColumns: cols, filterableCount: 5,
                              engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /1600|1,600/);
  });

  test("SQLite has no such ceiling, so the same field promotes there", () => {
    const cols = Array.from({ length: PG_COLUMN_CEILING }, (_, i) => `cf_${i}`);
    const p = promotionPlan({ field: f(), existingColumns: cols, filterableCount: 5,
                              engine: "sqlite" });
    assert.equal(p.ok, true);
  });

  test("a duplicate column is refused rather than emitting a failing ALTER", () => {
    const p = promotionPlan({ field: f(), existingColumns: ["cf_risk_score"],
                              filterableCount: 1, engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /already/i);
  });

  test("a field key that is not a safe identifier is refused — no SQL injection surface", () => {
    const p = promotionPlan({ field: f({ key: "oops\"; DROP TABLE artifact; --" }),
                              existingColumns: [], filterableCount: 0, engine: "postgres" });
    assert.equal(p.ok, false);
    assert.match(p.error, /identifier/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementations**

```javascript
// scripts/model/field-schema.mjs — user-defined custom field definitions (ADR-0018).
function dialect(name) {
  if (name === "postgres") return { txt: "text", int: "integer", bool: "boolean", tbl: "" };
  if (name === "sqlite")   return { txt: "TEXT", int: "INTEGER", bool: "INTEGER", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}
export const DATA_TYPES = ["text", "number", "date", "boolean", "enum"];

export function fieldDdl(name) {
  const d = dialect(name);
  const types = DATA_TYPES.map((t) => `'${t}'`).join(", ");
  return `
CREATE TABLE IF NOT EXISTS field_definition (
  id              ${d.txt} NOT NULL,
  project_key     ${d.txt} NOT NULL,
  key             ${d.txt} NOT NULL,
  label           ${d.txt} NOT NULL,
  data_type       ${d.txt} NOT NULL,
  applies_to_kind ${d.txt} NOT NULL,
  is_filterable   ${d.bool} NOT NULL DEFAULT 0,
  is_required     ${d.bool} NOT NULL DEFAULT 0,
  enum_values     ${d.txt},
  min_value       ${d.txt},
  max_value       ${d.txt},
  PRIMARY KEY (id),
  UNIQUE (project_key, key, applies_to_kind),
  CHECK (data_type IN (${types})),
  CHECK (data_type <> 'enum' OR enum_values IS NOT NULL)
)${d.tbl};
`;
}
```

```javascript
// scripts/model/field-promotion.mjs — promoting a filterable field to a real column.
//
// Every rule here is a measured number from the ADR-0018 benchmark, not a guess.
//
//   plain ALTER TABLE ADD COLUMN  ->  9.0 ms on 100k rows (metadata-only, PG 11+)
//   STORED generated column       ->  2,002 ms rewrite, and IMPOSSIBLE on SQLite
//   promoting a POPULATED field   ->  6.5 s PG / 2.1 s SQLite  (hence: at definition time)
//   indexing knee                 ->  200-400 indexed fields (insert p95 3.15 -> 51.4 ms)
//   Postgres hard column limit    ->  1,600
export const FILTERABLE_CAP = 200;
export const PG_COLUMN_CEILING = 1590;   // refuse before Postgres refuses at 1,600

const SAFE_IDENT = /^[a-z][a-z0-9_]{0,50}$/;

const SQL_TYPE = {
  postgres: { text: "text", number: "numeric", date: "date", boolean: "boolean", enum: "text" },
  sqlite:   { text: "TEXT", number: "REAL",    date: "TEXT", boolean: "INTEGER", enum: "TEXT" },
};

const TARGET_TABLE = { requirement: "artifact", architecture: "artifact" };

export function promotionPlan({ field, existingColumns = [], filterableCount = 0, engine }) {
  if (!SQL_TYPE[engine]) return { ok: false, sql: null, error: `unknown engine ${engine}` };
  if (!SAFE_IDENT.test(String(field?.key ?? ""))) {
    return { ok: false, sql: null,
      error: `${JSON.stringify(field?.key)} is not a safe identifier — expected /^[a-z][a-z0-9_]{0,50}$/` };
  }
  if (!field.is_filterable) return { ok: true, sql: null, error: null };  // JSON tail

  const col = `cf_${field.key}`;
  if (existingColumns.includes(col)) {
    return { ok: false, sql: null, error: `column ${col} already exists on this table` };
  }
  if (filterableCount >= FILTERABLE_CAP) {
    return { ok: false, sql: null, error:
      `refusing to promote ${field.key}: this installation already has ${filterableCount} `
      + `filterable fields, and the cap is ${FILTERABLE_CAP}. Past roughly 200 indexed fields `
      + `insert p95 degrades from 3.15ms to 51.4ms. Mark the field unfilterable, or retire one.` };
  }
  if (engine === "postgres" && existingColumns.length >= PG_COLUMN_CEILING) {
    return { ok: false, sql: null, error:
      `refusing to promote ${field.key}: this table has ${existingColumns.length} columns and `
      + `Postgres hard-refuses at 1600.` };
  }

  const table = TARGET_TABLE[field.applies_to_kind] ?? "ticket";
  const type = SQL_TYPE[engine][field.data_type];
  // Plain ADD COLUMN. Never GENERATED ... STORED.
  return { ok: true, error: null, sql: `ALTER TABLE ${table} ADD COLUMN ${col} ${type};` };
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 8 tests

- [ ] **Step 5: Prove the injection guard discriminates**

Remove the `SAFE_IDENT` check. Re-run — the identifier test must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/field-schema.mjs scripts/model/field-promotion.mjs tests/model/field-promotion.test.mjs
git commit -m "feat(v4): custom field definitions and column promotion

Plain ALTER TABLE ADD COLUMN, never STORED generated columns — 9ms metadata-only
versus a 2,002ms rewrite that SQLite cannot do at all. Refuses past the 200-filterable
cap and before Postgres' own 1,600-column limit, each with an error naming the number
and what to do, rather than letting ALTER fail raw."
```

---

### Task 7: Artifact revisions and computed staleness

**Files:**
- Create: append to `scripts/model/artifact-schema.mjs`; create `scripts/model/staleness.mjs`
- Test: `tests/model/staleness.test.mjs`

**Interfaces:**
- Produces: `revisionDdl(name)`; `staleLinks({ links, revisions })` → array of `{ linkId, targetRef, changedAt }` — **pure**

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/model/staleness.mjs — "N linked artifacts have not been re-reviewed since
// this changed", computed from revisions.
//
// We store NO suspicion flag. IBM removed suspicion profiles at DOORS Next 7.0.0 and
// replaced them with something their own docs say is "not a date-based check for
// changes". Polarion's is a boolean their docs concede is "implemented on the UI level
// only... do not work for server-side use cases like imports or API calls".
//
// A derived value cannot go stale, cannot be cleared by accident, and is visible to
// the API by construction.
export function staleLinks({ links = [], revisions = [] }) {
  const latest = new Map();
  for (const r of revisions) {
    const cur = latest.get(r.artifact_id);
    if (!cur || String(r.at) > String(cur)) latest.set(r.artifact_id, String(r.at));
  }
  const out = [];
  for (const l of links) {
    const changed = latest.get(l.source_id);
    if (!changed) continue;
    if (l.reviewed_at == null || String(l.reviewed_at) < changed) {
      out.push({ linkId: l.id, targetRef: l.target_id, changedAt: changed });
    }
  }
  return out;
}
```

Append to `artifact-schema.mjs`:

```javascript
export function revisionDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS artifact_revision (
  id          ${d.txt} NOT NULL,
  artifact_id ${d.txt} NOT NULL REFERENCES artifact (id) ON DELETE CASCADE,
  at          ${d.ts} NOT NULL,
  actor       ${d.txt} NOT NULL DEFAULT 'unknown',
  snapshot    ${d.txt} NOT NULL,
  PRIMARY KEY (id)
)${d.tbl};
CREATE INDEX IF NOT EXISTS artifact_revision_artifact_idx ON artifact_revision (artifact_id, at);
`;
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/model/staleness.mjs scripts/model/artifact-schema.mjs tests/model/staleness.test.mjs
git commit -m "feat(v4): computed staleness instead of stored suspicion state

Compares each link's review time to the latest revision of its source. Stores no flag,
because IBM retreated from stored suspicion at DNG 7.0.0 and Polarion's boolean is
invisible to its own API. A derived value cannot be cleared by accident."
```

---

### Task 8: Hierarchies with duplicate-safe rollup

**Files:**
- Create: `scripts/model/hierarchy-schema.mjs`, `scripts/model/hierarchy-rollup.mjs`
- Test: `tests/model/hierarchy-rollup.test.mjs`

**Interfaces:**
- Produces: `hierarchyDdl(name)`; `rollup({ memberships, values, hierarchyId, rootId })` → `number` — **pure**

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/hierarchy-rollup.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rollup } from "../../scripts/model/hierarchy-rollup.mjs";

const m = (hierarchyId, item_id, parent_id) => ({ hierarchy_id: hierarchyId, item_id, parent_id });

describe("rollup", () => {
  test("sums a simple subtree", () => {
    const memberships = [m("h1","root",null), m("h1","a","root"), m("h1","b","root")];
    const values = { a: 3, b: 4 };
    assert.equal(rollup({ memberships, values, hierarchyId: "h1", rootId: "root" }), 7);
  });

  test("sums to arbitrary depth", () => {
    const memberships = [m("h1","root",null), m("h1","a","root"),
                         m("h1","b","a"), m("h1","c","b")];
    assert.equal(rollup({ memberships, values: { c: 5 }, hierarchyId: "h1", rootId: "root" }), 5);
  });

  test("EXCLUDES DUPLICATES BY DEFAULT — an item reachable twice counts once", () => {
    // Structure requires an explicit 'Exclude duplicates' toggle, which means its
    // default is wrong (CS-038). A rollup that double-counts is not a number.
    const memberships = [m("h1","root",null), m("h1","a","root"), m("h1","b","root"),
                         m("h1","shared","a"), m("h1","shared","b")];
    assert.equal(rollup({ memberships, values: { shared: 10 }, hierarchyId: "h1", rootId: "root" }), 10);
  });

  test("a cycle terminates instead of hanging", () => {
    const memberships = [m("h1","a","b"), m("h1","b","a")];
    assert.equal(rollup({ memberships, values: { a: 1, b: 1 }, hierarchyId: "h1", rootId: "a" }), 2);
  });

  test("hierarchies are independent — the same items roll up differently", () => {
    const memberships = [m("h1","root",null), m("h1","x","root"),
                         m("h2","root",null)];   // x is not in h2
    assert.equal(rollup({ memberships, values: { x: 9 }, hierarchyId: "h1", rootId: "root" }), 9);
    assert.equal(rollup({ memberships, values: { x: 9 }, hierarchyId: "h2", rootId: "root" }), 0);
  });

  test("a missing value contributes zero, never NaN", () => {
    const memberships = [m("h1","root",null), m("h1","a","root")];
    assert.equal(rollup({ memberships, values: {}, hierarchyId: "h1", rootId: "root" }), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementations**

```javascript
// scripts/model/hierarchy-rollup.mjs — PURE, duplicate-safe subtree rollup.
//
// A whole-tree pass in JS beat a recursive CTE by 6.0x on 100k items in the
// ADR-0016 benchmark (762.7ms vs 4,585.9ms), so this being pure JS is the fast path,
// not a compromise.
//
// Duplicates are excluded BY DEFAULT. Structure needs a toggle for this, which means
// its default double-counts. A number you have to configure to be correct is not a
// number you can trust.
export function rollup({ memberships = [], values = {}, hierarchyId, rootId }) {
  const children = new Map();
  for (const r of memberships) {
    if (r.hierarchy_id !== hierarchyId) continue;
    if (!children.has(r.parent_id)) children.set(r.parent_id, []);
    children.get(r.parent_id).push(r.item_id);
  }
  const seen = new Set();          // both the dedup and the cycle guard
  const stack = [rootId];
  let total = 0;
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    if (id !== rootId) total += Number(values[id] ?? 0);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return total;
}
```

```javascript
// scripts/model/hierarchy-schema.mjs — multiple named hierarchies over the same items.
//
// Replaces a single parent_id, which forecloses the core Structure use case: a
// delivery hierarchy, a safety hierarchy and a contractual-deliverable hierarchy
// coexisting over one set of items.
function dialect(name) {
  if (name === "postgres") return { txt: "text", int: "integer", bool: "boolean", tbl: "" };
  if (name === "sqlite")   return { txt: "TEXT", int: "INTEGER", bool: "INTEGER", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function hierarchyDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS hierarchy (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  name        ${d.txt} NOT NULL,
  is_default  ${d.bool} NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE (project_key, name)
)${d.tbl};

CREATE TABLE IF NOT EXISTS hierarchy_membership (
  hierarchy_id ${d.txt} NOT NULL REFERENCES hierarchy (id) ON DELETE CASCADE,
  item_id      ${d.txt} NOT NULL,
  parent_id    ${d.txt},
  ord          ${d.int} NOT NULL DEFAULT 0,
  PRIMARY KEY (hierarchy_id, item_id, parent_id),
  CHECK (item_id <> parent_id)
)${d.tbl};

CREATE INDEX IF NOT EXISTS hierarchy_membership_parent_idx
  ON hierarchy_membership (hierarchy_id, parent_id);
`;
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 6 tests

- [ ] **Step 5: Prove the dedup guard discriminates**

Replace the `seen` set with a plain visited-once-per-path walk (remove the dedup, keep only cycle detection). Re-run — the duplicate test must report 20 and fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/hierarchy-schema.mjs scripts/model/hierarchy-rollup.mjs tests/model/hierarchy-rollup.test.mjs
git commit -m "feat(v4): multiple named hierarchies with duplicate-safe rollup

Replaces the single parent_id, which forecloses coexisting delivery, safety and
contractual hierarchies over the same items. Rollup excludes duplicates by default
rather than behind a toggle, and is pure JS because a whole-tree pass beat a recursive
CTE by 6x on 100k items."
```

---

### Task 9: Coverage rules

**Files:**
- Create: `scripts/model/coverage.mjs`
- Test: `tests/model/coverage.test.mjs`

**Interfaces:**
- Produces: `coverageDdl(name)`; `evaluateCoverage({ rule, artifacts, links })` → `{ rule, violations: [{ ref, why }] }` — **pure**; `DEFAULT_COVERAGE_RULES`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/coverage.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateCoverage, DEFAULT_COVERAGE_RULES } from "../../scripts/model/coverage.mjs";

const RULE = { name: "every-requirement-addressed", subject_kind: "requirement",
               definition: { requires_link: "Addresses", direction: "inbound", min: 1 } };

describe("coverage evaluation", () => {
  test("a requirement with an inbound Addresses link satisfies the rule", () => {
    const artifacts = [{ id: "a1", ref: "REQ-001", kind: "requirement" }];
    const links = [{ type_name: "Addresses", source_id: "d1", target_id: "a1" }];
    assert.deepEqual(evaluateCoverage({ rule: RULE, artifacts, links }).violations, []);
  });

  test("a requirement with no such link VIOLATES, and the violation names the ref", () => {
    const artifacts = [{ id: "a1", ref: "REQ-014", kind: "requirement" }];
    const r = evaluateCoverage({ rule: RULE, artifacts, links: [] });
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].ref, "REQ-014");
    assert.match(r.violations[0].why, /Addresses/);
  });

  test("a link of the WRONG TYPE does not satisfy the rule", () => {
    const artifacts = [{ id: "a1", ref: "REQ-014", kind: "requirement" }];
    const links = [{ type_name: "Relates", source_id: "x", target_id: "a1" }];
    assert.equal(evaluateCoverage({ rule: RULE, artifacts, links }).violations.length, 1);
  });

  test("direction matters — an OUTBOUND Addresses does not satisfy an inbound rule", () => {
    const artifacts = [{ id: "a1", ref: "REQ-014", kind: "requirement" }];
    const links = [{ type_name: "Addresses", source_id: "a1", target_id: "other" }];
    assert.equal(evaluateCoverage({ rule: RULE, artifacts, links }).violations.length, 1);
  });

  test("artifacts of another kind are not subject to the rule", () => {
    const artifacts = [{ id: "x1", ref: "ADR-0001", kind: "architecture" }];
    assert.deepEqual(evaluateCoverage({ rule: RULE, artifacts, links: [] }).violations, []);
  });

  test("EVERY violation is listed — never a count, never a truncated sample", () => {
    // A refusal saying only "coverage incomplete" is a defect: the person cannot act on it.
    const artifacts = Array.from({ length: 30 }, (_, i) =>
      ({ id: `a${i}`, ref: `REQ-${String(i + 1).padStart(3, "0")}`, kind: "requirement" }));
    const r = evaluateCoverage({ rule: RULE, artifacts, links: [] });
    assert.equal(r.violations.length, 30);
  });

  test("the shipped defaults are named, so a refusal can cite the rule that refused", () => {
    for (const r of DEFAULT_COVERAGE_RULES) {
      assert.ok(r.name && r.description, `${JSON.stringify(r)} needs a name and description`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/model/coverage.mjs — coverage rules as named, first-class objects.
//
// Not hardcoded queries: a rule has a NAME, so a refusal can cite the rule that
// refused rather than saying "coverage incomplete", which nobody can act on.
export const DEFAULT_COVERAGE_RULES = [
  { name: "every-requirement-addressed", subject_kind: "requirement",
    description: "Every requirement is addressed by at least one architecture decision.",
    definition: { requires_link: "Addresses", direction: "inbound", min: 1 } },
  { name: "every-requirement-verified", subject_kind: "requirement",
    description: "Every requirement has at least one verifying item.",
    definition: { requires_link: "Verifies", direction: "inbound", min: 1 } },
  { name: "no-orphan-architecture", subject_kind: "architecture",
    description: "Every architecture decision addresses a requirement or states why not.",
    definition: { requires_link: "Addresses", direction: "outbound", min: 1 } },
];

export function evaluateCoverage({ rule, artifacts = [], links = [] }) {
  const { requires_link, direction, min = 1 } = rule.definition ?? {};
  const counts = new Map();
  for (const l of links) {
    if (l.type_name !== requires_link) continue;
    const key = direction === "inbound" ? l.target_id : l.source_id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const violations = [];
  for (const a of artifacts) {
    if (a.kind !== rule.subject_kind) continue;
    const n = counts.get(a.id) ?? 0;
    if (n < min) {
      violations.push({ ref: a.ref, why:
        `needs at least ${min} ${direction} ${requires_link} link${min === 1 ? "" : "s"}, has ${n}` });
    }
  }
  return { rule: rule.name, violations };
}
```

Plus `coverageDdl(name)` following the same dialect pattern, with columns
`(id, project_key, name, description, subject_kind, definition, enabled)`.

- [ ] **Step 4: Run tests to verify they pass** → PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/model/coverage.mjs tests/model/coverage.test.mjs
git commit -m "feat(v4): coverage rules as named first-class objects

A rule has a name so a refusal can cite what refused it. Every violation is listed
rather than counted — a refusal saying only 'coverage incomplete' cannot be acted on."
```

---

### Task 10: Gates

**Files:**
- Create: `scripts/model/gates.mjs`
- Test: `tests/model/gates.test.mjs`

**Interfaces:**
- Consumes: `evaluateCoverage` (Task 9)
- Produces: `GATED_ACTIONS`; `checkGate({ action, subject, context })` → `{ ok, error, failures }` — **pure**

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/gates.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkGate, GATED_ACTIONS } from "../../scripts/model/gates.mjs";

describe("gates", () => {
  test("the gated actions are ENUMERATED — an unlisted action is not a gate", () => {
    assert.deepEqual([...GATED_ACTIONS].sort(),
      ["architecture:accepted", "document:baselined", "goal:achieved", "requirement:verified"]);
  });

  test("an unknown action passes through rather than silently blocking everything", () => {
    const r = checkGate({ action: "task:done", subject: {}, context: {} });
    assert.equal(r.ok, true);
  });

  test("requirement -> verified is refused without a resolving Verifies link (RQ-6)", () => {
    const r = checkGate({ action: "requirement:verified",
      subject: { id: "a1", ref: "REQ-014" }, context: { links: [] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-014/);
    assert.match(r.error, /Verifies/);
  });

  test("...and allowed with one", () => {
    const r = checkGate({ action: "requirement:verified", subject: { id: "a1", ref: "REQ-014" },
      context: { links: [{ type_name: "Verifies", source_id: "s1", target_id: "a1" }] } });
    assert.equal(r.ok, true);
  });

  test("goal -> achieved is refused while ANY child requirement is non-terminal (RQ-7)", () => {
    const r = checkGate({ action: "goal:achieved", subject: { id: "g1" }, context: {
      children: [{ ref: "REQ-001", kind: "requirement", status: "implemented", terminal: true },
                 { ref: "REQ-002", kind: "requirement", status: "proposed", terminal: false }] } });
    assert.equal(r.ok, false);
    assert.match(r.error, /REQ-002/);
    assert.doesNotMatch(r.error, /REQ-001/, "a satisfied child must not be listed as a failure");
  });

  test("architecture -> accepted requires Context, Decision AND Consequences (AQ-2)", () => {
    const bad = checkGate({ action: "architecture:accepted", subject: { ref: "ADR-0007",
      body: "## Context\nsome context\n## Decision\nwe will\n" }, context: {} });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Consequences/);

    const good = checkGate({ action: "architecture:accepted", subject: { ref: "ADR-0007",
      body: "## Context\nc\n## Decision\nd\n## Consequences\ne\n" }, context: {} });
    assert.equal(good.ok, true);
  });

  test("an EMPTY required section does not count as present", () => {
    const r = checkGate({ action: "architecture:accepted", subject: { ref: "ADR-0007",
      body: "## Context\nc\n## Decision\nd\n## Consequences\n\n" }, context: {} });
    assert.equal(r.ok, false);
  });

  test("EVERY failure is listed, not just the first", () => {
    const r = checkGate({ action: "goal:achieved", subject: { id: "g1" }, context: {
      children: [{ ref: "REQ-001", kind: "requirement", terminal: false },
                 { ref: "REQ-002", kind: "requirement", terminal: false },
                 { ref: "REQ-003", kind: "requirement", terminal: false }] } });
    assert.equal(r.failures.length, 3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/model/gates.mjs — the enumerated set of gated actions (ADR-0015, ADR-0017).
//
// A gate is where a coverage rule finally bites. Coverage cannot block a write --
// when a requirement is created, the architecture answering it does not exist yet --
// so it blocks at a deliberate checkpoint instead.
//
// A gate not on this list DOES NOT EXIST. Adding one is a deliberate act.
//
// Every refusal lists EVERY failing item. "Coverage incomplete" is a defect: the
// person hitting the gate has to know exactly what to fix.
export const GATED_ACTIONS = new Set([
  "document:baselined",
  "requirement:verified",
  "goal:achieved",
  "architecture:accepted",
]);

const REQUIRED_ADR_SECTIONS = ["Context", "Decision", "Consequences"];

export function checkGate({ action, subject = {}, context = {} }) {
  if (!GATED_ACTIONS.has(action)) return { ok: true, error: null, failures: [] };

  let failures = [];
  if (action === "requirement:verified") {
    const has = (context.links ?? []).some(
      (l) => l.type_name === "Verifies" && l.target_id === subject.id);
    if (!has) failures = [{ ref: subject.ref, why: "no resolving Verifies link" }];
  }

  if (action === "goal:achieved") {
    failures = (context.children ?? [])
      .filter((c) => c.kind === "requirement" && !c.terminal)
      .map((c) => ({ ref: c.ref, why: `still ${c.status ?? "open"}` }));
  }

  if (action === "architecture:accepted") {
    const body = String(subject.body ?? "");
    failures = REQUIRED_ADR_SECTIONS
      .filter((s) => !sectionHasContent(body, s))
      .map((s) => ({ ref: subject.ref, why: `section "${s}" is missing or empty` }));
  }

  if (action === "document:baselined") {
    failures = (context.coverageViolations ?? [])
      .map((v) => ({ ref: v.ref, why: v.why }));
  }

  if (!failures.length) return { ok: true, error: null, failures: [] };
  return {
    ok: false,
    failures,
    error: `${action} refused — ${failures.length} item${failures.length === 1 ? "" : "s"} failing:\n`
      + failures.map((f) => `  ${f.ref}: ${f.why}`).join("\n"),
  };
}

function sectionHasContent(body, heading) {
  const m = body.match(new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|\\Z)`, "m"));
  return Boolean(m && m[1].trim().length > 0);
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 8 tests

- [ ] **Step 5: Prove the enumeration discriminates**

Change the `GATED_ACTIONS.has(action)` guard to always fall through. Re-run — the "unknown action passes through" test must fail. Revert.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/gates.mjs tests/model/gates.test.mjs
git commit -m "feat(v4): enumerated gates with fully-itemised refusals

Four gated actions; anything unlisted is not a gate. Every refusal lists every
failing item with its ref and reason, because a refusal saying only 'coverage
incomplete' cannot be acted on."
```

---

### Task 11: The traceability matrix

**Files:**
- Create: `scripts/model/matrix.mjs`
- Test: `tests/model/matrix.test.mjs`

**Interfaces:**
- Produces: `buildMatrix({ rows, cols, links, linkTypes })` → `{ rows, cols, cells, untraced }` — **pure**

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/model/matrix.mjs — the traceability matrix as a query.
//
// Derived, never hand-edited. The tickets are the source of truth; the matrix is a
// view of them. build_matrices.py already works this way on the v3 board; this makes
// it native.
export function buildMatrix({ rows = [], cols = [], links = [], linkTypes = [] }) {
  const inverseOf = new Map(linkTypes.map((t) => [t.name, t.inverse_name ?? null]));
  const colIds = new Set(cols.map((c) => c.id));
  const cells = {};
  const traced = new Set();

  for (const l of links) {
    if (!colIds.has(l.source_id)) continue;
    if (!cells[l.target_id]) cells[l.target_id] = {};
    cells[l.target_id][l.source_id] = {
      type: l.type_name,
      inverse: inverseOf.get(l.type_name) ?? null,
    };
    traced.add(l.target_id);
  }

  return {
    rows, cols, cells,
    untraced: rows.filter((r) => !traced.has(r.id)).map((r) => r.ref),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/model/matrix.mjs tests/model/matrix.test.mjs
git commit -m "feat(v4): traceability matrix as a derived query

Cells read both directions from one link table via the declared inverse name.
Untraced requirements are counted and listed rather than hidden, because inventing
a requirement to close a gap would make the matrix a lie."
```

---

### Task 12: Baselines

**Files:**
- Create: `scripts/model/baseline-schema.mjs`
- Test: `tests/model/baseline.test.mjs`

**Interfaces:**
- Consumes: `checkGate` (Task 10), `revisionDdl` (Task 7)
- Produces: `baselineDdl(name)`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/baseline.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { artifactDdl, revisionDdl } from "../../scripts/model/artifact-schema.mjs";
import { baselineDdl } from "../../scripts/model/baseline-schema.mjs";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(artifactDdl("sqlite"));
  db.exec(revisionDdl("sqlite"));
  db.exec(baselineDdl("sqlite"));
  db.exec(`INSERT INTO artifact VALUES ('a1','BLZ','requirement','REQ-001','T',NULL,NULL,'proposed','t','t');`);
  db.exec(`INSERT INTO artifact_revision VALUES ('rev1','a1','2026-01-01','me','{}');`);
  db.exec(`INSERT INTO baseline VALUES ('b1','BLZ','Release 1.0','2026-02-01','me',NULL);`);
  return db;
}

describe("baselines", () => {
  test("a baseline is scoped to a PROJECT, not a document", () => {
    // DOORS baselined per module, then had to invent baseline SETS to fix the problem
    // that created. The fix is evidence of the mistake (CS-019).
    const db = open();
    const cols = db.prepare("SELECT * FROM baseline").all()[0];
    assert.ok("project_key" in cols);
    assert.ok(!("document_id" in cols), "a baseline must not be per-document");
  });

  test("a member pins a specific REVISION, not the live artifact", () => {
    const db = open();
    db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
    const row = db.prepare("SELECT revision_id FROM baseline_member").get();
    assert.equal(row.revision_id, "rev1");
  });

  test("an artifact cannot appear twice in one baseline", () => {
    const db = open();
    db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
    assert.throws(() => db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')"),
      /UNIQUE|constraint/i);
  });

  test("a baseline cannot pin a revision that does not exist", () => {
    const db = open();
    assert.throws(() => db.exec("INSERT INTO baseline_member VALUES ('b1','a1','nope')"),
      /FOREIGN KEY|constraint/i);
  });

  test("deleting an artifact that a baseline pins is REFUSED", () => {
    // A baseline is a historical record. Deleting out from under it would silently
    // rewrite history, which is the opposite of what a baseline is for.
    const db = open();
    db.exec("INSERT INTO baseline_member VALUES ('b1','a1','rev1')");
    assert.throws(() => db.exec("DELETE FROM artifact WHERE id='a1'"),
      /FOREIGN KEY|constraint/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/model/baseline-schema.mjs — immutable named snapshots, at PROJECT scope.
//
// DOORS baselined per module, which forced baseline SETS to be invented to group them.
// The existence of the fix is evidence of the original mistake, so we baseline at
// project scope from the start.
function dialect(name) {
  if (name === "postgres") return { ts: "timestamptz", txt: "text", tbl: "" };
  if (name === "sqlite")   return { ts: "TEXT", txt: "TEXT", tbl: " STRICT" };
  throw new Error(`unknown dialect ${JSON.stringify(name)}`);
}

export function baselineDdl(name) {
  const d = dialect(name);
  return `
CREATE TABLE IF NOT EXISTS baseline (
  id          ${d.txt} NOT NULL,
  project_key ${d.txt} NOT NULL,
  name        ${d.txt} NOT NULL,
  created_at  ${d.ts} NOT NULL,
  created_by  ${d.txt} NOT NULL,
  note        ${d.txt},
  PRIMARY KEY (id),
  UNIQUE (project_key, name)
)${d.tbl};

-- RESTRICT on both: a baseline is a historical record, and deleting out from under
-- it would silently rewrite history.
CREATE TABLE IF NOT EXISTS baseline_member (
  baseline_id ${d.txt} NOT NULL REFERENCES baseline (id) ON DELETE CASCADE,
  artifact_id ${d.txt} NOT NULL REFERENCES artifact (id) ON DELETE RESTRICT,
  revision_id ${d.txt} NOT NULL REFERENCES artifact_revision (id) ON DELETE RESTRICT,
  PRIMARY KEY (baseline_id, artifact_id)
)${d.tbl};
`;
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/model/baseline-schema.mjs tests/model/baseline.test.mjs
git commit -m "feat(v4): project-scoped baselines pinning revisions

Project scope, not per-document — DOORS baselined per module then had to invent
baseline sets to fix it. Members pin a revision, and deleting a pinned artifact is
refused rather than silently rewriting history."
```

---

### Task 13: API enforcement and the conformance rule

**Files:**
- Modify: `scripts/model/serve-auth.mjs` (add v4 routes to `ROUTE_SCOPES`)
- Create: `scripts/model/artifact-api.mjs`
- Test: `tests/model/artifact-api.test.mjs`

**Interfaces:**
- Consumes: `checkLink` (5), `checkGate` (10), `promotionPlan` (6)
- Produces: `artifactApi(store)` with `createLink`, `transition`, `defineField`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/artifact-api.test.mjs
//
// ADR-0015 §4.5: enforcement lives BELOW HTTP, and is proven by exercising every rule
// through the API. CS-018 is the anti-pattern -- Polarion's own docs concede their
// suspect links "are implemented on the UI level only. They do not work for
// server-side use cases like imports or API calls." For agent-driven teams the API IS
// the primary interface, so a rule the API cannot see does not exist.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { artifactApi } from "../../scripts/model/artifact-api.mjs";
import { ROUTE_SCOPES } from "../../scripts/model/serve-auth.mjs";

function api() {
  const state = {
    artifacts: [{ id: "a1", ref: "REQ-001", kind: "requirement", status: "proposed" }],
    linkTypes: [{ id: "lt1", name: "Addresses", inverse_name: "Addressed by",
                  source_kinds: "architecture", target_kinds: "requirement",
                  min_card: 0, max_card: null }],
    links: [],
  };
  return { api: artifactApi(state), state };
}

describe("every rule is enforced through the API, not above it", () => {
  test("a link with an illegal endpoint is refused BY THE API", async () => {
    const { api } = api2();
    const r = await api.createLink({ typeName: "Addresses", sourceId: "a1", targetId: "a1" });
    assert.equal(r.ok, false);
  });

  test("an undeclared link type is refused BY THE API — default deny", async () => {
    const { api } = api2();
    const r = await api.createLink({ typeName: "Whatever", sourceId: "x", targetId: "a1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown link type/i);
  });

  test("a gated transition is refused BY THE API", async () => {
    const { api } = api2();
    const r = await api.transition({ id: "a1", to: "verified" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Verifies/);
  });

  test("field promotion past the cap is refused BY THE API", async () => {
    const { api } = api2();
    const r = await api.defineField({ key: "x", data_type: "number", is_filterable: true,
                                      applies_to_kind: "requirement", filterableCount: 200 });
    assert.equal(r.ok, false);
    assert.match(r.error, /200/);
  });

  test("EVERY v4 route is classified in ROUTE_SCOPES — an unclassified route fails closed", () => {
    for (const r of ["POST /api/artifact", "POST /api/link", "POST /api/baseline",
                     "GET /api/matrix", "POST /api/field"]) {
      assert.ok(r in ROUTE_SCOPES, `${r} is not classified`);
    }
  });

  test("every mutating v4 route costs write or admin, and no GET does", () => {
    for (const [route, scope] of Object.entries(ROUTE_SCOPES)) {
      if (route.startsWith("POST ")) assert.notEqual(scope, "read", route);
      if (route.startsWith("GET ")) assert.equal(scope, "read", route);
    }
  });
});

function api2() { return api(); }
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/model/artifact-api.mjs — the v4 API surface. Enforcement lives HERE, below
// HTTP, so an import, a script and an agent are governed identically to the UI.
import { checkLink } from "./link-rules.mjs";
import { checkGate } from "./gates.mjs";
import { promotionPlan } from "./field-promotion.mjs";

export function artifactApi(state) {
  const find = (id) => state.artifacts.find((a) => a.id === id);
  const typeByName = (n) => state.linkTypes.find((t) => t.name === n) ?? null;

  return {
    async createLink({ typeName, sourceId, targetId }) {
      const lt = typeByName(typeName);
      const existingCount = state.links.filter(
        (l) => l.type_name === typeName && l.source_id === sourceId).length;
      const verdict = checkLink({
        linkType: lt,
        sourceKind: find(sourceId)?.kind ?? "unknown",
        targetKind: find(targetId)?.kind ?? "unknown",
        existingCount,
      });
      if (!verdict.ok) return verdict;
      state.links.push({ type_name: typeName, source_id: sourceId, target_id: targetId });
      return { ok: true, error: null };
    },

    async transition({ id, to }) {
      const subject = find(id);
      if (!subject) return { ok: false, error: `no such artifact ${id}` };
      const verdict = checkGate({
        action: `${subject.kind}:${to}`,
        subject,
        context: { links: state.links },
      });
      if (!verdict.ok) return verdict;
      subject.status = to;
      return { ok: true, error: null };
    },

    async defineField(field) {
      const plan = promotionPlan({
        field,
        existingColumns: state.columns ?? [],
        filterableCount: field.filterableCount ?? 0,
        engine: state.engine ?? "sqlite",
      });
      return plan.ok ? { ok: true, error: null, sql: plan.sql }
                     : { ok: false, error: plan.error };
    },
  };
}
```

Add to `serve-auth.mjs` `ROUTE_SCOPES`:

```javascript
  "POST /api/artifact": "write",
  "POST /api/link": "write",
  "POST /api/baseline": "write",
  "POST /api/field": "admin",
  "GET /api/matrix": "read",
  "GET /api/coverage": "read",
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 6 tests

- [ ] **Step 5: Prove the route classification discriminates**

Add `"POST /api/unclassified": "read"` to `ROUTE_SCOPES`. Re-run — the "no POST costs read" test must fail. Remove it.

- [ ] **Step 6: Commit**

```bash
git add scripts/model/artifact-api.mjs scripts/model/serve-auth.mjs tests/model/artifact-api.test.mjs
git commit -m "feat(v4): API-level enforcement for links, gates and field promotion

Every rule is enforced below HTTP and tested through the API, so an import, a script
and an agent are governed identically to the UI. Polarion's own docs concede their
suspect links work at the UI level only and not for API calls — for agent-driven teams
that makes the rule worthless, and this is the test that prevents it here."
```

---

### Task 14: Migration from v3 with a zero-diff oracle

> **PREREQUISITE:** the db-primary Phase 2 cutover must have landed. A document has no
> status directory, so the fs write port cannot represent this model. Do not start this
> task until `BLAZE_WRITE_PORT=db` is the default.

**Files:**
- Create: `scripts/migrate/v4-artifacts.mjs`
- Test: `tests/migrate/v4-artifacts.test.mjs`

**Interfaces:**
- Produces: `migrateArtifacts({ tickets, links })` → `{ artifacts, documents, usages, links, report }`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/migrate/v4-artifacts.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { migrateArtifacts } from "../../scripts/migrate/v4-artifacts.mjs";

const T = [
  { id: "BLZ-10", type: "requirement",  ref: "REQ-001", title: "A", status: "implemented" },
  { id: "BLZ-11", type: "requirement",  ref: "REQ-003", title: "B", status: "proposed" },
  { id: "BLZ-12", type: "architecture", ref: "ADR-0002", title: "C", status: "accepted" },
  { id: "BLZ-13", type: "feature",      title: "not an artifact", status: "done" },
];

describe("v3 -> v4 artifact migration", () => {
  test("only requirement and architecture tickets become artifacts", () => {
    const out = migrateArtifacts({ tickets: T, links: [] });
    assert.equal(out.artifacts.length, 3);
    assert.ok(!out.artifacts.some((a) => a.ref === undefined));
  });

  test("EVERY ref is carried across unchanged — a changed ref breaks every citation", () => {
    const out = migrateArtifacts({ tickets: T, links: [] });
    assert.deepEqual(out.artifacts.map((a) => a.ref).sort(), ["ADR-0002", "REQ-001", "REQ-003"]);
  });

  test("the REQ-002 gap is preserved, not closed", () => {
    const out = migrateArtifacts({ tickets: T, links: [] });
    assert.ok(!out.artifacts.some((a) => a.ref === "REQ-002"),
      "migration must not renumber to close a gap");
  });

  test("each project gets one default document, ordered by ref", () => {
    const out = migrateArtifacts({ tickets: T, links: [] });
    const reqDoc = out.documents.find((d) => d.kind === "requirements");
    const ords = out.usages.filter((u) => u.document_id === reqDoc.id)
                           .sort((a, b) => a.ord - b.ord);
    assert.deepEqual(ords.map((u) => u.artifact_ref), ["REQ-001", "REQ-003"]);
  });

  test("a ticket of an artifact type with NO ref is reported, never silently dropped", () => {
    const out = migrateArtifacts({
      tickets: [...T, { id: "BLZ-99", type: "requirement", title: "no ref", status: "proposed" }],
      links: [] });
    assert.equal(out.report.missingRef.length, 1);
    assert.equal(out.report.missingRef[0], "BLZ-99");
  });

  test("the report counts everything, so nothing is lost silently", () => {
    const out = migrateArtifacts({ tickets: T, links: [] });
    assert.equal(out.report.artifacts, 3);
    assert.equal(out.report.skippedNonArtifact, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/migrate/v4-artifacts.mjs — v3 requirement/architecture tickets become v4
// artifacts, carrying their refs unchanged.
//
// A ref appears in commit messages, code comments and audit submissions. Changing one
// during migration silently redirects every existing citation, so refs are carried
// verbatim and gaps are preserved.
const ARTIFACT_TYPES = { requirement: "requirement", architecture: "architecture" };

export function migrateArtifacts({ tickets = [], links = [] }) {
  const artifacts = [], usages = [], documents = [];
  const report = { artifacts: 0, skippedNonArtifact: 0, missingRef: [] };
  const byProject = new Map();

  for (const t of tickets) {
    const kind = ARTIFACT_TYPES[t.type];
    if (!kind) { report.skippedNonArtifact++; continue; }
    if (!t.ref) { report.missingRef.push(t.id); continue; }
    const project = t.project ?? String(t.id).split("-")[0];
    artifacts.push({ id: t.id, project_key: project, kind, ref: t.ref,
                     title: t.title, status: t.status });
    if (!byProject.has(project)) byProject.set(project, { requirement: [], architecture: [] });
    byProject.get(project)[kind].push(t.ref);
    report.artifacts++;
  }

  for (const [project, kinds] of byProject) {
    for (const [kind, refs] of Object.entries(kinds)) {
      if (!refs.length) continue;
      const docKind = kind === "requirement" ? "requirements" : "architecture";
      const docId = `${project}-${docKind}`;
      documents.push({ id: docId, project_key: project, kind: docKind,
                       title: `${project} ${docKind}` });
      refs.sort().forEach((ref, i) => usages.push(
        { document_id: docId, artifact_ref: ref, ord: i + 1, depth: 0 }));
    }
  }
  return { artifacts, documents, usages, links, report };
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 6 tests

- [ ] **Step 5: Run the zero-diff oracle against the real corpus**

The method that found six data-loss defects in already-merged v3 code. Do not skip it.

```bash
export PATH=/home/rnamwoh/.local/node24/bin:$PATH
cd /home/rnamwoh/Documents/Code/blaze-pm
python3 scripts/build_matrices.py --check          # capture the CURRENT derived matrices
node ../blaze/scripts/migrate/v4-artifacts.mjs --emit-matrix > /tmp/v4-matrix.md
diff <(cat docs/matrices/requirements.md) /tmp/v4-matrix.md
```

Expected: **zero diff.** Any difference is either a migration defect or a real
discrepancy the v3 matrix was hiding — investigate before proceeding, and record which
it was.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate/v4-artifacts.mjs tests/migrate/v4-artifacts.test.mjs
git commit -m "feat(v4): migrate v3 requirement and architecture tickets to artifacts

Refs are carried verbatim and gaps preserved, because a ref appears in commit messages
and audit submissions and renumbering would silently redirect every citation. Tickets
of an artifact type with no ref are reported rather than dropped. Verified by zero-diff
against the existing derived matrices — the method that caught six data-loss defects in
merged v3 code."
```

---

## Self-Review

**Spec coverage.** §2 document model → Task 3. §3.1 artifact + ref → Tasks 1, 2. §3.2 → Task 3. §3.3 hierarchies → Task 8. §3.4 custom fields → Task 6. §3.5 links → Tasks 4, 5. §3.6 baselines → Task 12. §3.7 revisions → Task 7. §4.1 write-time blocks → Task 5 (links); **§4.1's RQ-4a banned-construction lint has NO task — see gap below.** §4.2 gates → Task 10. §4.4 coverage rules → Task 9. §4.5 API enforcement → Task 13. §5 matrix → Task 11. §6 migration → Task 14.

**Gap found and closed:** RQ-4a/RQ-4b (the tiered wording lint from ADR-0017) had no task. It is added as **Task 15** below rather than folded into an existing task, because it has an independent test cycle and a reviewer could reject it while approving everything else.

**Type consistency:** `checkLink`, `checkGate`, `promotionPlan`, `evaluateCoverage`, `rollup`, `staleLinks`, `buildMatrix`, `migrateArtifacts` — each defined once and consumed with the same signature. All return `{ ok, error }` or a plain value; none are async, so a synchronous driver can call them.

---

### Task 15: The tiered wording lint (RQ-4a / RQ-4b)

**Files:**
- Create: `scripts/model/wording-lint.mjs`
- Test: `tests/model/wording-lint.test.mjs`

**Interfaces:**
- Produces: `lintStatement(text, { blockList, warnList })` → `{ blocked: [...], warnings: [...] }`; `BLOCK_TIER`; `WARN_TIER`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/model/wording-lint.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lintStatement, BLOCK_TIER, WARN_TIER } from "../../scripts/model/wording-lint.mjs";

describe("ISO 29148 §5.2.7 banned constructions, in two tiers", () => {
  test("an untestable construction is BLOCKED", () => {
    const r = lintStatement("The system shall be user friendly.");
    assert.equal(r.blocked.length, 1);
    assert.match(r.blocked[0].phrase, /user friendly/);
  });

  test("the finding explains WHY, not just that it matched", () => {
    const r = lintStatement("The system shall respond as fast as possible.");
    assert.ok(r.blocked[0].why.length > 10, "a bare match is not actionable");
  });

  test("THE DECISIVE CASE: 'never' only WARNS, because this is a real requirement", () => {
    // "the system shall never store plaintext passwords" is genuine, testable and
    // correct. Blocking it would be absurd, which is why the warn tier exists.
    const r = lintStatement("The system shall never store plaintext passwords.");
    assert.equal(r.blocked.length, 0, "must not block a correct requirement");
    assert.equal(r.warnings.length, 1);
  });

  test("a clean quantified requirement produces nothing", () => {
    const r = lintStatement("The system shall respond within 200ms at 500 concurrent users.");
    assert.deepEqual(r.blocked, []);
    assert.deepEqual(r.warnings, []);
  });

  test("matching is case-insensitive and word-bounded, so 'fastener' is not 'fast'", () => {
    assert.equal(lintStatement("The fastener shall be steel.").blocked.length, 0);
    assert.equal(lintStatement("The system shall be FAST.").blocked.length, 1);
  });

  test("the lists are OVERRIDABLE per project — a client's contract language is not ours to overrule", () => {
    const r = lintStatement("The system shall be user friendly.", { blockList: [] });
    assert.deepEqual(r.blocked, []);
  });

  test("the two tiers are disjoint — no phrase both blocks and warns", () => {
    const overlap = BLOCK_TIER.filter((b) => WARN_TIER.some((w) => w.phrase === b.phrase));
    assert.deepEqual(overlap, []);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** → module not found

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/model/wording-lint.mjs — ISO/IEC/IEEE 29148 §5.2.7, enforced in two tiers
// (ADR-0017).
//
// Fires at creation, which is the ~93% moment. engineering-method.md measured that
// obligations met at creation land ~93% while return-visit obligations land 15% and 0%.
//
// TWO TIERS, and the split is load-bearing: "the system shall never store plaintext
// passwords" is a genuine, testable, correct requirement. A flat list that blocked
// "never" would refuse it, so "never" can only warn.
export const BLOCK_TIER = [
  { phrase: "user friendly",  why: "unmeasurable — state the task and the time budget" },
  { phrase: "user-friendly",  why: "unmeasurable — state the task and the time budget" },
  { phrase: "easy to use",    why: "unmeasurable — state the task and the time budget" },
  { phrase: "intuitive",      why: "unmeasurable" },
  { phrase: "fast",           why: "superlative without a number — give a latency budget" },
  { phrase: "quick",          why: "superlative without a number — give a latency budget" },
  { phrase: "as appropriate", why: "permits any behaviour, so nothing can fail" },
  { phrase: "as required",    why: "permits any behaviour, so nothing can fail" },
  { phrase: "if possible",    why: "doing nothing satisfies it" },
  { phrase: "where possible", why: "doing nothing satisfies it" },
  { phrase: "including but not limited to", why: "open-ended list — nothing is testable" },
  { phrase: "etc",            why: "open-ended list — name the members" },
  { phrase: "and/or",         why: "two different systems both satisfy it — pick one" },
  { phrase: "provide support for", why: "partial support passes — state the behaviour" },
  { phrase: "sufficient",     why: "unmeasurable" },
  { phrase: "adequate",       why: "unmeasurable" },
  { phrase: "reasonable",     why: "unmeasurable" },
  { phrase: "robust",         why: "unmeasurable" },
  { phrase: "seamless",       why: "unmeasurable" },
  { phrase: "state of the art", why: "unmeasurable and time-dependent" },
];

export const WARN_TIER = [
  { phrase: "all",    why: "often unverifiable — can every case actually be tested?" },
  { phrase: "always", why: "often unverifiable" },
  { phrase: "never",  why: "often unverifiable — though sometimes exactly right" },
  { phrase: "every",  why: "often unverifiable" },
  { phrase: "should", why: "29148 reserves 'shall' for requirements; 'should' is a goal" },
];

const rx = (p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

export function lintStatement(text, { blockList = BLOCK_TIER, warnList = WARN_TIER } = {}) {
  const s = String(text ?? "");
  return {
    blocked:  blockList.filter((e) => rx(e.phrase).test(s)).map((e) => ({ ...e })),
    warnings: warnList.filter((e) => rx(e.phrase).test(s)).map((e) => ({ ...e })),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass** → PASS, 7 tests

- [ ] **Step 5: Prove the tier split discriminates**

Move the `never` entry from `WARN_TIER` into `BLOCK_TIER`. Re-run — the plaintext-passwords test must fail. Revert. **This is the test that keeps the product from refusing a correct requirement.**

- [ ] **Step 6: Commit**

```bash
git add scripts/model/wording-lint.mjs tests/model/wording-lint.test.mjs
git commit -m "feat(v4): tiered ISO 29148 wording lint

Block tier for constructions untestable in every context, warn tier for ones that are
usually but not always wrong. The split is load-bearing: 'the system shall never store
plaintext passwords' is a genuine correct requirement, so 'never' can only warn. Both
lists are project-overridable, because a client's contract language is not ours to
overrule."
```
