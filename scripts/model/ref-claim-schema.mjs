// scripts/model/ref-claim-schema.mjs — the append-only ref ledger (BLZ-326).
//
// `nextRef` (ref-allocator.mjs) is pure arithmetic: hand it every ref this project has
// ever claimed and it returns the next one. The v4 spine wired it to `state.artifacts`
// instead — the LIVE table — so a withdrawn, rejected or deleted artifact vanished from
// that view and its ref was silently reissued to a different requirement. A ref is a
// citation (commit messages, code comments, audit submissions); reusing one silently
// redirects every existing citation, and there is no recovery, because renumbering is
// itself reuse.
//
// This table is the fix, modelled directly on ADR-0005's ticket-id claim ledger
// (projects/<KEY>/.ids/<N> in blaze-pm): an append-only tombstone per allocation, never
// deleted, so a rejected requirement leaves a GAP rather than freeing its number.
// Ref allocation is simpler than ticket allocation — refs live in a database, not in
// git, so there is no filesystem reservation layer and no remote-heads scan. What must
// survive the port unchanged is the one property that matters: the allocator reads the
// LEDGER, never the live rows (see claimRef in ref-claim.mjs).
//
// Two defects already hit this plan's schema code and must not repeat here:
//  1. A nullable column inside a composite PRIMARY KEY is uninsertable under STRICT
//     SQLite and in Postgres. Every column of this table's PK — project_key, kind,
//     num — is NOT NULL by construction, nothing nullable is ever part of it.
//  2. `boolean NOT NULL DEFAULT 0` is rejected by Postgres (an untyped integer literal
//     does not implicitly cast to boolean). This table has no boolean column, so the
//     trap cannot recur here.
//
// Table-level constraints come after every column: SQLite STRICT requires it, Postgres
// tolerates it (artifact-schema.mjs).
import { REF_PATTERNS } from "./ref-allocator.mjs";
import { dialect } from "./sql-dialect.mjs";


export function refClaimDdl(name) {
  const d = dialect(name);
  const kinds = Object.keys(REF_PATTERNS).map((k) => `'${k}'`).join(", ");
  const pg = name === "postgres";

  // Append-only, enforced by the database rather than by convention — the same
  // guarantee ticket_event carries (sqlite-schema.mjs / pg-schema.mjs) applied to the
  // ref ledger: no write path, however well-intentioned, can delete or rewrite a claim.
  // SQLite trigger bodies are SQL-only (RAISE(ABORT, …)); Postgres needs a PL/pgSQL
  // function behind the trigger.
  const appendOnly = pg ? `
CREATE OR REPLACE FUNCTION ref_claim_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ref_claim is append-only: % is refused', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ref_claim_no_update ON ref_claim;
CREATE TRIGGER ref_claim_no_update BEFORE UPDATE ON ref_claim
  FOR EACH ROW EXECUTE FUNCTION ref_claim_append_only();
DROP TRIGGER IF EXISTS ref_claim_no_delete ON ref_claim;
CREATE TRIGGER ref_claim_no_delete BEFORE DELETE ON ref_claim
  FOR EACH ROW EXECUTE FUNCTION ref_claim_append_only();
` : `
CREATE TRIGGER IF NOT EXISTS ref_claim_no_update
  BEFORE UPDATE ON ref_claim
BEGIN
  SELECT RAISE(ABORT, 'ref_claim is append-only: UPDATE is refused');
END;

CREATE TRIGGER IF NOT EXISTS ref_claim_no_delete
  BEFORE DELETE ON ref_claim
BEGIN
  SELECT RAISE(ABORT, 'ref_claim is append-only: DELETE is refused');
END;
`;

  return `
CREATE TABLE IF NOT EXISTS ref_claim (
  project_key ${d.txt} NOT NULL,
  kind        ${d.txt} NOT NULL,
  num         ${d.int} NOT NULL CHECK (num > 0),
  ref         ${d.txt} NOT NULL,
  claimed_at  ${d.ts} NOT NULL,
  -- The PK is what makes concurrent allocation safe: two callers racing to claim the
  -- same (project_key, kind, num) triple collide here, not silently both succeed.
  PRIMARY KEY (project_key, kind, num),
  -- A second, independent uniqueness guarantee on the citation string itself — belt
  -- and braces against a future caller that inserts a claim without going through
  -- nextRef's arithmetic.
  UNIQUE (project_key, ref),
  CHECK (kind IN (${kinds}))
)${d.tbl};

CREATE INDEX IF NOT EXISTS ref_claim_project_kind_idx ON ref_claim (project_key, kind, num);
${appendOnly}`;
}
