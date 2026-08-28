// scripts/move.mjs — `blaze move <id> <status>`: validate the transition, set
// resolution on terminal entry, rewrite frontmatter, and relocate the ticket file
// between status directories. applyMove() is pure-ish (fs only, no git) for tests;
// the CLI wrapper adds git add/commit.
import { dirname } from "node:path";
import { locateTicket, ambiguousIdError } from "./model/index.mjs";
import { fsStorage } from "./model/storage.mjs";
import { fsWritePort } from "./model/write-port.mjs";
import { fsReadStorage } from "./model/read-storage.mjs";
import { planMove } from "./model/move-plan.mjs";
import { loadProject } from "./config.mjs";
import { isTerminal } from "./model/workflows.mjs";
import { isType } from "./model/schema.mjs";

export async function applyMove(projectsDir, id, toStatus, opts = {}) {
  const { today = null, storage = fsStorage, readStorage = fsReadStorage,
          writePort = fsWritePort(projectsDir, storage) } = opts;
  const { found, duplicates } = locateTicket(projectsDir, id);
  if (duplicates) return { ok: false, errors: [ambiguousIdError(id, duplicates)] };
  if (!found) return { ok: false, errors: [`ticket not found: ${id}`] };

  // requireWorklog: explicit opt wins; otherwise read the ticket's project config.
  let requireWorklog = opts.requireWorklog;
  if (requireWorklog === undefined) {
    try {
      // BLZ-408: same source as edit.mjs's equivalent call. This one's message is not
      // reachable today — the `catch` below swallows every failure, including a malformed
      // key — but the two calls must not drift, and the day that catch narrows this is
      // already right.
      const proj = loadProject(found.frontmatter.project, {
        root: dirname(projectsDir), projectsDir,
        source: `ticket ${id}'s 'project' field`,
      });
      requireWorklog = proj.requireWorklogBeforeTerminal;
    } catch { requireWorklog = false; }
  }

  const hasWorklog = Array.isArray(found.frontmatter.worklog) && found.frontmatter.worklog.length > 0;
  const plan = planMove({ frontmatter: found.frontmatter, body: found.body }, found.status, toStatus,
    { hasWorklog, requireWorklog });
  if (!plan.ok) return { ok: false, errors: plan.errors };

  // Advisory-only: an open (non-terminal) Blocks link targeting this ticket never
  // stops the move, it just surfaces a warning for the caller to print.
  const warnings = [];
  if (toStatus === "in-progress") {
    // ADR-0009: ask the driver for the blockers instead of walking the corpus and
    // filtering here. This was the engine's worst read — a full 2,534-ticket walk to
    // answer a two-row question, ~22 ms and ~5.6 MiB per invocation against 0.06 ms
    // from an index.
    for (const t of readStorage.blockersOf(projectsDir, id)) {
      // A blocker whose type is unresolvable can't be classified terminal/open —
      // treat it as non-blocking rather than let isTerminal() throw and abort the move.
      if (isType(t.frontmatter.type) && !isTerminal(t.frontmatter.type, t.status)) {
        warnings.push(`advisory: ${id} is blocked by ${t.frontmatter.id} (open) — moving to in-progress anyway`);
      }
    }
  }

  const fm = { ...plan.frontmatter };
  if (today) fm.updated = today;

  // The destination is the port's business, not this verb's. move.mjs used to compute
  // it as dirname(dirname(file)) + toStatus, which works only while `file` is a real
  // path — handed a database handle it produced "done/BLZ-9" and still returned
  // ok:true, the BLZ-122 class reintroduced. The verb now states WHAT it wants
  // persisted; where that lives is the adapter's answer (BLZ-271, BLZ-293).
  // BLZ-348 / ADR-0013 §6: who did it. Carried as the port's CONTEXT rather than as
  // part of the ticket — the actor belongs to the event log, never to the ticket row.
  const { file: destFile, fromFile } = await writePort.move({
    project: found.project, status: toStatus,
    frontmatter: fm, body: plan.body, currentFile: found.file,
  }, { actor: opts.actor ?? "unknown", source: opts.source ?? "cli" });

  return { ok: true, id, from: found.status, to: toStatus, fromFile: fromFile ?? found.file, file: destFile, resolution: plan.resolution, warnings };
}
