// tests/model/events.test.mjs — BLZ-278. The replacement for `git log --follow`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stateAt, revertPlan } from "../../scripts/model/events.mjs";

const log = [
  { id: 1, kind: "create", detail: JSON.stringify({ status: "defined", title: "First", priority: "medium" }) },
  { id: 2, kind: "edit", field: "title", old_value: "First", new_value: "Second" },
  { id: 3, kind: "transition", from_status: "defined", to_status: "in-progress" },
  { id: 4, kind: "worklog", detail: '{"minutes":30}' },
  { id: 5, kind: "edit", field: "priority", old_value: "medium", new_value: "high" },
];

test("stateAt with no bound replays the whole log", () => {
  const { state } = stateAt(log);
  assert.deepEqual(state, { status: "in-progress", title: "Second", priority: "high" });
});

test("stateAt reconstructs the ticket as it was at any point — this is git log --follow", () => {
  assert.equal(stateAt(log, 1).state.title, "First");
  assert.equal(stateAt(log, 2).state.title, "Second");
  assert.equal(stateAt(log, 2).state.status, "defined", "the transition has not happened yet");
  assert.equal(stateAt(log, 3).state.status, "in-progress");
  assert.equal(stateAt(log, 4).state.priority, "medium", "the priority edit is still ahead");
});

test("stateAt REPORTS what it skipped rather than silently half-reconstructing", () => {
  // worklog/link/ac events are real history but carry no scalar field delta. Saying so
  // is the difference between "nothing changed" and "I ignored things".
  const { skipped, replayed } = stateAt(log);
  assert.deepEqual(skipped, { worklog: 1 });
  assert.equal(replayed, 4);
});

test("revertPlan returns a diff and does NOT apply it", () => {
  const { patch, noop } = revertPlan(log, 2);
  assert.equal(noop, false);
  assert.deepEqual(patch, {
    status: { from: "in-progress", to: "defined" },
    priority: { from: "high", to: "medium" },
  });
  assert.equal(patch.title, undefined, "title is already 'Second' at event 2 — not in the diff");
});

test("revertPlan to the head of the log is a no-op", () => {
  assert.equal(revertPlan(log, 5).noop, true);
  assert.deepEqual(revertPlan(log, 5).patch, {});
});

test("revertPlan to the create event restores the original", () => {
  const { patch } = revertPlan(log, 1);
  assert.deepEqual(patch, {
    title: { from: "Second", to: "First" },
    status: { from: "in-progress", to: "defined" },
    priority: { from: "high", to: "medium" },
  });
});

test("an empty log yields empty state rather than throwing", () => {
  assert.deepEqual(stateAt([]).state, {});
  assert.equal(revertPlan([], 1).noop, true);
});

test("a log with no create event still replays edits it does have", () => {
  // A ticket imported by migration may have no create event — the corpus's own
  // transitions.json covers only ~15% of tickets, so partial logs are the norm, not
  // an edge case.
  const partial = [{ id: 9, kind: "transition", from_status: "defined", to_status: "done" }];
  assert.deepEqual(stateAt(partial).state, { status: "done" });
});

// --- against a real database ----------------------------------------------------
import { openSqliteRead } from "../../scripts/model/sqlite-storage.mjs";

function seeded() {
  const s = openSqliteRead(":memory:", { create: true });
  s.db.prepare(
    `INSERT INTO ticket (id,project_key,num,type,status,title,body,created_on,updated_on)
     VALUES ('BLZ-1','BLZ',1,'task','defined','First','','2026-01-01','2026-01-01')`).run();
  const ev = (o) => s.appendEvent(null, { ticket_id: "BLZ-1", source: "cli", ...o });
  ev({ kind: "create", at: "2026-01-01T00:00:00Z",
       detail: JSON.stringify({ status: "defined", title: "First" }) });
  ev({ kind: "edit", at: "2026-01-02T00:00:00Z", field: "title",
       old_value: "First", new_value: "Second" });
  ev({ kind: "transition", at: "2026-01-03T00:00:00Z",
       from_status: "defined", to_status: "in-progress" });
  return s;
}

test("sqlite: listEvents returns the trail in chronological order", () => {
  const s = seeded();
  assert.deepEqual(s.listEvents(null, "BLZ-1").map((e) => e.kind),
    ["create", "edit", "transition"]);
});

test("sqlite: replaying listEvents reconstructs the ticket — git log --follow, replaced", () => {
  const s = seeded();
  const events = s.listEvents(null, "BLZ-1");
  assert.equal(stateAt(events, events[0].id).state.title, "First");
  assert.equal(stateAt(events).state.title, "Second");
  assert.equal(stateAt(events).state.status, "in-progress");
});

test("sqlite: the event log is append-only — the DATABASE refuses, not a convention", () => {
  const s = seeded();
  assert.throws(() => s.db.exec("UPDATE ticket_event SET actor = 'forged'"), /append-only/);
  assert.throws(() => s.db.exec("DELETE FROM ticket_event"), /append-only/);
});

test("sqlite: a ticket with events cannot be deleted out from under its history", () => {
  const s = seeded();
  assert.throws(() => s.db.exec("DELETE FROM ticket WHERE id = 'BLZ-1'"));
});

test("sqlite: the transition view yields exactly the shape metrics.mjs consumes", () => {
  const s = seeded();
  const rows = s.db.prepare("SELECT * FROM ticket_transition").all();
  assert.equal(rows.length, 1, "only the transition event, not the edit or create");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["actor", "from", "id", "source", "to", "ts"]);
  assert.deepEqual({ id: rows[0].id, from: rows[0].from, to: rows[0].to },
    { id: "BLZ-1", from: "defined", to: "in-progress" });
});

test("sqlite: revertPlan over real events describes the change without making it", () => {
  const s = seeded();
  const events = s.listEvents(null, "BLZ-1");
  const { patch } = revertPlan(events, events[0].id);
  assert.deepEqual(patch, {
    title: { from: "Second", to: "First" },
    status: { from: "in-progress", to: "defined" },
  });
  // nothing was written
  assert.equal(s.listEvents(null, "BLZ-1").length, 3);
});
