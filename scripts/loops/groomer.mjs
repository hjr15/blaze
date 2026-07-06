// groomer.mjs — the agentic board-keeper loop: pick an ungroomed ticket, drive the
// configured agent command to edit it, then auto-commit the change.
import { createHash } from "node:crypto";
import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseTicket } from "../model/ticket.mjs";

export function hashContent(s) {
  return createHash("sha1").update(s).digest("hex");
}

export function loadState(root) {
  const p = join(root, ".blaze", "state.json");
  if (!existsSync(p)) return { groomed: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return s && s.groomed ? s : { groomed: {} };
  } catch {
    return { groomed: {} };
  }
}

export function saveState(root, state) {
  const dir = join(root, ".blaze");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}

export function selectNextTicket(root, cfg, state) {
  for (const col of cfg.loops.groomer.columns) {
    let files = [];
    try {
      files = readdirSync(join(root, col)).filter((f) => cfg.fileRegex.test(f));
    } catch {
      continue;
    }
    files.sort();
    for (const file of files) {
      const rel = `${col}/${file}`;
      const raw = readFileSync(join(root, rel), "utf8");
      const m = cfg.idLineRegex.exec(raw);
      if (!m) continue;
      const id = m[1];
      if (state.groomed[id] !== hashContent(raw)) return { id, file, col, rel, raw };
    }
  }
  return null;
}

export function extractGroomingRules(agentsMd) {
  const m = /## Grooming rules[\s\S]*?(?=\n## |\n# |$)/.exec(agentsMd || "");
  return m ? m[0].trim() : "";
}

export function buildPrompt(ticket, rules, cfg) {
  const labels = (cfg.defaultLabels || []).join(", ");
  const guard = [
    "You are a groomer. PROPOSE improvements only — never transition, never resolve, never move the file.",
    "Draft Acceptance Criteria, suggest an estimate, and suggest a parent/links.",
    `Write suggestions ONLY as a subsection under \`## Notes\` titled \`Groomer proposals (${cfg.today || ""})\`.`,
    "Do NOT change the `status`, `resolution`, `parent`, or `estimate` frontmatter fields — a human/agent applies accepted proposals via `blaze move`/`blaze edit`.",
  ].join("\n");
  return [
    guard,
    ``,
    `You are grooming an issue-tracker ticket. Edit ONLY the file at ${ticket.rel} and no other file.`,
    labels ? `Use only these labels: ${labels}.` : "",
    ``,
    rules,
    ``,
    `--- ticket: ${ticket.rel} ---`,
    ticket.raw,
  ].join("\n");
}

export function parseChangedFiles(diffOut) {
  return diffOut.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse `git status --porcelain --untracked-files=all` output into a list of
 * affected paths. Handles:
 *   " M path"  — unstaged modification
 *   "M  path"  — staged modification
 *   "A  path"  — staged add (new file)
 *   "?? path"  — untracked new file
 *   " D path"  — unstaged deletion
 *   "D  path"  — staged deletion
 *   "R  old -> new"  — staged rename (take the new path)
 * Returns deduplicated list of paths.
 */
export function parsePorcelain(porcelain) {
  const seen = new Set();
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    let path;
    // Rename: "R  old -> new" or "R  old\0new" — porcelain v1 uses " -> "
    if (xy[0] === "R" || xy[1] === "R") {
      const arrow = rest.indexOf(" -> ");
      path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    } else {
      path = rest;
    }
    path = path.trim();
    if (path) seen.add(path);
  }
  return [...seen];
}

/**
 * Returns true if the before/after content represents a structural change:
 * - resolution frontmatter value changed
 * - status frontmatter value changed
 * These fields must only be mutated by explicit human/agent `blaze move`/`blaze edit`.
 *
 * Uses parseTicket (the real parser) to extract field values so that a duplicated
 * key in the frontmatter cannot evade the guard via first-match regex.
 */
