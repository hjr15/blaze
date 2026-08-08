// tests/new.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyNew } from "../scripts/new.mjs";

// BLZ-136: allocation reserves ids in the shared git common dir, so a board root
// must be a real git worktree. commonDirFor fails loud rather than degrading to
// an unshared reservation, so the fixture is a repo — the guard is not weakened
// for tests.
function root() {
  const d = mkdtempSync(join(tmpdir(), "blaze-new-"));
  execFileSync("git", ["-C", d, "init", "-q", "-b", "main"]);
  return d;
}

test("applyNew creates a validated task in the initial status dir with a namespaced id", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "Wire gateway timeout",
    priority: "high", labels: ["infra"], today: "2026-06-29", extra: { estimate: 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.id, "OBA-1");
  assert.equal(res.status, "defined");
  assert.ok(existsSync(res.file));
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /id: OBA-1/);
  assert.match(txt, /type: task/);
  assert.match(txt, /estimate: 30/);
  assert.match(txt, /## Acceptance Criteria/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew increments the id on the second create", () => {
  const r = root(); const projects = join(r, "projects");
  applyNew(projects, { project: "OBA", type: "task", title: "first", today: "2026-06-29", extra: { estimate: 5 } });
  const res = applyNew(projects, { project: "OBA", type: "task", title: "second", today: "2026-06-29", extra: { estimate: 5 } });
  assert.equal(res.id, "OBA-2");
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rejects an unknown type and a leaf with no estimate", () => {
  const r = root(); const projects = join(r, "projects");
  assert.equal(applyNew(projects, { project: "OBA", type: "nope", title: "x", today: "2026-06-29" }).ok, false);
  const noEst = applyNew(projects, { project: "OBA", type: "task", title: "x", today: "2026-06-29" });
  assert.equal(noEst.ok, false);
  assert.ok(noEst.errors.some((e) => /estimate/.test(e)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew places a goal in its own initial status", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "goal", title: "Ship v1", today: "2026-06-29" });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.status, "defined");
  assert.ok(readdirSync(join(projects, "OBA", "defined")).length === 1);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rounds the estimate to 5m at create", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "round me",
    today: "2026-06-29", extra: { estimate: 33 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /estimate: 35/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew: a positive sub-5m estimate is bumped to 5, not dropped", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "tiny",
    today: "2026-06-29", extra: { estimate: 2 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.match(readFileSync(res.file, "utf8"), /estimate: 5/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew sets components from extra.components and round-trips", () => {
  const r = root();
  const projects = join(r, "projects");
  const res = applyNew(projects, {
    project: "OBA", type: "task", title: "comp task", today: "2026-07-15",
    extra: { components: ["auth", "gateway"], estimate: 30 },
  });
  assert.equal(res.ok, true);
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /components: \[auth, gateway\]/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew hard-rejects an off-taxonomy component", () => {
  const r = root();
  const projects = join(r, "projects");
  mkdirSync(join(projects, "OBA"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ components: ["auth"], labels: [] }));
  const res = applyNew(projects, {
    project: "OBA", type: "task", title: "bad comp", today: "2026-07-15",
    extra: { components: ["auth", "bogus"], estimate: 30 },
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /bogus/.test(e)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew warns (does not block) on empty required components", () => {
  const r = root();
  const projects = join(r, "projects");
  mkdirSync(join(projects, "OBA"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"),
    JSON.stringify({ components: ["auth"], requireComponents: true }));
  const res = applyNew(projects, { project: "OBA", type: "task", title: "no comp", today: "2026-07-15", extra: { estimate: 30 } });
  assert.equal(res.ok, true);                       // NOT blocked
  assert.ok(res.warnings.some((w) => /component/.test(w)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew accepts sprint/start/due when the sprint id is in the registry", () => {
  const r = root();
  const projects = join(r, "projects");
  writeFileSync(join(r, "sprints.json"), JSON.stringify({
    active: "S1", sprints: [{ id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" }],
  }));
  const res = applyNew(projects, {
    project: "OBA", type: "task", title: "sprint task", today: "2026-07-15",
    extra: { estimate: 30, sprint: "S1", start: "2026-07-20", due: "2026-07-24" },
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /sprint: S1/);
  assert.match(txt, /start: 2026-07-20/);
  assert.match(txt, /due: 2026-07-24/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rejects a sprint id not in the registry", () => {
  const r = root();
  const projects = join(r, "projects");
  const res = applyNew(projects, {
    project: "OBA", type: "task", title: "bad sprint", today: "2026-07-15",
    extra: { estimate: 30, sprint: "S9" },
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /sprint 'S9'/.test(e)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew WITHOUT sprint fields writes no sprint:/start:/due: lines (M2 delete-guard)", () => {
  const r = root();
  const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "plain task", today: "2026-07-15", extra: { estimate: 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const txt = readFileSync(res.file, "utf8");
  assert.doesNotMatch(txt, /^sprint:/m);
  assert.doesNotMatch(txt, /^start:/m);
  assert.doesNotMatch(txt, /^due:/m);
  rmSync(r, { recursive: true, force: true });
});

// BLZ-136: the claim must be created with the ticket and returned, so the batch
// ledger can stage both atomically. A ticket that reaches upstream without its
// claim merges exactly as silently as before the allocator existed.
test("BLZ-136: applyNew writes a claim beside the ticket and returns its path", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const r0 = root();
  execFileSync("git", ["-C", r0, "init", "-q", "-b", "main"]);
  const projects = join(r0, "projects");
  const res = applyNew(projects, { project: "PROJ", type: "task", title: "Wire the gateway",
    today: "2026-06-29", extra: { estimate: 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.ok(res.claimFile, "applyNew must return the claim path so the ledger can stage it");
  assert.equal(existsSync(res.claimFile), true);
  const n = res.id.split("-")[1];
  assert.equal(res.claimFile, join(projects, "PROJ", ".ids", n));
  assert.match(readFileSync(res.claimFile, "utf8"), new RegExp(res.id));
  rmSync(r0, { recursive: true, force: true });
});

// --- INF-791: `blaze new` must validate --parent, and must not burn an id -----

// The reservation ledger is the ground truth for "was an id consumed": allocateId
// creates <common>/blaze/ids/<KEY>/<N> with O_EXCL, and that reservation survives
// even when no ticket file is written. Reading it directly is how we prove a
// rejected create left the counter untouched, rather than inferring it.
function reservedIds(r, key) {
  const d = join(r, ".git", "blaze", "ids", key);
  try { return readdirSync(d).filter((e) => /^\d+$/.test(e)).map(Number).sort((a, b) => a - b); }
  catch { return []; }
}

function seedParent(projects, { type, title }) {
  const res = applyNew(projects, { project: "OBA", type, title, today: "2026-08-07",
    extra: { estimate: type === "goal" || type === "epic" ? undefined : 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  return res.id;
}

test("INF-791: applyNew REJECTS an epic parented to an epic", () => {
  const r = root(); const projects = join(r, "projects");
  const goal = seedParent(projects, { type: "goal", title: "the goal" });
  const epic = applyNew(projects, { project: "OBA", type: "epic", title: "the epic",
    today: "2026-08-07", extra: { parent: goal } });
  assert.equal(epic.ok, true, JSON.stringify(epic.errors));

  const bad = applyNew(projects, { project: "OBA", type: "epic", title: "child epic",
    today: "2026-08-07", extra: { parent: epic.id } });
  assert.equal(bad.ok, false, "epic -> epic must be refused at create time");
  assert.ok(bad.errors.some((e) => /invalid parent/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: applyNew REJECTS a task parented to a goal", () => {
  const r = root(); const projects = join(r, "projects");
  const goal = seedParent(projects, { type: "goal", title: "the goal" });
  const bad = applyNew(projects, { project: "OBA", type: "task", title: "orphan task",
    today: "2026-08-07", extra: { parent: goal, estimate: 30 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /invalid parent/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: applyNew REJECTS a parent that does not exist", () => {
  const r = root(); const projects = join(r, "projects");
  seedParent(projects, { type: "goal", title: "the goal" });
  const bad = applyNew(projects, { project: "OBA", type: "task", title: "dangling",
    today: "2026-08-07", extra: { parent: "OBA-9999", estimate: 30 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /parent not found/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: applyNew ACCEPTS every legal pair (the check discriminates both ways)", () => {
  const r = root(); const projects = join(r, "projects");
  const goal = seedParent(projects, { type: "goal", title: "the goal" });
  const epic = applyNew(projects, { project: "OBA", type: "epic", title: "the epic",
    today: "2026-08-07", extra: { parent: goal } });
  assert.equal(epic.ok, true, JSON.stringify(epic.errors));
  for (const t of ["story", "task", "bug"]) {
    const res = applyNew(projects, { project: "OBA", type: t, title: `a ${t}`,
      today: "2026-08-07", extra: { parent: epic.id, estimate: 30 } });
    assert.equal(res.ok, true, `${t} -> epic must be allowed: ${JSON.stringify(res.errors)}`);
  }
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: a rejected create does NOT burn an id", () => {
  const r = root(); const projects = join(r, "projects");
  const goal = seedParent(projects, { type: "goal", title: "the goal" });
  const before = reservedIds(r, "OBA");
  assert.deepEqual(before, [1], `expected only the goal's id reserved, got ${before}`);

  const bad = applyNew(projects, { project: "OBA", type: "task", title: "rejected",
    today: "2026-08-07", extra: { parent: goal, estimate: 30 } });
  assert.equal(bad.ok, false);

  const after = reservedIds(r, "OBA");
  assert.deepEqual(after, before, `a rejected create burned an id: ${before} -> ${after}`);

  // And the next SUCCESSFUL create takes the id the rejection would have eaten.
  const epic = applyNew(projects, { project: "OBA", type: "epic", title: "next",
    today: "2026-08-07", extra: { parent: goal } });
  assert.equal(epic.ok, true, JSON.stringify(epic.errors));
  assert.equal(epic.id, "OBA-2", "the id after a rejected create must not skip");
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: a create rejected for a NON-parent reason also keeps its id", () => {
  const r = root(); const projects = join(r, "projects");
  seedParent(projects, { type: "goal", title: "the goal" });
  const before = reservedIds(r, "OBA");
  const bad = applyNew(projects, { project: "OBA", type: "task", title: "no estimate",
    today: "2026-08-07" });
  assert.equal(bad.ok, false);
  assert.deepEqual(reservedIds(r, "OBA"), before);
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: a parentless non-goal is still allowed (missing parent is soft)", () => {
  const r = root(); const projects = join(r, "projects");
  const res = applyNew(projects, { project: "OBA", type: "task", title: "no parent",
    today: "2026-08-07", extra: { estimate: 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  rmSync(r, { recursive: true, force: true });
});
