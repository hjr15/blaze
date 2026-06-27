// groomer.mjs — the agentic board-keeper loop: pick an ungroomed ticket, drive the
// configured agent command to edit it, then auto-commit the change.
import { createHash } from "node:crypto";
import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  return [
    `You are grooming an issue-tracker ticket. Edit ONLY the file at ${ticket.rel} and no other file.`,
    `Use only these labels: ${cfg.defaultLabels.join(", ")}.`,
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

  const diff = execFileSync("git", ["-C", root, "diff", "--name-only"], { encoding: "utf8" });
  const changed = parseChangedFiles(diff).filter((f) => cfg.columns.some((c) => f.startsWith(`${c}/`)));
  const record = () => {
    const raw = readFileSync(join(root, ticket.rel), "utf8");
    state.groomed[ticket.id] = hashContent(raw);
    saveState(root, state);
  };

  if (!changed.length) {
    record(); // mark groomed so we don't re-run on a no-op
    return { type: "groom", id: ticket.id, noop: true, ts: today };
  }

  execFileSync("git", ["-C", root, "add", ...changed]);
  execFileSync("git", ["-C", root, "commit", "-m", commitMessage(ticket.id, changed), "--", ...changed]);
  const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  record();
  return { type: "groom", id: ticket.id, sha, files: changed, ts: today };
}

// CLI: `node scripts/loops/groomer.mjs` runs one grooming pass.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadConfig, ROOT } = await import("../config.mjs");
  const cfg = loadConfig();
  let agentsMd = "";
  try { agentsMd = readFileSync(join(ROOT, "AGENTS.md"), "utf8"); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const evt = groomOnce({ root: ROOT, cfg, agentsMd, today });
  console.log(evt ? JSON.stringify(evt) : "groomer: nothing to groom.");
}
