// scripts/init-runner.mjs — `blaze init`, the first-run setup (BLZ-285, ADR-0012).
//
// The flags ARE the contract. The prompts are a wrapper that fills the same fields, and
// they run ONLY on a real TTY — an agent session and CI are never a TTY, so a password
// typed here can never reach a transcript. That matters concretely here: a secret in a
// transcript forces a rotation.
import { existsSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { planInit, questions, testConnection, OFFERED_DRIVERS } from "./init.mjs";
// BLZ-460: `--help` used to say "see ADR-0025" and give no path at all, which is the
// worst of the three variants of this defect — the reader cannot even guess wrong. The
// pointer is imported rather than retyped so `--help`, the refusal in `assertValidKey`
// and `AGENTS.md` cannot drift into three different answers, and so that it stays a URL:
// `docs/` ships zero files in the npm package, so a repo-relative path here resolves to
// nothing for the installed operator this usage text is written for.
import { KEY_RULE_DOC } from "./config.mjs";
import { addUser } from "./model/user-admin.mjs";

const FLAGS = {
  "--dir": "dir", "--project": "project", "--project-name": "projectName",
  "--db": "driver", "--host": "host", "--port": "port", "--database": "database",
  "--user": "user", "--password-env": "passwordEnv",
  "--title": "boardTitle", "--board-port": "boardPort",
  "--admin-email": "adminEmail",
};

export function parseArgs(argv) {
  const out = { _unknown: [], yes: false, force: false };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") { out.yes = true; continue; }
    if (a === "--force") { out.force = true; continue; }
    if (a === "--no-git") { out.noGit = true; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!(name in FLAGS)) { out._unknown.push(a); continue; }
    out[FLAGS[name]] = eq === -1 ? true : a.slice(eq + 1);
  }
  return out;
}

export const USAGE = `usage: blaze init [options]

Sets up a board: creates the directory, the first project, and records which database
to use. Answer every question by flag, or be prompted when run at a terminal.

  --dir=PATH            where the board lives            (required)
  --project=KEY         first project key, e.g. ENG      (required)
                        Upper-case letters and digits, starting with a letter.
                        Refused, never auto-corrected (ADR-0025):
                        ${KEY_RULE_DOC}
  --project-name=NAME   human name for that project
  --db=${OFFERED_DRIVERS.join("|")}       database driver                  (default: sqlite)
  --title=NAME          board title, shown in the viewer (default: Blaze)
  --board-port=N        port for 'blaze board'           (default: 4321)
  --admin-email=EMAIL   create the first admin user and print its token ONCE.
                        Optional: without it the board serves on loopback only,
                        and 'blaze user add' or the first-run setup flow can
                        create the admin later.

postgres only — Blaze NEVER stores a password:
  --host=HOST           (default: localhost)
  --port=N              (default: 5432)
  --database=NAME
  --user=NAME
  --password-env=VAR    NAME of the env var holding the password

  --yes                 never prompt; fail if something required is missing
  --force               re-initialise a directory that already has a board
  --no-git              skip 'git init' (ticket ids then cannot be reserved)
`;

/**
 * Read a line without echoing it. Only ever called behind an isTTY check.
 *
 * Raw mode rather than an ANSI overwrite: overwriting the line still PUTS the
 * characters on the terminal first, so anything capturing the stream sees them.
 * Byte codes rather than escape literals, so the control characters this handles
 * never appear in the source either.
 */
export function askHidden(prompt, { stdin = process.stdin, stdout = process.stdout } = {}) {
  const CR = 13, LF = 10, EOT = 4, ETX = 3, DEL = 127, BS = 8;
  return new Promise((res, rej) => {
    stdout.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    let buf = "";
    const done = (fn, arg) => {
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.removeListener("data", onData);
      stdin.pause();
      stdout.write("\n");
      fn(arg);
    };
    const onData = (chunk) => {
      const code = chunk[0];
      if (code === CR || code === LF || code === EOT) return done(res, buf);
      if (code === ETX) return done(rej, new Error("cancelled"));
      if (code === DEL || code === BS) { buf = buf.slice(0, -1); return; }
      buf += chunk.toString("utf8");
    };
    stdin.on("data", onData);
  });
}

const ask = (rl, q, def) => new Promise((res) =>
  rl.question(def === null || def === undefined ? `${q}: ` : `${q} [${def}]: `,
    (v) => res(v.trim() || (def === null ? "" : String(def)))));

