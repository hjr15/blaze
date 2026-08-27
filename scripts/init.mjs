// scripts/init.mjs — first-run setup (BLZ-285), implementing ADR-0012.
//
// TWO RULES SHAPE EVERYTHING HERE.
//
// 1. THE FLAGS ARE THE CONTRACT; the prompts are a wrapper. `blaze init --dir=... ` can
//    answer every question the interactive path asks, and both call this same code.
//    Two paths that can produce different config are two sources of truth, and the
//    second one drifts.
//
// 2. THE WIZARD ASKS WHAT STARTUP NEEDS, and nothing else. Every question below is
//    justified by a read site that FAILS without it:
//      - the board directory   → config.mjs:113 throws `no data dir found`
//      - the first project key → config.mjs:216-218 throws `unknown project` for every
//                                verb except `blaze new`, and reconcile silently
//                                no-ops on an empty `projects` array
//    `agentCommand`, `commitMode`, `codeRepos`, `loops`, `port` and `boardTitle` have
//    defaults right for the overwhelming majority. `key`, `provider`, `columns`,
//    `terminal`, `defaultLabels` and a base URL are NOT asked because nothing reads
//    them (BLZ-298) — a question whose answer nothing reads is ceremony, not setup.
import { join } from "node:path";
// BLZ-402: KEY_RE used to be a private copy here, checked ONLY on this wizard's
// `--project` answer — nothing on the config-load path (scripts/config.mjs) ever ran
// it. It now lives in config.mjs as the one shared definition; planInit uses the
// predicate form (`KEY_RE.test`) because it COLLECTS errors rather than throwing on
// the first one ("a wizard that reports one problem per run is a wizard people run
// four times"), so the throwing `assertValidKey` form doesn't fit here.
import { KEY_RE } from "./config.mjs";

/** Drivers this engine will offer. Derived intent, per ADR-0012: a driver is offered
 *  because it passes the conformance suite, not because it is listed somewhere. */
export const OFFERED_DRIVERS = ["sqlite", "postgres"];

/**
 * Turn answers into the exact files to write. PURE — no I/O, no prompting.
 *
 * Returns `{ ok, errors, plan }`. Every refusal is collected rather than thrown on the
 * first, because a wizard that reports one problem per run is a wizard people run four
 * times.
 */
export function planInit(answers = {}) {
  const errors = [];
  const dir = String(answers.dir ?? "").trim();
  const project = String(answers.project ?? "").trim().toUpperCase();
  const driver = String(answers.driver ?? "sqlite").trim();

  if (!dir) errors.push("--dir is required: the directory this board will live in");
  if (!project) {
    errors.push("--project is required: a key for the first project, e.g. ENG");
  } else if (!KEY_RE.test(project)) {
    errors.push(`--project ${JSON.stringify(project)} is not a valid key — `
      + "upper-case letters and digits, starting with a letter (e.g. ENG, OBA, BLZ2)");
  }
  if (!OFFERED_DRIVERS.includes(driver)) {
    errors.push(`--db ${JSON.stringify(driver)} is not a supported driver — `
      + `expected ${OFFERED_DRIVERS.join(" or ")}`);
  }

  // Absent means "no admin yet", which is legal. PRESENT AND BLANK is a mistake — an
  // operator who typed a space has not chosen to skip, and silently treating it as a
  // skip would hand them a board they cannot serve on a non-loopback address.
  const rawAdmin = answers.adminEmail;
  const adminEmail = rawAdmin === undefined || rawAdmin === null || rawAdmin === ""
    ? null : String(rawAdmin).trim();
  if (adminEmail !== null && !adminEmail) {
    errors.push("--admin-email was given but is blank: supply an address, or omit it entirely");
  }

  let database = null;
  if (driver === "postgres") {
    const host = String(answers.host ?? "").trim();
    const dbName = String(answers.database ?? "").trim();
    const user = String(answers.user ?? "").trim();
    const passwordEnv = String(answers.passwordEnv ?? "").trim();
    const port = Number(answers.port ?? 5432);

    if (!host) errors.push("--host is required for postgres");
    if (!dbName) errors.push("--database is required for postgres");
    if (!user) errors.push("--user is required for postgres");
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`--port ${JSON.stringify(answers.port)} is not a valid port`);
    }
    // The password is NEVER a field here. ADR-0012: config names the variable that
    // carries it, so the secret lives in the environment and never in a file.
    if (!passwordEnv) {
      errors.push("--password-env is required for postgres: the NAME of the environment "
        + "variable that will carry the password (e.g. BLAZE_DB_PASSWORD). "
        + "Blaze never stores a password.");
    }
    database = { driver, host, port, database: dbName, user, passwordEnv };
  }

  // A password, or a URL that could contain one, must never reach either file. Checked
  // here rather than trusted, because "put it in the untracked file" degrades to
  // JIRA's plaintext dbconfig.xml the moment someone pastes a URL into the wrong place.
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v !== "string") continue;
    if (/^password$/i.test(k)) {
      errors.push("refusing a literal password: pass --password-env naming an "
        + "environment variable instead. Blaze never writes a password to disk.");
    }
    if (/:\/\/[^/@\s]*:[^/@\s]*@/.test(v)) {
      errors.push(`refusing ${k}: it looks like a URL containing credentials. `
        + "Pass --host/--port/--database/--user separately, with --password-env for the secret.");
    }
  }

  if (errors.length) return { ok: false, errors, plan: null };

  return {
    ok: true,
    errors: [],
    plan: {
      dataRoot: dir,
      projectsDir: join(dir, "projects"),
      projectDir: join(dir, "projects", project),
      // Tracked. The driver NAME is repo-shaped: every clone speaks the same dialect.
      configPath: join(dir, "blaze.config.json"),
      config: {
        boardTitle: answers.boardTitle?.trim() || "Blaze",
        projects: [project],
        database: { driver },
        ...(answers.boardPort ? { port: Number(answers.boardPort) } : {}),
      },
      // Untracked, 0600. Absent entirely for sqlite — there is nothing to connect to.
      databasePath: database ? join(dir, ".blaze", "database.json") : null,
      database,
      project,
      adminEmail,
    },
  };
}

