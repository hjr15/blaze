// scripts/model/ids.mjs — per-project sequential ID allocation by filesystem
// scan. Zero stored state: the highest <KEY>-N on disk (closed tickets stay in
// terminal dirs, so the high-water mark survives) + 1. (Phase-3 design §1.2.)
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function* walkFiles(dir) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

export function maxId(projectsDir, key) {
  const re = new RegExp("(?:^|[/\\\\])" + key + "-(\\d+)\\b", "i");
  let max = 0;
  for (const f of walkFiles(join(projectsDir, key))) {
    if (!f.endsWith(".md")) continue;
    const m = re.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export function nextId(projectsDir, key) {
  return `${key}-${maxId(projectsDir, key) + 1}`;
}
