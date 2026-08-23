# ADR-0020 — Autonomous implementers are no longer deferred; the ceiling is `in-review`

- **Status:** accepted
- **Date:** 2026-08-23
- **Ticket:** BLZ-352 (goal BLZ-345, design BLZ-346, capability gate BLZ-349)
- **Supersedes:** `docs/design.md`'s "No code-writing worker loops" non-goal.

## Context

`docs/design.md`'s non-goals said, verbatim:

> **No code-writing worker loops.** The loops keep the *board*; they never cut branches or
> write code in the mirrored repo. (This was an explicit fork in the brainstorm — autonomous
> implementers are deferred.)

That was a deliberate fork, not an oversight, and it held for the whole of v3 and the v4 spine.

BLZ-345 asks for the other branch of that fork: a user connects an LLM of their choice and
dispatches a work item to an agent that works on it. BLZ-346's grill settled what "work on it"
means — **the full ladder**, up to and including opening a pull request. That reverses this
non-goal under every architecture considered, and reverses it whether or not Blaze ever holds
an API key.

Deferral was the right call while the capability was unproven. **BLZ-349 proved it.** A `claude -p`
run, given one Blaze ticket as a prompt, wrote a failing test, injected a mutation to confirm the
test discriminated, fixed the code, committed, pushed and opened a PR — with an explicit
`--allowedTools` allowlist and **no permissions bypass**. The reason to defer has expired.

## Decision

**Blaze may dispatch a work item to an agent that writes code and opens a pull request.**

Four constraints, each load-bearing:

1. **The ceiling is `in-review`. Blaze never merges.** A run drives a ticket as far as an open
   PR and stops.
2. **Blaze is the dispatcher and the ledger. It is never the runtime.** The agent is a
   delegated CLI. Blaze builds ticket → prompt → run record → git signal → board status, and
   does not build an agent harness.
3. **The agent runs where the credentials already are** — the user's own machine for
   self-hosted, a customer-operated runner for cloud. Blaze holds no LLM key.
4. **A run is a durable, attributable object** — one `agent_run` row per dispatch, in the
   board's own database, attributed to a ticket carrying `project_key`.

## The `in-review` bound is a POLICY, not a permission-model guarantee

This must be recorded honestly, because it is easy to assume otherwise.

GitHub's permissions reference places `PUT /repos/{owner}/{repo}/pulls/{n}/merge` under
**`Contents: write`** — the same scope required to push a branch. **Push and merge cannot be
separated.** GitHub Apps are also eligible bypass actors in rulesets.

So the bound is enforced by three things, none of which is the permission model:

- Blaze never calls the merge endpoint.
- A customer-side branch-protection ruleset, **verified per repo at install time**.
- A minimal custom GitHub App requesting only `Contents`, `Issues`, `Pull requests` — and
  explicitly **not** `Workflows: write`, which would let an agent rewrite the CI that runs its
  own output.

**Unresolved and flagged:** whether an App's approving review satisfies required-approvals.
`github-actions[bot]` is documented as not counting; no primary source was found for custom
Apps. Until settled, Blaze must not rely on its own approval counting for anything.

## What this does NOT reverse

**`docs/design.md`'s "no API key handling inside Blaze" bullet is UPHELD.** It sits two lines
below the one this ADR supersedes and it would be easy to assume both fell together. They did
not. Because the agent runs where the credentials already are, Blaze never holds an LLM key —
so the hardest constraint BLZ-345 identified for itself dissolved rather than being solved. The
only secret Blaze stores is a runner pairing token, which is the same class as `api_token` in
`identity.mjs`: hashed, never retained in plaintext, shown once.

## Relationship to the ADRs this touches

- **ADR-0003 (delivery truth, not deploy truth) — governs, and is not contradicted.** It ruled
  that the engine mirrors delivery state and reads `git`/`gh` exclusively, leaving deploy
  reality to the infra layer: *"Two truths, two layers."* The same reasoning applies here.
  Blaze **observes** an agent run through git and PR signals — which `reconcile` already does —
  and does not **become** the execution layer. That is precisely why the agent runs on the
  user's machine or their runner, and why server-side execution was rejected.
- **ADR-0007 (eight services; `blaze-core` the sole ticket writer).** No service in that
  decomposition is described as a code writer. A dispatcher is a new responsibility and must be
  placed deliberately rather than bolted onto `serve.mjs`. Amend before any server-side
  execution ships.
- **ADR-0011 (database clients are optional peer dependencies).** The mechanism for anything
  this needs. **No new REQUIRED runtime dependency** — the chosen architecture adds zero, which
  is one of the reasons it was chosen.
- **ADR-0013 (identity) — constrained, not reversed.** "Each user" in BLZ-345 has no subject
  until identity is live (BLZ-348).
- **ADR-0014 (tenancy) — a hard wall, untouched.** The `agent_run` table carries no tenant or
  board discriminator. A design that only makes sense with rows from more than one board
  coexisting is the wrong design.
- **ADR-0019 (the groomer's guard is advisory).** The existing groomer is anti-agency by
  construction — it reverts any status change and its prompt forbids transitions. It is **not**
  the evolution path for this work; generalising it would invert the one invariant it exists to
  enforce.

## Consequences

- `docs/design.md`'s non-goals list loses the "no code-writing worker loops" bullet and gains a
  pointer here.
- Every dispatch needs an explicit tool allowlist. `cfg.agentCommand.split(" ")` cannot express
  one — the required flags contain quoted arguments with spaces and parentheses — so that seam
  must be redesigned before anything ships.
- A zero exit code is not evidence of work. BLZ-349 measured a run that exited 0 having written
  nothing, which is exactly what today's groomer would record as success. Run outcomes must be
  read from git and filesystem state, never from an exit code.
- The blast radius of a run is bounded by where it executes, not by prompt engineering. Prompt
  injection is unsolved industry-wide; ADR-0019 records the same conclusion for the groomer.

## What would reverse this

A capability result that no longer holds. BLZ-349 was **n=1 by design** — a capability check,
not a benchmark — and it deliberately set no success rate, because a 20-ticket/40% bar was
refuted as an experiment (the 95% CI for 8/20 spans 21.9–61.3%). If dispatch in practice cannot
reach a reviewable PR without a permissions bypass, the containment story that this architecture
rests on is gone, and the honest response is to reopen BLZ-346's Q1 and scope BLZ-345 down to
advisory output.
