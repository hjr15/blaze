# ADR-0036 — sign-in is rate limited by the board, per source, not by the edge

- **Status:** Accepted
- **Date:** 2026-09-08
- **Deciders:** Ryan Howman
- **Ticket:** BLZ-571 (the gap), BLZ-569 / [ADR-0034](0034-a-browser-signs-in-a-token-does-not.md) (the design that named it)

## Context

[ADR-0034](0034-a-browser-signs-in-a-token-does-not.md) recorded the sign-in design and,
in the same breath, recorded what it did not do: **`POST /signin` counted nothing**.
scrypt's ~50–100 ms was the only friction slowing a credential-stuffing or brute-force run
against the single operator account, so an attacker's rate was bounded by the board's CPU
and by nothing else.

BLZ-571 could not simply be implemented, because the obvious implementation is itself the
attack. A naive per-address counter hands anyone who can make requests appear to come from
the operator's address — or who shares a NAT, or sits behind a proxy the board does not
know about — the ability to lock the real operator out of a credential they could use to
fix it. So the question was answered before any code: **whose problem is this, and what
address is it keyed on?**

> **Amended 2026-09-12 (re-review).** An earlier draft of this ADR said "there is **one
> account** on this board" and keyed the whole design, refund included, on the source
> alone. That premise was false the day it was written — `blaze user add --email --role`
> has shipped since BLZ-360 and `viewer` is a real, read-only role — and it was a live
> vulnerability, not just an inaccuracy: because a correct password cleared the whole
> source's bucket, **any** valid credential, a read-only viewer's included, bought an
> unbounded brute force of the admin password from one address (four wrong admin guesses,
> one viewer sign-in to wipe the bucket, repeat: 40 admin guesses to the KDF in ~3 s). The
> bucket is now keyed on the **(source, account)** pair; see Decision points 1 and 4.

## Decision

**The board rate limits `POST /signin` itself, per source address, with an explicit
trusted-proxy configuration.** Not the edge.

Chosen over delegating to the reverse proxy because the limit has to hold **however the
board is fronted** — behind Traefik, behind nothing, on a laptop — and because a limit
nothing in this suite can exercise is a limit nobody can prove. An edge limit may be added
later as defence in depth; `scripts/model/rate-limit.mjs` may never assume one is there.

Three properties are load-bearing, and each is a way a rate limiter becomes the
vulnerability it was added to close:

**0. The attempt is counted at ADMISSION, not at failure.** The check that decides and the
write that records are one synchronous step (`AttemptLimiter.charge`), taken immediately
before the KDF. Splitting them across `await store.signIn(...)` leaves ~50–100 ms in which
nothing accounts for requests already in flight, and every request arriving inside that
window reads a zeroed bucket. That is not a theoretical window: measured on the first
version of this work, 40 sequential attempts cost the KDF 5 invocations while 200
concurrent attempts from one address, with no spoofing, cost it 170 — and it was sustained,
three bursts of 150 reaching the KDF 394 times in 67 seconds against an intended 8. A limit
that only counts attackers polite enough to wait their turn is not a limit; scrypt was still
the only friction for everyone else, which is the exact sentence ADR-0034 wrote and this ADR
exists to stop being true.

**1. The key is never a value the caller chooses.** `X-Forwarded-For` is read **only**
when the peer address is a configured trusted proxy, and then the chain is walked **from
the right**, skipping each element that is itself a declared trusted proxy; the first
element that is not one is the client. Taking the rightmost element unconditionally is
correct behind **one** proxy only — with two, it names the edge, and every client behind
that edge shares a single bucket. **Every hop must therefore be listed in
`trustedProxies`**, and forgetting one *groups* the clients behind it rather than letting
any of them escape: over-limiting a shared source, never under-limiting a distinct one.
`trustedProxies` defaults to empty, and empty means the header is ignored entirely. Every branch that cannot establish a
trustworthy forwarded address falls back to the peer: no configuration, wrong-typed
configuration, a peer that is not a configured proxy, an empty chain, a chain whose last
element is not address-shaped. Keying on a spoofable value is **worse** than not limiting
at all — the attacker rotates it to escape their own bucket and sets it to the operator's
to fill theirs.

