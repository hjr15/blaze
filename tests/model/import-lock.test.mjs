// tests/model/import-lock.test.mjs — BLZ-640: the import-scoped lock.
//
// Design §7 states one-import-at-a-time as an OPERATOR CONSTRAINT and §8 item
// 8 records why nothing enforced it: `acquireLock` is taken inside `commitFile`
// AFTER every write has landed, and not taken at all on a `commitMode:
// "batch"` board. It serialises the COMMIT, not the write phase.
//
// This suite pins the lock itself. The concurrency PROPERTY it exists for —
// two `--apply` runs over one file, one exiting 5 with nothing written and the
// board holding each source key exactly once — is
// tests/import-lock-contention.test.mjs, because that one needs a board.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMPORT_LOCK_NAME, importLockPath, acquireImportLock, releaseImportLock, withImportLock,
} from "../../scripts/model/import-lock.mjs";
import { RECEIPT_DIR } from "../../scripts/model/import-apply.mjs";

function tmp(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-import-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("the lock is a directory under import-receipts/, named by §8 item 8", (t) => {
  const root = tmp(t);
  assert.equal(importLockPath(root), join(root, RECEIPT_DIR, IMPORT_LOCK_NAME));
  assert.equal(IMPORT_LOCK_NAME, "import.lock");
});

test("acquire → release round-trip, and the owner.json carries {pid, session, ts}", (t) => {
  const root = tmp(t);
  assert.deepEqual(acquireImportLock(root, { session: "s1" }), { ok: true });
  const owner = JSON.parse(readFileSync(join(importLockPath(root), "owner.json"), "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.session, "s1");
  assert.match(owner.ts, /^\d{4}-\d{2}-\d{2}T/);
  releaseImportLock(root);
  assert.equal(existsSync(importLockPath(root)), false);
});

test("acquiring creates import-receipts/ if it does not exist yet", (t) => {
  const root = tmp(t);
  assert.equal(existsSync(join(root, RECEIPT_DIR)), false);
  assert.equal(acquireImportLock(root).ok, true);
  assert.equal(existsSync(join(root, RECEIPT_DIR)), true);
  releaseImportLock(root);
});

test("a lock held by a LIVE owner is contended immediately — no retry, no wait", (t) => {
  const root = tmp(t);
  assert.equal(acquireImportLock(root, { session: "holder" }).ok, true);
  const t0 = Date.now();
  const r = acquireImportLock(root);
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, false);
  assert.equal(r.owner.session, "holder");
  assert.equal(r.owner.pid, process.pid);
  // `commit-lock.mjs` retries ten times at 200 ms because a commit is short.
  // An import is not: a second run waiting out a 2,850-ticket apply would look
  // hung. A contended import lock is exit 5 AT ONCE (§8 item 8).
  assert.ok(elapsed < 150, `contention must not sleep through a retry budget (took ${elapsed}ms)`);
  releaseImportLock(root);
});

test("a lock whose owner PID is dead is stolen — the same staleness rule commit-lock.mjs uses", (t) => {
  const root = tmp(t);
  mkdirSync(importLockPath(root), { recursive: true });
  writeFileSync(join(importLockPath(root), "owner.json"),
    JSON.stringify({ pid: 999999999, session: "ghost", ts: new Date().toISOString() }));
  assert.equal(acquireImportLock(root).ok, true,
    "a dead owner's lock would otherwise wedge every later import forever");
  releaseImportLock(root);
});

test("a LIVE owner is never stolen from on age alone, however long the import runs", (t) => {
  const root = tmp(t);
  // Deliberately DIFFERENT from `commit-lock.mjs`'s 60 s age-out, and the
  // difference is the point: a commit takes milliseconds, so an hour-old
  // commit lock is a bug. A 2,850-ticket import legitimately outlives any
  // fixed window, and stealing from a live importer is the exact race this
  // ticket exists to close.
  const old = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  mkdirSync(importLockPath(root), { recursive: true });
  writeFileSync(join(importLockPath(root), "owner.json"),
    JSON.stringify({ pid: process.pid, session: "slow-import", ts: old }));
  const r = acquireImportLock(root);
  assert.equal(r.ok, false, "a six-hour-old lock held by a LIVE pid is still held");
  assert.equal(r.owner.session, "slow-import");
  releaseImportLock(root);
});

test("an ownerless lock directory is respected briefly and then stolen", (t) => {
  const root = tmp(t);
  mkdirSync(importLockPath(root), { recursive: true });
  const fresh = acquireImportLock(root);
  assert.equal(fresh.ok, false, "an acquirer between mkdir and write is respected");
  assert.equal(fresh.owner, null);
  // Backdated past the grace window, the dir is clearly abandoned and stolen —
  // the same arm `tests/commit-lock.test.mjs` pins for the commit lock.
  const old = Date.now() / 1000 - 60;
  utimesSync(importLockPath(root), old, old);
  assert.equal(acquireImportLock(root).ok, true);
  releaseImportLock(root);
});

test("withImportLock releases on success and on a throw", async (t) => {
  const root = tmp(t);
  const ok = await withImportLock(root, () => ({ exitCode: 0, report: "done" }));
  assert.deepEqual(ok, { exitCode: 0, report: "done" });
  assert.equal(existsSync(importLockPath(root)), false, "released on the success path");

  await assert.rejects(
    () => withImportLock(root, () => { throw new Error("boom"); }),
    /boom/);
  assert.equal(existsSync(importLockPath(root)), false,
    "released in a `finally` — a throw that left the lock held would wedge every later import");
});

test("withImportLock holds the lock FOR THE DURATION of the callback", async (t) => {
  const root = tmp(t);
  let seen = null;
  await withImportLock(root, async () => {
    seen = acquireImportLock(root);
    return { exitCode: 0, report: "" };
  });
  assert.equal(seen.ok, false, "a second acquirer inside the callback must be refused");
});

test("a contended withImportLock is exit 5 and the callback never runs", async (t) => {
  const root = tmp(t);
  assert.equal(acquireImportLock(root, { session: "first" }).ok, true);
  let ran = false;
  const r = await withImportLock(root, () => { ran = true; return { exitCode: 0, report: "" }; });
  assert.equal(ran, false, "nothing may run past a contended lock — not even the prune");
  assert.equal(r.exitCode, 5,
    "§8 item 8: a contended lock is exit 5 — `the run's own records are not in a state it may "
    + "start from`, which is that code's definition");
  assert.equal(r.contended, true);
  assert.match(r.report, /another import holds/);
  assert.match(r.report, /import\.lock/);
  assert.match(r.report, /pid \d+/, "the report names the owner so an operator can check it");
  assert.match(r.report, /nothing was written/i);
  releaseImportLock(root);
});

test("releaseImportLock on a lock that is not held is not an error", (t) => {
  const root = tmp(t);
  releaseImportLock(root);
  assert.equal(existsSync(importLockPath(root)), false);
});
