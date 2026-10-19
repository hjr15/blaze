// scripts/dir-lock.mjs — an advisory lock over a caller-supplied DIRECTORY: an atomically
// mkdir'ed directory holding owner.json {pid, session, ts}, bounded retry, and theft of a lock
// whose owner is dead, aged out, or long ownerless. Zero-dependency. (BLZ-640)
//
// BLZ-254 (spec §5.5): this was scripts/commit-lock.mjs, which also bound the mechanism to the
// board's commit lock (`acquireLock`/`releaseLock` over `.blaze/commit.lock/`). The board no
// longer commits, so that policy is deleted. The mechanism stays because
// `scripts/model/import-lock.mjs` (out of BLZ-254's scope, guarding `blaze import --apply` in
// every mode) is built on it, and design §8 item 8 forbids a second copy of the staleness logic.
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
// BLZ-512 / ADR-0031. THE ELEVENTH SITE, and BLZ-493's inventory did not have it at all.
// Reproduced at `44b797f`: a FIFO `owner.json` in a contended lock directory makes
// `acquireDirLock` never return — `EXIT=137` under a 6s cap — so the write behind the
// lock stops with nothing on stderr. That is worse than any wrong answer: nothing reports at all.
import { readRegularFileSync, NotARegularFileError } from "./model/regular-file.mjs";

/** REFUSE, never launder. `null` from here is read one line below as *"an acquirer between
 *  mkdir and write"* — a sentence about ANOTHER PROCESS — and after `OWNERLESS_GRACE_MS`
 *  that sentence STEALS the lock and lets two writers into the board's git tree at once.
 *  A run that could not read `owner.json` has no business saying it. ENOENT, a truncated
 *  write and a malformed body keep the old `null`: those ARE the ownerless state, and Blaze
 *  looked to find them out. */
function readOwner(dir) {
  try {
    return JSON.parse(readRegularFileSync(join(dir, "owner.json"), "utf8"));
  } catch (e) {
    if (e instanceof NotARegularFileError) throw e;
    return null;
  }
}

function ownerAlive(owner) {
  if (!owner || typeof owner.pid !== "number") return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch {
    // Any kill() error (ESRCH, but also e.g. EPERM for a pid owned by another
    // user) is treated as dead — fine for this engine's single-user-host scope.
    return false;
  }
}

// Sync sleep without spinning: Atomics.wait on a throwaway buffer.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// An EEXIST lock with no owner.json is an acquirer between mkdir and write —
// respect it briefly; steal only once the dir itself is clearly abandoned.
const OWNERLESS_GRACE_MS = 2_000;

/**
 * The mechanism, over an arbitrary lock DIRECTORY: atomic `mkdirSync` plus an
 * `owner.json` of `{pid, session, ts}`, bounded retry, and theft of a lock
 * whose owner PID is dead, whose `ts` has aged past `staleMs`, or which has
 * been ownerless past the grace window.
 *
 * `staleMs: Infinity` disables the AGE-OUT arm only — a dead owner is still
 * stolen from, and so is a live owner whose `ts` will not parse (see the
 * `!(age <= staleMs)` note below). That is the policy an import needs: a
 * commit took milliseconds, so an hour-old commit lock (deleted by BLZ-254) was a bug, while a
 * 2,850-ticket import legitimately outlives any fixed window and stealing
 * from a live importer is the race BLZ-640 exists to close.
 */
export function acquireDirLock(dir, {
  session = null,
  pid = process.pid,
  retries = 10,
  delayMs = 200,
  staleMs = 60_000,
  ownerlessGraceMs = OWNERLESS_GRACE_MS,
  now = Date.now,
} = {}) {
  mkdirSync(dirname(dir), { recursive: true }); // ensure the parent exists
  // A STEAL IS NOT A RETRY, and the distinction only became visible once
  // BLZ-640 asked for `retries: 0` (a contended import lock is exit 5 at
  // once). Under the previous `attempt++`-per-iteration loop the `continue`
  // after `rmSync` consumed the one attempt a `retries: 0` caller has, so a
  // dead owner's lock could never be stolen at all and the arm that stops a
  // crashed importer wedging every later one was structurally unreachable.
  // Bounded independently, so a pathological "steal, lose the race, steal"
  // cycle cannot spin: three is more than any real contention needs.
  const MAX_STEALS = 3;
  let steals = 0;
  for (let attempt = 0; attempt <= retries;) {
    try {
      mkdirSync(dir); // atomic: throws EEXIST while held
      writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid, session, ts: new Date(now()).toISOString() }));
      return { ok: true };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = readOwner(dir);
      let stale;
      if (owner === null) {
        let dirAgeMs = 0;
        try { dirAgeMs = now() - statSync(dir).mtimeMs; } catch { /* vanished: retry */ }
        stale = dirAgeMs > ownerlessGraceMs;
      } else {
        const age = now() - Date.parse(owner.ts);
        // Written as `!(age <= staleMs)` rather than `age > staleMs`: a
        // corrupt/garbage owner.ts makes Date.parse (and so age) NaN, and
        // every comparison with NaN is false — `age > staleMs` would then
        // read as "not stale" and pin the lock forever. Negating `<=` makes
        // NaN age count as stale, so a garbage timestamp still ages out.
        stale = !ownerAlive(owner) || !(age <= staleMs);
      }
      if (stale && steals < MAX_STEALS) {
        steals++;
        process.stderr.write(`blaze: stealing stale ${basename(dir)} (owner pid ${owner?.pid ?? "unknown"})\n`);
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      attempt++;
      if (attempt <= retries) sleep(delayMs);
    }
  }
  return { ok: false, owner: readOwner(dir) };
}

export function releaseDirLock(dir) {
  rmSync(dir, { recursive: true, force: true });
}
