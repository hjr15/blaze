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
//      the only operations the verbs actually perform against the file store.
//
//      This is a TRANSITIONAL funnel, not the v3 storage port, and the difference
//      matters. An earlier version of this comment claimed "a SQLite driver
//      satisfying this shape is a drop-in, which is the whole point". That is
//      false, and a review panel caught it: the v3 port (service-architecture
//      §B.4) is `tx`/`create`/`getForUpdate`/`allocateSeq`/`ancestors`/`update`
//      — path-keyed blob I/O and a transactional ticket repository share ZERO
//      methods and zero arguments. Nothing here is reused by the database driver.
//
//      What this seam actually buys is narrower and still worth having: one
//      authority for where a ticket lives, no `node:fs` call inside a verb, and
//      an injectable driver so a verb's writes can be observed in a test without
//      touching disk. It is expected to be DELETED at Phase 2 cutover (BLZ-254)
//      rather than reimplemented over SQL.
//
// Drivers are passed in, never set globally. ~56 of the engine's test files build a
// real temp dir and a real git repo, so a module-level singleton would make them
// order-dependent; an explicit parameter keeps every existing test working against
// fsStorage unchanged while new tests inject memStorage.
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";

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

/**
 * Where a ticket goes when its status changes — the ONE authority for that question.
 *
 * move.mjs and reconcile.mjs used to compute this inline as
 * `join(dirname(dirname(file)), toStatus)` plus `basename(file)`. That works only
 * while `file` is a real path. Handed anything else — which is exactly what a
 * database driver yields — it produces `"done/BLZ-9"` and the caller returns
 * `ok: true`. A ticket silently relocated to a bogus path is the BLZ-122 class,
 * reintroduced by the seam meant to remove it.
 *
 * So this REFUSES an unrecognised handle rather than guessing. The fs assumption is
 * now explicit and loud: the day a non-fs driver reaches here, it throws instead of
 * corrupting.
 *
 * It also deliberately does NOT recompute the filename slug. `blaze edit` never
 * renames on a title change, so 60 of the live corpus's 2,537 tickets have a
 * filename that no longer matches `id-slug(title)`. Recomputing would rename them on
 * their next move — silent churn, and it would widen the zero-diff migration oracle's
 * existing gap.
 */
ticketPath.relocate = function relocate(projectsDir, project, toStatus, currentFile) {
  const statusDir = dirname(String(currentFile ?? ""));
  const projectDir = dirname(statusDir);
  if (!currentFile || projectDir !== join(projectsDir, project)) {
    // Two distinguishable failures, because they mean different mistakes.
    if (dirname(projectDir) !== projectsDir) {
      throw new Error(
        `relocate: ${JSON.stringify(currentFile)} is not a ticket path under ${projectsDir} — ` +
        `refusing to guess a destination. A non-filesystem driver must implement its own move.`);
    }
    throw new Error(
      `relocate: ${JSON.stringify(currentFile)} disagrees with project ${project} — ` +
      `one of them was derived wrongly; refusing to pick.`);
  }
  const dir = join(projectsDir, project, toStatus);
  return { dir, file: join(dir, basename(currentFile)) };
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
