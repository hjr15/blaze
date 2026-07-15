# ADR-0001: `Blocks` links are advisory, not a hard gate on move

| Field | Value |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-07-15 |
| **Deciders** | Ryan Howman |

## Context

`blaze link` (this PR) lets a ticket carry a typed `Blocks` link — one ticket
declaring it blocks another, mirroring the dependency relationship Jira
tracks with issue links. Jira's own `Blocks`/`is blocked by` link is
advisory by default too, but many teams layer a workflow validator on top
that hard-stops a transition while the blocking issue is open.

Blaze's north star is "simple for an AI to drive": an agent should be able
to move a ticket forward with `blaze move <id> <status>` and trust that a
successful exit means the move happened. A hard gate on `Blocks` breaks
that contract — an agent mid-flow (working a ticket, unaware a stale or
mis-scoped `Blocks` link exists) hits a rejected move for a reason it has
no easy path to override, and now has to go inspect link state before it
can retry the one command it just ran. That's exactly the kind of surprise
the design principle exists to rule out.

At the same time, dependency information has real value — an agent (or a
human) benefits from being told "this ticket you're about to work is still
blocked by an open ticket," even if the tool doesn't stop them.

## Decision

A `Blocks` link is **advisory only**. Moving a ticket to `in-progress`
while an open (non-terminal) ticket holds a `Blocks` link targeting it
prints a warning but the move proceeds unconditionally. Implemented in
`applyMove` (`scripts/move.mjs`): after the existing `planMove` validation
passes, a second pass over the ticket set collects any open `Blocks` link
targeting the ticket being moved and appends a `warnings: string[]` array
to the return value. The move itself is never blocked by this pass.

## Alternatives considered

**(a) Hard-gate the move.** Reject `blaze move <id> in-progress` outright
when an open `Blocks` link targets `<id>`, the way a strict workflow
validator would. Rejected: this is the surprise-an-agent-mid-flow failure
mode above, and it fights the "simple for an AI to drive" design principle
head-on — a tool that can refuse a well-formed command for reasons the
caller didn't set up to check first adds a discovery burden Blaze is
explicitly designed to avoid.

**(b) Advisory warning (chosen).** Surface the dependency without ever
refusing the move. Keeps `blaze move` unconditionally successful once
`planMove` validation passes, while still getting the information in front
of whoever's driving.

**(c) Advisory + a dedicated board badge only.** Render the open-`Blocks`
state as a board-only visual cue and skip the CLI warning entirely.
Rejected: the CLI is the primary agent-driven path, and a board-only
signal would never reach an agent that only interacts via `blaze move`.
The chosen design instead treats the board as one more consumer of the
same link data, not the sole surface for it.

## Consequences

- Link data and integrity are still surfaced independently of this guard:
  `blaze reindex` already lints every ticket's `links` for malformed
  entries and dangling targets (BLZ-10), and the board renders link edges
  in the graph view and the ticket detail panel — both existing surfaces,
  unchanged by this decision.
- The guard is reversible: turning the advisory into a hard gate later is
  a small, localized change — move the same open-`Blocks` check from
  `applyMove`'s post-validation warning pass into `planMove`'s error path,
  so it participates in the existing `{ ok: false, errors }` rejection
  instead of the `warnings` array.
- The advisory warning currently surfaces on the CLI path only. `blaze
  move` prints each `warnings` entry to stderr after a successful move.
  The board's `/api/move` handler calls the same `applyMove` and receives
  the same `warnings` array, but its JSON response returns only `{ ok,
  resolution }` — the warning is computed but not surfaced to the board
  UI. This is an accepted gap for now: the CLI is the agent-driven path
  this guard targets, and board-driven moves are a human clicking a card,
  where the omission is lower-stakes. Wiring `warnings` through
  `/api/move`'s response and into the board UI is separable follow-up
  work, not required for this decision to hold.
