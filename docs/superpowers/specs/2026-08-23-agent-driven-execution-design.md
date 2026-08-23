# Agent-driven execution — design spec

**Goal:** BLZ-345. **Grill + brainstorm:** BLZ-346.
**Date:** 2026-08-23. **Status:** design, approved by the operator; no code written under it.

A user connects an LLM of their choice and dispatches a Blaze work item — a ticket at any
level, or a sprint — to an agent that works on it, and watches it work from inside Blaze.

This spec is written from a five-lane expert panel and an adversarial review of that panel's
consensus. The panel record is
`docs/superpowers/plans/2026-08-23-blz-346-q2-panel-findings.md`; the brief the lanes answered
is `2026-08-23-blz-346-q2-panel-brief.md`. **Read the findings document before disputing
anything here** — four of the panel's nine consensus points were refuted, and the reasoning
that survives is not the reasoning it started with.

---

## 1. The two decisions everything else follows from

### 1.1 What "work on it" means — the full ladder

Four rungs, ascending: **(a)** groom the ticket · **(b)** produce a plan or spec ·
**(c)** write code and open a PR · **(d)** drive the ticket to done.

The answer is **all four**. The operator's words: *"all 4 really — whatever is needed to
complete the task."*

Rungs are not four products. They are a **capability ladder with a per-dispatch ceiling**. A
run declares its rung; the runner refuses to exceed it. The default ceiling is (c).

**Rung (d) stops at `in-review`.** The agent never merges. See §5.3 for why this is a policy
rather than a mechanism, which is a distinction the panel initially got wrong.

### 1.2 Where the agent runs

| Deployment | Answer |
|---|---|
| **Self-hosted** | **(a)** — the agent runs on the user's own machine; Blaze stores no secret and inherits credentials from the environment, as `groomer.mjs:210-213` does today |
| **Cloud SaaS** | **(c) hybrid** — Blaze owns the queue, run records, transcripts and UI; a paired runner the customer operates executes with credentials Blaze never sees |

**Server-side (b) is rejected for SaaS — but not for the reason first given.** The panel's
custody argument ("the decryption key must live on the box that uses it") proves too much: it
would rule out every CI provider and secret manager in existence. The argument that survives is
the **build matrix**. Rung (c) means running the customer's tests, which means reproducing the
customer's toolchain — language versions, native build deps, service containers, private
registries, warmed caches — per customer, forever. That is a CI company, and it is maintenance
load rather than build load, so it never amortises.

**Consequence, stated because it matters: if the build matrix gets an answer — the customer
supplies a container image, or execution moves into their own CI — (b) returns to the table.**
The operator's server-side instinct was not defeated on principle.

### 1.3 What 1.2 collapses

The hardest constraint in BLZ-345 — *"a usable LLM API key must stay decryptable, which is a
different secret class from anything Blaze holds today"* — **dissolves.** Under (a) and (c),
Blaze never holds an LLM key at all.

- **Q3, key storage:** the only secret Blaze stores is a runner **pairing token**, which is the
  same class as `api_token` in `identity.mjs` — hash it, never retain plaintext, show it once.
  No new encryption primitive. `docs/design.md:47-48` ("no API key handling inside Blaze") is
  therefore **upheld, not reversed**.
- **Q4, cost:** you cannot overspend a key you do not hold. Per-token budgeting is not Blaze's
  problem. What survives is **run-count fan-out** on sprint dispatch (§4.3) — a concurrency
  concern, not a billing one.
- **Q5, multi-provider:** provider configuration belongs to the runner. Blaze's job is to **not
  model providers at all.** It dispatches work; the runner decides what answers.

---

## 2. What is bought, not built

`claude -p` — already Blaze's default `agentCommand` (`config.mjs:19`) — is the runtime. Blaze
builds **ticket → prompt → run record → git signal → board status**: a dispatcher and a ledger.
It never builds an agent harness, and it never builds a sandbox for the self-hosted case.

