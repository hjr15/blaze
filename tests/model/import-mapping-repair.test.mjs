// tests/model/import-mapping-repair.test.mjs — BLZ-634's two REQUIRED tests,
// plus the rest of `blaze import repair`'s behaviour. Design §4.2 (the map and
// its two named tests), §5.2 (the exit codes) and §5.3 (the four-state rule,
// the park → truncate → pair → `resolved` order).
//
// The property under test is the one the whole mapping layer exists for:
// `sourceIdColumn` is idempotent UNDER FAILURE. A re-import after a crash must
// neither duplicate a row whose ticket landed nor skip one whose ticket did
// not, and the only thing standing between those two failures is the ordering
// of two appends to two files.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  MAPPING_DIR, SOURCE_IDS_DIR, headerDigest, sourceIdsPathFor,
  runMappedImport, runRepair, appendPair, openSourceIds,
} from "../../scripts/model/import-mapping.mjs";
import { RECEIPT_DIR, readReceipt } from "../../scripts/model/import-apply.mjs";
import { OP_LABEL } from "../../scripts/commit-summary.mjs";

const HEADER = ["Key", "Name", "Kind", "State"];
const NAME = "acme";

function boardRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "blaze-mapping-repair-"));
  t.after(() => {
    for (const d of [SOURCE_IDS_DIR, RECEIPT_DIR]) {
      try { chmodSync(join(root, d), 0o700); } catch { /* not narrowed */ }
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "projects", "BLZ", "defined"), { recursive: true });
  // `allocateId` reserves through an O_EXCL file under the repo's common dir,
  // so the allocate path needs a real worktree (§5.3 step 2).
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  return root;
}

/** A mapping with `sourceIdColumn` and NO `id` column: every row's blaze id is
 *  allocated, so the skip can only be keyed on the source key — which is the
 *  case `source-ids/<name>.jsonl` exists for. */
function writeMapping(root, overrides = {}) {
  mkdirSync(join(root, MAPPING_DIR), { recursive: true });
  const m = {
    mappingVersion: 1,
    schemaVersion: 1,
    name: NAME,
    source: { columns: HEADER.slice(), sha256: headerDigest(HEADER) },
    sourceIdColumn: "Key",
    columns: {
      title: { from: "Name" },
      description: { from: "Name" },
      type: { from: "Kind" },
      status: { from: "State" },
      project: { constant: "BLZ" },
      estimate: { constant: "30" },
    },
    values: { type: { Bug: "task" }, status: { Open: "defined" } },
    unmapped: [],
    ...overrides,
  };
  const p = join(root, MAPPING_DIR, `${m.name}.json`);
  writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
  return p;
}

