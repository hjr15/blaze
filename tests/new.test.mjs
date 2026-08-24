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

test("applyNew creates a validated task in the initial status dir with a namespaced id", async () => {
  const r = root(); const projects = join(r, "projects");
  const res = await applyNew(projects, { project: "OBA", type: "task", title: "Wire gateway timeout",
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

test("applyNew increments the id on the second create", async () => {
  const r = root(); const projects = join(r, "projects");
  await applyNew(projects, { project: "OBA", type: "task", title: "first", today: "2026-06-29", extra: { estimate: 5 } });
  const res = await applyNew(projects, { project: "OBA", type: "task", title: "second", today: "2026-06-29", extra: { estimate: 5 } });
  assert.equal(res.id, "OBA-2");
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rejects an unknown type and a leaf with no estimate", async () => {
  const r = root(); const projects = join(r, "projects");
  assert.equal((await applyNew(projects, { project: "OBA", type: "nope", title: "x", today: "2026-06-29" })).ok, false);
  const noEst = await applyNew(projects, { project: "OBA", type: "task", title: "x", today: "2026-06-29" });
  assert.equal(noEst.ok, false);
  assert.ok(noEst.errors.some((e) => /estimate/.test(e)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew places a goal in its own initial status", async () => {
  const r = root(); const projects = join(r, "projects");
  const res = await applyNew(projects, { project: "OBA", type: "goal", title: "Ship v1", today: "2026-06-29" });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(res.status, "defined");
  assert.ok(readdirSync(join(projects, "OBA", "defined")).length === 1);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rounds the estimate to 5m at create", async () => {
  const r = root(); const projects = join(r, "projects");
  const res = await applyNew(projects, { project: "OBA", type: "task", title: "round me",
    today: "2026-06-29", extra: { estimate: 33 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /estimate: 35/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew: a positive sub-5m estimate is bumped to 5, not dropped", async () => {
  const r = root(); const projects = join(r, "projects");
  const res = await applyNew(projects, { project: "OBA", type: "task", title: "tiny",
    today: "2026-06-29", extra: { estimate: 2 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.match(readFileSync(res.file, "utf8"), /estimate: 5/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew sets components from extra.components and round-trips", async () => {
  const r = root();
  const projects = join(r, "projects");
  const res = await applyNew(projects, {
    project: "OBA", type: "task", title: "comp task", today: "2026-07-15",
    extra: { components: ["auth", "gateway"], estimate: 30 },
  });
  assert.equal(res.ok, true);
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /components: \[auth, gateway\]/);
  rmSync(r, { recursive: true, force: true });
});

test("applyNew hard-rejects an off-taxonomy component", async () => {
  const r = root();
  const projects = join(r, "projects");
  mkdirSync(join(projects, "OBA"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ components: ["auth"], labels: [] }));
  const res = await applyNew(projects, {
    project: "OBA", type: "task", title: "bad comp", today: "2026-07-15",
    extra: { components: ["auth", "bogus"], estimate: 30 },
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /bogus/.test(e)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew warns (does not block) on empty required components", async () => {
  const r = root();
  const projects = join(r, "projects");
  mkdirSync(join(projects, "OBA"), { recursive: true });
  writeFileSync(join(projects, "OBA", "project.json"),
    JSON.stringify({ components: ["auth"], requireComponents: true }));
  const res = await applyNew(projects, { project: "OBA", type: "task", title: "no comp", today: "2026-07-15", extra: { estimate: 30 } });
  assert.equal(res.ok, true);                       // NOT blocked
  assert.ok(res.warnings.some((w) => /component/.test(w)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew accepts sprint/not_before/deadline, and REFUSES start/due", async () => {
  const r = root();
  const projects = join(r, "projects");
  writeFileSync(join(r, "sprints.json"), JSON.stringify({
    active: "S1", sprints: [{ id: "S1", name: "Mid-July", start: "2026-07-13", end: "2026-07-26" }],
  }));
  const res = await applyNew(projects, {
    project: "OBA", type: "task", title: "sprint task", today: "2026-07-15",
    extra: { estimate: 30, sprint: "S1", not_before: "2026-07-20", deadline: "2026-07-24" },
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  const txt = readFileSync(res.file, "utf8");
  assert.match(txt, /sprint: S1/);
  assert.match(txt, /not_before: 2026-07-20/);
  assert.match(txt, /deadline: 2026-07-24/);

  // Inverted by BLZ-386 rather than deleted: this test locked in `start`/`due` on the create
  // path, which is the contract ADR-0022 removes. Closing only the runner left this library
  // verb open, and an adversarial review found the flags that replaced them were parsed,
  // documented and then dropped on the floor.
  assert.ok(!/^start:/m.test(txt), "start is the scheduler's output, not a create-time input");
  assert.ok(!/^due:/m.test(txt));

  // And the validator now actually sees them, which it could not while the value never
  // reached frontmatter.
  const bad = await applyNew(projects, {
    project: "OBA", type: "task", title: "bad deadline", today: "2026-07-15",
    extra: { estimate: 30, deadline: "garbage" },
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /deadline .*YYYY-MM-DD/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew rejects a sprint id not in the registry", async () => {
  const r = root();
  const projects = join(r, "projects");
  const res = await applyNew(projects, {
    project: "OBA", type: "task", title: "bad sprint", today: "2026-07-15",
    extra: { estimate: 30, sprint: "S9" },
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /sprint 'S9'/.test(e)));
  rmSync(r, { recursive: true, force: true });
});

test("applyNew WITHOUT sprint fields writes no sprint:/start:/due: lines (M2 delete-guard)", async () => {
  const r = root();
  const projects = join(r, "projects");
  const res = await applyNew(projects, { project: "OBA", type: "task", title: "plain task", today: "2026-07-15", extra: { estimate: 30 } });
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
  const res = await applyNew(projects, { project: "PROJ", type: "task", title: "Wire the gateway",
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

async function seedParent(projects, { type, title }) {
  const res = await applyNew(projects, { project: "OBA", type, title, today: "2026-08-07",
    extra: { estimate: type === "goal" || type === "epic" ? undefined : 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  return res.id;
}

test("INF-791: applyNew REJECTS a feature parented to a feature", async () => {
  const r = root(); const projects = join(r, "projects");
  const goal = await seedParent(projects, { type: "goal", title: "the goal" });
  const feat = await applyNew(projects, { project: "OBA", type: "feature", title: "the feature",
    today: "2026-08-07", extra: { parent: goal } });
  assert.equal(feat.ok, true, JSON.stringify(feat.errors));

  const bad = await applyNew(projects, { project: "OBA", type: "feature", title: "child feature",
    today: "2026-08-07", extra: { parent: feat.id } });
  assert.equal(bad.ok, false, "feature -> feature must be refused at create time");
  assert.ok(bad.errors.some((e) => /invalid parent/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("BLZ-231: applyNew REJECTS a new epic anywhere — the type is retired, not deleted", async () => {
  const r = root(); const projects = join(r, "projects");
  const goal = await seedParent(projects, { type: "goal", title: "the goal" });
  const bad = await applyNew(projects, { project: "OBA", type: "epic", title: "a new epic",
    today: "2026-08-07", extra: { parent: goal } });
  assert.equal(bad.ok, false, "an epic has no legal parent, so none can be created");
  assert.ok(bad.errors.some((e) => /invalid parent/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: applyNew REJECTS a task parented to a goal", async () => {
  const r = root(); const projects = join(r, "projects");
  const goal = await seedParent(projects, { type: "goal", title: "the goal" });
  const bad = await applyNew(projects, { project: "OBA", type: "task", title: "orphan task",
    today: "2026-08-07", extra: { parent: goal, estimate: 30 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /invalid parent/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: applyNew REJECTS a parent that does not exist", async () => {
  const r = root(); const projects = join(r, "projects");
  await seedParent(projects, { type: "goal", title: "the goal" });
  const bad = await applyNew(projects, { project: "OBA", type: "task", title: "dangling",
    today: "2026-08-07", extra: { parent: "OBA-9999", estimate: 30 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /parent not found/.test(e)), JSON.stringify(bad.errors));
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: applyNew ACCEPTS every legal pair (the check discriminates both ways)", async () => {
  const r = root(); const projects = join(r, "projects");
  const goal = await seedParent(projects, { type: "goal", title: "the goal" });
  const req = await applyNew(projects, { project: "OBA", type: "requirement", title: "a requirement",
    today: "2026-08-07", extra: { parent: goal } });
  assert.equal(req.ok, true, JSON.stringify(req.errors));
  const feat = await applyNew(projects, { project: "OBA", type: "feature", title: "the feature",
    today: "2026-08-07", extra: { parent: req.id } });
  assert.equal(feat.ok, true, JSON.stringify(feat.errors));
  for (const t of ["story", "task", "bug"]) {
    const res = await applyNew(projects, { project: "OBA", type: t, title: `a ${t}`,
      today: "2026-08-07", extra: { parent: feat.id, estimate: 30 } });
    assert.equal(res.ok, true, `${t} -> feature must be allowed: ${JSON.stringify(res.errors)}`);
  }
  // A risk reaches every altitude it can threaten (BLZ-231).
  for (const [parent, label] of [[goal, "goal"], [req.id, "requirement"], [feat.id, "feature"]]) {
    const res = await applyNew(projects, { project: "OBA", type: "risk", title: `a risk on ${label}`,
      today: "2026-08-07", extra: { parent, likelihood: "medium", impact: "high" } });
    assert.equal(res.ok, true, `risk -> ${label} must be allowed: ${JSON.stringify(res.errors)}`);
  }
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: a rejected create does NOT burn an id", async () => {
  const r = root(); const projects = join(r, "projects");
  const goal = await seedParent(projects, { type: "goal", title: "the goal" });
  const before = reservedIds(r, "OBA");
  assert.deepEqual(before, [1], `expected only the goal's id reserved, got ${before}`);

  const bad = await applyNew(projects, { project: "OBA", type: "task", title: "rejected",
    today: "2026-08-07", extra: { parent: goal, estimate: 30 } });
  assert.equal(bad.ok, false);

  const after = reservedIds(r, "OBA");
  assert.deepEqual(after, before, `a rejected create burned an id: ${before} -> ${after}`);

  // And the next SUCCESSFUL create takes the id the rejection would have eaten.
  const req = await applyNew(projects, { project: "OBA", type: "requirement", title: "next",
    today: "2026-08-07", extra: { parent: goal } });
  assert.equal(req.ok, true, JSON.stringify(req.errors));
  assert.equal(req.id, "OBA-2", "the id after a rejected create must not skip");
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: a create rejected for a NON-parent reason also keeps its id", async () => {
  const r = root(); const projects = join(r, "projects");
  await seedParent(projects, { type: "goal", title: "the goal" });
  const before = reservedIds(r, "OBA");
  const bad = await applyNew(projects, { project: "OBA", type: "task", title: "no estimate",
    today: "2026-08-07" });
  assert.equal(bad.ok, false);
  assert.deepEqual(reservedIds(r, "OBA"), before);
  rmSync(r, { recursive: true, force: true });
});

test("INF-791: a parentless non-goal is still allowed (missing parent is soft)", async () => {
  const r = root(); const projects = join(r, "projects");
  const res = await applyNew(projects, { project: "OBA", type: "task", title: "no parent",
    today: "2026-08-07", extra: { estimate: 30 } });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  rmSync(r, { recursive: true, force: true });
});
