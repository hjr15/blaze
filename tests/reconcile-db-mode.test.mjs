// tests/reconcile-db-mode.test.mjs — BLZ-670.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcile } from "../scripts/reconcile.mjs";
import { memReadStorage } from "../scripts/model/read-storage.mjs";
import { stageFor } from "../scripts/commit-or-queue.mjs";
import { scratchRegistry } from "./helpers/scratch.mjs";

const scratch = scratchRegistry();
const root = () => {
  const r = scratch(mkdtempSync(join(tmpdir(), "blz670-rec-")));
  mkdirSync(join(r, "projects", "ENG"), { recursive: true });
  writeFileSync(join(r, "blaze.config.json"), JSON.stringify({ projects: ["ENG"], schemaVersion: 2 }));
  return r;
};
const rec = { frontmatter: { id: "ENG-1", type: "task", project: "ENG", title: "t" }, body: "",
              project: "ENG", status: "defined", file: "ENG-1" };
// The ASYNC shape every database reader has. `[...promise]` throws on it; `await` does not.
const asyncReader = (extra = {}) => ({ ...memReadStorage([rec]), listTickets: async () => [rec],
  unreadableTicketDirs: async () => [], ...extra });

test("reconcile awaits listTickets (an async reader is not iterable)", async () => {
  const r = await reconcile({ root: root(), dryRun: true, tickets: ["ENG-1"], readStorage: asyncReader() });
  assert.equal(r.ok, true, r.error);
});

test("reconcile asks the reader which directories it could not read", async () => {
  const r = await reconcile({ root: root(), dryRun: true,
    readStorage: asyncReader({ unreadableTicketDirs: async () => [{ message: "X was NOT read" }] }) });
  assert.ok(r.findings.some((f) => f.kind === "unreadable-ticket-directory"));
});

// The apply path in db mode. Fixture copied from tests/reconcile-pertype.test.mjs's
// committing run: a code repo whose default branch carries `OBA-1: shipped work` (BLZ-131's
// shipped-commit signal) drives OBA-1 defined -> done with no forge access at all.
test("db-mode --apply moves through writePort.move, leaves the file alone, and reports 'db'", async () => {
  const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  const board = scratch(mkdtempSync(join(tmpdir(), "blz670-rec-apply-")));
  const codeRepo = scratch(mkdtempSync(join(tmpdir(), "blz670-rec-apply-code-")));
  git(codeRepo, "init", "-q", "-b", "main");
  git(codeRepo, "config", "user.email", "t@t.t");
  git(codeRepo, "config", "user.name", "t");
  writeFileSync(join(codeRepo, "README.md"), "x\n");
  git(codeRepo, "add", "-A");
  git(codeRepo, "commit", "-q", "-m", "seed");
  git(codeRepo, "commit", "-q", "--allow-empty", "-m", "OBA-1: shipped work");

  const projects = join(board, "projects");
  mkdirSync(join(projects, "OBA", "defined"), { recursive: true });
  writeFileSync(join(board, "blaze.config.json"), JSON.stringify({ key: "OBA", projects: ["OBA"] }));
  writeFileSync(join(projects, "OBA", "project.json"), JSON.stringify({ key: "OBA", codeRepos: [codeRepo] }));
  const ticket = join(projects, "OBA", "defined", "OBA-1.md");
  writeFileSync(ticket, "---\nid: OBA-1\ntitle: t\ntype: task\nproject: OBA\nestimate: 30\n---\nb\n");
  git(board, "init", "-q", "-b", "main");
  git(board, "config", "user.email", "t@t.t");
  git(board, "config", "user.name", "t");
  git(board, "add", "-A");
  git(board, "commit", "-q", "-m", "seed board");
  const commitsBefore = git(board, "rev-list", "--count", "HEAD").trim();

  const calls = [];
  const writePort = {
    async move(t) { calls.push(["move", t]); return { file: "OBA-1", fromFile: t.currentFile }; },
    async write(t) { calls.push(["write", t]); return { file: "OBA-1" }; },
  };
  const r = await reconcile({ fetch: false, commit: true, dryRun: false, root: board,
    writePort, stage: stageFor("db"), mode: "db" });

  assert.equal(r.ok, true, r.error);
  const moves = calls.filter(([k]) => k === "move");
  assert.equal(moves.length, 1, `the move must go through writePort.move, calls: ${JSON.stringify(calls.map(([k]) => k))}`);
  assert.equal(moves[0][1].status, "done");
  assert.ok(existsSync(ticket), "db mode must not move the ticket file");
  assert.equal(existsSync(join(projects, "OBA", "done", "OBA-1.md")), false, "nothing may arrive in done/");
  assert.equal(git(board, "rev-list", "--count", "HEAD").trim(), commitsBefore, "db mode makes no git commit");
  assert.equal(r.commitOutcome, "db");
});
