// tests/dir-lock.test.mjs — BLZ-640's lock mechanism, kept by BLZ-254 for model/import-lock.mjs. Was tests/commit-lock.test.mjs; the commit-lock POLICY it also wrapped is deleted (spec §5.5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDirLock, releaseDirLock } from "../scripts/dir-lock.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "blaze-lock-")); }
const FAST = { retries: 2, delayMs: 10 };

test("acquire → release round-trip", () => {
  const root = tmp();
  const dir = join(root, ".blaze", "x.lock");
  assert.deepEqual(acquireDirLock(dir, FAST), { ok: true });
  assert.ok(existsSync(join(dir, "owner.json")));
  releaseDirLock(dir);
  assert.ok(!existsSync(dir));
  rmSync(root, { recursive: true, force: true });
});

test("held by a live owner → bounded retry then ok:false with owner info", () => {
  const root = tmp();
  const dir = join(root, ".blaze", "x.lock");
  assert.equal(acquireDirLock(dir, { ...FAST, session: "holder" }).ok, true);
  const r = acquireDirLock(dir, FAST); // same live pid holds it
  assert.equal(r.ok, false);
  assert.equal(r.owner.session, "holder");
  assert.equal(r.owner.pid, process.pid);
  releaseDirLock(dir);
  rmSync(root, { recursive: true, force: true });
});

test("stale: dead-pid owner is stolen", () => {
  const root = tmp();
  const dir = join(root, ".blaze", "x.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: 999999999, session: "ghost", ts: new Date().toISOString() }));
  assert.equal(acquireDirLock(dir, FAST).ok, true);
  releaseDirLock(dir);
  rmSync(root, { recursive: true, force: true });
});

test("stale: aged-out live owner is stolen", () => {
  const root = tmp();
  const dir = join(root, ".blaze", "x.lock");
  const old = new Date(Date.now() - 120_000).toISOString();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, session: "slow", ts: old }));
  assert.equal(acquireDirLock(dir, { ...FAST, staleMs: 60_000 }).ok, true);
  releaseDirLock(dir);
  rmSync(root, { recursive: true, force: true });
});

test("stale: a live owner with a corrupt/garbage ts ages out (NaN age counts as stale)", () => {
  const root = tmp();
  const dir = join(root, ".blaze", "x.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, session: "x", ts: "garbage" }));
  assert.equal(acquireDirLock(dir, FAST).ok, true);
  releaseDirLock(dir);
  rmSync(root, { recursive: true, force: true });
});

test("ownerless lock dir: fresh is respected, old is stolen", () => {
  const root = tmp();
  const dir = join(root, ".blaze", "x.lock");
  mkdirSync(dir, { recursive: true }); // no owner.json — acquirer mid-write
  assert.equal(acquireDirLock(dir, FAST).ok, false); // fresh: treated as held
  const past = (Date.now() - 10_000) / 1000;
  utimesSync(dir, past, past);
  assert.equal(acquireDirLock(dir, FAST).ok, true); // old ownerless: stolen
  releaseDirLock(dir);
  rmSync(root, { recursive: true, force: true });
});
