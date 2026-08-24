// tests/schedule-runner.test.mjs — BLZ-385 / BLZ-387, the I/O half.
//
// The planners are tested purely in tests/model/. This spawns the real runner against a REAL
// temp board, because the two things that can only fail at the I/O boundary are the two things
// this migration must not get wrong: writing the wrong file, and writing at all when it was
// asked not to.
//
// `--write` is exercised HERE and nowhere near the live board. BLZ-384's scope is explicit that
// the tool is built and proven and the operator runs the real write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(REPO, "scripts", "cli.mjs");

function board(tickets) {
  const root = mkdtempSync(join(tmpdir(), "sched-"));
  writeFileSync(join(root, "blaze.config.json"), JSON.stringify({ schema_version: 2, projects: ["TST"] }));
  mkdirSync(join(root, "projects", "TST", "defined"), { recursive: true });
  mkdirSync(join(root, "projects", "TST", "done"), { recursive: true });
  writeFileSync(join(root, "projects", "TST", "project.json"),
    JSON.stringify({ key: "TST", name: "T", labels: [], components: [] }));
  for (const t of tickets) {
    const { status, ...fm } = t;
    const body = Object.entries({
      id: fm.id, title: "t", type: fm.type ?? "task", project: "TST", priority: "medium",
      resolution: status === "done" ? "done" : "", parent: "", assignee: "unassigned",
      labels: "[]", components: "[]",
      ...(fm.estimate ? { estimate: fm.estimate } : {}),
      ...(fm.start ? { start: fm.start } : {}),
      ...(fm.due ? { due: fm.due } : {}),
    }).map(([k, v]) => `${k}: ${v}`).join("\n")
      // The block form real tickets use; the inline `links: [{...}]` string does not parse.
      + (fm.links ? "\nlinks:\n" + fm.links.map((l) => `  - { type: ${l.type}, target: ${l.target} }`).join("\n") : "");
    writeFileSync(join(root, "projects", "TST", status, `${fm.id}-x.md`), `---\n${body}\n---\nbody text\n`);
  }
  return root;
}

const run = (root, args) => spawnSync(process.execPath, [cli, "schedule", ...args],
  { encoding: "utf8", cwd: root, env: { ...process.env, BLAZE_DATA: root } });

const read = (root, status, id) =>
  readFileSync(join(root, "projects", "TST", status, `${id}-x.md`), "utf8");

test("the dry run is the DEFAULT and writes nothing", () => {
  const root = board([
    { id: "TST-1", status: "defined", start: "2026-08-11", due: "2026-08-16" },
    { id: "TST-2", status: "done", start: "2026-06-01", due: "2026-06-05" },
  ]);
  const before = read(root, "defined", "TST-1");
  const r = run(root, ["migrate-dates"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run — nothing written/);
  assert.equal(read(root, "defined", "TST-1"), before, "the file is byte-identical");
});

test("the dry run names the cohort and both fields for every affected ticket", () => {
  // §4.1 item 1: "prints one line per affected ticket naming the cohort and both the old and
  // new field. All 40 ids fit on one screen."
  const root = board([
    { id: "TST-1", status: "defined", start: "2026-08-11", due: "2026-08-16" },
    { id: "TST-2", status: "done", start: "2026-06-01", due: "2026-06-05" },
    { id: "TST-3", status: "defined", due: "2026-10-20" },
  ]);
  const r = run(root, ["migrate-dates", "--dry-run"]);
  assert.match(r.stdout, /TST-1\s+constraints-both\s+not_before=2026-08-11 deadline=2026-08-16/);
  assert.match(r.stdout, /TST-2\s+terminal-actuals-both\s+start=2026-06-01 due=2026-06-05/);
  assert.match(r.stdout, /TST-3\s+constraints-due-only\s+deadline=2026-10-20/);
  assert.match(r.stdout, /FROZEN as actuals \(terminal, kept verbatim\): 1/);
  assert.match(r.stdout, /MIGRATED to constraints \(non-terminal\): 2/);
});

test("--write migrates the non-terminal ticket and LEAVES THE TERMINAL ONE BYTE-IDENTICAL", () => {
  // The single most important property of the whole migration: §4's 28 frozen actuals are
  // history, and a migration that rewrites them has destroyed the thing it exists to protect.
  const root = board([
    { id: "TST-1", status: "defined", start: "2026-08-11", due: "2026-08-16" },
    { id: "TST-2", status: "done", start: "2026-06-01", due: "2026-06-05" },
  ]);
  const frozenBefore = read(root, "done", "TST-2");
  const r = run(root, ["migrate-dates", "--write"]);
  assert.equal(r.status, 0, r.stderr);

  const after = read(root, "defined", "TST-1");
  assert.match(after, /^not_before: 2026-08-11$/m);
  assert.match(after, /^deadline: 2026-08-16$/m);
  assert.ok(!/^start:/m.test(after), "start is cleared, because it is now derived");
  assert.ok(!/^due:/m.test(after), "due is cleared too");
  assert.match(after, /^body text$/m, "and the body survives the rewrite");

  assert.equal(read(root, "done", "TST-2"), frozenBefore, "the frozen actual is untouched, byte for byte");
});

test("--write is IDEMPOTENT — a second run changes nothing", () => {
  const root = board([{ id: "TST-1", status: "defined", start: "2026-08-11", due: "2026-08-16" }]);
  run(root, ["migrate-dates", "--write"]);
  const once = read(root, "defined", "TST-1");
  const r = run(root, ["migrate-dates", "--write"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(root, "defined", "TST-1"), once, "the second run is a no-op, not a clobber");
  assert.match(r.stdout, /MIGRATED to constraints \(non-terminal\): 0/);
});

test("import-deps reports and refuses --write, naming the reason", () => {
  const root = board([
    { id: "TST-1", status: "defined", links: [{ type: "Blocks", target: "TST-2" }] },
    { id: "TST-2", status: "defined", links: [{ type: "Blocks", target: "TST-1" }] },
  ]);
  const ok = run(root, ["import-deps"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /UNDECIDABLE \(2\)/);
  assert.match(ok.stdout, /Nothing written/);

  const refused = run(root, ["import-deps", "--write"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /has no --write/);
  assert.match(refused.stderr, /mutual and carry no direction/, "the refusal names WHY, not just no");
});

test("an unknown subcommand and an unknown flag both fail loudly", () => {
  const root = board([{ id: "TST-1", status: "defined" }]);
  assert.notEqual(run(root, ["nonsense"]).status, 0);
  assert.notEqual(run(root, ["migrate-dates", "--nonsense"]).status, 0);
});
