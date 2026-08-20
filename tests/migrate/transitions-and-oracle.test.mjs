// tests/migrate/transitions-and-oracle.test.mjs — BLZ-281.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";
import { fsReadStorage } from "../../scripts/model/read-storage.mjs";
import { loadCorpus } from "../../scripts/migrate/load-corpus.mjs";
import { importTransitions } from "../../scripts/migrate/import-transitions.mjs";
import { zeroDiff } from "../../scripts/migrate/zero-diff.mjs";

const doc = (fm, body = "body") =>
  ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", body, ""].join("\n");

function board(list) {
  const dir = mkdtempSync(join(tmpdir(), "blaze-mig-"));
  for (const t of list) {
    mkdirSync(join(dir, "BLZ", t.status), { recursive: true });
    writeFileSync(join(dir, "BLZ", t.status, `${t.id}-x.md`), t.text);
  }
  return dir;
}
const ticket = (id, status, extra = {}) => ({ id, status,
  text: doc({ id, title: id, type: "task", project: "BLZ", parent: "",
              priority: "high", assignee: "me", ...extra }) });

// --- transitions -----------------------------------------------------------------
test("transitions import verbatim, with the timestamp untouched", () => {
  const dir = board([ticket("BLZ-1", "done")]);
  const s = openSqliteRead(); loadCorpus(s.db, dir);
  const r = importTransitions(s.db,
    { transitions: [{ id: "BLZ-1", from: "defined", to: "done", ts: "2026-07-16T12:29:58+10:00" }] });
  assert.equal(r.imported, 1);
  const ev = s.listEvents(null, "BLZ-1")[0];
  assert.equal(ev.at, "2026-07-16T12:29:58+10:00",
    "carried through exactly — evidence that has been tidied is weaker evidence");
  assert.equal(ev.source, "git-backfill", "marked as backfill, not as a live write");
});

test("a transition for an unknown ticket is COUNTED, never invented", () => {
  const dir = board([ticket("BLZ-1", "done")]);
  const s = openSqliteRead(); loadCorpus(s.db, dir);
  const r = importTransitions(s.db,
    { transitions: [{ id: "BLZ-999", from: "a", to: "b", ts: "2026-07-16T12:00:00Z" }] });
  assert.equal(r.imported, 0);
  assert.equal(r.skipped.unknownTicket, 1);
});

test("a transition missing `from` cannot be an event and is counted, not forced", () => {
  // The event shape CHECK requires both statuses. Inventing a `from` to satisfy it
  // would put fiction in the audit trail.
  const dir = board([ticket("BLZ-1", "done")]);
  const s = openSqliteRead(); loadCorpus(s.db, dir);
  const r = importTransitions(s.db,
    { transitions: [{ id: "BLZ-1", to: "done", ts: "2026-07-16T12:00:00Z" }] });
  assert.equal(r.imported, 0);
  assert.equal(r.skipped.malformed, 1);
});

test("coverage is REPORTED, because the trail is known to be partial", () => {
  const dir = board([ticket("BLZ-1", "done"), ticket("BLZ-2", "defined"),
                     ticket("BLZ-3", "defined"), ticket("BLZ-4", "defined")]);
  const s = openSqliteRead(); loadCorpus(s.db, dir);
  const r = importTransitions(s.db,
    { transitions: [{ id: "BLZ-1", from: "defined", to: "done", ts: "2026-07-16T12:00:00Z" }] });
  assert.equal(r.ticketsCovered, 1);
  assert.equal(r.totalTickets, 4);
  assert.equal(r.coveragePct, 25,
    "the metrics view must surface this — history is squash-merged and cannot be recovered");
});

// --- the oracle ------------------------------------------------------------------
test("a faithful migration passes the oracle", () => {
  const dir = board([ticket("BLZ-1", "defined"), ticket("BLZ-2", "done")]);
  const s = openSqliteRead(); loadCorpus(s.db, dir);
  const z = zeroDiff(fsReadStorage, dir, s);
  assert.equal(z.ok, true);
  assert.equal(z.valueDiffs.length, 0);
  assert.equal(z.compared, 2);
});

test("the oracle CATCHES a changed value — it is not decorative", () => {
  const dir = board([ticket("BLZ-1", "defined")]);
  const s = openSqliteRead(); loadCorpus(s.db, dir);
  s.db.exec("UPDATE ticket SET title = 'tampered' WHERE id = 'BLZ-1'");
  const z = zeroDiff(fsReadStorage, dir, s);
  assert.equal(z.ok, false);
  assert.deepEqual(z.valueDiffs.map((d) => d.field), ["title"]);
});

test("the oracle catches a missing ticket and an extra one", () => {
  const dir = board([ticket("BLZ-1", "defined")]);
  const s = openSqliteRead();
  const z1 = zeroDiff(fsReadStorage, dir, s);
  assert.equal(z1.missing.length, 1, "loaded nothing — the ticket is missing");
  assert.equal(z1.ok, false);
});

test("an APPLIED DEFAULT is reported separately from a changed value", () => {
  // The source states no priority; the schema declares NOT NULL DEFAULT 'medium'.
  // That is not data loss — the value was never stated — but it IS a difference, so
  // it is named rather than either hidden or treated as a failure.
  const dir = board([{ id: "BLZ-1", status: "defined",
    text: doc({ id: "BLZ-1", title: "One", type: "task", project: "BLZ", parent: "" }) }]);
  const s = openSqliteRead();
  const load = loadCorpus(s.db, dir);
  assert.equal(load.defaultsApplied.priority, 1);
  const z = zeroDiff(fsReadStorage, dir, s);
  assert.equal(z.valueDiffs.length, 0, "an applied default is not a value change");
  assert.deepEqual(z.defaulted.map((d) => d.field), ["priority", "assignee"]);
  assert.equal(z.ok, true);
});

test("a DIFFERENT value in a defaulted field is still a failure", () => {
  // The escape hatch must not swallow a real change in the same field.
  const dir = board([ticket("BLZ-1", "defined", { priority: "high" })]);
  const s = openSqliteRead(); loadCorpus(s.db, dir);
  s.db.exec("UPDATE ticket SET priority = 'low' WHERE id = 'BLZ-1'");
  const z = zeroDiff(fsReadStorage, dir, s);
  assert.equal(z.ok, false, "high -> low is a change, not a default");
  assert.equal(z.valueDiffs[0].field, "priority");
});