/** The questions, in order, with what each is for. Data, so the interactive path and
 *  `--help` cannot describe different wizards. */
export function questions({ driver = "sqlite" } = {}) {
  const base = [
    { key: "dir", prompt: "Where should this board live?", def: process.cwd(),
      why: "the only hard startup failure — Blaze refuses to run without a data directory" },
    { key: "project", prompt: "Key for your first project (e.g. ENG)", def: null,
      why: "every verb except `new` refuses an unknown project, and an empty board silently does nothing" },
    { key: "driver", prompt: `Database (${OFFERED_DRIVERS.join("/")})`, def: "sqlite",
      why: "sqlite needs no setup and is built into Node; postgres is opt-in" },
    // BLZ-358. Optional, and blank is a real answer: loopback with no identities is
    // what Blaze has always served, and this must not turn that into a required step.
    // Answering it means a shell-installed board never meets the non-loopback refusal
    // the HTTP setup flow exists to replace.
    { key: "adminEmail", prompt: "Email for the first admin (blank to skip)", def: "",
      why: "creates the first user, which turns authentication on and lets the board bind a non-loopback address" },
  ];
  if (driver !== "postgres") return base;
  return [...base,
    { key: "host", prompt: "Postgres host", def: "localhost", why: "where to connect" },
    { key: "port", prompt: "Postgres port", def: 5432, why: "where to connect" },
    { key: "database", prompt: "Database name", def: "blaze", why: "which database" },
    { key: "user", prompt: "Postgres user", def: null, why: "who to connect as" },
    { key: "passwordEnv", prompt: "Environment variable holding the password",
      def: "BLAZE_DB_PASSWORD",
      why: "Blaze stores the NAME, never the password itself" },
  ];
}

/**
 * Prove the connection before anything is written.
 *
 * Four checks, each earning its cost. A wizard that reports "connection OK" and then
 * fails at schema creation has lied, so the privilege probe is not optional.
 */
export async function testConnection(database, { password, openPostgres } = {}) {
  const checks = [];
  const fail = (step, message, hint) => ({ ok: false, checks, step, message, hint });

  let client = null;
  try {
    client = await openPostgres({
      host: database.host, port: database.port, database: database.database,
      user: database.user, password,
    });
    checks.push("connected");
  } catch (e) {
    const code = e?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      return fail("reach",
        `Could not reach Postgres at ${database.host}:${database.port} (${code}).`,
        "Check the host and port, and that the server is accepting connections.");
    }
    if (code === "28P01" || code === "28000") {
      return fail("auth",
        `Postgres rejected the credentials for user "${database.user}" at `
        + `${database.host}:${database.port}/${database.database}.`,
        `Check the password in $${database.passwordEnv}. It is never logged or echoed.`);
    }
    if (code === "3D000") {
      return fail("database",
        `Postgres has no database named "${database.database}" at ${database.host}:${database.port}.`,
        `Create it first:  createdb ${database.database}`);
    }
    // Deliberately the driver's own message, minus anything we composed — the client
    // was built from parsed parts, never a URL, so no password was ever in a string
    // this code could print.
    return fail("connect", `Could not connect: ${e?.message ?? e}`, null);
  }

  try {
    const v = await client.serverVersionNum();
    checks.push(`server_version ${v}`);
    if (v < 120000) {
      return fail("version",
        `Postgres at ${database.host}:${database.port} reports version ${v}; Blaze needs 12 or newer.`,
        "Blaze uses IS DISTINCT FROM, generated identity columns and partial indexes. "
        + "Upgrade the server, or use sqlite instead.");
    }
    const encoding = await client.encoding();
    checks.push(`encoding ${encoding}`);
    if (encoding && !/^UTF8$/i.test(encoding)) {
      return fail("encoding",
        `Database "${database.database}" uses ${encoding} encoding; Blaze requires UTF8.`,
        "A non-UTF8 database silently mangles ticket text. Recreate it with UTF8.");
    }
    // Privilege probe, rolled back. Without it the wizard can pass and `db init` fail.
    await client.probeCreate();
    checks.push("can create tables");
  } catch (e) {
    return fail("privilege",
      `Connected as "${database.user}", but could not create a table: ${e?.message ?? e}`,
      `Grant it:  GRANT CREATE ON DATABASE ${database.database} TO ${database.user};`);
  } finally {
    await client?.close?.();
  }

  return { ok: true, checks, step: null, message: null, hint: null };
}
