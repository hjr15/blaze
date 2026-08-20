// scripts/model/storage.mjs — the storage seam (BLZ-267, Blaze v3 Phase 1).
//
// Every mutating verb funnels its finished text through serializeTicket() and then,
// today, calls node:fs itself — nine call sites across six verbs, each computing its
// own path with a locally-duplicated join()/slugify(). This module is the one place
// those two concerns live, so the file-and-git store can be swapped for a database
// (ADR-0006) without touching a single line of business logic.
//
// Two things live here and nothing else:
//
//   1. ticketPath()/slugify() — the single authority for WHERE a ticket lives.
//      Previously duplicated inline in new.mjs, move.mjs, reconcile.mjs and
//      migrate/jira-import.mjs. A seam cannot have two implementations until the
//      thing it abstracts has exactly one.
//
//   2. The driver contract — write/read/exists/move. Deliberately tiny: these are
//      the only operations the verbs actually perform. A SQLite driver satisfying
//      this shape is a drop-in, which is the whole point.
//
// Drivers are passed in, never set globally. ~56 of the engine's test files build a
// real temp dir and a real git repo, so a module-level singleton would make them
// order-dependent; an explicit parameter keeps every existing test working against
// fsStorage unchanged while new tests inject memStorage.
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

/** Ticket-filename slug: lowercase, non-alphanumerics collapsed to single dashes, trimmed. */
export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The canonical path of a ticket file: `<projectsDir>/<project>/<status>/<id>-<slug>.md`.
 * Status is the directory — that is the storage model this seam exists to abstract away.
 */
export function ticketPath(projectsDir, project, status, id, title) {
  return ticketPath.parts(projectsDir, project, status, id, title).file;
}

/** Same computation, exposing the directory separately so a move can mkdir it. */
ticketPath.parts = function parts(projectsDir, project, status, id, title) {
  const dir = join(projectsDir, project, status);
  return { dir, file: join(dir, `${id}-${slugify(title)}.md`) };
};

/** The real filesystem. The only driver in use until Phase 1 lands SQLite. */
export const fsStorage = {
  name: "fs",
  exists(file) {
    return existsSync(file);
  },
  read(file) {
    return readFileSync(file, "utf8");
  },
  write(file, text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  },
  // Write-then-rename, not rename-then-write: the text belongs to the destination
  // status, so a crash between the two must not leave the OLD body sitting at the
  // NEW path. Matches what move.mjs already does today.
  move(from, to, text) {
    if (from === to) {
      this.write(to, text);
      return;
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(from, text);
    renameSync(from, to);
  },
};

/**
 * An in-memory driver, for tests that care about the verb's logic rather than about
 * the filesystem. Each call returns an isolated store — never a shared singleton.
 * It is also the executable proof that the seam is real: if a verb still reaches for
 * node:fs behind the driver's back, a test using memStorage sees nothing on disk and
 * fails.
 */
export function memStorage(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    name: "mem",
    exists: (file) => files.has(file),
    read(file) {
      if (!files.has(file)) {
        const e = new Error(`ENOENT: no such file or directory, open '${file}'`);
        e.code = "ENOENT";
        throw e;
      }
      return files.get(file);
    },
    write(file, text) {
      files.set(file, text);
    },
    move(from, to, text) {
      if (from !== to) files.delete(from);
      files.set(to, text);
    },
    /** Test affordance — not part of the driver contract the verbs may use. */
    _dump: () => new Map(files),
  };
}
