// tests/new-usage-risk-flags.test.mjs — BLZ-232.
//
// `risk` requires `likelihood` and `impact`, and `--likelihood`/`--impact` were parsed but
// absent from the usage line — so the documented invocation for the one type that needs them
// could not satisfy it. The flags were found by reading the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "new-runner.mjs");

/** Run the runner with no args against a throwaway data dir; usage goes to stderr. */
function usage() {
  const dir = mkdtempSync(join(tmpdir(), "blaze-usage-"));
  mkdirSync(join(dir, "projects"), { recursive: true });
  try {
    execFileSync(process.execPath, [runner], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BLAZE_PROJECTS_DIR: join(dir, "projects") },
    });
    return "";
  } catch (e) { return `${e.stdout ?? ""}${e.stderr ?? ""}`; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the usage line documents --likelihood and --impact", () => {
  const u = usage();
  assert.match(u, /--likelihood/, "usage omits --likelihood");
  assert.match(u, /--impact/, "usage omits --impact");
});

test("the usage line says they are required for a risk", () => {
  assert.match(usage(), /REQUIRED for --type risk/i);
});

test("every flag the runner parses appears in the usage line", () => {
  const src = readFileSync(runner, "utf8");
  const parsed = [...src.matchAll(/case "(--[a-z-]+)":/g)].map((m) => m[1]);
  const u = usage();
  const missing = parsed.filter((f) => !u.includes(f));
  assert.deepEqual(missing, [], `flags parsed but undocumented: ${missing.join(", ")}`);
});
