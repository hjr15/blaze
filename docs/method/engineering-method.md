# Engineering method

The normative method behind the type hierarchy in
[`work-item-types.md`](work-item-types.md): why the layers exist, what makes
each ticket well-formed, which gates are real and which are honest fiction,
and where this method runs out of road. It's grounded in ISO/IEC/IEEE 29148
(requirements engineering) and ISO/IEC/IEEE 42010 (architecture description),
cited by clause throughout rather than taken on authority.

This describes a method you configure on top of the engine's schema
mechanism — it is not a built-in mode. See
[`schema-customization.md`](../schema-customization.md) for how a `schema`
block installs new types and workflows.

## The flow

```
goal            outcome — long-lived, not time-boxed, achieved once
  → requirement statement of need — singular, verifiable, solution-free
      → architecture   design decision — only when one is warranted
          → feature     delivery bundle — one PR, one integration branch
              → task/bug   execution
```

`architecture` is optional in that chain — a requirement may go straight to
`feature` when no real decision was made (see "When architecture is
required" below). `feature` may also parent straight to `goal`, bypassing
`requirement` entirely, for work that doesn't trace to a stated need (see
"Untraced work" below). Both bypasses are legal by design, not gaps in the
model.

## Why a requirements layer

The case for `requirement` as a distinct ticket type isn't "professional
delivery runs off a numbered requirements matrix" — that's an argument from
authority, and it's the weakest one available. The real argument is
structural.

Without a requirements layer, one ticket is simultaneously the statement of
need, the design decision, and the delivery bundle. Those are three different
things with three different lifetimes — a need can outlive several designs,
a design can outlive several delivery bundles, a delivery bundle closes and
stays closed. Collapsing them into one ticket means the board can answer
"are these tickets closed?" but not "is this finished?" — because "finished"
is a question about the need, and the need was never written down as its own
object with its own status.

Splitting them costs one more hop of indirection per unit of work. What it
buys: a `requirement` can be `implemented` by several `feature`s over time,
survive the `architecture` that first addressed it being superseded, and
carry its own terminal state (`verified`) independent of any one delivery
bundle's status.

## What makes a well-formed requirement

ISO/IEC/IEEE 29148 §5.2.5 names nine characteristics of an individual
requirement: *Necessary, Appropriate, Unambiguous, Complete, Singular,
Feasible, Verifiable, Correct, Conforming.* Nine is accurate and not
memorable — nobody applies a nine-item checklist while writing a ticket.
Five rules, condensed from those nine, are meant to actually get used:

| Rule | What it rules out |
|---|---|
| **Singular** | One capability per requirement. If it contains "and", it's two requirements. |
| **Verifiable** | States a condition someone could check. If you can't name how you'd check it, it's a goal, not a requirement. |
| **Solution-free** | Says what, not how. Naming a technology is the tell — that belongs in the `architecture` ticket underneath it. |
| **Necessary** | Deleting it would make the product wrong, not merely worse. |
| **Unambiguous** | No banned construction (below). |

