# BLZ-346 — Q2 panel findings and adversarial review

**Status: input to the spec, not the spec.** Q1 is settled. Q2 is answerable but carries
refutations that change the reasoning behind the answer, and one gate that must be passed
before any of it is worth building.

Five expert lanes answered a shared brief
(`2026-08-23-blz-346-q2-panel-brief.md`); one adversarial reviewer then tried to refute the
consensus. Everything below marked CONFIRMED was verified by direct read or execution in
this session, not taken from a lane's report.

---

## 1. The answer to Q2

**Self-hosted: (a)** — the agent runs on the user's own machine; Blaze stores no secret and
inherits credentials from the environment.
**Cloud SaaS: (c) hybrid** — Blaze owns the queue, run records, transcripts and UI; a paired
runner the customer operates executes with credentials Blaze never sees.

All five lanes rejected **(b) server-side for SaaS**. The operator's stated lean was
server/hybrid; the hybrid half is vindicated, the server half is not.

**But the reason matters, and the panel got it wrong first time.** The adversary showed the
custody argument proves too much — "the decryption key must live on the box that uses it"
would rule out every CI provider and secret manager in existence. The argument that actually
survives is the **build matrix**: rung (c) means running the customer's tests, which means
reproducing the customer's toolchain, per customer, forever.

**Consequence: if the build-matrix problem gets an answer — the customer supplies a container
image, or execution moves into their own CI — (b) returns to the table.** That is the single
most useful thing in this document, because it means the operator's instinct was not defeated
on principle.

---

## 2. What the adversary refuted

### 2.1 "`claude -p` already does all four rungs" — REFUTED, and this is the load-bearing one

In `-p`, the starting permission mode is `default`, where only **reads** run without asking.
`Edit`, `Write`, `git commit`, `git push` and `gh pr create` all require approval. Anthropic's
own commit example must explicitly allowlist `Bash(git commit *)`. There is no built-in
"open a PR" — it is just Bash.

Worse, the seam cannot express the fix: `cfg.agentCommand.split(" ")` (`groomer.mjs:207`) is a
naive space split with no quoting, so
`claude -p --allowedTools "Bash(git commit *)"` **cannot be represented in `agentCommand` at
all.** The multi-provider seam breaks on the first real invocation.

The realistic failure mode is not "the model cannot code". It is that the first runs are spent
on permission-flag archaeology, and the moment anyone reaches for a permissions bypass, the
containment story that (a) and (c) were sold on is gone.

### 2.2 "Blaze never merges is a mechanism" — REFUTED

GitHub's permissions reference puts `PUT /repos/{owner}/{repo}/pulls/{n}/merge` under
**`Contents: write`** — the same scope needed to push a branch. **Push and merge cannot be
separated in the permission model.** On a customer repo with no branch protection, the token
pushes to `main` and merges its own PRs. GitHub Apps are also explicitly eligible bypass
actors in rulesets.

"The agent drives to `in-review` and a human merges" remains **a policy**, enforced by a
customer-side ruleset that must be verified per repo at install time. It is a good policy with
good precedent — GitHub's own Copilot coding agent enforces exactly it at the product layer —
but Blaze cannot get it for free from GitHub's permission model.

Open hole: whether an App's approving review satisfies required-approvals. `github-actions[bot]`
is documented as not counting; no primary source found for custom Apps.

### 2.3 The single `Executor` interface — REFUTED on this repo's own record

Not on abstraction theory. This codebase has built the same seam three times and it was inert
each time:

- `write-port-resolve.mjs:4-7`, verbatim: *"`selectWritePort` has existed since BLZ-293 and
  NOTHING in production called it… a flag that silently does nothing is worse than no flag."*
- Identity/auth: zero production importers of `serve-auth.mjs` (BLZ-348).
- The `provider` seam `design.md:49` promised was **deleted** as a hard error
  (`schema-version.mjs:31`).

Recommendation: build (a) with no interface. Extract the seam later from two real
implementations, per this repo's own "widen by column, not by rewrite" precedent.

### 2.4 The 20-ticket / 40% validation — REFUTED as an experiment

