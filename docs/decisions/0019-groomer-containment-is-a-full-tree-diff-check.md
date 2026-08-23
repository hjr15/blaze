# ADR-0019 — Groomer containment is a full-tree diff check, and the loop ships disabled

- **Status:** accepted
- **Date:** 2026-08-23
- **Ticket:** BLZ-347
- **Context:** `groomOnce` filtered `git status --porcelain` down to the configured
  groomable status directories *before* any guard ran. Every downstream step — the rename
  guard, `isStructuralChange`, the three-command revert, the auto-commit — only ever saw
  that filtered set. Anything the agent wrote outside those directories was never seen,
  never refused, never reverted, and was left in the working tree.
- **Why it mattered:** `blaze.config.json` sits at the data root, outside every status
  directory, and is not gitignored. It holds `agentCommand` — the string the *next* pass
  executes, with the full inherited environment. The loop shipped `enabled: true` and the
  supervisor auto-starts every enabled loop.

## Decision

**Full-tree diff check.** Survey every path `git status` reports, before any other outcome
is decided; if anything lands outside the groomable directories, revert the whole pass and
return `refused` with the offending paths.

Three answers were available. The two not taken:

- **OS-enforced allowlisted write path** (Landlock, bubblewrap, seccomp) is the only one
  that *prevents* rather than *detects*. Rejected on portability: it is Linux-only in
  practice, it would have to wrap whatever arbitrary `agentCommand` the operator
  configured, and Blaze ships as a portable npm package under a hard "Node stays the
  runtime" constraint ([ADR-0016](0016-node-stays-the-runtime.md)). Every install would
  carry a non-Node dependency, including the ones that never enable this loop.
- **"The agent is trusted; the guard is advisory."** Rejected because it leaves
  `agentCommand` writable by the very process it launches — a self-escalating loop — and
  trustworthiness is not a property Blaze can assert about a command string it did not
  write.

## What this buys, and what it does not

Buys: an out-of-bounds write can no longer arrive as a `noop` or as a clean commit,
because the survey runs first. The revert covers everything touched, not just the stray
path — a pass that reached outside its ticket has disqualified its in-bounds edit too.
`blaze.config.json` additionally gets a byte-for-byte snapshot and restore that does not
go through git at all, because a board may gitignore it and `git status` never reports an
ignored file.

Does not buy: detection is after the fact. A network call, a write outside `root`, or a
process that outlives the pass is outside what a diff can see.

## Consequences recorded, not fixed

- **The loop now ships `enabled: false`.** That residue above is the reason. Launching an
  arbitrary agent CLI on a 300-second timer with the full inherited environment is an
  operator opt-in, not a shipped default. `reconcile` stays enabled — it only runs git and
  moves files.
- **`spawnSync` still blocks the event loop.** `supervisor.mjs` calls `groomOnce`
  synchronously from the HTTP server process, so an agent run is a total board outage for
  its duration. Converting to async `spawn` changes the function signature and every
  caller and test; it is a larger change than this bug warrants. It is *bounded* instead:
  a wall-clock `timeout` (default 900s, `killSignal: SIGKILL` — SIGTERM is deferred by a
  shell waiting on a foreground child, and a timeout that can itself hang is not a
  timeout) caps the outage, and the default flip means no install takes it unasked.
- **Secrets are redacted at persistence time**, where the event object is built, not where
  it is printed. Denylist: `sk-ant-`, `sk-`, `ghp_`, `github_pat_`, `gho_`, `AKIA`,
  `blz_`. Redaction runs before the 200-character truncation, so a key cannot be stored
  half-truncated and the diagnosis after it is not thrown away.
- **Untrusted ticket content is no longer last in the prompt.** The delimiter carries a
  per-call random nonce the ticket body cannot forge, and a guard restatement follows the
  body so the last instruction read is Blaze's.

## Known gap, left open deliberately

`agent_command` is also a plaintext, user-writable database column
(`scripts/model/config-schema.mjs`) — the same hole reachable by a DB write rather than a
file write. The file path is closed here; the DB path belongs with the v4 storage work,
not with this fix.
