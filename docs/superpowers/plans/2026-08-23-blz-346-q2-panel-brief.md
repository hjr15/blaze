# BLZ-346 Q2 panel brief — where does the BYO-key agent run?

**Shared brief. Read it in full before starting. Do not paraphrase it for anyone else.**
You are one of five experts answering the SAME question from different angles. Your output
is integrated mechanically against the others, so the output contract is not optional.

**This is design analysis. Write NO code. Create NO tickets. Modify NO files.**
Report back in prose, in the shape given at the bottom.

---

## 1. The product

Blaze is a project-management tool whose data store is a **git repo of markdown**. One
ticket = one markdown file; its status is the directory it sits in. There is a v4 SQLite/
Postgres layer, but the filesystem is still the source of truth today
(`BLAZE_WRITE_PORT` defaults to `fs`). Repo: `/home/rnamwoh/Documents/Code/blaze`, branch
`main`. Version 0.7.0. Solo vendor, solo maintainer.

It ships **two ways, and the operator believes they need different answers**:
- **self-hosted** — the user runs Blaze on their own box or their own server;
- **cloud SaaS** — the operator runs Blaze for other people.

## 2. The requirement (BLZ-345, operator's verbatim words)

> "Since this will be agent driven and work as a project management tool I would actually
> like to explore the capability for each user to be able to plugin or connect an LLM model
> key of there choice, and then be able select a ticket at any level, and or sprint to then
> send to the llm to start working on it via an interface on the app. ... the idea is that a
> user can configure there llm key so then they are able to kick off there llm of choice to
> work on blaze work items via a click of a button which would then be able to interact with
> them via some kind of interface native to the blaze application."

## 3. What is ALREADY SETTLED — do not reopen

**Q1 is answered.** "Work on it" means **drive the ticket to done** — the full ladder:
(a) groom the ticket → (b) produce a plan/spec → (c) write code and open a PR → (d) drive
to done. The operator's words: *"all 4 really — whatever is needed to complete the task."*

Consequence you must design for: the agent needs **code-repo write access and a git identity
that is not the operator's**, on top of the LLM key. That is three secret classes, not one.

A working reframe the parent has proposed but NOT settled — you may refute it: the agent
drives to `in-review` and a **human merges**, so Blaze never needs merge rights. Say
explicitly whether your analysis supports or refutes that.

## 4. Verified ground truth about the current codebase

Every line below was verified this session by direct read. Trust it; re-verify only if your
analysis depends on a detail not stated here.

**The only existing agent dispatch** is `scripts/loops/groomer.mjs`:
- `agentCommand` defaults to `"claude -p"` (`scripts/config.mjs:19`), overridable by
  `blaze.config.json` (`config.mjs:45`) or `BLAZE_AGENT_COMMAND` (`config.mjs:56`). Also a
  plaintext DB column `agent_command text NOT NULL DEFAULT 'claude -p'`
  (`scripts/model/config-schema.mjs:91`).
- Spawn: `spawnSync(cmd, [...args, prompt], { cwd: root, encoding: "utf8", env: {
  ...process.env, BLAZE_GROOM_TARGET: ticket.rel } })` — `groomer.mjs:208-213`. No shell.
  **No timeout.** Naive `.split(" ")` on the command string.
- **Credentials today are inherited implicitly**: the whole parent `process.env` is passed
  through, so an `ANTHROPIC_API_KEY` in the launching shell reaches the agent. Blaze itself
  reads, stores and manages nothing.
- Output handling: agent stdout is **never read**. Blaze inspects filesystem side effects via
  `git status --porcelain`, reverts on any structural mutation (rename across status dirs, or
  a change to `status`/`resolution` frontmatter — `isStructuralChange`, `groomer.mjs:174-196`),
  else stages exactly the changed files and auto-commits.
- Failure handling: non-zero exit → error event carrying `stderr.slice(0, 200)`. No retry, no
  backoff. Re-entrancy guarded only by an in-process boolean in
  `scripts/supervisor.mjs:124-137`; **no cross-process lock, no rate limit, no quota.**

**No encryption-at-rest exists anywhere in the repo.** Zero hits for `createCipheriv`,
`createDecipheriv`, `scrypt`, `pbkdf2`, `keytar`, `libsecret`, `sops`. The only `node:crypto`
use is one-way: `identity.mjs` SHA-256-hashes bearer tokens and **never retains plaintext**
(`identity.mjs:20-22`), and `groomer.mjs` hashes ticket content for dedupe.

**A decryptable secret is therefore a new primitive, not an extension.**

**Identity exists but is DORMANT.** `scripts/model/identity.mjs` + `identity-schema.mjs`
implement users, provider-identities, memberships and API tokens with roles
`admin|member|viewer` → scopes `read|write|admin`, and the invariant that a token's effective
scopes are the **intersection** of the owner's *current* role and the token's issued scopes,
recomputed every call (`identity.mjs:32-46`). `serve-auth.mjs` implements a bind-address
boundary (refuse to serve non-loopback with no users configured, `serve-auth.mjs:69-84`) and
fail-closed route classification (unknown `/api/*` → 404, `:104-110`).

