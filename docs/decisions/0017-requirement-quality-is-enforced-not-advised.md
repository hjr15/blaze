# ADR-0017 — Requirement quality is enforced at creation and at gates, not advised

- **Status:** accepted
- **Date:** 2026-08-22
- **Amends:** `docs/method/engineering-method.md` §"What makes a well-formed requirement"
  and the shelved status of `verified` / `achieved` in `docs/schema.md`
- **Builds on:** ADR-0015 (shape rules block at write time; coverage rules block at gates)

## Context

`engineering-method.md` states the ISO/IEC/IEEE 29148 §5.2.7 standard for requirement
wording — *"Any of these in a requirement's text is a signal to rewrite it, not a style
preference"* — and then declines to enforce it. Separately, `verified` (on `requirement`)
and `achieved` (on `goal`) were designed but never shipped, held back because they were
return-visit obligations with nothing enforcing them.

Both decisions were made for the same reason, and the same evidence now overturns both.
From `engineering-method.md`'s own "Known limits", measured over ~2,000 tickets:

| Obligation | Completion |
|---|---|
| A field filled **at creation time** | **~93%** |
| Ticking an acceptance-criteria box before closing | **15%** |
| Superseding a decision record when the decision changed | **0%** (0 of 18) |

The lesson is not "obligations fail". It is **obligations that require a voluntary return
visit fail; obligations attached to a moment the author already wants something succeed.**

## Decision 1 — Wording rules are enforced, in two tiers

A banned-construction check fires at `blaze new` and `blaze edit` — precisely the ~93%
moment. But the constructions are not equally bad, so a single flat list would either be
too permissive or generate false refusals. **Two tiers:**

### Block tier — untestable in every context, `--reason` overrides

There is no sentence in which "user friendly" is a testable requirement.

`user friendly` · `user-friendly` · `easy to use` · `intuitive` · `fast` · `quick` ·
`rapid` (as bare adjectives, no number) · `as appropriate` · `as required` · `as needed` ·
`if possible` · `where possible` · `if practical` · `including but not limited to` ·
`etc.` · `and so on` · `and/or` · `provide support for` · `sufficient` · `adequate` ·
`reasonable` · `state of the art` · `robust` · `seamless` · superlatives (`best`, `most`,
`optimal`, bare `maximum`, `-est` forms)

**The override is `--reason`, the flag Blaze already ships for `requireLabels` and
`requireComponents`.** No new UX is invented. The override is recorded on the ticket, so
a vague requirement becomes a deliberate, attributable act rather than the default.

**Why an override exists at all.** A firm transcribing a client's contractual wording
verbatim must be able to record it. Without an escape hatch, that requirement simply lives
outside the tool — which is the failure `engineering-method.md` names directly: *"a gate
that blocks the thing people are trying to do gets routed around, not respected."* An
absolute block would be stricter on paper and weaker in practice.

### Warn tier — usually wrong, sometimes correct, never blocks

`all` · `always` · `never` · `every` · `none` · `and` joining clauses · vague pronouns
(`it`, `this`, `they` as subject) · `should` where `shall` is meant

**These cannot be blocked, and the reason is decisive: "the system shall never store
plaintext passwords" is a genuine, testable, correct requirement.** Refusing it would be
absurd. Likewise "search and filter" may be one integrated capability or two requirements
in disguise, and no regex can tell them apart.

### Both lists are project-editable

They ship as defaults, not as law. A client's contract language is not ours to overrule,
and a domain may have terms of art the general list mistakes for vagueness.

## Decision 2 — `verified` and `achieved` ship, gated

- **RQ-6:** `requirement → verified` is refused without a resolving `Verifies` link.
- **RQ-7:** `goal → achieved` is refused while any child `requirement` is non-terminal.

**Why the reversal is justified rather than merely reconsidered.** These were shelved
because nothing enforced them, and an unenforced return-visit obligation measures at
0–15%. A gate removes exactly that objection: the obligation now attaches to something the
person is actively trying to do. This is the same reasoning ADR-0015 used, applied to two
transitions that were shelved before that reasoning existed.

Together they close the gap `engineering-method.md` names as the entire reason the
`requirement` layer exists — **"is this actually finished?"** — a question that is
currently unanswerable, because the status that would answer it never ships.

## What is deliberately NOT enforced

Stated explicitly, because a standards document that claims more than it can check is
worse than one that claims less:

- **Unambiguous, in general.** Only the named constructions are detectable. A requirement
  can be perfectly ambiguous using none of them. **Any claim that the system checks for
  ambiguity would be false.**
- **Necessary** — would deleting it make the product wrong? Pure judgement.
- **Singular** — flagged, never blocked, because the false-positive rate is too high.
- **Whether the verification method chosen is the right one** — `demonstration` where the
  claim really needs `test` is a judgement call.
- **Whether an `Addresses` link is honest** rather than added to make coverage look
  complete. `engineering-method.md` already names matrix-gaming as an unaddressed failure
  mode, and this ADR does not address it either.

## Consequences

**Good.** Two standing gaps between what the method says and what it enforces are closed.
Enforcement lands at the ~93% moment rather than the 15% one. `verified` and `achieved`
become real, so "is this finished?" becomes answerable. Every refusal cites a clause of a
published standard, not a house preference.

**Bad.** `blaze new` becomes more likely to refuse, which is friction on the most common
operation in the system. The block list will occasionally be wrong, and `--reason` will
absorb that — which means `--reason` usage must be watched: **a high override rate is
evidence the list is wrong, not that users are lazy.**

**Risk accepted.** The warn tier may be ignored entirely, exactly as this project's own
data predicts for soft signals. It is retained anyway because the alternative — blocking
"shall never store plaintext passwords" — is worse than being ignored.
