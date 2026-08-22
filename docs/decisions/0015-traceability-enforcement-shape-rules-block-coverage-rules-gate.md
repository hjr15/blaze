# ADR-0015 — Shape rules block at write time; coverage rules block at named gates

- **Status:** accepted
- **Date:** 2026-08-22
- **Supersedes:** the position in `docs/method/engineering-method.md` §"Traceability is a
  soft gate, audited, not enforced at write time"
- **Context:** the Blaze v4 redesign. The operator's requirement, verbatim: *"This should
  be strict from the get go so it can all tie up and not fall out of drift and or
  standards as this must be strictly adhered too."*

## The distinction this ADR turns on

Two things get called "traceability rules". Only one of them can be a database constraint,
and conflating them is why the previous position went wrong.

**Shape rules** constrain a link that is being written: *a requirement may link to an
architecture item via `addressed-by`, and to nothing else.* The subject and object both
exist at write time. This is decidable, and Polarion enforces exactly this — a link its
meta-model disallows cannot be created.

**Coverage rules** assert an absence: *every requirement is addressed by at least one
architecture item.* **These cannot be enforced at write time in any SQL schema, and not
for want of trying.** At the moment a requirement is created, the architecture that
answers it does not exist. Refusing the write would make it impossible to author the first
requirement in a project. Absence is a query, not a constraint.

## Decision

**Shape rules: hard-refused at write time, default-deny.** An undeclared link type or
endpoint combination is rejected, not warned about. This fixes CS-011 (Jama warns but does
not block) and CS-012 (*"If you don't define a rule for a particular item type, that item
type can have a relationship with anything"* — maximum permissiveness as the default,
exactly backwards for a governance tool).

**Coverage rules: computed continuously, visible always, blocking at named gates.**
Drafting is unimpeded. A requirement may sit uncovered for as long as the design takes.
But a **gate** — baselining a requirements document, marking a goal achieved, closing a
phase — is **refused** while its coverage rules are unmet, and the refusal names every
item that fails and why.

## Why this reverses the previous position

`engineering-method.md` argued for soft gates, and **half of that argument was right and
survives here**:

> "A hard rejection sounds safer, but it has a specific, fatal failure mode here: it makes
> ticket creation fail when the requirement it should trace to doesn't exist yet… That
> inverts the natural order of work, and a gate that blocks the thing people are trying to
> do gets routed around, not respected."

That is correct, and it is precisely why coverage rules do not block at **write** time
under this ADR. The old position identified the right hazard.

**It then drew the wrong conclusion — and its own measurements prove it.** Having rejected
write-time enforcement, it concluded that traceability should be "something an audit
reports". The same document then records what that produced, measured over roughly 2,000
tickets on the board this method was developed against:

| Obligation | Completion |
|---|---|
| A field filled at creation time | **~93%** |
| Ticking an acceptance-criteria box before closing | **15%** (483 of 3,159) |
| Updating a *different* document when a decision changed | **0%** (0 of 18 decision records ever superseded) |
| Writing a justification instead of leaving a field blank | **~0%** (0 of ~2,000 tickets) |

An audit that reports a number nobody acts on is not a soft gate. **It is no gate.** The
0% supersession rate is the clearest possible statement: the method's own most important
obligation was met zero times out of eighteen.

## The objection this ADR must answer

The method's closing warning applies to this ADR by name:

> "be suspicious of any new gate whose value depends on a return visit"

A coverage gate at baseline time looks like a return-visit gate, and the data above says
return-visit gates fail.

**The distinction is what the person wants at that moment.** The obligations that measured
at 0–15% all required someone to come back *voluntarily*, with nothing at stake if they
did not. A gate at baseline time is different in kind: it refuses something the person is
actively trying to do, right now, while they are present and motivated. That is the same
property that makes creation-time fields durable at ~93% — the person is there, has the
context, and wants to proceed.

**So the measured data does not argue against this ADR. It argues against the position
this ADR replaces.** The 15% and the 0% are what soft gates produced.

## The residual risk, stated plainly

The method's other warning is not answered by the above and remains live:

> "a gate that blocks the thing people are trying to do gets routed around, not respected"

A team that cannot baseline **will simply not baseline**, and carry on working. The gate
does not fail loudly; it falls into disuse, and disuse looks like compliance.

**Mitigation, and it is partial:** a gate must be attached to something the organisation
independently needs — a release, an audit submission, a customer deliverable — so that
skipping it has a cost outside the tool. A gate on a purely internal ceremony will be
skipped. **We should measure gate usage and treat a falling baseline rate as the leading
indicator of exactly this failure**, rather than discovering it at an audit.

This risk is accepted, not solved. If baseline rates fall, this ADR is the thing to
revisit.

## What this obliges the v4 design to do

1. **A typed link meta-model** declaring, per link type, the permitted source and target
   types and cardinality — the codebeamer "reference" model (CS-020), enforced as
   constraints rather than as advice.
2. **Coverage rules as declared, named, first-class objects** — not hardcoded queries.
   A rule has a name, a scope, and a definition, so a refusal can cite the rule that
   refused it.
3. **Gates as an explicit concept** with an enumerated set of gated actions. A gate that
   is not enumerated does not exist; a new gated action must be added deliberately.
4. **Enforcement in the API layer, never the UI.** CS-018 is the anti-pattern to avoid at
   all costs — Polarion's own documentation concedes *"Suspect links are implemented on
   the UI level only. They do not work for server-side use cases like imports or API
   calls."* For agent-driven teams the API **is** the primary interface. A rule the API
   cannot see does not exist.
5. **Applying a rule to existing data must report every current violation.** Jama's silent
   grandfathering (CS-013 — *"If a rule set is applied to a project with existing items,
   nothing changes"*) is the drift the operator explicitly named. Retroactive silence is
   forbidden; retroactive *blocking* is not required, but retroactive *reporting* is.

## Consequences

**Good.** Strictness lands where it is physically possible and where it is felt.
Authoring stays frictionless. Every refusal is explainable, because it cites a named rule.
The API is the enforcement point, so agents are governed identically to humans.

**Bad.** Two enforcement mechanisms exist rather than one, and the difference between them
must be taught. Gates can be avoided by not passing through them. Coverage computation is
a query over the whole project, so it has a cost that write-time validation does not.

**Explicitly not decided here.** Which coverage rules ship as defaults, which gates exist,
and whether rules can be defined per project — all deferred to the requirements-practices
work, where they belong.
