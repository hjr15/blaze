# 12. How an installation selects, verifies and stores its database

Date: 2026-08-21

## Status

Accepted (BLZ-284). Implements REQ-055 (blaze-pm BLZ-283).

## Context

[ADR-0006](0006-database-is-the-sole-source-of-truth.md) makes a database the sole
source of truth. [ADR-0009](0009-read-seam-is-query-shaped.md) makes the storage
contract query-shaped so more than one database can satisfy it.
[ADR-0010](0010-v3-storage-port-is-async-the-fs-seam-is-not.md) makes the port async.
[ADR-0011](0011-database-clients-are-optional-peer-dependencies.md) makes every
database client an optional peer dependency.

All of that settles what a driver *is*. **None of it settles how an installation
chooses one** — and today there is no choice at any level: the driver is decided by
which module the caller imports. No file names a database, nothing persists a choice,
and there is no prompt. That is tolerable while the drivers are internal plumbing. It
stops being tolerable the moment v3 is something a person installs.

The operator asked for a first-run wizard, naming JIRA as the model, and asked that it
collect "environment details that are needed for start up".

This decision was taken against a five-lens review, an adversarial pass that refuted
three of its four positions, and then **execution** — the contested claims were run
against a real MySQL 8 and against the installed `pg`. The record is in blaze-pm
`docs/audits/2026-08-21-adr-0021-panel-and-empirical-settlements.md`. Two findings from
that exercise shape what follows, and both contradict the review that produced them.

## Decision

### 1. Nothing is refused. A driver is admitted by passing a bar.

The operator's goal — "installable on all the popular database drivers" — is **not**
declined. It is given a mechanism instead of a promise.

**Supported today: SQLite and Postgres.** A driver becomes supported when it passes,
with no exceptions and no maintainer's discretion:

1. The full driver conformance suite, every assertion, against a **real server** in CI
   — not a mock. Currently 36 assertions across 4 drivers.
2. A dual-write soak against a real corpus with `strict: true` and **zero** divergences.
3. Its dialect divergences enumerated in its own schema module's header, the way
   `pg-schema.mjs` enumerates its seven and `pg-storage.mjs` its eighth.
4. A CI service container someone maintains.

**The offered list is derived from what passes, never hand-maintained.** A hand-written
list is still valid code when it has gone stale, and the staleness is invisible.

> **The evidence for refusing a third dialect turned out to be wrong, and that is worth
> recording.** The review argued MySQL would silently corrupt data: its `||` is logical
> OR, so `CHECK (id = project_key || '-' || CAST(num AS TEXT))` would "compile and
> validate nothing", and its case-insensitive default collation would silently merge
> `Bug` and `bug`. Run against `mysql:8`, **both claims are false**. The CHECK as
> written fails at `CREATE TABLE` (`TEXT` is not a MySQL CAST target); hand-ported to
> `CHAR` it evaluates to `1` and rejects **every** row, valid ones included. The
> collation case raises a loud duplicate-key error and is removed by one
> `COLLATE utf8mb4_bin`.
>
> A MySQL port would be *obviously* broken, not quietly wrong. The cost is real — six
> hard-coded two-dialect branches, and `DEFERRABLE INITIALLY DEFERRED` has no MySQL or
> MSSQL equivalent at all while `config-schema.mjs`'s `workflow.reopen_to` cycle has no
> insert order that works without one — but cost is a reason to set a bar, not a reason
> to refuse.

### 2. The driver NAME is repo config. The CONNECTION is not.

| Location | Tracked | Holds |
|---|---|---|
| `blaze.config.json` at the board root | **git-tracked** | `database.driver` — the name only |
| `<dataRoot>/.blaze/database.json`, mode 0600 | **never tracked** | host, port, database, user, `passwordEnv` |
| environment | — | `BLAZE_DB_*`, and the password itself |

Every clone of a board speaks the same dialect, so the driver name is repo-shaped, like
`columns`. The connection is instance-shaped and carries a credential.

`.blaze/` is already gitignored and already used for runtime state, so this introduces
no new location.

**`loadConfig` throws** if the tracked file carries `database.url`, `database.password`,
or a `user:pass@` host. A committed password is not something to warn about — and
without this rule, "put the connection in the untracked file" degrades to JIRA's
plaintext `dbconfig.xml` the first time someone pastes a URL into the wrong file.

### 3. The password is never stored by Blaze, and never prompted outside a TTY.

`.blaze/database.json` holds `passwordEnv` — the **name** of an environment variable —
never a password and never a URL containing one.

The wizard prompts for a password **only when `process.stdin.isTTY`**, with echo
suppressed, and uses it to test the connection and then discards it. An agent session
and CI are never a TTY, so a credential cannot reach a transcript. This matters
concretely: the operator's standing rule is that a secret in a transcript forces a
rotation.

> The review recommended routing through `~/.pgpass` and `PGSERVICE` instead, inventing
> nothing. **That was refuted by the installed dependency.** `pg` prints "pgpass support
> is deprecated and will be removed in pg@9.0" (`node_modules/pg/lib/client.js:25`) and
> has no `PGSERVICE` support whatsoever. It would have been built on something being
> removed.

