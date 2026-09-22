// scripts/model/import-lock.mjs — the import-scoped lock. BLZ-640,
// implementing design §8 item 8 (docs/design/csv-import-and-export.md).
//
// WHAT THIS CLOSES. §7 states one-import-at-a-time as an OPERATOR CONSTRAINT
// and is explicit that nothing enforced it. The commit lock does not:
// `acquireLock` is taken inside `commitFile` (`serve-commit.mjs:9`) at `git
// add` time, AFTER every write has landed, and is not taken at all on a
// `commitMode: "batch"` board, where `commitOrQueue` returns from the ledger
// append before `commitFile` is ever called. It serialises the COMMIT, not the
// write phase. Two `--apply` runs started together under `--allocate-ids` and
// one `sourceIdColumn` mapping would each pass the exit-5 check — each sees the
// other's receipt as empty — each allocate a number for the same source key,
// and each append a pair; §4.2's first-occurrence lookup keeps one and the
// other is a ticket nothing reads. A duplicate, by the exact mechanism §4.2
// exists to prevent.
//
// THE SAME MECHANISM, NOT A SECOND ONE. §8 item 8 requires "one
// atomically-`mkdirSync`'ed lock directory (matching `scripts/commit-lock.mjs`,
// not a `wx` file)", and that is what this is: `acquireDirLock` IS
// `commit-lock.mjs`'s primitive — the atomic `mkdirSync`, the `owner.json` of
// `{pid, session, ts}`, and theft of a lock whose owner PID fails
// `process.kill(pid, 0)`. Nothing about the staleness or theft logic is
// reimplemented here; only the directory and the POLICY differ, and both
// differences are stated below.
//
// WHERE IT IS TAKEN. Before the PRE-WRITE PHASE — before the prune and before
// the exit-5 receipt check, "since those are what a second run must not race
// past" (§8 item 8) — and held until staging returns. The seam is
// `scripts/import-runner.mjs`, which wraps `runImport`/`runMappedImport`/
// `runRepair` in `withImportLock`: those three verbs own the pre-write phase,
// so a lock taken around the CALL is a lock taken before it.
//
// ONLY UNDER `--apply`. A dry run writes nothing, reads no records it could
// race on and is a legitimate thing to run against a board mid-import, so it
// takes no lock. The lock guards the WRITE phase, which is the only phase a
// dry run does not have.
import { join } from "node:path";
import { acquireDirLock, releaseDirLock } from "../commit-lock.mjs";
import { RECEIPT_DIR } from "./import-apply.mjs";

/** §8 item 8: "a lock directory under `import-receipts/`". Beside the receipts
 *  and deliberately not under `.blaze/`, for the same reason the receipts are
 *  not: that directory holds regenerable caches `reindex.mjs` calls safe to
 *  delete, and a live exclusion is not a cache. `pruneReceipts` skips it —
 *  it prunes only `*.jsonl` — and staging never names it. */
export const IMPORT_LOCK_NAME = "import.lock";

export function importLockPath(dataRoot) {
  return join(dataRoot, RECEIPT_DIR, IMPORT_LOCK_NAME);
}

/**
 * The POLICY, and both departures from the commit lock's are deliberate.
 *
 *   `retries: 0`   — a contended import lock is exit 5 AT ONCE. The commit
 *                    lock retries ten times at 200 ms because a commit takes
 *                    milliseconds; an import of the live corpus does not, and
 *                    a second run silently sleeping out a 2,850-ticket apply
 *                    would look hung rather than refused. §8 item 8 says "a
 *                    contended lock is exit 5", not "a contended lock waits".
 *   `staleMs: Infinity`
 *                  — never stolen from a LIVE owner on age. The commit lock's
 *                    60 s age-out is right for a commit and catastrophic here:
 *                    it would hand a second importer the lock in the middle of
 *                    a long apply, which is the very race being closed. The
 *                    DEAD-owner arm is untouched — `process.kill(pid, 0)`
 *                    failing still steals, which is what stops a crashed
 *                    import from wedging every later one — and so is the
 *                    unparseable-`ts` arm inherited from `!(age <= staleMs)`:
 *                    an `owner.json` this code wrote always carries a valid
 *                    ISO stamp, so a garbage one is corruption, and a corrupt
 *                    record that pinned the lock forever is worse.
 */
export function acquireImportLock(dataRoot, opts = {}) {
  return acquireDirLock(importLockPath(dataRoot), { retries: 0, staleMs: Infinity, ...opts });
}

export function releaseImportLock(dataRoot) {
  releaseDirLock(importLockPath(dataRoot));
}

/** The exit-5 refusal a contended lock produces. Written here rather than in
 *  the runner so the three verbs cannot each word it differently. */
function contendedReport(dataRoot, owner) {
  const who = owner
    ? `owner pid ${owner.pid}${owner.session ? `, session ${owner.session}` : ""}, held since ${owner.ts}`
    : "owner unknown — the lock directory exists but carries no readable owner.json";
  return `blaze import: another import holds ${importLockPath(dataRoot)} (${who}). One import at a `
    + `time (design §7): the lock is taken BEFORE the prune and the exit-5 check, because those `
    + `are what a second run must not race past — two runs that did would each allocate a number `
    + `for the same source key and leave a pair nothing reads (§8 item 8). Nothing was written and `
    + `nothing was attempted; re-run when the other import has finished.`;
}

/**
 * Run `fn` holding the import lock.
 *
 * @returns `fn`'s own result, or `{ exitCode: 5, report, contended: true }`
 *          when the lock is held. On contention `fn` NEVER RUNS — not the
 *          prune, not the exit-5 check, not a single write.
 *
 * Released in a `finally`, because a throw that left the lock held would wedge
 * every later import until the process died and the dead-PID arm stole it.
 */
export async function withImportLock(dataRoot, fn, opts = {}) {
  const got = acquireImportLock(dataRoot, opts);
  if (!got.ok) {
    return { exitCode: 5, report: contendedReport(dataRoot, got.owner), contended: true };
  }
  try {
    return await fn();
  } finally {
    releaseImportLock(dataRoot);
  }
}
