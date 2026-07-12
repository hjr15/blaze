// scripts/commit-lock.mjs — advisory lock serializing board git writes.
// Plain-file: an atomically-mkdir'ed .blaze/commit.lock/ directory holding
// owner.json {pid, session, ts}. Bounded retry; stale locks (dead owner PID,
// aged out, or long-ownerless) are stolen with a warning. Zero-dependency.
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export function lockPath(root) {
  return join(root, ".blaze", "commit.lock");
}

function readOwner(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
  } catch {
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

export function acquireLock(root, {
  session = null,
  pid = process.pid,
  retries = 10,
  delayMs = 200,
  staleMs = 60_000,
  now = Date.now,
} = {}) {
  const dir = lockPath(root);
  mkdirSync(dirname(dir), { recursive: true }); // ensure .blaze/ exists
  for (let attempt = 0; attempt <= retries; attempt++) {
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
        stale = dirAgeMs > OWNERLESS_GRACE_MS;
      } else {
        const age = now() - Date.parse(owner.ts);
        // Written as `!(age <= staleMs)` rather than `age > staleMs`: a
        // corrupt/garbage owner.ts makes Date.parse (and so age) NaN, and
        // every comparison with NaN is false — `age > staleMs` would then
        // read as "not stale" and pin the lock forever. Negating `<=` makes
        // NaN age count as stale, so a garbage timestamp still ages out.
        stale = !ownerAlive(owner) || !(age <= staleMs);
      }
      if (stale) {
        process.stderr.write(`blaze: stealing stale commit.lock (owner pid ${owner?.pid ?? "unknown"})\n`);
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (attempt < retries) sleep(delayMs);
    }
  }
  return { ok: false, owner: readOwner(lockPath(root)) };
}

export function releaseLock(root) {
  rmSync(lockPath(root), { recursive: true, force: true });
}
