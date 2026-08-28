// tests/walk-unreadable-dirs.test.mjs — BLZ-470.
//
// BLZ-430 fixed a real crash by skipping any directory under `projects/` that carries a
// `.git` entry. The skip is SILENT, so a repo-shaped directory now takes its tickets off
// the board with no finding and no counter — which is the same class BLZ-430 explicitly
// refused to introduce for malformed `.md` files (those still throw), and the class this
// whole programme exists to end: A RUN THAT COULD NOT LOOK MUST NOT REPORT WHAT A RUN THAT
// LOOKED AND FOUND NOTHING REPORTS.
//
// Measured before the fix, on the 8-ticket board `board()` builds below:
//
//   zero-byte `.git` in a PROJECT directory   8 ids -> 4
//   zero-byte `.git` in a STATUS  directory   8 ids -> 6
//   `chmod 000` on a PROJECT directory        8 ids -> 4   (safeReaddir's swallowed error)
//
// The reporting channel is `unreadableTicketDirs`, a NAMED read rather than a parameter on
// the generator — see its own comment and ADR-0030 for why. The first test here is the one
// that matters: it does not trust either implementation, it compares the reporter against
// GROUND TRUTH — the ids the walk actually lost.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { unreadableTicketDirs } from "../scripts/model/index.mjs";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";
import { reconcile } from "../scripts/reconcile.mjs";

/** Eight tickets, two projects, two status directories each — so a project-level skip and
 *  a status-level skip lose different, checkable amounts. */
function board(tmp) {
  const projects = join(tmp, "projects");
  let n = 0;
  for (const [key, statuses] of [["BLZ", ["defined", "done"]], ["OBA", ["defined", "done"]]]) {
    for (const status of statuses) {
      mkdirSync(join(projects, key, status), { recursive: true });
      for (let i = 0; i < 2; i++) {
        n += 1;
        writeFileSync(join(projects, key, status, `${key}-${n}-t.md`),
          `---\nid: ${key}-${n}\ntype: task\nproject: ${key}\n---\n\nbody\n`);
      }
    }
  }
  return projects;
}

const idsUnder = (projects) =>
  [...fsReadStorage.listTickets(projects)].map((t) => t.frontmatter.id).sort();

/** The shapes that make a directory unreadable, each with the directory it is applied to. */
const SHAPES = [
  { name: "a zero-byte `.git` file in a PROJECT directory",
    at: ["BLZ"], make: (p) => writeFileSync(join(p, ".git"), ""), reason: "git-file-empty" },
  { name: "a zero-byte `.git` file in a STATUS directory",
    at: ["BLZ", "defined"], make: (p) => writeFileSync(join(p, ".git"), ""), reason: "git-file-empty" },
  { name: "a junk `.git` file that is not a gitdir pointer",
    at: ["BLZ", "defined"], make: (p) => writeFileSync(join(p, ".git"), "not a pointer\n"),
    reason: "git-file-unrecognised" },
  { name: "a `.git` DIRECTORY — a plain clone",
    at: ["BLZ", "defined"], make: (p) => mkdirSync(join(p, ".git")), reason: "nested-repo" },
  { name: "a `gitdir:` pointer — what `git submodule add` writes",
    at: ["BLZ", "defined"],
    make: (p) => writeFileSync(join(p, ".git"), "gitdir: ../../../.git/modules/vendor\n"),
    reason: "nested-repo-pointer" },
  { name: "a PROJECT directory Blaze cannot list at all",
    at: ["BLZ"], make: (p) => chmodSync(p, 0o000), undo: (p) => chmodSync(p, 0o755),
    reason: "directory-unreadable" },
];

