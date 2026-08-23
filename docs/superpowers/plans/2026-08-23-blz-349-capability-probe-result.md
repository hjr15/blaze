# BLZ-349 — capability probe result

**Question:** can `claude -p`, given a Blaze ticket as a prompt, reach rung (c) — write code, run
tests, open a PR — and under which flags?

**Answer: YES, with an explicit `--allowedTools` allowlist and NO permissions bypass.**

This gates `docs/superpowers/specs/2026-08-23-agent-driven-execution-design.md`. **The spec
holds. Q1 does not reopen.**

Run 2026-08-23 against a scratch clone of `blaze` at `353081c`, probe ticket **BLZ-107**
(bug, estimate 30m, chosen because it is small, real, well-specified and carries a regression
test in its own acceptance criteria).

---

## The six binaries

| | Run 1 — default mode, no allowlist | Run 2 — explicit allowlist |
|---|---|---|
| exit 0 | **yes** | **yes** |
| wrote a file | no | **yes** |
| committed | no | **yes** (`879a6e7`) |
| pushed a branch | no | **yes** |
| opened a PR | no | **yes** — PR #91, 3 files, +98/−7 |
| bypass needed | — | **no** |

### The flags that were required

```
claude -p "<prompt>" \
  --allowedTools Read Write Edit Glob Grep \
    "Bash(npm test:*)" "Bash(npm run:*)" "Bash(node:*)" "Bash(git:*)" "Bash(gh:*)"
```

Nothing else. No `--permission-mode` change, no `--dangerously-skip-permissions`.

---

## Run 1 confirms the adversarial review, empirically

**Exit code 0, and no work of any kind happened.** Every `Write` and every `node`/`npm`
invocation was denied; read-only tools worked. The agent produced a useful written analysis and
changed nothing.

This is the concrete proof of the spec's §4.1 rule — **"never trust exit 0"** — and it is
exactly the failure `groomer.mjs:214` would record as success today, because it tests
`r.status !== 0` and never reads stdout. A dispatcher built on exit codes would have marked this
run complete.

It also settles the disagreement the adversary flagged between Anthropic's own sources on
headless denial behaviour: in this environment the process **completes normally with exit 0**
rather than terminating after N denials.

---

## What run 2 produced, and what that says about quality

The agent did not merely produce a diff. It:

- **wrote the failing test first**, then found it passed;
- **injected the pre-BLZ-133 shape** (`const dataRoot = roots.dataRoot`) to check the test
  discriminates, watched it go red with the ticket's exact reported symptom, and reverted;
- discovered the **ticket is partly stale** — BLZ-133 already closed the runtime hole by
  re-resolving `dataRoot` from the argv target, so BLZ-107 is a test + docs gap, not a live bug;
- **declined to fix out-of-scope drift** it found (`docs/schema-versioning.md` still says
  `SCHEMA_VERSION` is 1 while the code says 2, bumped by BLZ-298) on the grounds that it did not
  belong in a `BLZ-107:` commit, and flagged it for its own ticket instead;
- correctly attributed 11 suite failures to a missing optional `pg` dependency in its scratch
  clone rather than to its own diff.

That is the mutation-discipline and one-ticket-per-commit behaviour this repo requires, unprompted
beyond the prompt's stated rules.

**This has been independently reviewed rather than taken on trust** — see the review verdict
recorded against PR #91.

---

## What this changes in the spec

- **§2 "what is bought, not built" holds.** The runtime is genuinely delegable.
- **§2's caveat is now measured, not feared.** `agentCommand` must carry an allowlist, and
  `cfg.agentCommand.split(" ")` (`groomer.mjs:207`) **cannot express it** — the flags above
  contain quoted arguments with spaces and parentheses. Redesigning that seam is now a confirmed
  requirement, not a hypothetical.
- **§4.1 "never trust exit 0" is upgraded from principle to measured fact.**
- **The containment story survives.** Reaching a PR needed no permissions bypass, so options (a)
  and (c) keep the property they were chosen for.

## What it does NOT establish

- **A success rate.** n=1, deliberately — §7.2 of the spec explains why a 20-ticket/40% bar was
  refuted as an experiment. This is a capability check, not a benchmark.
- **That the output is mergeable.** That is a separate question, answered by review, not by the
  probe.
- **Behaviour on a hard ticket.** BLZ-107 was chosen to be tractable. A ticket requiring real
  design judgement is untested.
- **Behaviour in a sandboxed or CI environment.** This ran on the operator's own machine with a
  working `claude` on PATH.
