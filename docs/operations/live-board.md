# Running a live board

How a deployed, shared Blaze board is laid out and operated: where the data lives, how people
and agents write to it, and which commands run where. Every hostname, namespace and path below
is a placeholder (`https://blaze.example.com`, `<namespace>`, `/path/to/…`); substitute your
deployment's own.

## Where the board runs

A deployment runs `node scripts/serve.mjs` with `BLAZE_WRITE_PORT=db` and a `database` block
in `blaze.config.json` naming `driver: "postgres"`. The tickets and the id counter live in
Postgres. Once the database is at schema v6 (after `blaze db migrate`,
[ADR-0039](../decisions/0039-board-data-lives-in-postgres-board-config-in-the-platform-chart.md)),
the sprint registry and the users live there too. Below v6, identity is still read from
`identity.db` and sprints from `sprints.json`. There is no ticket tree on the server's disk to
edit, back up or commit.

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
- `blaze show` and `blaze list` read; `blaze new`, `move`, `edit`, `resolve`, `log`, `link` and
  `ac` write. Every other command is refused in remote mode.
- Scope the variables to the command (or a shell kept for the purpose), never a global
  `export`.

## Writing a body and acceptance criteria

An agent with no checkout gives a ticket its body and criteria from files (BLZ-729). The body is
markdown; the criteria file holds one criterion per line:

```bash
BLAZE_REMOTE_URL=<board origin> BLAZE_TOKEN_FILE=/path/to/token \
  blaze-live new --project ENG --type task "Add the export" --estimate 60 \
    --body-file body.md --ac-file criteria.txt

# replace the body (or only the criteria) of an existing ticket
blaze-live edit ENG-12 --body-file body.md
blaze-live edit ENG-12 --ac-file criteria.txt

# add one criterion, then tick criterion 2 (counting from 1)
blaze-live ac add ENG-12 "the export is documented"
blaze-live ac toggle ENG-12 2
blaze-live ac toggle ENG-12 2 --uncheck
```

(`blaze-live` is `blaze` with those two variables set; write it however your machine does.)

- The body is capped at 128 KiB (131072 bytes) and a whole request at 256 KiB (262144 bytes).
  The client refuses an over-size file or request before sending, so a refusal is a clear line
  and never an opaque 400. A stored body cannot be grown past 128 KiB by an edit or an `ac add`
  either: the server refuses it with the byte count.
- `--body-file` replaces the **whole** body. To change one part of a body, read it with
  `blaze show <id> --json`, edit the text and send the whole of it back.
- A server older than 0.11.0 does not know these. `new` with a body against one creates the
  ticket with the template body and the client then exits `1` saying so
  (`created ENG-9 but ignored the body … older than BLZ-729 (0.11.0)`), and `edit --body-file` or
  `ac add` against one says `the server at <board origin> has no /api/body — it is older than
  BLZ-729 (0.11.0)`. Upgrade the server; do not retry.

## Admin verbs run inside the deployment

The commands that need the board's data on the machine — `user`, `sprint`, `db`, `audit`,
`matrices` and `import` — run inside the deployment itself. The container's disk is
temporary, so run `matrices` with `--check`, or with `--out <dir>` followed by `kubectl cp` to
copy the files out:

```bash
kubectl exec -n <namespace> deploy/<name> -- node scripts/cli.mjs <verb> …
```

`blaze user add` prints the new token **once**; only its hash is stored. Run it yourself and
send the token line straight into the machine's token file, so it never sits in a terminal
scrollback or a chat:

```bash
( umask 077; set -o pipefail
  kubectl exec -n <namespace> deploy/<name> -- node scripts/cli.mjs user add \
      --email agent-1@example.com --role member \
    | awk '/^ *blz_[^ ]+ *$/ { print $1; n++; next }
           { print > "/dev/stderr" }
           END { exit n == 1 ? 0 : 1 }' > /path/to/token.new
) && mv /path/to/token.new /path/to/token || rm -f /path/to/token.new
```

- The subshell keeps `umask 077` and `pipefail` out of your own shell, and the new file is
  created mode `0600`.
- Only a line that is a single `blz_…` word goes to the file. Every other line of the output
  goes to stderr, where you can read it: the user it created, its scopes, and a **NOTE** about
  restarting. Tokens are checked on every request, so on a board that already has users the new
  token works at once; a restart is needed only when this is the board's very first user.
- The existing token file is replaced only when the whole pipeline succeeded **and** exactly
  one token line was found. A failed `kubectl exec`, a refusal, or output with no token leaves
  the old file untouched and removes the partial `token.new`.

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
