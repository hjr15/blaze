// tests/walk-nested-repo.test.mjs — BLZ-430.
//
// `walkTickets` reads `projects/<KEY>/<status>/*.md`, so it treats EVERY directory under a
// project as a status directory and every `.md` inside it as a ticket. A git SUBMODULE
// checked out under a project directory is therefore walked as a status, its `README.md` is
// parsed as a ticket, and `parseTicket` throws "missing frontmatter (--- on line 1)".
//
// The throw escapes the generator, so it does not degrade one ticket — it takes down the
// WHOLE walk, and with it `blaze audit`, `buildIndex`, the board view, `blaze new`/`edit`'s
// id resolution and `reconcile`. One neighbouring directory makes a whole board unreadable.
//
// A nested repository is a DIFFERENT repository's working tree. Its files are not this
// board's tickets under any reading, so the walk skips it rather than parsing it — which is
// narrower than "skip any .md that fails to parse", and deliberately so: a genuinely
// malformed TICKET must still be loud, and BLZ-430 is not a licence to swallow it.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fsReadStorage } from "../scripts/model/read-storage.mjs";

function board(tmp) {
  const projects = join(tmp, "projects");
  mkdirSync(join(projects, "BLZ", "defined"), { recursive: true });
  writeFileSync(join(projects, "BLZ", "defined", "BLZ-1-t.md"),
    "---\nid: BLZ-1\ntype: task\nproject: BLZ\n---\n\nbody\n");
  return projects;
}

/** A real `git submodule add`, so the on-disk shape is git's own and not a guess. */
function addSubmodule(parentDir, at) {
  const upstream = join(parentDir, "upstream-repo");
  mkdirSync(upstream, { recursive: true });
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", upstream, ...a]);
  }
  writeFileSync(join(upstream, "README.md"), "# a vendored library\n\nno frontmatter here.\n");
  execFileSync("git", ["-C", upstream, "add", "-A"]);
  execFileSync("git", ["-C", upstream, "commit", "-q", "-m", "seed"]);

  const host = join(parentDir, "board");
  for (const a of [["init", "-q", "-b", "main"], ["config", "user.email", "t@t.t"],
                   ["config", "user.name", "t"]]) {
    execFileSync("git", ["-C", host, ...a]);
  }
  execFileSync("git", ["-C", host, "-c", "protocol.file.allow=always",
    "submodule", "add", "-q", upstream, at]);
}

describe("BLZ-430: a submodule under a project directory does not make the board unreadable", () => {
  test("a real git submodule beside the status directories is skipped, not parsed", () => {
    const tmp = mkdtempSync(join(tmpdir(), "blz430-sub-"));
    try {
      mkdirSync(join(tmp, "board"), { recursive: true });
      board(join(tmp, "board"));
      addSubmodule(tmp, join("projects", "BLZ", "vendor-lib"));

      const projects = join(tmp, "board", "projects");
      const ids = [...fsReadStorage.listTickets(projects)].map((t) => t.frontmatter.id);
      assert.deepEqual(ids, ["BLZ-1"],
        "the board's one ticket must still be readable with a submodule beside it");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a submodule checked out AS a project directory is skipped too", () => {
    // The same shape one level up: `projects/<submodule>/` rather than
    // `projects/<KEY>/<submodule>/`. The walk treats its subdirectories as statuses.
    const tmp = mkdtempSync(join(tmpdir(), "blz430-subproj-"));
    try {
      mkdirSync(join(tmp, "board"), { recursive: true });
      board(join(tmp, "board"));
      addSubmodule(tmp, join("projects", "vendor-lib"));
      // Give it a subdirectory holding a non-ticket .md, so the walk would reach a file.
      const docs = join(tmp, "board", "projects", "vendor-lib", "docs");
      mkdirSync(docs, { recursive: true });
      writeFileSync(join(docs, "guide.md"), "# a guide\n");

      const projects = join(tmp, "board", "projects");
      const ids = [...fsReadStorage.listTickets(projects)].map((t) => t.frontmatter.id);
      assert.deepEqual(ids, ["BLZ-1"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the on-disk shape alone is enough — no git binary is consulted", () => {
    // `.git` as a FILE containing a `gitdir:` pointer is exactly what `git submodule add`
    // writes, and it is the whole signal the walk uses. Pinned separately so the guard
    // cannot quietly become a `git` invocation on the read path, which walks 2,700 files.
    const tmp = mkdtempSync(join(tmpdir(), "blz430-shape-"));
    try {
      const projects = board(tmp);
      const nested = join(projects, "BLZ", "vendor-lib");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, "README.md"), "# no frontmatter\n");
      writeFileSync(join(nested, ".git"), "gitdir: ../../../.git/modules/vendor-lib\n");

      const ids = [...fsReadStorage.listTickets(projects)].map((t) => t.frontmatter.id);
      assert.deepEqual(ids, ["BLZ-1"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a nested repo with a `.git` DIRECTORY is skipped as well", () => {
    // Not every nested repository is a submodule: a plain `git clone` under a project
    // directory has `.git` as a directory. Same consequence for the walk, same treatment.
    const tmp = mkdtempSync(join(tmpdir(), "blz430-clone-"));
    try {
      const projects = board(tmp);
      const nested = join(projects, "BLZ", "vendor-lib");
      mkdirSync(join(nested, ".git"), { recursive: true });
      writeFileSync(join(nested, "README.md"), "# no frontmatter\n");

      const ids = [...fsReadStorage.listTickets(projects)].map((t) => t.frontmatter.id);
      assert.deepEqual(ids, ["BLZ-1"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a MALFORMED TICKET is still loud — the guard is nested repos, not bad frontmatter", () => {
    // The negative side. Widening BLZ-430 into "skip anything that will not parse" would
    // make a corrupted ticket silently disappear from the board, the index and the audit,
    // which is a worse defect than the one being fixed.
    const tmp = mkdtempSync(join(tmpdir(), "blz430-neg-"));
    try {
      const projects = board(tmp);
      writeFileSync(join(projects, "BLZ", "defined", "BLZ-2-broken.md"),
        "id: BLZ-2\ntype: task\n");
      assert.throws(() => [...fsReadStorage.listTickets(projects)], /missing frontmatter/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
