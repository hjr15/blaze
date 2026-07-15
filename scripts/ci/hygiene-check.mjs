// scripts/ci/hygiene-check.mjs — fail on public-repo hygiene violations in THIS
// PR's own commits + added diff lines. Not product code (excluded from coverage).
import { execFileSync } from "node:child_process";
const base = process.env.HYGIENE_BASE || process.argv[2] || "origin/main";
const violations = [];

// 1. commit-message trailers — TWO-dot (base..HEAD) = commits unique to THIS branch.
//    (Three-dot is symmetric-difference and would scan other PRs' commits that land on
//    base while this PR is open — a false-fail. Verified: `git log A...B` returns both sides.)
const log = execFileSync("git", ["log", "--format=%H%n%B%n--END--", `${base}..HEAD`], { encoding: "utf8" });
if (/^Co-Authored-By:/im.test(log)) violations.push("Co-Authored-By trailer in a PR commit message");

// 2. ADDED diff lines only (leading '+'), THREE-dot (vs merge-base) for content.
//    Exclude the checker itself (it defines the patterns) and Markdown docs (prose that
//    legitimately discusses paths/rules — the precisely-scoped exemption, AC #2).
const diff = execFileSync("git", ["diff", "--unified=0", `${base}...HEAD`, "--", ".",
  ":(exclude)scripts/ci/hygiene-check.mjs", ":(exclude)*.md"], { encoding: "utf8" });
for (const line of diff.split("\n")) {
  if (!line.startsWith("+") || line.startsWith("+++")) continue;
  if (/\/home\//.test(line)) violations.push(`absolute home path in a diff: ${line.slice(1, 80)}`);
  if (/[a-z0-9-]+\.howman\.link/i.test(line)) violations.push(`internal hostname in a diff: ${line.slice(1, 80)}`);
}

if (violations.length) {
  console.error("Upstream hygiene violations:\n  " + violations.join("\n  "));
  process.exit(1);
}
console.log("hygiene: clean");
