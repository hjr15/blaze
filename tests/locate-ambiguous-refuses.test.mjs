// tests/locate-ambiguous-refuses.test.mjs — BLZ-122.
//
// Every mutating verb resolves its target through a `locate()` that returned a SINGLE match
// and picked the first one it saw. When a board holds one id in two status directories, that
// silent pick does not merely act on an arbitrary copy — it writes a FALSE LINE INTO BOARD
// HISTORY. The recorded case: `blaze move INF-583 in-progress` rewrote the stale `defined/`
// duplicate of a ticket that was already `done`, and the resulting commit message asserted a
// transition that never happened.
//
// Choosing which duplicate is canonical needs judgement (on the seven 2026-08-11 cases the
// `done/` copy was right; that is not a general rule), and a wrong auto-pick silently destroys
// the real ticket. So the verbs REFUSE and name every path, mutating nothing — the operator
// decides, and `blaze audit`'s duplicate-status finding tells them it is there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMove } from "../scripts/move.mjs";
import { applyEdit, applyToggleAc } from "../scripts/edit.mjs";
import { applyLog } from "../scripts/log.mjs";
import { applyLink } from "../scripts/link.mjs";
import { applyResolve } from "../scripts/resolve.mjs";

function write(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, body);
  return f;
}

function ticketBody(id, status, title) {
  return `---\nid: ${id}\ntitle: ${title}\ntype: task\nproject: PROJ\npriority: medium\n` +
    `resolution: ${status === "done" ? "done" : ""}\nestimate: 30\nlabels: [infra]\ncomponents: [core]\n` +
    `created: 2026-01-01\nupdated: 2026-01-01\n---\n\n## Acceptance Criteria\n\n- [ ] one\n`;
}

/** PROJ-41 in `done/` AND `defined/` — the shape that reached published main. */
function ambiguousBoard() {
  const root = mkdtempSync(join(tmpdir(), "blaze-ambiguous-"));
  const projects = join(root, "projects");
  mkdirSync(join(projects, "PROJ"), { recursive: true });
  writeFileSync(join(projects, "PROJ", "project.json"),
    JSON.stringify({ key: "PROJ", components: ["core"], labels: ["infra"] }));
  const done = write(join(projects, "PROJ", "done"), "PROJ-41-real.md",
    ticketBody("PROJ-41", "done", "the real, finished one"));
  const defined = write(join(projects, "PROJ", "defined"), "PROJ-41-stale.md",
    ticketBody("PROJ-41", "defined", "the stale resurrected copy"));
  // An unambiguous neighbour, so the verbs are proven to still work on a clean id.
  const other = write(join(projects, "PROJ", "defined"), "PROJ-42-fine.md",
    ticketBody("PROJ-42", "defined", "an ordinary ticket"));
  return { root, projects, done, defined, other };
}

const VERBS = [
  ["blaze move",   async (p, id) => await applyMove(p, id, "in-progress", { today: "2026-01-02" })],
  ["blaze edit",   async (p, id) => await applyEdit(p, id, { priority: "high" }, { today: "2026-01-02" })],
  ["blaze log",    async (p, id) => await applyLog(p, id, 30, { today: "2026-01-02" })],
  ["blaze link",   async (p, id) => await applyLink(p, id, { type: "Relates", target: "PROJ-42" }, { today: "2026-01-02" })],
  ["blaze resolve",async (p, id) => await applyResolve(p, id, "done", { today: "2026-01-02" })],
  ["toggle-ac",    async (p, id) => await applyToggleAc(p, id, { index: 0, checked: true }, { today: "2026-01-02" })],
];

for (const [name, run] of VERBS) {
  test(`BLZ-122: ${name} REFUSES an ambiguous id, names every path, and mutates nothing`, async () => {
    const { root, projects, done, defined } = ambiguousBoard();
    const before = [done, defined].map((f) => readFileSync(f, "utf8"));

    const res = await run(projects, "PROJ-41");

    assert.equal(res.ok, false, `${name} must refuse rather than pick a copy`);
    const msg = res.errors.join("\n");
    // Naming one path sends the operator hunting for the other — the failure mode itself.
    assert.ok(msg.includes(done), `${name} must name the done/ copy:\n${msg}`);
    assert.ok(msg.includes(defined), `${name} must name the defined/ copy:\n${msg}`);
    assert.match(msg, /PROJ-41/);

    const after = [done, defined].map((f) => readFileSync(f, "utf8"));
    assert.deepEqual(after, before, `${name} must leave BOTH files byte-identical`);
    rmSync(root, { recursive: true, force: true });
  });
}

test("BLZ-122: an ambiguous LINK TARGET is refused too — the link would point at two tickets", async () => {
  const { root, projects, done, defined } = ambiguousBoard();
  const before = readFileSync(done, "utf8");
  const res = await applyLink(projects, "PROJ-42", { type: "Relates", target: "PROJ-41" }, { today: "2026-01-02" });
  assert.equal(res.ok, false, "a target resolving to two files is not a resolved target");
  const msg = res.errors.join("\n");
  assert.ok(msg.includes(done) && msg.includes(defined), `must name both target paths:\n${msg}`);
  assert.equal(readFileSync(done, "utf8"), before);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-122: the refusal is scoped to the ambiguous id — clean ids still work", async () => {
  const { root, projects, other } = ambiguousBoard();
  const res = await applyEdit(projects, "PROJ-42", { priority: "high" }, { today: "2026-01-02" });
  assert.equal(res.ok, true, `an unambiguous ticket must still edit: ${JSON.stringify(res.errors)}`);
  assert.match(readFileSync(other, "utf8"), /priority: high/);
  rmSync(root, { recursive: true, force: true });
});

test("BLZ-122: a genuinely missing id still reports 'not found', not 'ambiguous'", async () => {
  const { root, projects } = ambiguousBoard();
  const res = await applyLog(projects, "PROJ-999", 30, { today: "2026-01-02" });
  assert.equal(res.ok, false);
  assert.match(res.errors.join("\n"), /not found/);
  rmSync(root, { recursive: true, force: true });
});