**This is contingent on a capability the panel asserted and the adversary refuted.** In `-p`
the starting permission mode is `default`, where only reads run without asking; `Edit`, `Write`,
`git commit`, `git push` and `gh pr create` all require approval, and there is no built-in
"open a PR" — it is Bash. Worse, `cfg.agentCommand.split(" ")` (`groomer.mjs:207`) is a naive
space split with no quoting, so `claude -p --allowedTools "Bash(git commit *)"` **cannot be
expressed in `agentCommand` at all**.

**BLZ-349 is the gate on this entire spec.** One ticket, one scratch clone, one hour; record six
binaries — exit 0 / wrote a file / committed / pushed / opened a PR / which flags were needed.
If reaching a PR requires a permissions bypass, the containment story that (a) and (c) were
chosen on is gone, and **Q1 must be reopened and this spec scoped down to advisory output.**
That is a legitimate outcome, not a failure.

---

## 3. Architecture

### 3.1 The run is the object; its location is a driver

One durable row, in the board's own database:

```
agent_run(
  id, ticket_id, project_key, rung,
  state,            -- queued | claimed | running | succeeded | failed | cancelled | expired
  runner_id, lease_expires_at, attempt, cancel_requested_at,
  workspace_ref, head_sha_before, head_sha_after,
  exit_code, pr_url, created_at, updated_at
)
```

**Storage and attribution are orthogonal, and conflating them caused a design question that did
not exist.** Storage: the board's database, because on a self-hosted install it is the only
database there is. Attribution: the **ticket**, carrying `project_key` — so per-project run
metrics are a `GROUP BY project_key` and per-ticket history is a `WHERE`, exactly as every
existing project metric already works.

ADR-0014 is satisfied: no row assumes tickets from more than one board coexist. No `tenant_id`,
no `board_id`.

**Do not widen `ticket_event`.** Its `kind` CHECK is closed (`sqlite-schema.mjs:138-140`), so a
new kind is a `db-schema-version` bump. Runs get their own `agent_run_event`; a `ticket_event`
is emitted only when a run actually transitions the ticket.

### 3.2 Transport — outbound long-poll, never server-to-runner

`GET /api/runs/claim?wait=30`, held open, returns a run or 204. Pure `node:http`, no new
dependency. The runner dials **out**; Blaze never connects in.

This survives NAT, CGNAT, corporate proxies and sleep/wake, and it is what both leading vendors
shipped independently within five months — Cursor's self-hosted cloud agents (*"connects
outbound via HTTPS… no inbound ports, firewall changes, or VPN tunnels required"*, GA
25 Mar 2026) and Anthropic's runners (*"Anthropic never connects into your network. The control
plane remains Anthropic-hosted"*).

**Self-hosted is the same transport with the runner on loopback**, but it is **not** unified
behind an `Executor` interface. That abstraction is explicitly rejected — see §7.1.

Note for implementation: `/api/live` is **not** an SSE bus. It returns plain JSON and the client
3-second-polls it (`serve.mjs:103-105`, `views/live.mjs:39`). The only SSE in the repo is
`/events` in the supervisor. Poll; do not assume a bus exists.

### 3.3 Transcripts — the one irreversible decision

`<dataRoot>/.blaze/runs/<run_id>/transcript.jsonl` — append-only, gitignored (`.gitignore:20`),
regenerable, truncatable. **The database stores a pointer and a byte offset, never the bytes.
The ticket gets one summary line and a link.**

The pattern is already proven in-repo by `activity.jsonl`, whose 500-line tail cap
(`activity.mjs:12`) keeps reads cheap regardless of file size.

Both obvious alternatives poison something permanent: into the ticket markdown pollutes a
git-tracked corpus forever on every board that ever runs once; into a DB TEXT column bloats
every `SELECT` and every backup, and would put customer source code in a shared table.

**Do not put transcripts in the v4 `artifact` store.** `ARTIFACT_KINDS = ["requirement",
"architecture"]` (`artifact-schema.mjs:8`) — it is the requirements entity, not a blob store.
Name collision only.

### 3.4 Data flow

```
click → agent_run(queued)
      → runner claims (long-poll) → agent_run(claimed, lease set)
      → runner executes with ITS OWN key and toolchain → agent_run(running)
      → transcript chunks POSTed back, appended to .blaze/runs/<id>/transcript.jsonl
      → branch pushed via a GitHub App installation token
      → PR opened
      → `blaze reconcile` reads PR state (it already does this) → ticket → in-review
      → a human merges
```

