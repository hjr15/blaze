# 39. Board data lives in Postgres; board configuration lives in the platform chart

Date: 2026-10-22

## Status

Accepted (BLZ-711, feature BLZ-703)

## Context

A deployed db-mode board still read its identities, its sprints and its project taxonomy from a
writable checkout of the board's repository, while tickets and events were in Postgres. That left
two stores for one board. A second checkout could be written in fs mode and silently diverge from
the deployed board, with nothing in the engine to notice or refuse it.

The design and its decisions D1 to D10 are in
[`docs/superpowers/specs/2026-10-22-phase5-retire-blaze-pm-design.md`](../superpowers/specs/2026-10-22-phase5-retire-blaze-pm-design.md)
(section 1 for the problem).

## Decision

1. **Board data lives in the board's Postgres database, and nowhere else,** once the database is at
   schema v6, which `blaze db migrate` brings it to and marks authoritative. The v6 features key on
   the schema stamp, not on the authoritative flag: a database `blaze db init` creates at v6 already
   reads identity and sprints from Postgres. Board data is tickets, events, users, tokens, sessions and sprints.
   Identity is six tables (`app_user`, `user_identity`, `membership`, `api_token`, `local_password`,
   `user_session`) and sprints are two (`sprint`, `sprint_registry`). `blaze db migrate
   --identity-from` and `--sprints-from` copy an existing `identity.db` and `sprints.json` in once,
   verified row for row.
2. **Board configuration is mounted read-only from the deployment's own versioned configuration,**
   for example a Helm chart. That is `blaze.config.json` and `projects/<KEY>/project.json`. It is
   reviewed, versioned and revertible there, and the engine reads it unchanged through `loadConfig`
   and `loadProject`.
3. **The schema moves forward only, in one transaction** (D1). `DB_SCHEMA_VERSION` becomes 6 and
   `MIN_DB_SCHEMA_VERSION` stays 5, so a v5 database serves exactly as before until it is migrated.
4. **A postgres-driver config refuses implicit file writes** (D5). A board whose config names
   `database.driver: "postgres"` refuses a verb or runner that would write files while
   `BLAZE_WRITE_PORT` is unset. An explicit `BLAZE_WRITE_PORT` (`fs`, `dual` or `db`) is allowed,
   because it states where the write goes. `blaze db *` and `blaze init` are exempt (`blaze init`
   only creates a new board directory), and remote mode never reaches the guard.
5. **Remote mode is the agent surface, and admin verbs run inside the deployment** (D7). An agent
   reaches the board over its HTTP API with a bearer token; `blaze user`, `blaze sprint` and the
   migration run where the database credentials already are.

## Consequences

- `blaze db init --force` is refused on every Postgres database already; the authoritative flag
  newly guards `blaze db load --replace`, which is refused on an authoritative database. The
  `older` schema refusal on it names `blaze db migrate`, never a rebuild.
- A `pg_dump` is the backup, and it now holds credential hashes (password verifiers and token
  hashes). Treat a dump as a secret and take one before every migrate.
- fs mode is unchanged: an fs board keeps `sprints.json`, `identity.db` and `project.json` as files.
- An engine older than 0.10.0 is not protected by the guard in decision 4, because it has no guard.
  It would also refuse a v6 database as newer, but a v5 database that has not yet been migrated is
  still writable by it.
- A fresh SQLite shadow is stamped 6 and an older engine refuses it as newer. That is harmless: the
  shadow is derived and `blaze db init --force` rebuilds it.
- The guard has known gaps, listed in AGENTS.md under
  [A Postgres board refuses file writes](https://github.com/hjr15/blaze/blob/main/AGENTS.md#a-postgres-board-refuses-file-writes):
  the board server's first-user setup writes the setup-token file and its `.gitignore` line (its
  `identity.db` write goes through `addUser` and is refused), the supervisor's `/control/revert` runs
  `git revert` in the data root, and a direct `reindex.mjs` or `matrices-runner.mjs` writes derived
  files only.
- An empty v6 roster beside a `.blaze/identity.db` that holds users is refused, not served as "no
  users": both servers fail closed and name `blaze db migrate --identity-from`.
- db mode on a Postgres board needs the database reachable at start, even at v5, because the stamp
  decides where identity and sprints are read. The board servers, `blaze user` and `blaze sprint`
  refuse when it is down. A deployed server restarted during a database outage crash-loops until the
  database returns, rather than answering `503` per request as before 0.10.0.
- `dual` and `fs` read `identity.db` even on a v6 database. A server started with
  `BLAZE_WRITE_PORT=dual` after a migrate authenticates from that stale file until it is removed, so
  a token revoked in Postgres since the migrate still works there.
- The Live view reads local files only, so it shows nothing for a Postgres-only board (D10).
  `GET /api/live` and `/view/live` are gated by `views.live` (BLZ-724).
- On a db board `blaze reconcile` and `/api/reconcile-preview` refuse, so tickets move only by
  explicit `blaze move` (D6, BLZ-723). Agents with no checkout read with remote `blaze show` and
  `blaze list` (D7, BLZ-709).
- A concurrent pair of `blaze sprint` saves on one board can lose an update, because the registry is
  read, changed and written without a table lock. BLZ-727 tracks it.

## Alternatives rejected

- **Identity on a PVC** (D2(a)). It keeps the SQLite `identity.db` as a second stateful volume
  with its own backup story, only to preserve a file format. In Postgres, identity joins the
  database's own backup.
- **Project configuration in `blaze_config.project`** (D4(a)). It needs a reader, a loader and an
  editing verb for data that changes a few times a year, and a table row has no review, history or
  revert unless an audit trail is built. Configuration in versioned deployment config gets all
  three, and needs no engine change.
- **Raising the floor to 6** (D1(a)). A v5 database would be refused until it is migrated, so a
  routine rollout of the new engine would take a running board down. With the floor at 5, merging
  the engine changes nothing live and the switch happens when the operator migrates.
- **Adding tables without a version bump** (D1(c)). It is the silent schema change the stamp exists
  to prevent: a database created before the change and one created after it would carry the same
  stamp and different tables.