export function isStructuralChange(before, after) {
  let parsedBefore = null;
  let parsedAfter = null;
  try { parsedBefore = parseTicket(before); } catch { /* no frontmatter */ }
  try { parsedAfter = parseTicket(after); } catch { /* no frontmatter */ }

  // If before had frontmatter but after does not → structural (gutted ticket).
  if (parsedBefore && !parsedAfter) return true;
  // If neither had frontmatter → no structural change to detect.
  if (!parsedBefore && !parsedAfter) return false;
  // If after has frontmatter but before didn't → treat as non-structural (new frontmatter added).
  if (!parsedBefore) return false;

  const fmBefore = parsedBefore.frontmatter;
  const fmAfter = parsedAfter.frontmatter;
  for (const field of ["resolution", "status"]) {
    // Normalise to string for comparison: null/undefined both mean "absent".
    const vBefore = fmBefore[field] ?? null;
    const vAfter = fmAfter[field] ?? null;
    if (String(vBefore) !== String(vAfter)) return true;
  }
  return false;
}

export function commitMessage(id, files) {
  return `chore(groom): ${id} ${files.length} file(s) groomed`;
}

export function groomOnce({ root, cfg, agentsMd, today }) {
  const state = loadState(root);
  const ticket = selectNextTicket(root, cfg, state);
  if (!ticket) return null;

  const prompt = buildPrompt(ticket, extractGroomingRules(agentsMd), cfg);
  const [cmd, ...args] = cfg.agentCommand.split(" ");
  const r = spawnSync(cmd, [...args, prompt], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BLAZE_GROOM_TARGET: ticket.rel },
  });
  if (r.status !== 0) {
    return { type: "groom", id: ticket.id, error: ((r.stderr || "agent command failed") + "").slice(0, 200), ts: today };
  }

  const porcelain = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" });
  const changed = parsePorcelain(porcelain).filter((f) => cfg.columns.some((c) => f.startsWith(`${c}/`)));
  const record = () => {
    const raw = readFileSync(join(root, ticket.rel), "utf8");
    state.groomed[ticket.id] = hashContent(raw);
    saveState(root, state);
  };

  if (!changed.length) {
    record(); // mark groomed so we don't re-run on a no-op
    return { type: "groom", id: ticket.id, noop: true, ts: today };
  }

  // Guard: detect renames (status-dir change) or structural frontmatter mutations.
  // A rename means any changed path lands in a different column dir than the ticket's.
  const ticketDir = ticket.rel.split("/")[0];
  const hasRename = changed.some((f) => f.split("/")[0] !== ticketDir);
  const afterRaw = existsSync(join(root, ticket.rel)) ? readFileSync(join(root, ticket.rel), "utf8") : "";
  const hasStructuralFmChange = isStructuralChange(ticket.raw, afterRaw);
  if (hasRename || hasStructuralFmChange) {
    // Reset all changes so the tree stays clean.
    // Staged changes must be unstaged first; untracked new files must be removed.
    try { execFileSync("git", ["-C", root, "restore", "--staged", "--", ...changed]); } catch {}
    try { execFileSync("git", ["-C", root, "checkout", "--", ...changed]); } catch {}
    try { execFileSync("git", ["-C", root, "clean", "-f", "--", ...changed]); } catch {}
    console.error(`groomer: refused structural change on ${ticket.id}`);
    return { type: "groom", id: ticket.id, refused: true, ts: today };
  }

  execFileSync("git", ["-C", root, "add", ...changed]);
  execFileSync("git", ["-C", root, "commit", "-m", commitMessage(ticket.id, changed), "--", ...changed]);
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  record();
  return { type: "groom", id: ticket.id, sha, files: changed, ts: today };
}

// CLI: `node scripts/loops/groomer.mjs` runs one grooming pass.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadConfig, resolveRoots } = await import("../config.mjs");
  const root = resolveRoots().dataRoot;
  const cfg = loadConfig({ root });
  let agentsMd = "";
  try { agentsMd = readFileSync(join(root, "AGENTS.md"), "utf8"); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const evt = groomOnce({ root, cfg, agentsMd, today });
  console.log(evt ? JSON.stringify(evt) : "groomer: nothing to groom.");
}