Address equality is **structural, not textual**: `net.isIP` decides what is an address at
all, and every IPv6 form is canonicalised (RFC 5952) before it becomes a key, so
`2001:db8::1`, `2001:0db8:0000:…:0001`, `[2001:DB8::1]:443` and `2001:db8::1%eth0` are one
bucket rather than four, and `::ffff:1.2.3.4` is `1.2.3.4`. Every extra spelling a source
can reach would otherwise be another whole allowance.

**4. The key is the (source, account) pair, and the refund is per account.** The board has
more than one account, so the counter cannot be per source alone: a success on one account
must not refund guesses at another. The bucket is `(source, folded-email)` — email folded
`trim().toLowerCase()` to match the identity store — a charge is taken against the account
the request names, and a correct password refunds **only that account's** bucket. A block on
the admin's bucket is therefore liftable only by the admin's own password or by time, never
by signing in as a viewer. One source gets a fresh allowance per distinct account it names;
that is what keeps the refund honest, and a source spraying many account names is bounded by
the map's cap and eviction (point 2) rather than by a single per-source count.

**2. The map is bounded, and eviction can never IMPOSE a penalty.** A per-source map keyed
on anything an attacker can vary is a memory-exhaustion vector wearing a defence's clothes.
The map is capped and evicts the least-recently-**failed** entry, so an attacker flooding
from many addresses cannot use eviction to throttle a source that has not itself failed —
which is the property that matters, because the alternative is a free lockout of the
operator.

The converse is **true and is a deliberate trade, not a property this ADR claims**:
eviction *can* discard a penalty, so an attacker holding `maxSources` addresses and keeping
them all failing will evict their own oldest bucket and recover its allowance. Bounded
memory is chosen over perfect memory. It is poor value for the attacker — 1024 live sources
to buy back the allowance of one — and it is pinned by a test so that the trade cannot
change silently.

**3. It is backoff, not lockout — on a MONOTONIC clock.** The penalty is a delay that
grows, is capped, decays on its own, and is cleared outright by a correct password; the
refusal carries `Retry-After`. Durations are measured with `performance.now()`, never
`Date.now()`: an NTP correction, a laptop resuming from suspend or a DST boundary steps the
wall clock, and a one-hour backward step turns a 30 s penalty into a ~60 minute one — the
lockout this design refuses, arriving with no attacker involved — while a forward step past
the forget window clears every penalty on the board at once.
A lockout needing a human to clear it is a denial of service the attacker triggers and the
operator suffers — and the operator would have to clear it from the board they can no
longer reach.

The counter moves **only on a credential check**. A malformed body or a bad CSRF token is
refused without spending the source's allowance, so a misconfigured client cannot walk the
operator into a wait they did not earn. The check runs **before the body is read and long
before scrypt**, because the point is to stop paying for an attacker's attempts. `/signout`
and `GET /signin` are outside it: one presents a session and mints nothing, and an operator
who cannot load the page cannot read why they are waiting.

## Consequences

- `trustedProxies` is new configuration (`scripts/config.mjs`), empty by default. An
  operator fronting the board with Traefik on the same host sets `["127.0.0.1", "::1"]`;
  one who leaves it empty gets peer-address keying, which is correct for that deployment.
- **Both** servers that mount the sign-in route carry the limit — `blaze board`
  (`scripts/serve.mjs`) and `blaze start` (`scripts/supervisor.mjs`), one limiter each,
  per server rather than per module. Each is pinned by its own test, because BLZ-359's
  lesson is that a control wired into one of them is absent from the other.
- **Stated plainly rather than left to look covered:** this is per-source, so an attacker
  distributed across many addresses is slowed only in proportion to how few addresses they
  hold. scrypt remains the backstop for that case, and this ADR does not claim otherwise.
- Nothing rate-limits `/setup` (its token is one-time and high-entropy).

## Alternatives rejected

- **Rate limiting is the edge's job; document that the board does not do it.** Rejected:
  the board is run behind nothing at least as often as behind Traefik, and a control that
  exists only in a deployment note is a control the test suite cannot fail on.
- **A global counter rather than per-source.** Rejected outright: it *is* the lockout —
  any attacker anywhere can spend the whole board's allowance and the operator is the one
  who waits.
- **Hard lockout after N failures.** Rejected for the reason in Decision (3): the operator
  is the person who would have to clear it, from a board they can no longer reach.
- **A source-only key (no account dimension).** Rejected after the re-review: it let any
  valid credential refund another account's guesses — see the amendment note above.