- Wilson 95% CI for 8/20 is **[21.9%, 61.3%]** — 39.5 points wide, and it contains 25%.
  n=20 cannot distinguish 40% from 25%. Power for that contrast is **24.5%**; 80% power needs
  **n ≈ 90**.
- Closest published analogue: Answer.AI's independent Devin evaluation ran **exactly 20 tasks**
  and got **3 successes / 14 failures / 3 inconclusive = 15%**.
- It measures the wrong thing four ways: ticket quality (BLZ `defined` tickets are unusually
  rich), population (only 30 `defined` BLZ tickets exist — 20 consumes two-thirds of the ready
  backlog), repo (Blaze on Blaze, zero-dep Node), and operator (whoever picks the 20 knows
  which are tractable).
- It can pass and still be wrong (if it passes via a permissions bypass, the capability is
  unshippable) and fail and still be worth building — METR found maintainer merge rate averaged
  **24.2pp below** grader pass rate, so a dispatcher producing a reliably *reviewable draft* has
  value well under 40% unattended completion.

**Better bar: set no rate.** Run 5 tickets and gate on the binary — *did any ticket reach a PR
at all, and under which flags.*

---

## 3. Live defects confirmed this session

| Finding | Verified how | Where it is tracked |
|---|---|---|
| Groomer containment gap — writes outside groomable status dirs are never seen, reverted or committed | direct read of `groomer.mjs:220-223`; `git check-ignore blaze.config.json` → not ignored | **BLZ-347** |
| `spawnSync` has no timeout and no `maxBuffer`; blocks the event loop for the whole run | direct read; `timeout` appears once in `scripts/`, at `reconcile.mjs:176` | **BLZ-347** |
| Identity/auth built, tested, imported by nothing; no `blaze user add` | `grep` returns zero production importers | **BLZ-348** |
| `blaze reconcile` exits 1 on blaze-pm — rejects the `provider` key | **executed**; error reproduced in full | fix already in the 19 unpushed v4-spine commits |
| `claude` is a dangling symlink to snap rev 254; `command not found` | `ls -l`, `which` | operator action |
| `in-review` is structurally unreachable on any non-GitHub forge, silently | `reconcile.mjs:190` is the only forge call; `sh()` at `:31-38` swallows all errors and returns `null` | **undocumented; needs a ticket** |

**Mitigating fact, verified:** both loops are `enabled: false` on this board, versus
`enabled: true` in the shipped default (`config.mjs:23`). BLZ-347's escalation path is not live
for this operator. It is live for anyone running defaults.

---

## 4. Market evidence — what shipping products actually do

Verified against primary vendor documentation.

**BYO-key custody.** Local tools hold keys client-side (Zed: system keychain; Aider: local env).
Cloud tools either route without persisting (Cursor: *"not stored on our servers… sent to our
backend with every request"*, which voided their Zero Data Retention guarantee for BYO-key
traffic) or hold them server-side for enterprise only (Amp, Cody).

**The decisive datapoint: nobody who sells model access sells BYO-key on a cloud agent.**
Cursor staff confirm on their own forum that **Cloud Agents do not support BYOK**, and that
sub-agents ignoring the user's key is *"a confirmed bug"* — reaffirmed twice, fixed never, and
documented on none of their 219 docs pages. Factory ships BYO-key on its CLI and desktop and
**excludes it from the hosted tier**, in one vendor's own two tiers. GitHub draws the same line.

The one clean counterexample is **OpenHands** — BYO-LLM on Cloud, GA 4 Nov 2025 — an
MIT-licensed vendor with no token margin to protect. **Blaze is in OpenHands' position, not
Cursor's.** BYO-key is not a concession; it is what lets a solo vendor ship an agentic feature
with zero inference COGS and zero cost-runaway liability.

**Where the agent runs — the industry moved to (c) recently.** Cursor made self-hosted cloud
agents GA on 25 Mar 2026: *"A worker… connects outbound via HTTPS to Cursor's cloud — no inbound
ports, firewall changes, or VPN tunnels required."* Anthropic shipped the same shape:
*"A runner is a program running on hosts inside your network… Anthropic never connects into your
network. The control plane remains Anthropic-hosted."* Two of the three leading vendors,
independently, within five months.

