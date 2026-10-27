# Running a live board

How a deployed, shared Blaze board is laid out and operated: where the data lives, how people
and agents write to it, and which commands run where. Every hostname, namespace and path below
is a placeholder (`https://blaze.example.com`, `<namespace>`, `/path/to/…`); substitute your
deployment's own.

## Where the board runs

A deployment runs `node scripts/serve.mjs` with `BLAZE_WRITE_PORT=db` and a `database` block
in `blaze.config.json` naming `driver: "postgres"`. The tickets, the id counter, the sprint
registry and the users all live in Postgres
([ADR-0039](../decisions/0039-board-data-lives-in-postgres-board-config-in-the-platform-chart.md)).
There is no ticket tree on the server's disk to edit, back up or commit.

## Configuration

`blaze.config.json` and each `projects/<KEY>/project.json` are mounted **read-only** from the
deployment's versioned config (a chart's values, a ConfigMap, or equivalent). A new project,
label, component or workflow is a reviewed change to that config, followed by a rollout — not
an edit on the running box, which the read-only mount refuses anyway.

## Agents and people write remotely

Every machine that writes to the board does it over HTTP, in
[remote mode](../guide/commands.md#remote-mode):

```bash
BLAZE_REMOTE_URL=https://blaze.example.com \
BLAZE_TOKEN_FILE=/path/to/token \
  blaze move ENG-12 in-progress
```

- `BLAZE_TOKEN_FILE` names a file holding the token, mode `0600`. `BLAZE_TOKEN` (the token
  itself) also works and wins when both are set; the file keeps the token out of the shell's
  environment and history. An unreadable, empty or whitespace-bearing file is refused with a
  line naming the path — never its content.
- If the server's certificate comes from a private CA, point Node at that CA:
  `NODE_EXTRA_CA_CERTS=/path/to/ca.crt`. Without it, `blaze` reports the certificate as not
  trusted, names the TLS error code, and suggests exactly this.
- `blaze show` and `blaze list` read; `blaze new`, `move`, `edit`, `resolve`, `log` and `link`
  write. Every other command is refused in remote mode.
- Scope the variables to the command (or a shell kept for the purpose), never a global
  `export`.

## Admin verbs run inside the deployment

The commands that need the board's data on the machine — `user`, `sprint`, `db`, `audit`,
`matrices` and `import` — run inside the deployment itself:

```bash
kubectl exec -n <namespace> deploy/<name> -- node scripts/cli.mjs <verb> …
```

`blaze user add` prints the new token **once**; only its hash is stored. Run it yourself and
send the token line straight into the machine's token file, so it never sits in a terminal
scrollback or a chat:

```bash
umask 077
kubectl exec -n <namespace> deploy/<name> -- node scripts/cli.mjs user add \
    --email agent-1@example.com --role member \
  | awk '/^ *blz_/ { print $1 }' > /path/to/token
```

## One token per machine

Give each machine (each agent host, each laptop) its own `member` user and its own token. A
machine that is lost or retired is then revoked on its own, and no other machine's token
changes.

## Moves are explicit

A db board does not run `blaze reconcile`: tickets change status only by an explicit
`blaze move` (remote mode). Reconcile, which derives moves from branches and pull requests,
works on file boards only, and refuses on a db board — dry run included.

## There is no Live view

The Live activity feed is a local file written by a local hook, so a board served from a
database has nothing to show there. Set `views.live: false` in the board's config; `/view/live`
and `/api/live` then both answer `404`.

## Backups

A `pg_dump` of the board database holds the users' password and token **hashes** as well as
the tickets. Write dumps into a directory of mode `0700`, and treat them as credentials-adjacent.

Restore with `pg_restore` into the database. Never use `blaze db init --force` or
`blaze db load --replace` to "restore" a Postgres board: the first is refused on every Postgres
database, and the second is refused on an authoritative one (a database `blaze db migrate` has
marked) — that database *is* the board, with no file corpus to reload it from
([ADR-0039](../decisions/0039-board-data-lives-in-postgres-board-config-in-the-platform-chart.md)).
