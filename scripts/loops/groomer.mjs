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

/**
 * Every root-relative directory a ticket in `col` could live in.
 *
 * BLZ-298: this used to be just `col`. The board layout is
 * `projects/<KEY>/<status>/`, so `readdirSync(join(root, "defined"))` threw ENOENT for
 * every column, the catch swallowed it, and the groomer selected NOTHING — measured
 * against the live board. It had never worked on a multi-project board; nobody noticed
 * because the loop is disabled by default.
 *
 * The flat layout is still honoured, so a board that predates `projects/` keeps working.
 */
export function statusDirs(root, cfg, col) {
  const out = [];
  if (existsSync(join(root, "projects"))) {
    // cfg.projects is the authority on which projects exist; a stray directory is not
    // a project until it is configured as one.
    for (const key of cfg.projects ?? []) {
      const dir = join("projects", key, col);
      if (existsSync(join(root, dir))) out.push({ dir, key });
    }
  }
  // Legacy flat layout: `<root>/<col>/`, matched by the single-project cfg.key.
  if (existsSync(join(root, col))) out.push({ dir: col, key: null });
  return out;
}

/**
 * A project's ticket-file and id-line matchers.
 *
 * BLZ-298: the groomer used `cfg.fileRegex`, derived from the SINGLE-project `cfg.key`
 * — which defaults to "TASK". Against a board of BLZ/OBA/INF tickets it matched no
 * file at all, so even after the directory walk was fixed the groomer still selected
 * nothing. Reconcile already derives its matchers per project (config.mjs:228-230);
 * this is the same construction, applied here.
 */
export function matchersFor(cfg, key) {
  if (!key) return { fileRegex: cfg.fileRegex, idLineRegex: cfg.idLineRegex };
  return {
    fileRegex: new RegExp("^" + key + "-\\d+.*\\.md$"),
    idLineRegex: new RegExp("^id:\\s*(" + key + "-\\d+)", "m"),
  };
}

export function selectNextTicket(root, cfg, state) {
  for (const col of cfg.loops.groomer.columns) {
    for (const { dir, key } of statusDirs(root, cfg, col)) {
      const { fileRegex, idLineRegex } = matchersFor(cfg, key);
      let files = [];
      try {
        files = readdirSync(join(root, dir)).filter((f) => fileRegex.test(f));
      } catch {
        continue;
      }
      files.sort();
      for (const file of files) {
        const rel = `${dir}/${file}`;
        const raw = readFileSync(join(root, rel), "utf8");
        const m = idLineRegex.exec(raw);
        if (!m) continue;
        const id = m[1];
        // `statusDir` is carried so the rename guard compares against the ticket's OWN
        // directory rather than rel.split("/")[0], which is "projects" for every ticket
        // under the project layout and therefore compares nothing.
        if (state.groomed[id] !== hashContent(raw)) return { id, file, col, rel, raw, statusDir: dir };
      }
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
  // Any status directory of any configured project, not just a top-level `<col>/`.
  const groomable = (cfg.loops.groomer.columns ?? [])
    .flatMap((c) => statusDirs(root, cfg, c).map((d) => d.dir));
  const changed = parsePorcelain(porcelain)
    .filter((f) => groomable.some((d) => f.startsWith(`${d}/`)));
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
  // The ticket's own status directory. `rel.split("/")[0]` was "projects" for every
  // ticket under the project layout, so the rename guard compared a constant to itself
  // and could never fire.
  const ticketDir = ticket.statusDir ?? ticket.rel.split("/").slice(0, -1).join("/");
  const hasRename = changed.some((f) => f.split("/").slice(0, -1).join("/") !== ticketDir);
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
