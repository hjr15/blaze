// groomer.mjs — the agentic board-keeper loop: pick an ungroomed ticket, drive the
// configured agent command to edit it, then auto-commit the change.
import { createHash } from "node:crypto";
import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync,
} from "node:fs";
import { join } from "node:path";

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
