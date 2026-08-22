// scripts/model/ref-claim.mjs — claimRef, the allocation path over the ref_claim
// ledger (BLZ-326, ref-claim-schema.mjs).
//
// `nextRef` (ref-allocator.mjs) stays pure arithmetic and untouched: give it a list of
// already-claimed refs and it returns the next one. What changes here is WHERE that
// list comes from. The defect this closes: reading it from live artifacts makes a
// withdrawn/rejected/deleted artifact invisible and its ref gets reissued. Reading it
// from the claim ledger instead means a ref, once claimed, can never come back around
// — the ledger has no delete path (ref-claim-schema.mjs's append-only triggers).
//
// `exec` is the same {run, all} shape write-port.mjs and the storage drivers use
// (ADR-0010): synchronous against node:sqlite, asynchronous against `pg`, `await` on a
// plain value being a no-op is what lets one code path serve both engines.
import { nextRef, parseRef, REF_PATTERNS } from "./ref-allocator.mjs";

function isUniqueViolation(e) {
  // Postgres reports a real SQLSTATE (23505); node:sqlite throws a plain Error whose
  // message names the constraint. Neither driver is asked to agree on more than that.
  return e?.code === "23505" || /unique|constraint|duplicate/i.test(String(e?.message ?? e));
}

/**
 * Every ref this project has ever claimed for `kind` — the LEDGER, never filtered by
 * whether the artifact it names is still alive. This is the one call site nextRef's
 * `existing` is allowed to come from; anything that instead scans the artifact table
 * reintroduces the reuse bug this module exists to close.
 */
export async function claimedRefs(exec, ph, { project_key, kind }) {
  const rows = await exec.all(
    `SELECT ref FROM ref_claim WHERE project_key = ${ph(0)} AND kind = ${ph(1)}`,
    [project_key, kind]);
  return (rows ?? []).map((r) => r.ref);
}

/**
 * Claim the next ref for (project_key, kind) and return it.
 *
 * Two callers can both read the same ledger max before either has inserted — that is
 * the concurrent case, and it is not prevented, it is DETECTED: the table's
 * PRIMARY KEY (project_key, kind, num) makes the loser's INSERT fail rather than
 * silently double-issue a ref, and the loser retries against a freshly re-read ledger.
 * No lock, no advisory lock, no SELECT ... FOR UPDATE — the unique constraint IS the
 * concurrency primitive, exactly as ADR-0005's O_EXCL reservation is for ticket ids.
 */
export async function claimRef(exec, { dialect = "sqlite", project_key, kind, claimedAt, maxAttempts = 50 } = {}) {
  if (!REF_PATTERNS[kind]) throw new Error(`no ref scheme for kind ${JSON.stringify(kind)}`);
  if (!project_key) throw new Error("claimRef needs a project_key");
  if (dialect !== "sqlite" && dialect !== "postgres") {
    throw new Error(`unknown dialect ${JSON.stringify(dialect)} — expected 'sqlite' or 'postgres'`);
  }
  const pg = dialect === "postgres";
  const ph = (i) => (pg ? `$${i + 1}` : "?");
  const at = claimedAt ?? new Date().toISOString();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const existing = await claimedRefs(exec, ph, { project_key, kind });
    const ref = nextRef({ kind, existing });
    const { num } = parseRef(ref);
    try {
      await exec.run(
        `INSERT INTO ref_claim (project_key, kind, num, ref, claimed_at)
         VALUES (${ph(0)}, ${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})`,
        [project_key, kind, num, ref, at]);
      return ref;
    } catch (e) {
      // Lost the race for this num — someone else's claim landed between our read and
      // our insert. Retry against a freshly re-read ledger rather than incrementing
      // blindly, so a THIRD concurrent claimant is handled the same way.
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new Error(
    `claimRef: could not claim a ${kind} ref for project ${project_key} `
    + `after ${maxAttempts} attempts — contention this sustained means something else is wrong`);
}
