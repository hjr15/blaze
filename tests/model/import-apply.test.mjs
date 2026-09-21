// tests/model/import-apply.test.mjs — BLZ-629: the import apply.
//
// Design §5.3 (the seven-step write sequence, the receipt, the four-state
// inspection rule, the prune), §5.4 (staging) and §5.5 (id allocation and
// claims), from docs/design/csv-import-and-export.md.
//
// The SIGKILL-mid-write assertion lives in tests/import-sigkill.test.mjs
// instead: node:test's `timeout` is an event-loop timer and cannot observe a
// signal death, so that case spawns a child and kills it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  applyImport, runImport, loadBoard, readReceipt, unresolvedIntents,
  pruneReceipts, inspectReceipt, receiptPathFor, RECEIPT_DIR,
} from "../../scripts/model/import-apply.mjs";
import { planImport, parseCanonicalCsv } from "../../scripts/model/import-plan.mjs";
import { COLUMN_NAMES } from "../../scripts/model/csv-schema.mjs";
import { writeCsv } from "../../scripts/model/csv.mjs";
import { fsWritePort } from "../../scripts/model/write-port.mjs";
import { claimPath, claimDir } from "../../scripts/model/claims.mjs";
import { OP_LABEL } from "../../scripts/commit-summary.mjs";

// --- fixtures ----------------------------------------------------------------