**BUT**: `scripts/serve.mjs` — the live `blaze board` server — **never imports any of it**.
No `checkBindSafety`, no `gate()`. It binds `process.env.HOST || "127.0.0.1"`
(`serve.mjs:93`) and guards POST routes with only a per-process CSRF header
(`serve.mjs:150`), which ADR-0013 itself calls "forgery protection, not a credential."
**There is no `blaze user add` command.** So `HOST=0.0.0.0` today serves every route
unauthenticated. Per-user anything depends on wiring this in first — state that dependency
if your answer relies on it.

**Storage layout.** `.blaze/` is gitignored (`.gitignore:20`); the SQLite file is
`<dataRoot>/.blaze/blaze.db` (`write-port-resolve.mjs:19`). The markdown corpus is
`<dataRoot>/projects/<KEY>/...` and IS git-tracked. Also under `.blaze/`: `database.json`
(mode 0600), `divergences.jsonl`, `commit.lock`, index caches.

**A stated design principle this requirement REVERSES.** `docs/design.md:47`: *"No embedded
Anthropic SDK and no API key handling inside Blaze — the agent CLI owns auth."* Any
recommendation that has Blaze hold a key must say it supersedes this and why.

**ADR-0013 (identity)** explicitly defers, and says not to build ahead of a paying customer:
SSO/OIDC wiring, a permissions matrix beyond three roles, cross-tenant isolation, billing,
per-project roles.

**ADR-0014 (tenancy)** — database-per-tenant is the model; **row-level shared-schema with a
`tenant_id` discriminator is ruled out PERMANENTLY**, not deferred. Quote: *"No table may be
designed on the assumption that rows from more than one board coexist in it."* The sanctioned
evolution pattern is *"widen by column, not by rewrite"* (precedent: `membership.scope_key`).
**Do not smuggle tenancy in through this door.** A per-user LLM key table on ONE board is
compatible; anything per-tenant is not.

## 5. THE QUESTION

Where does the agent process run? Four candidates, and the operator's stated lean is
**server, possibly hybrid** — *"I am not a fan of it relying on end user machines"* — but
they explicitly asked to be refuted if the analysis says otherwise.

- **(a) User's own machine** — an evolution of today's `spawnSync`. LLM key and repo creds
  never leave their box; Blaze stores neither. Cost: "click a button in the app" means the
  app must reach their machine.
- **(b) Server-side, next to the board** — Blaze runs the agent. Needs encrypted-at-rest LLM
  keys AND repo write creds AND per-run sandboxing. One breach costs every user their LLM
  billing and their code.
- **(c) Hybrid** — server owns the queue, run records, transcripts and UI; a paired local
  runner long-polls for work and executes with local credentials. Blaze stores only a runner
  pairing token.
- **(c-api) API-only, no repo** — Blaze calls the LLM API directly, advisory text back to the
  ticket. Cannot reach rungs (c)/(d), so it is **inconsistent with the settled Q1 answer**;
  included only so the trade-off is explicit. If you recommend it you are arguing to reopen Q1
  — say so plainly.

**The operator's framing to test: does self-hosted want a different answer from cloud SaaS?**
If yes, say which for each, and say what is SHARED between them so it is built once. If it
should be one answer for both, refute the framing and say why.

## 6. Your lane

Your dispatch message names your lane. Stay in it — the other four lanes are covered, and
overlapping wastes the fan-out. Do not re-answer another lane's question; reference it
instead.

The five lanes are: **security threat model** · **backend/runtime architecture** ·
**deployment & isolation (self-hosted vs SaaS)** · **market evidence (how shipping products
do this today)** · **tech-lead build-vs-buy & sequencing**.

## 7. OUTPUT CONTRACT — identical for all five

Return prose in EXACTLY these six sections, with these headings:

### VERDICT
One line: which of (a)/(b)/(c)/(c-api) you recommend for **self-hosted**, and which for
**cloud SaaS**. If the same, say "same for both". No hedging, no "it depends" — commit.

### WHY, FROM MY LANE
The reasoning specific to your expertise. 200–400 words. Concrete, not generic.

### WHAT KILLS THE OTHERS
One short paragraph per rejected option naming the **specific** failure, not a vibe. If an
option is merely worse rather than fatal, say "not fatal, just worse" and say by how much.

### THE THING THE OTHER LANES WILL MISS
The single point from your expertise you expect nobody else to raise. One paragraph.

### COST OF BEING WRONG
If your recommendation is wrong, what breaks, how would you find out, and is it reversible?
Name the cheapest early signal that would tell the operator to change course.

### CONFIDENCE + WHAT WOULD CHANGE MY MIND
High / medium / low, and the specific fact or constraint that would flip your verdict.

---

## 8. Constraints on your answer

- **Solo maintainer.** Every mechanism is maintained forever by one person. An answer that is
  correct but unmaintainable is wrong. Say plainly if you are recommending something that
  needs more than one maintainer.
- **YAGNI ruthlessly.** ADR-0013's own rule: do not build ahead of a customer who asked.
- Cite `file:line` for any claim about the codebase beyond §4. If you are inferring rather
  than reading, say so in the sentence.
- If §4 contains something you find to be WRONG, say so loudly and early — the panel's
  ground truth is shared, so an error there corrupts all five answers.
- Do not answer Q3 (key storage mechanics), Q4 (cost control), Q5 (multi-provider),
  Q6 (interface) or Q7 (sprint dispatch). They are downstream and are being asked separately.
  You may note a hard dependency on one of them in a single sentence.