export async function runInit(argv, io = {}) {
  const {
    isTTY = process.stdin.isTTY, log = console.log, err = console.error,
    env = process.env, cwd = process.cwd(),
  } = io;
  const args = parseArgs(argv);
  if (args.help) { log(USAGE); return 0; }
  if (args._unknown.length) {
    err(`blaze init: unknown option ${args._unknown[0]}\n`);
    err(USAGE);
    return 1;
  }

  const interactive = Boolean(isTTY) && !args.yes;
  const answers = { ...args };
  let typedPassword;

  if (interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      log("\nSetting up a Blaze board. Press enter to accept a default.\n");
      for (const q of questions({ driver: "sqlite" })) {
        if (answers[q.key] !== undefined && answers[q.key] !== true) continue;
        answers[q.key] = await ask(rl, q.prompt, q.key === "dir" ? cwd : q.def);
      }
      if (String(answers.driver).trim() === "postgres") {
        for (const q of questions({ driver: "postgres" }).slice(3)) {
          if (answers[q.key] !== undefined && answers[q.key] !== true) continue;
          answers[q.key] = await ask(rl, q.prompt, q.def);
        }
      }
    } finally { rl.close(); }

    if (String(answers.driver).trim() === "postgres" && !env[answers.passwordEnv]) {
      log(`\n$${answers.passwordEnv} is not set. The password is used to test the `
        + "connection and is never written anywhere.");
      typedPassword = await askHidden("Postgres password: ");
    }
  }

  const password = typedPassword ?? env[answers.passwordEnv ?? ""] ?? undefined;

  const planned = planInit({ ...answers, dir: answers.dir ? resolve(cwd, String(answers.dir)) : "" });
  if (!planned.ok) {
    err("blaze init: cannot proceed.\n");
    for (const e of planned.errors) err(`  - ${e}`);
    if (!interactive) err("\nRun at a terminal without --yes to be prompted, or see --help.");
    return 1;
  }
  const { plan } = planned;

  if (existsSync(plan.configPath) && !args.force) {
    err(`blaze init: ${plan.configPath} already exists.\n`);
    err("Re-initialising would replace this board's configuration. If that is what you");
    err("want, pass --force. It does NOT migrate any existing data.");
    return 1;
  }

  if (plan.database) {
    if (!password) {
      err(`blaze init: $${plan.database.passwordEnv} is not set, and there is no terminal to prompt at.\n`);
      err(`  export ${plan.database.passwordEnv}=...   then re-run`);
      return 1;
    }
    log(`\nTesting the connection to ${plan.database.host}:${plan.database.port}/${plan.database.database} ...`);
    const openPostgres = io.openPostgres ?? (await import("./init-pg.mjs")).openPostgres;
    const t = await testConnection(plan.database, { password, openPostgres });
    if (!t.ok) {
      err(`\nblaze init: ${t.message}`);
      if (t.hint) err(`\n${t.hint}`);
      err("\nNothing was written. Your filesystem and SQLite boards are unaffected.");
      return 1;
    }
    for (const c of t.checks) log(`  ok: ${c}`);
  }

  // Nothing is written until every check has passed.
  mkdirSync(plan.projectDir, { recursive: true });
  writeFileSync(plan.configPath, JSON.stringify(plan.config, null, 2) + "\n");
  writeFileSync(join(plan.projectDir, "project.json"),
    JSON.stringify({ key: plan.project, name: answers.projectName?.trim?.() || plan.project,
                     components: [], labels: [] }, null, 2) + "\n");

  if (plan.databasePath) {
    mkdirSync(dirname(plan.databasePath), { recursive: true });
    writeFileSync(plan.databasePath, JSON.stringify(plan.database, null, 2) + "\n");
    // 0600 even with no secret in it: the file names the variable and the account,
    // which is reconnaissance, and the permission costs nothing.
    try { chmodSync(plan.databasePath, 0o600); } catch { /* best effort */ }
  }

  // A board that cannot create a ticket is not a board. The id allocator reserves ids
  // through the git common dir (ids.mjs -> git-common.mjs), so a directory that is not
  // in a worktree fails on the FIRST `blaze new` — found by running the wizard's own
  // output rather than by reading it.
  let gitNote = null;
  if (!args.noGit) {
    const inRepo = spawnSync("git", ["rev-parse", "--git-dir"],
      { cwd: plan.dataRoot, encoding: "utf8" }).status === 0;
    if (!inRepo) {
      const r = spawnSync("git", ["init", "--quiet"], { cwd: plan.dataRoot, encoding: "utf8" });
      gitNote = r.status === 0
        ? "git          initialised (ticket ids are reserved through git)"
        : `git          NOT initialised: ${(r.stderr || "").trim() || "git unavailable"}`;
    }
  }

  // ADR-0012 puts the connection details in .blaze/ BECAUSE .blaze/ is untracked. On an
  // existing board that is true only because somebody added the rule; a new board has
  // no .gitignore at all, so without this the connection file would be committed on the
  // first `git add .` — precisely the outcome the ADR exists to prevent.
  const ignorePath = join(plan.dataRoot, ".gitignore");
  const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  if (!/^\.blaze\/?\s*$/m.test(existing)) {
    appendFileSync(ignorePath,
      (existing && !existing.endsWith("\n") ? "\n" : "")
      + "# Blaze runtime state and connection details — never commit these.\n.blaze/\n");
  }

  // BLZ-358 AC-6. ADR-0013 section 5: the first admin is a user, not an exception — so
  // this is the same `addUser` that `blaze user add` and the HTTP setup route call.
  // There is no third way to make a user, and this is deliberately after the board is
  // on disk: a half-written board with a live credential in it is the worse failure.
  let adminNote = null;
  if (plan.adminEmail) {
    try {
      const { user, token } = await addUser(plan.dataRoot, { email: plan.adminEmail, role: "admin" });
      adminNote = { user, token };
    } catch (e) {
      // Not fatal. The board is already usable on loopback, and `blaze user add` can
      // retry — failing the whole init here would leave a good board looking broken.
      err(`\nadmin       NOT created: ${String(e?.message ?? e)}`);
      err("            The board is fine — create it later with `blaze user add`.");
    }
  }

  log(`\nBoard ready at ${plan.dataRoot}`);
  log(`  project      ${plan.project}`);
  log(`  database     ${plan.config.database.driver}`);
  if (plan.databasePath) log(`  connection   ${plan.databasePath} (gitignored)`);
  if (gitNote) log(`  ${gitNote}`);
  if (adminNote) {
    log(`  admin        ${adminNote.user.email} (role: ${adminNote.user.role})`);
    log("\nAPI token (shown once — copy it now, it is not recoverable):");
    log(`    ${adminNote.token.token}`);
    log("Use it as:  Authorization: Bearer <token>");
  }
  log(`\nNext:  cd ${plan.dataRoot} && blaze new --project ${plan.project} --type task "First ticket"`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("init-runner.mjs")) {
  process.exit(await runInit(process.argv.slice(2)));
}