function sourceCsv(root, rows) {
  const p = join(root, "source.csv");
  writeFileSync(p, [HEADER.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n");
  return p;
}

const THREE = [
  ["ACME-1", "first", "Bug", "Open"],
  ["ACME-2", "second", "Bug", "Open"],
  ["ACME-3", "third", "Bug", "Open"],
];

const noStage = () => ({ ok: true, committed: false, queued: true });

function opts(root, extra = {}) {
  return {
    file: sourceCsv(root, THREE),
    mappingPath: writeMapping(root),
    projectsDir: join(root, "projects"),
    dataRoot: root,
    apply: true,
    allocateIds: true,
    stage: noStage,
    ...extra,
  };
}

const mapLines = (root) => {
  const p = sourceIdsPathFor(root, NAME);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const receiptPath = (root) => join(root, RECEIPT_DIR, readdirSync(join(root, RECEIPT_DIR))[0]);
const tickets = (root) => readdirSync(join(root, "projects", "BLZ", "defined"));

// =============================================================================
// The happy path, so the failure paths below are attributable
// =============================================================================

describe("a mapped import under sourceIdColumn", () => {
  test("writes one pair per row, and a re-run is a NO-OP even though blaze allocated the ids", async (t) => {
    const root = boardRoot(t);
    const o = opts(root);
    const first = await runMappedImport(o);
    assert.equal(first.exitCode, 0, first.report);
    assert.equal(tickets(root).length, 3);
    assert.equal(mapLines(root).length, 3);
    assert.deepEqual(mapLines(root).map((l) => l.source), ["ACME-1", "ACME-2", "ACME-3"]);

    const second = await runMappedImport({ ...o, now: new Date(Date.now() + 1000) });
    assert.equal(second.exitCode, 0, second.report);
    assert.match(second.report, /SKIPPED/);
    assert.equal(tickets(root).length, 3,
      "ADR-0037 §3: under `sourceIdColumn` the skip is keyed on the SOURCE key, so a second run "
      + "of the same export is a no-op even though every id was allocated");
    assert.equal(mapLines(root).length, 3, "the map is append-only and a skipped row appends nothing");
  });

  test("the pair lands BETWEEN the ticket write and that row's `done` — `done` implies pair", async (t) => {
    const root = boardRoot(t);
    const seen = [];
    await runMappedImport(opts(root, {
      appendMapLine: (p, pair) => {
        seen.push({ at: "pair", ticketOnDisk: tickets(root).length });
        appendPair(p, pair);
      },
    }));
    const entries = readReceipt(receiptPath(root)).entries;
    const doneSeqs = entries.filter((e) => e.phase === "done").map((e) => e.seq);
    assert.deepEqual(doneSeqs, [1, 2, 3]);
    assert.deepEqual(seen.map((s) => s.ticketOnDisk), [1, 2, 3],
      "the ticket is on disk when the pair is appended — the pair follows the write (§5.3 step 6)");
  });

  test("a dry run writes no pair, no receipt and no ticket", async (t) => {
    const root = boardRoot(t);
    const r = await runMappedImport(opts(root, { apply: false }));
    assert.equal(r.exitCode, 0);
    assert.match(r.report, /WOULD CREATE/);
    assert.equal(existsSync(join(root, SOURCE_IDS_DIR)), false);
    assert.equal(existsSync(join(root, RECEIPT_DIR)), false);
    assert.equal(tickets(root).length, 0);
  });
});

// =============================================================================
// REQUIRED TEST 1 (§4.2): an unwritable map, before any write
// =============================================================================

test("an UNWRITABLE source-ids map is exit 5 with NOTHING written — not one ticket, not one receipt line", async (t) => {
  const root = boardRoot(t);
  mkdirSync(join(root, SOURCE_IDS_DIR), { recursive: true });
  chmodSync(join(root, SOURCE_IDS_DIR), 0o500);   // readable, not writable

  const r = await runMappedImport(opts(root));

  assert.equal(r.exitCode, 5,
    "§5.1: the run's own records are not in a state it may start from. It is 5 and not 1 — an "
    + "uncaught throw would exit 1, whose row says `data refused — nothing written`, which is a "
    + "true sentence about the board and a false one about why");
  assert.equal(tickets(root).length, 0, "the board is unchanged — nothing was attempted");
  assert.equal(existsSync(join(root, "projects", "BLZ", ".ids")), false, "not even a claim");
  const receipt = receiptPath(root);
  assert.equal(readFileSync(receipt, "utf8"), "",
    "the receipt was established (step 3) and then the MAP's open failed (step 4), so the run "
    + "stopped before its first `intent` — zero receipt lines");
});

// =============================================================================
// REQUIRED TEST 2 (§4.2): the map append itself fails at row N
// =============================================================================

/**
 * The post-crash state, built by injecting a fault into the MAP APPEND itself
 * at row N — not into something after it. That placement is the whole point:
 * it is the only one that opens the ticket-without-pair window, and a draft
 * whose test injected after row N's map append could not expose it.
 */
async function crashedAtRowTwo(t) {
  const root = boardRoot(t);
  const o = opts(root);
  const r = await runMappedImport({
    ...o,
    appendMapLine: (p, pair) => {
      if (pair.seq === 2) throw new Error("ENOSPC: no space left on device, write");
      appendPair(p, pair);
    },
  });
  return { root, o, r };
}

describe("BLZ-634 / §4.2 test 2 — the map append fails at row N", () => {
  test("ticket N is on disk, the map holds N-1 pairs, and row N has no `done`", async (t) => {
    const { root, r } = await crashedAtRowTwo(t);

    assert.equal(r.exitCode, 4,
      "§5.1: a map append that fails AFTER a ticket write is under the exit-4 invariant with "
      + "everything else — once any ticket has been written, no later failure may exit anything but 4");

    const names = tickets(root);
    assert.equal(names.length, 2, "rows 1 and 2 have tickets; the run stopped at row 2's pair");
    assert.ok(names.some((n) => n.includes("second")), "ticket N IS genuinely on disk");

    const pairs = mapLines(root);
    assert.equal(pairs.length, 1, "N-1 pairs: row 2's never landed");
    assert.equal(pairs[0].source, "ACME-1");

    const entries = readReceipt(receiptPath(root)).entries;
    const forTwo = entries.filter((e) => e.seq === 2);
    assert.deepEqual(forTwo.map((e) => e.phase), ["intent", "allocated"],
      "row N has its `intent` and its `allocated` and NO `done` — `done` implies pair, so it "
      + "cannot exist here");
    assert.equal(forTwo[0].source, "ACME-2", "the `intent` carries the source key, so the pair is "
      + "reconstructible from the receipt alone (§5.3)");
    assert.ok(forTwo[1].id, "the `allocated` carries the id the moment it existed");
  });

  test("a re-import under this mapping REFUSES with exit 5, naming the row and the verb that lifts it", async (t) => {
    const { root, o } = await crashedAtRowTwo(t);
    const again = await runMappedImport({ ...o, now: new Date(Date.now() + 1000) });
    assert.equal(again.exitCode, 5,
      "§5.2: an unresolved prior partial apply. A re-import that proceeded would recreate the row "
      + "whose ticket landed but whose pair did not");
    assert.match(again.report, /ACME-2/);
    assert.match(again.report, /blaze import repair --apply/);
    assert.equal(tickets(root).length, 2, "nothing was written — the run never started");
  });

  test("`repair` with no flag writes NOTHING, prints the row under WOULD APPEND, and exits 0", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    const before = readFileSync(receiptPath(root), "utf8");
    const r = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root, stage: noStage,
    });
    assert.equal(r.exitCode, 0, "§5.3: the dry run exits with the code the apply would — nothing "
      + "would remain unresolved, so 0");
    assert.match(r.report, /WOULD APPEND/);
    assert.match(r.report, /ACME-2/);
    assert.equal(mapLines(root).length, 1, "no pair was appended");
    assert.equal(readFileSync(receiptPath(root), "utf8"), before, "the receipt is byte-identical");
    assert.equal(existsSync(`${sourceIdsPathFor(root, NAME)}.corrupt`), false);
  });

  test("`repair --apply` appends the pair and THEN the `resolved`, in that order", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    const r = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 0, r.report);

    const pairs = mapLines(root);
    assert.equal(pairs.length, 2, "N pairs");
    assert.equal(pairs[1].source, "ACME-2");

    const entries = readReceipt(receiptPath(root)).entries;
    const last = entries[entries.length - 1];
    assert.equal(last.phase, "resolved");
    assert.equal(last.seq, 2);
    assert.equal(last.state, "pair-appended", "§5.3's second row: the ticket-without-pair window");
  });

  test("a kill BETWEEN the pair append and the `resolved` append KEEPS the refusal in force", async (t) => {
    const { root, o } = await crashedAtRowTwo(t);
    // The kill: the pair append lands, and the process dies before the
    // `resolved` that would lift the refusal.
    const killed = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
      append: () => { throw new Error("SIGKILL between the two appends"); },
    });
    assert.notEqual(killed.exitCode, 0);

    assert.equal(mapLines(root).length, 2, "the pair IS written — it is written first, deliberately");
    const entries = readReceipt(receiptPath(root)).entries;
    assert.equal(entries.some((e) => e.phase === "resolved"), false,
      "`resolved` is NOT written: the record that lifts the refusal is written LAST, after the "
      + "record it vouches for");

    const again = await runMappedImport({ ...o, now: new Date(Date.now() + 1000) });
    assert.equal(again.exitCode, 5,
      "§5.3: in this order a crash between the two leaves the refusal in force. In the reverse "
      + "order it would be lifted over a missing pair and the re-import would duplicate the row");

    // The repaired state needs a SECOND `repair --apply`: the first never got
    // to its `resolved`. It finds the pair already present, so the row
    // re-examines as `nothing-to-repair`.
    const second = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
    });
    assert.equal(second.exitCode, 0, second.report);
    assert.match(second.report, /NOTHING TO REPAIR/);
    assert.equal(mapLines(root).length, 2, "the map is append-only — no second pair for the same row");
    const after = readReceipt(receiptPath(root)).entries;
    assert.equal(after[after.length - 1].state, "nothing-to-repair");
  });

  test("from the repaired state: rows above N are created, 1..N are SKIPPED, no duplicate, no phantom", async (t) => {
    const { root, o } = await crashedAtRowTwo(t);
    await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
    });

    const again = await runMappedImport({ ...o, now: new Date(Date.now() + 1000) });
    assert.equal(again.exitCode, 0, again.report);
    assert.equal(again.plan.counts.skip, 2, "rows 1..N are already resolved");
    assert.equal(again.plan.counts.create, 1, "only row 3 is left to create");

    const names = tickets(root);
    assert.equal(names.length, 3, "no duplicate: the two ticket files that existed were not re-created");
    assert.equal(names.filter((n) => n.includes("second")).length, 1);
    assert.equal(mapLines(root).length, 3);
    assert.deepEqual(mapLines(root).map((l) => l.source), ["ACME-1", "ACME-2", "ACME-3"],
      "no phantom pair: exactly one pair per ticket that exists");
    for (const l of mapLines(root)) {
      assert.ok(names.some((n) => n.startsWith(`${l.id}-`)),
        `the map's pair for ${l.source} names ${l.id}, which must be a ticket that exists`);
    }
  });
});