describe("BLZ-470: a skipped directory is REPORTED, not silently dropped", () => {
  for (const shape of SHAPES) {
    test(`${shape.name} is named by unreadableTicketDirs`, () => {
      const tmp = mkdtempSync(join(tmpdir(), "blz470-"));
      const target = join(tmp, "projects", ...shape.at);
      try {
        const projects = board(tmp);
        const before = idsUnder(projects);
        assert.equal(before.length, 8, "the fixture itself must hold all eight ids");

        shape.make(target);
        const after = idsUnder(projects);
        const lost = before.filter((id) => !after.includes(id));
        assert.ok(lost.length > 0,
          `${shape.name} must actually cost the walk some tickets, or this test proves nothing`);

        const found = unreadableTicketDirs(projects);
        assert.equal(found.length, 1,
          `exactly one directory is unreadable; got ${JSON.stringify(found.map((f) => f.path))}`);
        assert.equal(found[0].path, target);
        assert.equal(found[0].reason, shape.reason);
        assert.equal(found[0].project, shape.at[0]);
        assert.equal(found[0].status, shape.at[1] ?? null);
        // The message must say the count cannot be trusted — AC-2. A report that names the
        // directory but lets the total still read as a total has closed half the ticket.
        assert.match(found[0].message, /floor, not a total/);
      } finally {
        if (shape.undo) { try { shape.undo(target); } catch { /* already gone */ } }
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  test("GROUND TRUTH: the reporter names exactly the directories the walk lost tickets from", () => {
    // The reporter and the walk each traverse the tree, so they can drift. This is the
    // oracle that stops that: for every shape above, the set of directories the reporter
    // names must equal the set of directories the LOST ids actually came from — derived
    // from the walk itself, not from the reporter's own answer.
    let checked = 0;
    for (const shape of SHAPES) {
      const tmp = mkdtempSync(join(tmpdir(), "blz470-truth-"));
      const target = join(tmp, "projects", ...shape.at);
      try {
        const projects = board(tmp);
        const before = new Map([...fsReadStorage.listTickets(projects)]
          .map((t) => [t.frontmatter.id, `${t.project}/${t.status}`]));
        shape.make(target);
        const after = new Set([...fsReadStorage.listTickets(projects)].map((t) => t.frontmatter.id));
        const lostFrom = new Set();
        for (const [id, where] of before) if (!after.has(id)) lostFrom.add(where);

        // What the reporter names, expanded to the same "project/status" grain: a PROJECT
        // directory reported unreadable stands for every status directory beneath it.
        const named = new Set();
        for (const f of unreadableTicketDirs(projects)) {
          for (const where of lostFrom) {
            if (f.status === null ? where.startsWith(`${f.project}/`) : where === `${f.project}/${f.status}`) {
              named.add(where);
            }
          }
        }
        assert.deepEqual([...named].sort(), [...lostFrom].sort(),
          `${shape.name}: the reporter must account for every directory the walk lost`);
        assert.ok(lostFrom.size > 0, `${shape.name}: nothing was lost, so nothing was proven`);
        checked += 1;
      } finally {
        if (shape.undo) { try { shape.undo(target); } catch { /* already gone */ } }
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    assert.equal(checked, SHAPES.length,
      `the oracle must cover every shape; a smaller number means SHAPES shrank (${SHAPES.length})`);
    assert.equal(SHAPES.length, 6, "six shapes make a directory unreadable — see the table above");
  });

  test("a healthy board reports nothing — the finding is not a fill queue", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz470-clean-"));
    try {
      const projects = board(tmp);
      assert.deepEqual(unreadableTicketDirs(projects), []);
      assert.equal(idsUnder(projects).length, 8);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a projects directory that does not exist is not an unread corpus", () => {
    // A board with no `projects/` has no tickets to lose. Reporting it here would fire on
    // every fixture that never built one, which is the gate-people-learn-to-skip failure.
    const tmp = mkdtempSync(join(tmpdir(), "blz470-absent-"));
    try {
      assert.deepEqual(unreadableTicketDirs(join(tmp, "projects")), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a projects directory that exists but cannot be listed IS reported", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz470-rootperm-"));
    const projects = join(tmp, "projects");
    try {
      mkdirSync(projects, { recursive: true });
      chmodSync(projects, 0o000);
      const found = unreadableTicketDirs(projects);
      assert.equal(found.length, 1);
      assert.equal(found[0].reason, "directory-unreadable");
      assert.equal(found[0].project, null);
    } finally {
      try { chmodSync(projects, 0o755); } catch { /* already gone */ }
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the four `.git` shapes are told apart, not collapsed into one", () => {
    // AC-3: "A junk or zero-byte `.git` file is distinguished from a real nested repo, or
    // the finding says it could not tell." They are distinguished, and the two that are not
    // repositories say so in those words rather than accusing a repository that is not there.
    const tmp = mkdtempSync(join(tmpdir(), "blz470-shapes-"));
    try {
      const projects = board(tmp);
      const at = join(projects, "BLZ", "defined");
      const seen = new Map();
      for (const [make, reason] of [
        [() => mkdirSync(join(at, ".git")), "nested-repo"],
        [() => writeFileSync(join(at, ".git"), "gitdir: ../x\n"), "nested-repo-pointer"],
        [() => writeFileSync(join(at, ".git"), ""), "git-file-empty"],
        [() => writeFileSync(join(at, ".git"), "hello\n"), "git-file-unrecognised"],
      ]) {
        rmSync(join(at, ".git"), { recursive: true, force: true });
        make();
        const [f] = unreadableTicketDirs(projects);
        assert.equal(f.reason, reason);
        seen.set(reason, f.detail);
      }
      assert.equal(seen.size, 4, "four distinguishable shapes");
      assert.match(seen.get("git-file-empty"), /ZERO-BYTE/);
      assert.match(seen.get("git-file-empty"), /cannot tell whether one was meant/);
      assert.match(seen.get("git-file-unrecognised"), /cannot tell a repository from junk/);
      assert.match(seen.get("nested-repo"), /DIRECTORY/);
      assert.match(seen.get("nested-repo-pointer"), /gitdir/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// The two consumers. A reporter nothing reports through is not a report.
// =============================================================================

describe("BLZ-470: `blaze audit` refuses to call a corpus it could not finish reading clean", () => {
  const AUDIT = join(import.meta.dirname, "..", "scripts", "audit-runner.mjs");
  const runAudit = (projects, args = []) => spawnSync(process.execPath, [AUDIT, ...args, projects],
    { encoding: "utf8" });

  test("a clean board audits clean, and says the plain count", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz470-auditok-"));
    try {
      const res = runAudit(board(tmp));
      assert.match(res.stdout, /8 tickets across 2 project\(s\)$/m);
      assert.doesNotMatch(res.stdout, /FLOOR/);
      assert.match(res.stdout, /ok=true/);
      assert.equal(res.status, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a skipped directory is a HARD finding, and the count says it is a floor", () => {
    // Before this, `blaze audit` printed `6 tickets across 2 project(s)` and `ok=true` over
    // a board holding eight — a gate reporting a pass on a corpus it never read.
    const tmp = mkdtempSync(join(tmpdir(), "blz470-auditbad-"));
    try {
      const projects = board(tmp);
      writeFileSync(join(projects, "BLZ", "defined", ".git"), "");
      const res = runAudit(projects);
      assert.match(res.stdout, /6 tickets across 2 project\(s\) — a FLOOR, not a total: 1 directory could not be read/,
        "AC-2: the count must not be rendered as a total when it is not one");
      assert.match(res.stdout, /\[hard\] unreadable-ticket-directory: 1/);
      assert.match(res.stdout, /ok=false/);
      assert.equal(res.status, 1, "a hard finding exits non-zero — that is what makes it a gate");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--kind names the directory and what was found there", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz470-auditkind-"));
    try {
      const projects = board(tmp);
      mkdirSync(join(projects, "OBA", ".git"));
      const res = runAudit(projects, ["--kind", "unreadable-ticket-directory"]);
      assert.match(res.stdout, /projects\/OBA was NOT read/);
      assert.match(res.stdout, /`\.git` DIRECTORY/);
      assert.match(res.stdout, /floor, not a total/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BLZ-470: reconcile reports it too, on every run, filtered or not", () => {
  /** The audit fixture plus the two files reconcile needs to consider a project real. */
  function reconcilableBoard(tmp) {
    const root = join(tmp, "board");
    mkdirSync(root, { recursive: true });
    const projects = board(join(tmp, "board"));
    for (const key of ["BLZ", "OBA"]) {
      writeFileSync(join(projects, key, "project.json"), JSON.stringify({ key, codeRepos: [] }));
    }
    writeFileSync(join(root, "blaze.config.json"),
      JSON.stringify({ key: "BLZ", projects: ["BLZ", "OBA"] }));
    return root;
  }

  test("an unfiltered run raises the finding", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz470-rec-"));
    try {
      const root = reconcilableBoard(tmp);
      writeFileSync(join(root, "projects", "BLZ", "defined", ".git"), "");
      const r = await reconcile({ root, dryRun: true });
      const f = r.findings.filter((x) => x.kind === "unreadable-ticket-directory");
      assert.equal(f.length, 1);
      assert.equal(f[0].project, "BLZ");
      assert.equal(f[0].status, "defined");
      assert.equal(f[0].reason, "git-file-empty");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a run scoped to ANOTHER project still raises it — the scope cannot silence it", async () => {
    // The same argument BLZ-406 makes for `project-mismatch`, and it is stronger here: a
    // directory the walk skipped is invisible to every scope, so a scoped run that stayed
    // quiet about it would be exactly the silent skip the finding exists to report. It is
    // also the run most likely to be believed — `--project OBA` reporting nothing reads as
    // "OBA is in sync", not as "BLZ has an unreadable directory".
    const tmp = mkdtempSync(join(tmpdir(), "blz470-recscope-"));
    try {
      const root = reconcilableBoard(tmp);
      writeFileSync(join(root, "projects", "BLZ", "defined", ".git"), "");
      const r = await reconcile({ root, dryRun: true, projects: ["OBA"] });
      assert.deepEqual(r.scannedProjects, ["OBA"]);
      assert.equal(r.findings.filter((x) => x.kind === "unreadable-ticket-directory").length, 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a clean board raises nothing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz470-recclean-"));
    try {
      const r = await reconcile({ root: reconcilableBoard(tmp), dryRun: true });
      assert.deepEqual(r.findings.filter((x) => x.kind === "unreadable-ticket-directory"), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