§5.2.7 bans specific constructions, and this list is worth keeping literal
rather than paraphrasing: superlatives, subjective language ("user
friendly"), vague pronouns, ambiguous connectives ("and/or"), open-ended
terms ("provide support", "including but not limited to"), loopholes ("if
possible", "as appropriate"), and totality terms ("all", "always", "never").
Any of these in a requirement's text is a signal to rewrite it, not a style
preference.

**Syntax is optional.** [EARS](https://alistairmavin.com/ears/) (Easy
Approach to Requirements Syntax — "While `<trigger>`, the `<system>` shall
`<response>`") is a reasonable template if you want one, but it isn't
required by 29148 or by this method. §5.2.4 NOTE 2 explicitly permits
user-story formulations ("As a `<role>`, I want `<capability>`, so that
`<benefit>`") as a valid requirement expression — you don't need to translate
away from a form your team already writes in.

## Functional vs non-functional

29148 §5.2.8.3 treats Quality (non-functional) requirements as a distinct
*type*, with the taxonomy delegated to ISO/IEC 25010. Non-functional
requirements differ from functional ones in three ways that matter
operationally: they're cross-cutting rather than scoped to one feature, they
can't be retrofitted without structural change, and they verify by threshold
and analysis rather than by a binary pass/fail test.

This method doesn't give NFRs a separate *type* — that would need the same
workflow, the same links, and the same parent rules as `requirement`, for no
gain. Instead, `requirement` carries a `category: functional | quality |
constraint` field. Three values, one line, and it lets a reader — human or
agent — group non-functional requirements without having to infer them from
prose. "What performance requirements does this system have?" becomes a
grep instead of an unanswerable question.

## Verification

29148 §6.5.2.2 names four verification methods:

| Method | What it means |
|---|---|
| `inspection` | Read the artifact — code, doc, config — and confirm it meets the requirement. |
| `analysis` | Derive conformance from calculation, model, or review, without running the system. |
| `demonstration` | Operate the system and observe the behavior directly, without instrumented measurement. |
| `test` | Execute a controlled procedure with recorded, repeatable results. |

`verification` is a required field on every `requirement` (see
[`work-item-types.md`](work-item-types.md)) precisely so `verified` means
something. 29148 §3.1.37 ties verification to *objective evidence* — a
status flip from `implemented` to `verified` with nothing attached is not
that. `verified` should require at least one `Verifies` link resolving to a
concrete ticket that names how the requirement was checked, not just that
someone believes it was.

**`verified` does not depend on `story` existing.** Only `test` needs a test
artifact. `inspection`, `analysis`, and `demonstration` need no test matrix
at all — they're a read, a review, or an observed run. So a requirement
verified by one of those three methods is reachable the moment the work
lands, regardless of whether the `story` type's design (deferred elsewhere)
has shipped. `test`-method requirements are the ones that wait.

### When the evidence is an oracle

A `test`-method requirement is often verified by an **oracle**: a generated
cross-product of inputs, each compared against ground truth. An oracle is
stronger evidence than hand-picked examples — and it fails in ways an example
does not, because it is cited as proof while proving nothing. Three failures
have been found in this repo's own oracles, and every one of them was silent:

1. **The oracle does not assert its own size.** It PRINTS a case or clause
   count instead of asserting it, so deleting a dimension shrinks the evidence
   and the run still reads green. Deleting one value from one dimension of the
   reconcile feed oracle took it from 336 tickets to 224 and dropped 520
   clauses, at 3/3 pass (BLZ-415, BLZ-420, BLZ-437).
2. **The oracle reads the subject under test for its ground truth.** A
   de-vacuity guard that asks the thing under test whether it did anything is
   satisfied by that thing's own word: reconcile reporting
   `commitOutcome: "committed"` with an empty `git log` kept its guard green
   (BLZ-423, BLZ-431).
3. **The test is named for something it does not exercise.** A guard named for
   reconcile's ledger entry that never invokes `reconcile` stays green when the
   production line it names is deleted (BLZ-442, BLZ-443).

So:

- **Assert the size, and derive it from the cross-product's shape** — not from
  a figure read off a passing run. A fitted constant is a change-detector: it
  tells a reviewer the number is STABLE, never that it is RIGHT, and two
  compensating edits pass it. Assert it PER CELL where the cross-product has
  cells, so a deleted assertion names the coordinate it was deleted from
  rather than surfacing as a wrong grand total (BLZ-444).
- **Bind the counter to the assertion, never to a line beside it.** A count
  accumulated by hand next to each clause outlives the clause it counts:
  delete the assertion, leave the `count += 1`, and the total still balances
  while the evidence is gone. Increment INSIDE the assertion helper so the two
  cannot be separated (BLZ-427). Note the binding is one-directional — it
  catches a deleted clause, not an added one written as a bare `assert.`
  (BLZ-444).
- **A count that varies with the data is a weak invariant — so validate it,
  don't ban it.** Banning data-dependent accumulation outright would be the
  easy rule and it is the wrong one: it is what this repo's oracles all do, and
  a method rule the codebase contradicts will be followed by neither (BLZ-467).
  Every clause count here is incremented inside
  `if (shape.refused) / else if (outcome === "queued") / …`. What makes it
  evidence is the two things layered on top:
  **(a)** the total is validated PER CELL against a budget derived from that
  cell's own coordinates, never from a figure read off a passing run, so a
  failure names the coordinate that is short rather than an arithmetic
  mismatch 700 clauses later — `budgetFor(shape, outcome, consumer)` in
  `tests/board-overstatement-oracle.test.mjs`, and the four clause budgets in
  `tests/reconcile-title-claim-oracle.test.mjs`, each written as the product of
  its own dimensions;
  **(b)** the counter is bound to the assertion (the bullet above), so a
  deleted clause takes its own count with it.
  The thing to avoid is accumulation whose *budget* depends on which branches
  the data took — a budget computed from the run is a change-detector, not an
  invariant (BLZ-452).
- **Ground truth comes from somewhere the subject cannot reach** — the
  filesystem, `git log`, a ledger file on disk, or the fixture's own
  declaration of what it planted. A dry run's own before/after snapshot is not
  ground truth for what it PREDICTS; the only honest grader of a preview is an
  apply pass over the same board (BLZ-421).
- **Every finding needs a negative side.** A clause asserting the finding fires
  for the misfiled ticket is equally satisfied by a guard that fires for every
  ticket on the board (BLZ-435).
- **A coverage assertion must name its OWN branch.** "Some problem of the
  right kind was produced" is satisfied by a co-occurring passenger from an
  unrelated branch, so the shape it claims to cover can be deleted outright
  while the test stays green (BLZ-414).
- **A tier is only pinned where it is REACHABLE.** Cases added where a
  comparison cannot arise prove nothing, however many of them there are — the
  corroboration tier is unreachable within a single repo, because corroboration
  and the claim tier are the same question there, so it can only be pinned
  across repos (BLZ-458).
- **State reachability plainly.** A guard no current call path can reach cannot
  be killed by any mutation, and must be described that way rather than implied
  to be pinned (BLZ-414's non-array link-type endpoint branch is one).
- **Prove it by reverting, not by asserting.** Revert the production hunk the
  test claims to pin and watch THAT NAMED test go red for the reason its name
  gives. A test that stays green under that revert is not evidence, whatever it
  is called.

## Approval, stated honestly

`approved` is the requirement workflow's second status, and it's worth being
plain about what it does and doesn't do, because an over-claimed gate becomes
theatre the moment someone notices it forbids nothing.

**`approved` forbids nothing mechanically.** It does not lock the ticket, it
does not require a second reviewer, and nothing in the engine checks it
before a later edit. What it asserts is narrower and still real: *the author
has committed to this requirement, and any later change to its text is a
reviewable commit rather than a silent edit.* That property comes from git,
not from the status word — an approved requirement edited in place produces
a diff, on a branch, under a ticket key, in `git log`. The status is the
marker that says "treat future changes here as a decision, not a typo fix,"
and the audit trail is the thing that actually delivers on it.

29148 §6.6.2.1 asks for change to a baselined requirement to go through
"impact assessment, review and approval," with §5.2.8.2 defining an Owner
distinct from the author. A single operator collapses proposer, reviewer,
owner, and approver into one person, so read `approved` as what it can
actually be here — a commitment marker with a git-shaped audit trail behind
it — not as a sign-off gate with a second human on the other end of it.

## When architecture is required, and when it is not

Not every requirement needs a design decision recorded against it. ISO/IEC/
IEEE 42010 cl. 5.8 requires rationale only for decisions considered **key**,
and says outright: *"It is not practical to record every architecture
decision about a system. A decision recording and sharing strategy should be
applied … to establish criteria for selecting key decisions."* A mandatory
ADR per requirement would be stricter than the standard it claims to follow.

Write an `architecture` ticket when at least one of these is true:

- **An alternative was seriously considered and rejected.** If there was
  only ever one obvious way to do it, there's no decision to record.
- **The choice is expensive to reverse.** Data formats, public interfaces,
  anything that fans out into other work if it changes later.
- **It constrains later requirements.** The decision shapes what can be
  asked for next, not just how this one thing gets built.

A trivial requirement that admits one obvious implementation — "the CLI has
a `--help` flag" — goes straight to `feature`. An empty ADR asserting a
decision was made when none was is worse than no ADR at all; don't manufacture
one to satisfy a layer that's supposed to be optional.

One honest gap: 42010 routes decision traceability through *concerns*, with
relationship types (`constrains`, `influences`, `subsumes`, `refines`,
`conflicts-with`) that do not include anything resembling `Addresses:
architecture → requirement`. That link is the ADR community's practice, not
something 42010 itself specifies — it's a reasonable convention, but it
isn't standards-backed the way the four-method verification list is.

## Where work that traces to no requirement lives

Discovery, spikes, operational toil, and unplanned fixes don't, by
construction, trace to a stated need — forcing them to costs more than it's
worth.

`feature` may parent directly to `goal`, skipping `requirement` entirely.
Untraced features are legal, and they are **counted**: an audit publishes
"N features implement a requirement, M don't" as a plain figure rather than
hiding the gap behind a matrix that looks complete. A traceability register
that admits its holes is worth more than one that doesn't.

SAFe reaches the same conclusion by a different route — its **Enabler**
classification spans every level of its hierarchy specifically so
infrastructure, spike, and technical-debt work gets prioritized on its own
economics instead of being forced under a customer-facing story it doesn't
belong to.

## Traceability is a soft gate, audited, not enforced at write time

> **Superseded for v4 by [ADR-0015](../decisions/0015-traceability-enforcement-shape-rules-block-coverage-rules-gate.md).** That ADR keeps this
> section's core argument — coverage cannot be enforced at write time, because the
> requirement a piece of work traces to often does not exist yet — but rejects the
> conclusion that an audit report is therefore sufficient. The measured completion rates
> in "Known limits" below are the evidence against it: an audit nobody acts on is not a
> soft gate, it is no gate. Under v4, coverage rules block at named gates instead.

The `Implements` / `Addresses` / `Verifies` / `Supersedes` / `Derives` links
are not validated at write time the way `parent` legality and cycles are. A
hard rejection sounds safer, but it has a specific, fatal failure mode here:
it makes ticket creation fail when the requirement it should trace to doesn't
exist yet — which is common, because requirements and the work that
implements them are often written in the same sitting or the requirement
follows. That inverts the natural order of work, and a gate that blocks the
thing people are trying to do gets routed around, not respected.

Instead, treat traceability as something an audit reports, not something
`blaze new` enforces: unimplemented requirements and untraced features are
counted and surfaced after the fact, and the count itself is the signal.
Same principle as the previous section — visible and imperfect beats
invisible and clean.

## Known limits of this method

These are measured properties of requirements-driven delivery, not
hypothetical risks.

- **A retrofitted register reads as complete by construction.** If you
  reverse-engineer requirements from work that's already done, every
  requirement you write down will have something that satisfies it — you
  only wrote it down because you could see the thing that satisfies it. A
  register built this way is an *as-built specification* — an honest record
  of what the system does today — and it is genuinely useful as that. It is
  not a record of how the work was decided, and reading it as one is the
  mistake. `derived: retrospective` exists to mark that distinction on every
  requirement it applies to, so the register can't be silently misread as
  something it isn't.
- **Requirements-driven delivery has documented failure modes, and nothing
  here structurally prevents two of them.** Big-design-up-front — writing
  requirements speculatively, ahead of any real intent to build — costs
  nothing to do under this model; a `proposed` requirement is cheap to
  write and just as cheap to leave stale. And a traceability matrix can be
  gamed — populated with links that exist to make coverage look complete
  rather than because the work actually verifies the requirement. Nothing
  in the type model or the workflow rules catches either case; both rely on
  whoever's running the process noticing.
- **Gates that need someone to come back later decay, and the effect is
  large.** `approved`, `verified`, and a `Verifies` link all require a return
  visit after the triggering event has passed and attention has moved on.
  Measured on the board this method was developed against — roughly 2,000
  tickets, one operator, most writing done by an AI agent:

  | Obligation | Completion |
  |---|---|
  | A field filled at creation time | **~93%** |
  | Ticking an acceptance-criteria box before closing | **15%** (483 of 3,159) |
  | Updating a *different* document when a decision changed | **0%** (0 of 18 decision records ever superseded) |
  | Writing a justification instead of leaving a field blank | **~0%** (0 of ~2,000 tickets) |

  A field filled in at creation, when the author is already there and already
  has the context, is durable. A field that requires remembering to come back
  is not. The honest design response is to prefer capturing information at
  creation over promising to update it later — and to be suspicious of any
  new gate whose value depends on a return visit, including the three this
  method itself defines.

## The tie-breaker

When two options are otherwise close, this method resolves them the same way
the engine does: **can an agent read, interpret and correctly update this with
ordinary file tools and no special knowledge?**

That is why the fields are short closed sets rather than prose, why a
requirement is referenced by a stable designator rather than a path, and why
untraced work is counted rather than hidden — a number an agent can read beats
a caveat it has to interpret. Where this method adds something that makes the
board harder for an agent to drive, that addition should be argued for
explicitly or dropped.