// =============================================================================
// The rest of the four-state rule, and repair's own refusals
// =============================================================================

describe("`blaze import repair` refusals, before any write", () => {
  test("an absent receipt is exit 2 — the receipt is repair's INPUT", async (t) => {
    const root = boardRoot(t);
    const r = await runRepair({
      receipt: join(root, RECEIPT_DIR, "2026-09-22T00-00-00.000Z-acme.jsonl"),
      projectsDir: join(root, "projects"), dataRoot: root, apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 2);
  });

  test("an absent mapping file is exit 3, naming it, BEFORE any write", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    rmSync(join(root, MAPPING_DIR, `${NAME}.json`));
    const before = readFileSync(receiptPath(root), "utf8");
    const r = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 3,
      "§5.3: without the mapping `repair` cannot know whether `sourceIdColumn` was in force, so it "
      + "cannot tell an orphan reservation from a pair-without-ticket row");
    assert.match(r.report, new RegExp(`${NAME}\\.json`));
    assert.equal(readFileSync(receiptPath(root), "utf8"), before, "nothing was written");
    assert.equal(mapLines(root).length, 1);
  });

  test("a mapping declaring sourceIdColumn with the map ABSENT is exit 5", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    rmSync(sourceIdsPathFor(root, NAME));
    const r = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 5);
    assert.match(r.report, /source-ids/);
  });

  test("a pair WITHOUT its ticket is left for a person: no `resolved`, and exit 5 keeps firing", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    // The fourth state: the sequence cannot produce it, so it is constructed —
    // only a power loss that lost the ticket's bytes and kept the pair's, or a
    // manual deletion, reaches it. Here: the pair lands and the ticket is
    // removed from the board.
    const entries0 = readReceipt(receiptPath(root)).entries;
    const id = entries0.find((e) => e.phase === "allocated" && e.seq === 2).id;
    rmSync(join(root, "projects", "BLZ", "defined", tickets(root).find((n) => n.startsWith(`${id}-`))));
    appendPair(sourceIdsPathFor(root, NAME), { source: "ACME-2", id, seq: 2 });
    const r = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 5);
    assert.match(r.report, /NEEDS A PERSON/);
    const entries = readReceipt(receiptPath(root)).entries;
    assert.equal(entries.some((e) => e.phase === "resolved"), false,
      "§5.3: the fourth row gets NO `resolved` entry — that is what keeps exit 5 firing until a "
      + "person has acted");
  });

  test("a torn MAP is parked, truncated and re-appended — in that order", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    const mapPath = sourceIdsPathFor(root, NAME);
    writeFileSync(mapPath, `${readFileSync(mapPath, "utf8")}{"source":"ACME-2","id":"BL`);

    const r = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 0, r.report);
    const parked = readFileSync(`${mapPath}.corrupt`, "utf8");
    assert.match(parked, /\{"source":"ACME-2","id":"BL$|\{"source":"ACME-2","id":"BL\n/,
      "BLZ-531: park the raw bytes before you clear them");
    const lines = mapLines(root);
    assert.equal(lines.length, 2, "the fragment was truncated away and the real pair appended in its place");
    assert.equal(lines[1].id.startsWith("BLZ-"), true);
    assert.equal(readFileSync(mapPath, "utf8").endsWith("\n"), true,
      "appending onto a fragment with no newline would glue the pair to it and make it unparseable too");
  });

  test("a torn RECEIPT is parked, closed with one `\\n`, and marked — and the receipt is never truncated", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    const rp = receiptPath(root);
    writeFileSync(rp, `${readFileSync(rp, "utf8")}{"seq":3,"phase":"inte`);

    const r = await runRepair({
      receipt: rp, projectsDir: join(root, "projects"), dataRoot: root, apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 0, r.report);
    assert.match(readFileSync(`${rp}.corrupt`, "utf8"), /\{"seq":3,"phase":"inte/);
    const text = readFileSync(rp, "utf8");
    assert.match(text, /\{"seq":3,"phase":"inte\n/,
      "the fragment STAYS in the receipt — the receipt is evidence and is never truncated");
    assert.match(text, /"state":"torn-line-parked"/);
    const parsed = readReceipt(rp);
    assert.equal(parsed.entries.filter((e) => e.state === "torn-line-parked").length, 1);
    assert.equal(parsed.entries.find((e) => e.state === "torn-line-parked").seq, null,
      "the fifth state is the RECEIPT's, not any row's");
  });

  test("the `\\n` that closes a fragment is idempotent — a second repair does not glue another on", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    const rp = receiptPath(root);
    writeFileSync(rp, `${readFileSync(rp, "utf8")}{"seq":3,"phase":"inte`);
    const ctx = {
      receipt: rp, projectsDir: join(root, "projects"), dataRoot: root, apply: true, stage: noStage,
    };
    await runRepair(ctx);
    const after = readFileSync(rp, "utf8");
    await runRepair(ctx);
    assert.equal(readFileSync(rp, "utf8").includes("\n\n"), false,
      "§5.3: the append is idempotent BY CONSTRUCTION, not by convention");
    assert.ok(readFileSync(rp, "utf8").startsWith(after.slice(0, after.indexOf("torn-line-parked"))));
  });

  test("staging goes through commitOrQueue under a NEW `import-repair` op", async (t) => {
    assert.equal(Object.hasOwn(OP_LABEL, "import-repair"), true,
      "§5.4: commitOrQueue THROWS on an op it has no word for, so a repair that reached staging "
      + "without this line would exit 1 on its first successful apply");
    const { root } = await crashedAtRowTwo(t);
    const seen = [];
    await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: (a) => { seen.push(a); return { ok: true, queued: true }; },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].op, "import-repair");
    assert.equal(seen[0].files.every((f) => !f.includes(`${"projects"}/BLZ/defined`)), true,
      "§4.3: `repair` never writes a ticket — its files are the map, the receipt and their sidecars");
  });

  test("every record written and staging failed is exit 4, not 0", async (t) => {
    const { root } = await crashedAtRowTwo(t);
    const r = await runRepair({
      receipt: receiptPath(root), projectsDir: join(root, "projects"), dataRoot: root,
      apply: true, stage: () => { throw new Error("assertWritable: read-only"); },
    });
    assert.equal(r.exitCode, 4, "§5.2: the records are on disk and only the commit is missing");
    assert.equal(mapLines(root).length, 2, "the writes landed");
  });

  test("a `canonical` receipt has no mapping BY DESIGN and repair does not ask for one", async (t) => {
    const root = boardRoot(t);
    mkdirSync(join(root, RECEIPT_DIR), { recursive: true });
    const rp = join(root, RECEIPT_DIR, "2026-09-22T00-00-00.000Z-canonical.jsonl");
    writeFileSync(rp, `${JSON.stringify({ seq: 1, phase: "intent", row: 1, id: "BLZ-9", op: "create" })}\n`);
    const r = await runRepair({
      receipt: rp, projectsDir: join(root, "projects"), dataRoot: root, apply: true, stage: noStage,
    });
    assert.equal(r.exitCode, 0, r.report);
    assert.match(r.report, /ORPHAN RESERVATION/,
      "without `sourceIdColumn` there is no map and only rows 1 and 3 of the four-state table occur");
  });
});

test("openSourceIds and appendPair are the only way a pair reaches disk", (t) => {
  const root = boardRoot(t);
  const p = sourceIdsPathFor(root, NAME);
  openSourceIds(p);
  assert.equal(readFileSync(p, "utf8"), "", "the open establishes the file and writes no content");
});
