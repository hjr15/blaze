// tests/storage-read-fd-guard.test.mjs — BLZ-510.
//
// `fsStorage.read` opened a path without asking what kind of file it was, so a FIFO blocked
// it forever. ADR-0031's own consequences named it as the one constructible hang left in
// `scripts/model/` after BLZ-493 — "1 of 16 is at HEAD" — and raised it as this ticket.
//
// WHAT THIS TEST DOES NOT CLAIM, stated first because the honest version of this file is
// smaller than the dishonest one.
//
//   NO CURRENT CALL PATH REACHES `fsStorage.read` WITH A NON-REGULAR FILE. Its callers take
//   the file from a walk that already refuses one (ADR-0031 site 1), so the guard added here
//   protects nothing reachable today. A mutation-revert cannot prove otherwise: reverting it
//   reddens THIS test and nothing else in the suite, because this test is the only caller
//   that can construct the input. That is not the guard being load-bearing — it is a test
//   and a line of production code pinning each other, and saying so is the point.
//
//   So the case below calls the function DIRECTLY. It does not go through a verb, a runner
//   or the storage driver's own callers, because no such route exists to go through, and
//   dressing one up would be a claim about reachability that is false.
//
// WHY THE GUARD IS ADDED ANYWAY. `fsStorage` is the driver interface — the place a second
// caller arrives at, and the place a future non-fs driver's contract is read off. Leaving
// the one constructible hang in `scripts/model/` sitting behind an interface, with ADR-0031
// naming it in print, is a worse trade than one line that can never fire today.
//
// IT STILL RUNS OUT OF PROCESS, under a hard wall-clock limit. `node:test`'s `timeout` is an
// EVENT-LOOP timer and a blocking synchronous open never yields to it, so an in-process case
// for this shape does not fail — it wedges the whole file. A killed child IS the hang.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

const STORAGE = JSON.stringify(join(import.meta.dirname, "..", "scripts", "model", "storage.mjs"));
const fifo = (p) => execFileSync("mkfifo", [p]);

function child(dir, source, ms = 15000) {
  const script = join(dir, "probe.mjs");
  writeFileSync(script, source);
  const res = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: ms, cwd: dir });
  assert.equal(res.signal, null,
    `the child had to be KILLED after ${ms}ms — THAT IS THE HANG, not a failed assertion. `
    + `A synchronous read opened a FIFO and blocked forever.\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  return res;
}

describe("BLZ-510: fsStorage.read refuses a non-regular file — a guard NOTHING reaches today", () => {
  test("called DIRECTLY (no product call path exists), a FIFO is refused rather than blocking", () => {
    const dir = mkdtempSync(join(tmpdir(), "blz510-"));
    try {
      const p = join(dir, "t.md");
      fifo(p);
      const res = child(dir, `
        import { fsStorage } from ${STORAGE};
        try { console.log("RETURNED", JSON.stringify(fsStorage.read(${JSON.stringify(p)}))); }
        catch (e) { console.log("REFUSED", e.code, e.message); }
      `);
      assert.match(res.stdout, /REFUSED/,
        `the read must refuse rather than block. Got: ${res.stdout}`);
      assert.match(res.stdout, /ERR_BLAZE_NOT_A_REGULAR_FILE/,
        "named, so a caller can tell it from ENOENT without matching on a message");
      assert.ok(res.stdout.includes(p), `and it must NAME the path. Got: ${res.stdout}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a regular file still reads exactly as before — the guard changes nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "blz510-ok-"));
    try {
      const p = join(dir, "t.md");
      writeFileSync(p, "hello\nthere\n");
      const res = child(dir, `
        import { fsStorage } from ${STORAGE};
        console.log(JSON.stringify(fsStorage.read(${JSON.stringify(p)})));
      `);
      assert.equal(JSON.parse(res.stdout.trim()), "hello\nthere\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("ENOENT propagates unchanged — 'there is no file' is still a different fact", () => {
    // ADR-0031: "ENOENT IS DELIBERATELY UNTOUCHED." `fsStorage.exists` is a separate
    // question and callers ask it; folding a missing file into the refusal would change a
    // contract this ticket has no business changing.
    const dir = mkdtempSync(join(tmpdir(), "blz510-enoent-"));
    try {
      const res = child(dir, `
        import { fsStorage } from ${STORAGE};
        try { fsStorage.read(${JSON.stringify(join(dir, "nope.md"))}); console.log("NO THROW"); }
        catch (e) { console.log("THREW", e.code); }
      `);
      assert.match(res.stdout, /THREW ENOENT/, `got: ${res.stdout}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