Errors never echo the credential. `pg.Client` is constructed from parsed parts, never a
composed URL string, so an error handler structurally cannot print a password it never
held.

### 4. Precedence, and the headless path

**CLI flag > environment > `.blaze/database.json` > `blaze.config.json` > default.**

That is the shape `config.mjs` already uses. Flags exist only on `blaze init` and
`blaze db *`; they are how a human skips prompts, not a deployment mechanism.

**A container never runs the wizard.** The entire interactive path is gated on
`isTTY`, and in a container config arrives as environment variables from a Helm values
file and a Kubernetes Secret. There is no second declarative format to maintain and no
prompt code path reachable there.

**A headless run with missing configuration fails loudly and names the missing
variable.** It never silently falls back to SQLite — a typo'd env var in a deployment
must not quietly become a different database.

### 5. The default is SQLite, and it is not an evaluation mode

`npx blaze` on a laptop with no configuration uses SQLite at
`<dataRoot>/.blaze/blaze.db`. `node:sqlite` is built into Node 24, so this costs no
dependency and no setup.

This is a deliberate departure from the named model. **JIRA's bundled H2 is a trap it
then warns you against.** Blaze's SQLite is production-capable for a single operator —
it is the same driver, held to the same conformance suite, as the one running the
cluster.

### 6. The wizard asks what STARTUP needs, determined from read sites

The operator's refinement — "environment details that are needed for start up" — is a
sharper brief than "like JIRA", and it is answerable from the code rather than by
analogy. Every value below is classified by what happens when it is absent.

**Two questions are load-bearing. Everything else has a default or is dead.**

| # | Question | Why it earns a prompt |
|---|---|---|
| 1 | **Where should this board live?** | The only hard startup failure. `config.mjs:113` throws `blaze: no data dir found`. The wizard creates `<path>/projects/` and writes `blaze.config.json` there, which satisfies the cwd rung at `config.mjs:107` and makes `BLAZE_PROJECTS_DIR` unnecessary outside a container. |
| 2 | **First project key and name** | `config.mjs:216-218` throws `unknown project '<KEY>'` for every verb except `blaze new`, and `reconcile.mjs:262-263` silently no-ops on an empty `projects` array — a board with no project looks fine and does nothing. |
| 3 | **Which database?** | SQLite (default, no setup) or Postgres. §2 above. |
| 4 | **Connection details** | Postgres only. Host, port, database, user, and the env var that will carry the password. Tested before anything is written. |

Two conditional questions, asked only when `blaze serve`/`blaze start` is the intent —
neither is read by any CLI verb:

- **Port** — `serve.mjs:92`, `supervisor.mjs:247`. Ask only if 4321 is already bound.
- **Board title** — `views/page.mjs:168,274`. Cosmetic `<title>`/`<h1>` only.

**Deliberately not asked:** `agentCommand`, `commitMode`, `codeRepos`, `loops`, `key`,
`provider`, `columns`, `terminal`, `defaultLabels`, and a base URL. The first four have
defaults right for the overwhelming majority. **The rest are dead** — read by nothing,
or read only by a groomer path that cannot match the multi-project layout (blaze-pm
BLZ-298). A wizard question whose answer nothing reads is ceremony borrowed from the
model, not a setup need.

**The base URL is the one place this decision overrules the operator's first
instruction, and it does so on measurement:** zero reads across `scripts/`, and zero
mentions of base URL, webhook, callback or notification in the v3 database design or
the kickoff brief. There is no consumer, present or planned. It is added by the feature
that first needs it, in that feature's change, so the prompt and the reader are
invalidated together.

### 7. The interactive wizard is a wrapper, never the source of truth

`blaze init --db=postgres --host=... --password-env=BLAZE_DB_PASSWORD --yes` is the
contract. The interactive wizard calls exactly that code path and can answer nothing the
flags cannot. Two paths that can produce different config are two sources of truth, and
the second one drifts.

Connection details are **proven before they are saved**: connect, authenticate, check
the server version, and probe `CREATE`-then-rollback in a transaction. A wizard that
reports "connection OK" and then fails at schema creation has lied. Nothing is written
until the test passes.

## Consequences

The operator's stated goal is served by a mechanism rather than by a list, so a future
driver needs no amendment to this decision — only a passing suite.

A default install stays one package with zero dependencies (ADR-0011), and the default
path asks nothing at all.

Blaze never becomes a secret store. The cost is one documented step for Postgres users:
export a variable, or let the wizard prompt at a terminal.

**Runtime `open()` must stop creating schema.** Today `openSqliteRead` execs the DDL on
every open and every statement is `CREATE TABLE IF NOT EXISTS`, so a database created by
an older engine opens successfully with its columns silently absent — reproduced, and
tracked as blaze-pm BLZ-297. Schema creation becomes an explicit, named operation and
runtime open reads and refuses. That defect exists independently of this decision, but
this decision is what makes it unacceptable: an installation that can be *pointed* at an
arbitrary database must be able to tell whether that database is one it understands.