The last two steps need **no new code**: `reconcile` already joins branch and PR state to
tickets by `<KEY>-<n>`. That is the whole reason this is a dispatcher and not a platform.

---

## 4. Behaviour

### 4.1 Timeouts, cancellation and failure

- **Wall-clock timeout, enforced twice** — in-process on the spawn, *and* outside it, because an
  in-process timer dies with the process that would enforce it. Default 15–30 min.
- **`spawnSync` must become async `spawn` with `detached: true`**, so `process.kill(-pid)`
  reaches the agent's own children; a bare `child.kill()` orphans the tree. Today `spawnSync`
  blocks the event loop for the whole run — on the supervisor that is a total board outage for
  its duration (BLZ-347).
- **Set `maxBuffer` explicitly.** Node's 1 MB stdout default silently kills a chatty agent and
  reports it as a generic non-zero exit.
- **Cancellation is cooperative and does NOT undo work.** Board sets `cancel_requested_at`;
  runner acts on next heartbeat — SIGTERM, 10s grace, SIGKILL — then records `cancelled` with
  the head SHA and **leaves the branch**. Per-run `git worktree`, so debris is one directory.
- **A failed run is a failed run record. No retry.** Retrying a non-deterministic code writer
  produces conflicting branches, not a fixed ticket.
- **Never trust exit 0.** `groomer.mjs` never reads agent stdout and is already blind to this;
  a zero exit does not mean work happened. Inspect git and filesystem state directly. Note that
  `groomer.mjs:214-216` never inspects `r.error`, so a **missing binary reports identically to a
  failed run** — verified on this machine, where `claude` is a dangling symlink.
- **At-most-once for side-effecting rungs.** At-least-once only for rung (a).

### 4.2 Idempotency and lost runners

Lease expiry requeues the run. A requeued run at rung (c) or (d) must not duplicate side
effects: the runner checks `head_sha_before` against the branch before acting, and refuses if
the world moved.

### 4.3 Sprint dispatch

Specified in full, **including concurrency** — but the shipped default concurrency limit is
**1**, configurable upward.

The mechanism is designed so the blast radius is a configuration change, not a rewrite; the
default is 1 because concurrency multiplies every unknown by N while BLZ-349 is unanswered.

- Dispatching a sprint enqueues one `agent_run` per eligible ticket, in a stated order.
- Ticket 3 of 12 failing does **not** halt the rest; each run is independent and its own row.
- A partial sprint run is resumable because state lives per-run, not per-sprint.
- Eligibility is explicit: a ticket already `in-review` or terminal is skipped, and the skip is
  recorded rather than silently dropped.

---

## 5. Security

### 5.1 What Blaze holds

Under (a): **nothing.** Under (c): a runner pairing token, hashed, never retained in plaintext,
shown once — `identity.mjs`'s existing discipline, unchanged.

**The UI must make the paste path the only path, and safe:** TLS only; `type="password"`,
`autocomplete="off"`, `data-1p-ignore`/`data-lpignore`; write-only field that never re-renders
the value; never in a query string; request body never logged. A redaction denylist
(`sk-ant-`, `sk-`, `ghp_`, `github_pat_`, `gho_`, `AKIA`, `blz_`) applies **at persistence
time**, not display time — transcripts included, since §3.3 makes them the one place a key can
still leak.

### 5.2 Git identity — a GitHub App, never a stored PAT

Short-lived installation tokens (1 hour), installer-chosen repository scope, a real
`app-slug[bot]` principal, verified bot signing, and escalation requiring re-consent. GitHub
recommends Apps over PATs *and* over deploy keys, on each alternative's own documentation page.
Verified across ten vendors; `Contents: read/write` + `Pull requests: read/write` is universal.

Two design rules fall straight out:

- **Consent is all-or-nothing.** Anthropic documents it: *"When you install the app, you accept
  its full permission set. GitHub doesn't let you accept a subset."* Blaze therefore requests a
  **minimal** custom App — `Contents`, `Issues`, `Pull requests` — and nothing else.
