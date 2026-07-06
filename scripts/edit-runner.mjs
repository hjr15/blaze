// scripts/edit-runner.mjs — CLI entry for `blaze edit <id> <field> <value>`:
// applyEdit against the resolved data tree, then commit only the touched file.
import { applyEdit } from "./edit.mjs";
import { commitFile } from "./serve-commit.mjs";
import { resolveRoots } from "./config.mjs";

const { dataRoot, projectsDir } = resolveRoots();
const [id, field, ...valueParts] = process.argv.slice(2);
if (!id || !field || valueParts.length === 0) {
  console.error("usage: blaze edit <id> <field> <value>"); process.exit(1);
}
const value = valueParts.join(" ");
const today = new Date().toISOString().slice(0, 10);
const r = applyEdit(projectsDir, id, { [field]: value }, { today });
if (!r.ok) { console.error(`blaze edit failed:\n  ${r.errors.join("\n  ")}`); process.exit(1); }
const c = commitFile(dataRoot, r.file, `${id}: edit ${field}`);
if (!c.ok) { console.error(`blaze edit: file written but commit failed (status ${c.status}) — commit manually`); process.exit(1); }
console.log(`${id}: ${field} = ${value}`);