function boardRoot(t, { git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "blaze-import-apply-"));
  t.after(() => {
    // Restore any permission a test narrowed, or rmSync cannot empty it.
    try { chmodSync(join(root, RECEIPT_DIR), 0o700); } catch { /* not narrowed */ }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  if (git) spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  return root;
}

function cells(overrides = {}) {
  const base = Object.fromEntries(COLUMN_NAMES.map((n) => [n, ""]));
  return {
    ...base,
    schema_version: "1", id: "BLZ-1", project: "BLZ", type: "task",
    status: "defined", title: "t", description: "body", estimate: "30",
    ...overrides,
  };
}

function csv(...maps) {
  return writeCsv([COLUMN_NAMES.slice(), ...maps.map((m) => COLUMN_NAMES.map((n) => m[n] ?? ""))]);
}

function csvFile(root, ...maps) {
  const p = join(root, "in.csv");
  writeFileSync(p, csv(...maps));
  return p;
}

/** A plan built the way the verb builds one, against a real temp board. */
function planFor(root, ...maps) {
  const projectsDir = join(root, "projects");
  const parsed = parseCanonicalCsv(csv(...maps));
  assert.equal(parsed.ok, true, (parsed.errors ?? []).join("\n"));
  return planImport(parsed.rows, loadBoard(projectsDir, { dataRoot: root }));
}

// `applyImport` does NOT decide exit 5: establishing the receipt is the
// caller's pre-write phase (that is what `runImport` does, and what the exit-5
// tests below drive). So these direct-apply tests establish it themselves.
function ctxFor(root, extra = {}) {
  const projectsDir = join(root, "projects");
  mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
  return {
    projectsDir,
    dataRoot: root,
    writePort: fsWritePort(projectsDir),
    receiptPath: receiptPathFor(root, { now: new Date("2026-09-21T00:00:00Z") }),
    stage: () => ({ ok: true, committed: false, queued: true }),
    ...extra,
  };
}

const receiptLines = (p) =>
  readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// --- the seven-step sequence (§5.3) ------------------------------------------

describe("BLZ-629: the claim is its own step, before the ticket write, on BOTH paths", () => {
  test("an explicit-id create writes a claim (§5.5 — writeClaim's only other caller is blaze new)", async (t) => {
    const root = boardRoot(t);
    const plan = planFor(root, cells({ id: "BLZ-1" }));
    const r = await applyImport(plan, ctxFor(root));
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.equal(existsSync(claimPath(join(root, "projects"), "BLZ", 1)), true,
      "an importer that skips claims produces a board failing `blaze audit` on every imported row");
  });

  test("the claim lands BEFORE the ticket — a kill between them leaves the HARMLESS residue", async (t) => {
    const root = boardRoot(t);
    const projectsDir = join(root, "projects");
    const real = fsWritePort(projectsDir);
    const claimSeenAtWrite = [];
    const port = {
      ...real,
      write(target) {
        claimSeenAtWrite.push(existsSync(claimPath(projectsDir, "BLZ", 1)));
        return real.write(target);
      },
    };
    const plan = planFor(root, cells({ id: "BLZ-1" }));
    const r = await applyImport(plan, ctxFor(root, { writePort: port }));
    assert.equal(r.exitCode, 0);
    assert.deepEqual(claimSeenAtWrite, [true],
      "claim-before-write: the reverse order's residue is a missingClaimErrors ERROR on the operator's board");
  });

  test("an --allocate-ids create also gets a claim, and an `allocated` receipt entry the moment the id exists", async (t) => {
    // `allocateId` reserves under <common>/blaze/ids/<KEY>/ and refuses
    // outside a git worktree, so this is the one case that needs a real one.
    const root = boardRoot(t, { git: true });
    const plan = planFor(root, cells({ id: "" }));
    // The planner refuses an id-less row by default; --allocate-ids accepts it.
    const parsed = parseCanonicalCsv(csv(cells({ id: "" })));
    const allocPlan = planImport(parsed.rows, loadBoard(join(root, "projects"), { dataRoot: root }),
      { allocateIds: true });
    assert.equal(plan.ok, false, "the default path refuses an id-less row");
    const ctx = ctxFor(root);
    const r = await applyImport(allocPlan, ctx);
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    const lines = receiptLines(ctx.receiptPath);
    const intent = lines.find((l) => l.phase === "intent");
    const allocated = lines.find((l) => l.phase === "allocated");
    assert.equal(intent.id, null, "the intent is written BEFORE allocation, so it cannot carry the id");
    assert.ok(allocated, "the `allocated` phase records the id the moment it exists");
    assert.match(allocated.id, /^BLZ-\d+$/);
    assert.equal(existsSync(claimPath(join(root, "projects"), "BLZ", Number(allocated.id.split("-")[1]))), true);
  });

  test("a supplied id writes NO `allocated` entry — the id is already in the intent", async (t) => {
    const root = boardRoot(t);
    const ctx = ctxFor(root);
    const r = await applyImport(planFor(root, cells({ id: "BLZ-4" })), ctx);
    assert.equal(r.exitCode, 0);
    const lines = receiptLines(ctx.receiptPath);
    assert.equal(lines.filter((l) => l.phase === "allocated").length, 0);
    assert.equal(lines.find((l) => l.phase === "intent").id, "BLZ-4");
  });

  test("the receipt's per-row sequence is intent → (allocated) → done, in that order", async (t) => {
    const root = boardRoot(t);
    const ctx = ctxFor(root);
    await applyImport(planFor(root, cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" })), ctx);
    const lines = receiptLines(ctx.receiptPath);
    assert.deepEqual(lines.map((l) => `${l.seq}:${l.phase}`),
      ["1:intent", "1:done", "2:intent", "2:done"]);
    assert.match(lines[1].file, /^projects\/BLZ\/defined\/BLZ-1/,
      "`done` records the file, relative to the data root");
    assert.equal(lines[1].claim, true);
  });

  test("an UPDATE row runs steps 1, 5 and 7 only — an existing ticket keeps whatever claim it has", async (t) => {
    const root = boardRoot(t);
    writeFileSync(join(root, "projects", "BLZ", "defined", "BLZ-1-t.md"),
      "---\nid: BLZ-1\ntitle: old\ntype: task\nproject: BLZ\nestimate: 30\n---\n\nbody\n");
    const projectsDir = join(root, "projects");
    const parsed = parseCanonicalCsv(csv(cells({ id: "BLZ-1", title: "new" })));
    const plan = planImport(parsed.rows, loadBoard(projectsDir, { dataRoot: root }), { update: true });
    assert.equal(plan.rows[0].op, "update");
    const ctx = ctxFor(root);
    const r = await applyImport(plan, ctx);
    assert.equal(r.exitCode, 0, JSON.stringify(r.errors));
    assert.equal(existsSync(claimPath(projectsDir, "BLZ", 1)), false,
      "§5.5's promise is a claim per CREATED ticket; an update must not fabricate one");
    assert.deepEqual(receiptLines(ctx.receiptPath).map((l) => l.phase), ["intent", "done"]);
  });

  test("a SKIP row writes nothing at all — not even an intent", async (t) => {
    const root = boardRoot(t);
    const ctx = ctxFor(root);
    await applyImport(planFor(root, cells({ id: "BLZ-1" })), ctx);
    // Re-plan against the now-populated board: the row is identical, so it skips.
    const projectsDir = join(root, "projects");
    const parsed = parseCanonicalCsv(csv(cells({ id: "BLZ-1" })));
    const plan2 = planImport(parsed.rows, loadBoard(projectsDir, { dataRoot: root }));
    assert.equal(plan2.rows[0].op, "skip", "a re-run of the same file is a no-op");
    const ctx2 = ctxFor(root, { receiptPath: join(root, RECEIPT_DIR, "second.jsonl") });
    const r = await applyImport(plan2, ctx2);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.written, []);
    assert.equal(existsSync(ctx2.receiptPath), false,
      "a skip runs none of the seven steps, so not even an `intent` is appended");
  });
});

// --- the dry run is the default (ADR-0037 §4) --------------------------------

describe("BLZ-629: dry run by default", () => {
  test("runImport without apply writes no ticket, no claim and no receipt, and exits 0", async (t) => {
    const root = boardRoot(t);
    const file = csvFile(root, cells({ id: "BLZ-1" }));
    const r = await runImport({ file, projectsDir: join(root, "projects"), dataRoot: root });
    assert.equal(r.exitCode, 0);
    assert.equal(existsSync(join(root, "projects", "BLZ", "defined", "BLZ-1-t.md")), false);
    assert.equal(existsSync(claimDir(join(root, "projects"), "BLZ")), false);
    assert.equal(existsSync(join(root, RECEIPT_DIR)), false);
    assert.match(r.report, /WOULD CREATE/);
  });

  test("runImport with apply writes the ticket and the claim and exits 0", async (t) => {
    const root = boardRoot(t);
    const file = csvFile(root, cells({ id: "BLZ-1" }));
    const r = await runImport({
      file, projectsDir: join(root, "projects"), dataRoot: root, apply: true,
      stage: () => ({ ok: true, queued: true }),
    });
    assert.equal(r.exitCode, 0, r.report);
    assert.equal(existsSync(join(root, "projects", "BLZ", "defined", "BLZ-1-t.md")), true);
    assert.equal(existsSync(claimPath(join(root, "projects"), "BLZ", 1)), true);
  });
});

// --- exit codes (§5.1) -------------------------------------------------------

describe("BLZ-629: the exit codes", () => {
  test("exit 1 — a refused row means ZERO writes, board unchanged", async (t) => {
    const root = boardRoot(t);
    const file = csvFile(root, cells({ id: "BLZ-1" }), cells({ id: "BLZ-2", status: "wibble" }));
    const r = await runImport({ file, projectsDir: join(root, "projects"), dataRoot: root, apply: true });
    assert.equal(r.exitCode, 1);
    assert.equal(existsSync(join(root, "projects", "BLZ", "defined", "BLZ-1-t.md")), false,
      "500 good rows and one bad one writes none of them");
    assert.equal(existsSync(join(root, RECEIPT_DIR)), false);
  });

  test("exit 2 — an input that is not the format it claims", async (t) => {
    const root = boardRoot(t);
    const p = join(root, "bad.csv");
    writeFileSync(p, csv(cells()) + "1,BLZ-2\n");
    const r = await runImport({ file: p, projectsDir: join(root, "projects"), dataRoot: root, apply: true });
    assert.equal(r.exitCode, 2);
  });

  test("exit 2 — an unreadable input path is refused through readRegularFileSync, never opened blind", async (t) => {
    const root = boardRoot(t);
    const r = await runImport({
      file: join(root, "projects"), projectsDir: join(root, "projects"), dataRoot: root, apply: true });
    assert.equal(r.exitCode, 2, "a directory (and a FIFO, which would block forever) is refused, ADR-0031");
  });

  test("exit 5 — the receipt cannot be opened for append: zero tickets, zero receipt lines, board unchanged", async (t) => {
    const root = boardRoot(t);
    const dir = join(root, RECEIPT_DIR);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    t.after(() => { try { chmodSync(dir, 0o700); } catch { /* root already removed */ } });
    const file = csvFile(root, cells({ id: "BLZ-1" }));
    const r = await runImport({
      file, projectsDir: join(root, "projects"), dataRoot: root, apply: true,
      stage: () => ({ ok: true, queued: true }),
    });
    assert.equal(r.exitCode, 5, "'I could not open my own log' is not 'the input is unreadable' (2)");
    assert.equal(existsSync(join(root, "projects", "BLZ", "defined", "BLZ-1-t.md")), false);
  });

  test("exit 5 — an unresolved prior receipt, under sourceIdColumn, names the receipt and the verb that lifts it", async (t) => {
    const root = boardRoot(t);
    mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
    writeFileSync(join(root, RECEIPT_DIR, "2026-09-01T00-00-00.000Z-acme.jsonl"),
      `${JSON.stringify({ seq: 1, phase: "intent", row: 1, source: "ACME-1", id: null, op: "create" })}\n`);
    const file = csvFile(root, cells({ id: "BLZ-1" }));
    const r = await runImport({
      file, projectsDir: join(root, "projects"), dataRoot: root, apply: true,
      name: "acme", sourceIdColumn: "Issue key",
      stage: () => ({ ok: true, queued: true }),
    });
    assert.equal(r.exitCode, 5);
    assert.match(r.report, /blaze import repair --apply/);
    assert.match(r.report, /acme/);
    assert.equal(existsSync(join(root, "projects", "BLZ", "defined", "BLZ-1-t.md")), false,
      "the run never starts — board unchanged, nothing attempted");
  });

  test("the unresolved-prior-receipt refusal is SCOPED to sourceIdColumn — a canonical import finds a landed ticket on the board instead", async (t) => {
    const root = boardRoot(t);
    mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
    writeFileSync(join(root, RECEIPT_DIR, "2026-09-01T00-00-00.000Z-canonical.jsonl"),
      `${JSON.stringify({ seq: 1, phase: "intent", row: 1, source: null, id: "BLZ-9", op: "create" })}\n`);
    const file = csvFile(root, cells({ id: "BLZ-1" }));
    const r = await runImport({
      file, projectsDir: join(root, "projects"), dataRoot: root, apply: true,
      stage: () => ({ ok: true, queued: true }),
    });
    assert.equal(r.exitCode, 0, "only the source-key lookup can be blind to a ticket that exists (§5.1)");
  });

  test("a `resolved` entry lifts the exit-5 refusal", async (t) => {
    const root = boardRoot(t);
    mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
    writeFileSync(join(root, RECEIPT_DIR, "2026-09-01T00-00-00.000Z-acme.jsonl"),
      `${JSON.stringify({ seq: 1, phase: "intent", row: 1, source: "ACME-1", id: null, op: "create" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "resolved", state: "orphan-reservation" })}\n`);
    const file = csvFile(root, cells({ id: "BLZ-1" }));
    const r = await runImport({
      file, projectsDir: join(root, "projects"), dataRoot: root, apply: true,
      name: "acme", sourceIdColumn: "Issue key", stage: () => ({ ok: true, queued: true }),
    });
    assert.equal(r.exitCode, 0, r.report);
  });

  test("exit 4 — a ticket write that fails part way stops, lists written AND unwritten ids, and does not roll back", async (t) => {
    const root = boardRoot(t);
    const projectsDir = join(root, "projects");
    const real = fsWritePort(projectsDir);
    let n = 0;
    const port = {
      ...real,
      write(target) {
        if (++n === 3) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        return real.write(target);
      },
    };
    const plan = planFor(root, cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" }),
      cells({ id: "BLZ-3" }), cells({ id: "BLZ-4" }));
    const ctx = ctxFor(root, { writePort: port });
    const r = await applyImport(plan, ctx);
    assert.equal(r.exitCode, 4, "the ONE code the importer itself returns for a changed board");
    assert.deepEqual(r.written, ["BLZ-1", "BLZ-2"]);
    assert.deepEqual(r.notWritten, ["BLZ-3", "BLZ-4"]);
    assert.equal(existsSync(join(projectsDir, "BLZ", "defined", "BLZ-1-t.md")), true,
      "no rollback — a rollback is a second write path with its own blast radius (ADR-0032)");
    const lines = receiptLines(ctx.receiptPath);
    assert.equal(lines.filter((l) => l.phase === "done").length, 2);
    assert.equal(lines.filter((l) => l.phase === "intent").length, 3,
      "row 3's intent is on the receipt with no done — that is what exit 4 points the operator at");
  });

  test("exit 4 — every write landed and STAGING failed", async (t) => {
    const root = boardRoot(t);
    const plan = planFor(root, cells({ id: "BLZ-1" }));
    const r = await applyImport(plan, ctxFor(root, {
      stage: () => { throw new Error("git add failed"); },
    }));
    assert.equal(r.exitCode, 4,
      "once any ticket has been written, no later failure may exit anything but 4 (§5.1)");
    assert.deepEqual(r.written, ["BLZ-1"]);
  });

  test("exit 4 — a receipt append that fails AFTER a ticket write is under the same invariant", async (t) => {
    const root = boardRoot(t);
    const plan = planFor(root, cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" }));
    const ctx = ctxFor(root);
    let appends = 0;
    const r = await applyImport(plan, {
      ...ctx,
      // The `ENOSPC` §5.3 names, injected at the one place that proves the
      // rule: an append AFTER a ticket landed. An uncaught throw here used to
      // exit 1, which §5.1 declares means "unchanged — nothing written".
      appendReceipt: (p, data) => {
        if (++appends === 3) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        return ctx.appendReceipt ? ctx.appendReceipt(p, data) : undefined;
      },
    });
    assert.equal(r.exitCode, 4);
  });

  test("exit 0 — a clean apply, with the trailer naming the port and whether the commit actually happened", async (t) => {
    const root = boardRoot(t);
    const file = csvFile(root, cells({ id: "BLZ-1" }));
    const r = await runImport({
      file, projectsDir: join(root, "projects"), dataRoot: root, apply: true,
      commitMode: "batch", stage: () => ({ ok: true, committed: false, queued: true }),
    });
    assert.equal(r.exitCode, 0, r.report);
    assert.match(r.report, /queued/i,
      "exit 0 does not mean 'committed' on a batch board — the trailer says so rather than leaving it to be discovered");
  });
});

// --- the receipt: reading, the four states, the prune (§5.3, §5.4) -----------

describe("BLZ-629: the receipt reader is read-only and reports what it dropped", () => {
  test("a torn last line is REPORTED as dropped and never parked — parking is a write, and only `repair --apply` does it", (t) => {
    const root = boardRoot(t);
    const p = join(root, "r.jsonl");
    writeFileSync(p,
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n{"seq":2,"phase":"in`);
    const r = readReceipt(p);
    assert.equal(r.entries.length, 1);
    assert.equal(r.dropped, 1, "a partial read must never be presented as a complete one (ADR-0030)");
    assert.equal(r.parsedCompletely, false);
    assert.equal(existsSync(`${p}.corrupt`), false,
      "a park that failed in the pre-write phase would fall under no exit code at all");
  });

  test("a receipt that parses completely says so", (t) => {
    const root = boardRoot(t);
    const p = join(root, "r.jsonl");
    writeFileSync(p, `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`);
    const r = readReceipt(p);
    assert.equal(r.parsedCompletely, true);
    assert.equal(r.dropped, 0);
  });

  test("a torn `intent` is an UNMATCHED intent — the prune must not read a torn file as clean", (t) => {
    const root = boardRoot(t);
    const p = join(root, "r.jsonl");
    writeFileSync(p,
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "done", id: "BLZ-1" })}\n`
      + `{"seq":2,"phase":"int`);
    const r = readReceipt(p);
    assert.equal(unresolvedIntents(r).length > 0, true,
      "eligibility requires every intent to have a done AND the file to have parsed completely");
  });

  test("a `torn-line-parked` resolved entry carries seq null and belongs to the receipt, not to a row", (t) => {
    const root = boardRoot(t);
    const p = join(root, "r.jsonl");
    writeFileSync(p,
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "resolved", state: "pair-appended" })}\n`
      + `${JSON.stringify({ phase: "resolved", seq: null, state: "torn-line-parked" })}\n`);
    const r = readReceipt(p);
    assert.deepEqual(unresolvedIntents(r), [],
      "the receipt format has room for the entry type BLZ-634's repair verb appends");
  });
});

describe("BLZ-629: the four-state inspection rule (§5.3)", () => {
  const entries = [
    { seq: 1, phase: "intent", source: "A-1", id: "BLZ-1", op: "create" },
    { seq: 2, phase: "intent", source: "A-2", id: "BLZ-2", op: "create" },
    { seq: 3, phase: "intent", source: "A-3", id: "BLZ-3", op: "create" },
    { seq: 4, phase: "intent", source: "A-4", id: "BLZ-4", op: "create" },
  ];

  test("ticket absent, pair absent → orphan-reservation, re-created on re-import", () => {
    const s = inspectReceipt(entries, {
      hasTicket: () => false, hasPair: () => false, sourceIdColumn: "k" });
    assert.equal(s.get(1).state, "orphan-reservation");
    assert.equal(s.get(1).needsPerson, false);
  });

  test("ticket present, pair absent → pair-appended: the ticket-without-pair window a re-import would DUPLICATE", () => {
    const s = inspectReceipt(entries, {
      hasTicket: (id) => id === "BLZ-2", hasPair: () => false, sourceIdColumn: "k" });
    assert.equal(s.get(2).state, "pair-appended");
    assert.equal(s.get(2).needsPerson, false);
  });

  test("ticket present, pair present → nothing-to-repair, only the `done` is missing", () => {
    const s = inspectReceipt(entries, {
      hasTicket: (id) => id === "BLZ-3", hasPair: (src) => src === "A-3", sourceIdColumn: "k" });
    assert.equal(s.get(3).state, "nothing-to-repair");
  });

  test("ticket ABSENT, pair PRESENT → not a state the sequence produces: left for a PERSON, never auto-resolved", () => {
    const s = inspectReceipt(entries, {
      hasTicket: () => false, hasPair: (src) => src === "A-4", sourceIdColumn: "k" });
    assert.equal(s.get(4).state, "pair-without-ticket");
    assert.equal(s.get(4).needsPerson, true,
      "the pair governs the lookup, so a re-import SKIPS the row — neither re-created nor duplicated, silently absent");
    assert.equal(s.get(4).resolvedState, null, "the row gets no `resolved` entry and exit 5 keeps firing");
  });

  test("without sourceIdColumn there is no map, so only the first and third states occur", () => {
    const s = inspectReceipt(entries, {
      hasTicket: (id) => id === "BLZ-1", hasPair: () => false, sourceIdColumn: null });
    assert.equal(s.get(1).state, "nothing-to-repair");
    assert.equal(s.get(2).state, "orphan-reservation");
  });

  test("a row with a `done` is not inspected at all — done implies pair implies ticket implies claim", () => {
    const s = inspectReceipt([...entries, { seq: 1, phase: "done", id: "BLZ-1" }], {
      hasTicket: () => false, hasPair: () => false, sourceIdColumn: "k" });
    assert.equal(s.has(1), false);
  });
});

describe("BLZ-629: the pre-write, best-effort, exit-code-neutral prune (§5.3 item 2)", () => {
  const old = new Date("2026-01-01T00:00:00Z");
  const now = new Date("2026-09-21T00:00:00Z");

  function seed(root, name, text, when) {
    mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
    const p = join(root, RECEIPT_DIR, name);
    writeFileSync(p, text);
    if (when) utimesSync(p, when, when);
    return p;
  }

  test("a >90-day receipt in which every intent has a done is pruned", (t) => {
    const root = boardRoot(t);
    const p = seed(root, "2026-01-01T00-00-00.000Z-canonical.jsonl",
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "done", id: "BLZ-1" })}\n`, old);
    const r = pruneReceipts(root, { now });
    assert.equal(existsSync(p), false);
    assert.equal(r.pruned.length, 1);
  });

  test("a receipt with ANY unmatched intent is never pruned, at any age — it is the evidence of a partial apply", (t) => {
    const root = boardRoot(t);
    const p = seed(root, "2026-01-01T00-00-00.000Z-canonical.jsonl",
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`, old);
    pruneReceipts(root, { now });
    assert.equal(existsSync(p), true);
  });

  test("a `resolved` lifts the exit-5 refusal but never makes a receipt prunable", (t) => {
    const root = boardRoot(t);
    const p = seed(root, "2026-01-01T00-00-00.000Z-canonical.jsonl",
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "resolved", state: "orphan-reservation" })}\n`, old);
    pruneReceipts(root, { now });
    assert.equal(existsSync(p), true, "the prune requires a DONE, not a resolved");
  });

  test("a TORN receipt is kept — unreadable and clean are not the same fact, and a prune that cannot tell them apart must keep", (t) => {
    const root = boardRoot(t);
    const p = seed(root, "2026-01-01T00-00-00.000Z-canonical.jsonl",
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "done", id: "BLZ-1" })}\n{"seq":2,"phase":"int`, old);
    pruneReceipts(root, { now });
    assert.equal(existsSync(p), true,
      "without this the prune deletes exactly the receipt it exists to keep");
    assert.equal(existsSync(`${p}.corrupt`), false, "and it never parks — the prune's reader is read-only");
  });

  test("a receipt inside the window is kept even when clean", (t) => {
    const root = boardRoot(t);
    const p = seed(root, "2026-09-20T00-00-00.000Z-canonical.jsonl",
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "done", id: "BLZ-1" })}\n`, new Date("2026-09-20T00:00:00Z"));
    pruneReceipts(root, { now });
    assert.equal(existsSync(p), true);
  });

  test("a prune failure is a WARNING and never touches the exit code", async (t) => {
    const root = boardRoot(t);
    const dir = join(root, RECEIPT_DIR);
    seed(root, "2026-01-01T00-00-00.000Z-canonical.jsonl",
      `${JSON.stringify({ seq: 1, phase: "intent", id: "BLZ-1" })}\n`
      + `${JSON.stringify({ seq: 1, phase: "done", id: "BLZ-1" })}\n`, old);
    chmodSync(dir, 0o500);
    t.after(() => { try { chmodSync(dir, 0o700); } catch { /* root already removed */ } });
    const r = pruneReceipts(root, { now });
    assert.equal(r.warnings.length, 1,
      "inside the exit-4 guard this would tell the operator the board is partially applied when it is not");
    assert.equal(r.pruned.length, 0);
  });
});

// --- staging (§5.4) ----------------------------------------------------------

describe("BLZ-629: staging", () => {
  test("`import` is in OP_LABEL — without it commitOrQueue throws on the first successful apply", () => {
    assert.equal(Object.hasOwn(OP_LABEL, "import"), true,
      "a runner that reaches commitOrQueue without this exits 1 on its first successful apply (§5.4)");
  });

  test("staging names exactly the files the run wrote — the tickets, the claims and the receipt", async (t) => {
    const root = boardRoot(t);
    const staged = [];
    const plan = planFor(root, cells({ id: "BLZ-1" }), cells({ id: "BLZ-2" }));
    const ctx = ctxFor(root, { stage: (args) => { staged.push(args); return { ok: true, queued: true }; } });
    await applyImport(plan, ctx);
    assert.equal(staged.length, 1, "one commitOrQueue for the run, never git add -A");
    assert.equal(staged[0].op, "import");
    assert.deepEqual(staged[0].ids, ["BLZ-1", "BLZ-2"]);
    const files = staged[0].files;
    assert.equal(files.filter((f) => f.endsWith(".md")).length, 2);
    assert.equal(files.includes(ctx.receiptPath), true,
      "the receipt is a record, not a cache — it reaches the commit with the tickets");
    assert.equal(files.some((f) => f.includes(".ids")), true, "and so do the claims");
  });

  test("a run that wrote nothing stages nothing", async (t) => {
    const root = boardRoot(t);
    let called = 0;
    const ctx = ctxFor(root, { stage: () => { called++; return { ok: true }; } });
    await applyImport(planFor(root), ctx);
    assert.equal(called, 0);
  });
});