- **Refuse `Workflows: write`.** Devin, Anthropic and OpenHands request it; Qodo does not. It
  lets the agent rewrite `.github/workflows/` — structurally the *same defect* as BLZ-347's
  `agentCommand` hole: a config the agent can edit that decides what runs next.

### 5.3 "Blaze never merges" is a POLICY, not a mechanism

`PUT /repos/{owner}/{repo}/pulls/{n}/merge` sits under **`Contents: write`** — the same scope
required to push a branch. **Push and merge cannot be separated in GitHub's permission model.**
GitHub Apps are also eligible bypass actors in rulesets.

So the gate is enforced by a **customer-side branch-protection ruleset, verified per repo at
install time**, and by Blaze never calling the merge endpoint. It is a good policy with strong
precedent — GitHub's own Copilot coding agent cannot approve, merge, mark ready-for-review or
push to default — but Blaze does not get it for free.

**Unverified and flagged:** whether an App's approving review satisfies required-approvals.
`github-actions[bot]` is documented as not counting; no primary source found for custom Apps.
Until settled, Blaze must not rely on its own approval counting for anything.

### 5.4 Prompt injection is unsolved; put the boundary in the OS

A ticket is user-authored markdown that becomes the agent's prompt. `buildPrompt`
(`groomer.mjs:108-127`) currently places guard instructions **first** and untrusted content
**last** — the weakest position against last-instruction-wins. Treat the agent as
hostile-by-default; better prompt guarding is not the mitigation. Under (a)/(c) the user's own
machine is the boundary, which is a further reason not to be (b).

---

## 6. Prerequisites

**Nothing in this spec is worth building until these land, in this order:**

1. **BLZ-349** — the capability probe. Gates everything. One hour.
2. **BLZ-347** — the groomer containment gap and the missing timeout. Must precede any dispatch
   experiment on a board where `blaze.config.json` is writable in the agent's cwd, because such
   an experiment is exactly what triggers the escalation loop.
3. **BLZ-348** — wire the dormant identity layer into `serve.mjs` and ship `blaze user add`.
   **Not** a prerequisite for a CLI-only slice; **hard** prerequisite for the HTTP dispatch
   route, and independently overdue.

**The scope rule that must not be lost:** a CLI slice adds no HTTP route, but the requirement it
validates is *"kick off via a click of a button"*, and that button needs `POST /api/agent/run`
on a server that imports neither `serve-auth.mjs` nor `identity.mjs` and serves every route when
`HOST=0.0.0.0`. **That is remote code execution as a feature.** Any thin slice's constraints
must read "no new dependency, no key storage, no sandbox, **and no new HTTP route**."

---

## 7. Decisions recorded against advice

### 7.1 No `Executor` interface up front

The panel proposed one interface with `local` and `remote-runner` implementations. **Rejected**,
on this repo's own three-strikes record:

- `write-port-resolve.mjs:4-7`, verbatim: *"`selectWritePort` has existed since BLZ-293 and
  NOTHING in production called it… a flag that silently does nothing is worse than no flag."*
- `serve-auth.mjs` has zero production importers (BLZ-348).
- The `provider` seam `design.md:49-50` promised — *"GitHub via `gh` only, with a clean
  `provider` seam"* — was **deleted** as a hard error (`schema-version.mjs:31`).

Build the local path with no interface. Extract the seam later from two real implementations,
per this repo's own "widen by column, not by rewrite" precedent.

### 7.2 No success-rate acceptance bar

A 20-ticket / 40% bar was proposed and refuted: the Wilson 95% CI for 8/20 is
**[21.9%, 61.3%]** — 39.5 points wide and containing 25%, so n=20 cannot distinguish 40% from
25% (power 24.5%; 80% power needs n≈90). Answer.AI's independent Devin evaluation ran exactly 20
tasks and got 15%. There are only 30 `defined` BLZ tickets, so 20 would consume two-thirds of
the ready backlog to learn nothing statistically. **Set no rate; answer BLZ-349's binary.**

### 7.3 Leave `groomer.mjs` alone