**Claude Code GitHub Actions is the closest working precedent to BLZ-345**: the user's own CI
runner, the user's own `ANTHROPIC_API_KEY` or OIDC federation, no vendor sandbox, and it holds
no key at all.

**"PR and stop" is NOT a universal norm.** Two researchers found opposite things in different
samples, both correctly. Big-vendor cloud agents stop at a PR (Copilot's coding agent cannot
approve, merge, mark ready-for-review or push to default — the strongest enforced gate found).
Independent tools do not: Amp's *"Ship commits and pushes directly to `origin/main`"*; Devin's
docs recommend branch protection *"to ensure all required checks pass before Devin can merge"*;
Aider auto-commits every edit. So the `in-review` gate is well-precedented but is a deliberate
choice, not an industry default.

**The GitHub App pattern, verified across ten vendors.** `Contents: read/write` +
`Pull requests: read/write` is universal, no counterexample. Scope breadth varies from Qodo's 6
to Devin's 17. Two facts worth designing around:

- **Consent is all-or-nothing.** Anthropic alone documents it: *"When you install the app, you
  accept its full permission set. GitHub doesn't let you accept a subset."* Their mitigation —
  a custom App with only `Contents`, `Issues`, `Pull requests` — is the shape Blaze should copy.
- **`Workflows: write` is the scope to refuse.** Devin, Anthropic and OpenHands request it;
  Qodo does not. It lets the agent rewrite `.github/workflows/` — structurally the same defect
  as BLZ-347's `agentCommand` hole: a config the agent can edit that decides what runs next.

**It does not port.** GitLab has no installation model — the nearest equivalent is a
group/project access token the customer's Owner creates, default 365-day expiry, i.e. exactly
the long-lived stored token the panel forbids. Gitea/Forgejo is OAuth2-as-user only, and
Forgejo has not implemented scopes at all. Bitbucket's analogue is Forge `asApp()`, with Connect
closed to new apps in February 2026. `gh` supports GitHub.com and GHES only.

---

## 5. The gate that comes before everything

**Neither BLZ-348 nor a thin slice comes first. A one-hour capability probe does**, because if
`claude -p` cannot reach a PR under acceptable flags, sections 1–4 answer a question that does
not arise.

The probe: `claude -p` with an explicit `--allowedTools` list, **one** real BLZ ticket, a
scratch clone. Record six binaries — exit 0 / wrote a file / committed / pushed / opened a PR /
which flags had to be discovered. Blocked today: the `claude` binary is a dangling symlink.

Then **BLZ-347 before any dispatch experiment on a board where `blaze.config.json` is writable
in the agent's cwd** — the escalation loop is exactly what such an experiment triggers.
BLZ-348 is not a prerequisite for a CLI-only slice.

**One omission to write into scope now.** A CLI slice (`blaze agent run <ID>`) adds no HTTP
route. But the requirement it validates is *"kick off via a click of a button"*, and that button
needs `POST /api/agent/run` on `serve.mjs` — which imports neither `serve-auth.mjs` nor
`identity.mjs`, and serves every route when `HOST=0.0.0.0`. That is remote code execution as a
feature. The thin slice's "no new dependency, no key storage, no sandbox" must also say
**no new HTTP route**.

---

## 6. What this document does NOT settle

- **Q3 (key storage), Q4 (cost), Q5 (multi-provider), Q6 (interface), Q7 (sprint dispatch)** —
  all deliberately out of scope for the Q2 panel and still to be grilled.
- **Where the run-queue table lives under (c).** ADR-0014 forbids a table assuming rows from
  more than one board coexist. Either the queue is per-tenant and the control plane fans out
  across N databases, or it is a new control-plane database outside the board schema — a new
  deployment artifact, backup story and migration story for one maintainer. **No lane answered
  this, and it is the biggest unresolved design question in (c).**
- **Whether an App's approving review satisfies required-approvals.** Unverified.
- **The transcript sink** — flagged by the backend lane as the one genuinely irreversible
  decision. Recommended shape: `<dataRoot>/.blaze/runs/<run_id>/transcript.jsonl`, gitignored,
  DB stores a pointer and byte offset, ticket gets one summary line. Not yet ratified.
