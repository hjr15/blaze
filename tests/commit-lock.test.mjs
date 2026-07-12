import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockPath, acquireLock, releaseLock } from "../scripts/commit-lock.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "blaze-lock-")); }
const FAST = { retries: 2, delayMs: 10 };

test("acquire → release round-trip", () => {
  const root = tmp();
  assert.deepEqual(acquireLock(root, FAST), { ok: true });
  assert.ok(existsSync(join(lockPath(root), "owner.json")));
  releaseLock(root);
  assert.ok(!existsSync(lockPath(root)));
  rmSync(root, { recursive: true, force: true });
});

test("held by a live owner → bounded retry then ok:false with owner info", () => {
  const root = tmp();
  assert.equal(acquireLock(root, { ...FAST, session: "holder" }).ok, true);
  const r = acquireLock(root, FAST); // same live pid holds it
  assert.equal(r.ok, false);
  assert.equal(r.owner.session, "holder");
  assert.equal(r.owner.pid, process.pid);
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("stale: dead-pid owner is stolen", () => {
  const root = tmp();
  mkdirSync(lockPath(root), { recursive: true });
  writeFileSync(join(lockPath(root), "owner.json"), JSON.stringify({ pid: 999999999, session: "ghost", ts: new Date().toISOString() }));
  assert.equal(acquireLock(root, FAST).ok, true);
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("stale: aged-out live owner is stolen", () => {
  const root = tmp();
  const old = new Date(Date.now() - 120_000).toISOString();
  mkdirSync(lockPath(root), { recursive: true });
  writeFileSync(join(lockPath(root), "owner.json"), JSON.stringify({ pid: process.pid, session: "slow", ts: old }));
  assert.equal(acquireLock(root, { ...FAST, staleMs: 60_000 }).ok, true);
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});

test("ownerless lock dir: fresh is respected, old is stolen", () => {
  const root = tmp();
  mkdirSync(lockPath(root), { recursive: true }); // no owner.json — acquirer mid-write
  assert.equal(acquireLock(root, FAST).ok, false); // fresh: treated as held
  const past = (Date.now() - 10_000) / 1000;
  utimesSync(lockPath(root), past, past);
  assert.equal(acquireLock(root, FAST).ok, true); // old ownerless: stolen
  releaseLock(root);
  rmSync(root, { recursive: true, force: true });
});