Its entire safety model is anti-agency — `isStructuralChange` reverts any status change, and the
prompt forbids transitions. Generalising it means inverting the one invariant it exists to
enforce. Three pieces genuinely generalise and should be **extracted**: agent-command
resolution, `parsePorcelain` (`groomer.mjs:145-162`), and commit-with-explicit-pathspec. Once
runs can express grooming as rung (a), delete the groomer.

---

## 8. ADR obligations

| ADR / doc | Effect | Action |
|---|---|---|
| `design.md:44-46` — *"No code-writing worker loops… autonomous implementers are deferred"* | **Reversed by every option**, including (a), regardless of keys | **Superseding ADR required before any implementation** |
| `design.md:47-48` — no API key handling in Blaze | **Upheld** — §1.3 means Blaze holds no LLM key | none |
| ADR-0013 — identity | Constrained, not reversed. It designed the gate; nothing turned it on | New ADR when identity goes live (BLZ-348) |
| ADR-0014 — tenancy | Hard wall. Satisfied by §3.1: no discriminator column, no cross-board table | none, if §3.1 holds |
| ADR-0003 — delivery truth, not deploy truth | **The governing precedent.** Blaze *observes* a run through git/PR signals; it does not *become* the execution layer | Cite it; it is why (a)/(c) are consistent and (b) is not |
| ADR-0007 — eight services, `blaze-core` the sole ticket writer | Constrains (b): no service is described as a code writer | Amend before any server-side execution |
| ADR-0011 — optional peer dependencies | The mechanism for any dependency this needs | **No new REQUIRED runtime dependency.** (a) and (c) add zero |
| ADR-0002 — config schema versioning | `agentCommand`'s shape must change (§2); that is a config contract change | Follow the versioning rule; see BLZ-351 for why CI must catch it |

---

## 9. What this design does NOT solve

Stated plainly, per BLZ-346's acceptance criteria.

- **Cost caps and token metering.** You cannot overspend a key you do not hold. Under (a)/(c)
  this is permanently and correctly the user's problem.
- **Multi-provider abstraction.** The runner's concern. Blaze models no providers.
- **Cross-customer queue sharding under cloud SaaS.** Deferred on ADR-0013's own rule — *"not to
  be built ahead of a customer who asks."* There are zero SaaS customers.
- **Sandboxing under self-hosted (a).** The user is the trust boundary. Free hardening still
  applies — timeout, explicit env allowlist instead of `...process.env`, per-run `git worktree` —
  but it is not a sandbox and must not be described as one.
- **Prompt injection.** Unsolved industry-wide. Mitigated by where the agent runs, not by
  prompt engineering.
- **Merge authority.** Never. See §5.3 for the honest limits of that guarantee.
- **Non-GitHub forges.** GitHub-only is a *stated non-goal* — `design.md:49-50`: *"no second
  git provider (GitHub via `gh` only, with a clean `provider` seam)"* — so this spec inherits a
  deliberate narrowing rather than creating one. Two things about it are nonetheless defects:
  the promised `provider` seam was deleted (`schema-version.mjs:31`), and the failure mode is
  **silent** — `in-review` is structurally unreachable on GitLab, Bitbucket, Gitea and plain SSH
  with no error raised (BLZ-350). The GitHub App pattern does not port either — GitLab has no
  installation model, Gitea/Forgejo is OAuth2-as-user with scopes unimplemented, Bitbucket's
  Connect closed to new apps in February 2026. **This spec does not widen forge support; it
  inherits a narrowing that already shipped.**
- **Whether Blaze should adopt Jira's project-contains-boards model.** A real product question,
  raised during this session, explicitly out of scope and not to be smuggled in here.

---

## 10. Testing

TDD throughout, per the house standard. Two rules specific to this work:

- **Mutation discipline.** The v4 spine reviews found nine behaviour-removing mutations that a
  1,695-test suite accepted silently, and the same shape — *a test whose assertion does not vary
  with the thing under test* — fired twelve times. Every dispatch of this work carries the
  instruction: **if a mutation does not break a test, say so plainly.**
- **Never assert on exit codes alone.** §4.1 — a zero exit does not mean work happened. Tests
  assert on git state, filesystem state and the run record, never on `status === 0`.
