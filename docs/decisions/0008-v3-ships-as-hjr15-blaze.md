# 8. Blaze v3 ships as `@hjr15/blaze`; `@hjr15/blaze-board` freezes at 0.7.0

Date: 2026-08-20

## Status

Proposed (BLZ-263)

## Context

[ADR-0006](0006-database-is-the-sole-source-of-truth.md) removes the file-and-git
store. An existing user of `@hjr15/blaze-board` has a zero-dependency writer that
edits markdown in their own git repo and needs nothing running.

Shipping v3 as `@hjr15/blaze-board@1.0` would, on a routine major bump, convert
that into a client that requires a server. A semver major says "the API broke".
It does not say "the storage model you depend on no longer exists, and the thing
you keep if you walk away is no longer a git repo full of markdown". Those are
not the same promise, and one package name cannot carry both.

## Decision

Blaze v3 ships as **`@hjr15/blaze`** — confirmed unclaimed on npm, 2026-08-20.

`@hjr15/blaze-board` **freezes at 0.7.0** as the file-based line. Its README gains
a deprecation note pointing at `@hjr15/blaze` and stating plainly that v3 needs a
server.

> **Amended 2026-08-20.** This ADR first said "freezes at 0.6.0 … it is not
> republished". That was written before it was noticed that **no published version
> carried BLZ-251's fix** — 0.6.0 was cut at `f3ed8f7`, the fix landed at
> `2f19a03`, after it. Freezing at 0.6.0 would have frozen a known write-path bug
> into the only version anyone can install, for a board whose own config depends on
> exactly the override it breaks.
>
> So the line freezes **after one more release, 0.7.0**, and the freeze holds from
> there. The bump is a **minor, not a patch**, because `main` also carries BLZ-264
> raising `engines.node` from `>=20` to `>=24` — breaking for consumers, which in
> 0.x is signalled by the minor, exactly as the 0.6.0 release commit argued.
> Consumers who cannot move off Node 20 stay on 0.6.0 and do not get the fix; that
> is the honest cost of the runtime floor and it is not hidden behind a patch
> number.

The bare name already matches everything else in the estate — the repo
(`hjr15/blaze`), the CLI binary (`blaze`), the image (`ghcr.io/hjr15/blaze`) and
the deployed hostname (`blaze.howman.link`) — so it removes a naming
inconsistency rather than adding one. It also leaves `@hjr15/blaze-core`,
`@hjr15/blaze-config` and `@hjr15/blaze-query` free for the
[ADR-0007](0007-true-microservices-behind-one-api.md) service packages.

### Rejected

- **`@hjr15/blaze-server`** — names the breaking change most explicitly, but
  reads wrong for the `npx` + SQLite path, whose entire point is that there is no
  server to run. It would also collide conceptually with the eight service
  packages.
- **`@hjr15/blaze-stack`** — signals an umbrella of services, but is a coinage
  matching no existing repo, binary, image or hostname.
- **`@hjr15/blaze-board@1.0`** — the option this ADR exists to reject.

## Consequences

- Existing `@hjr15/blaze-board` users are **not** upgraded by accident. They stay
  on 0.7.0 (or 0.6.0, on Node 20) until they choose to move, and what they move to
  is visibly a different thing.
- Every consumer reference moves in one effort: `blaze-pm`'s `package.json` and
  `package-lock.json`, the service-platform chart, and the docs that name the
  package. Note BLZ-247 — the lockfile currently pins 0.4.1, so an `npm ci` there
  would downgrade past BLZ-251 before any rename lands.
- Two published names must be kept straight in docs and in support answers. The
  deprecation note is what keeps that cost bounded.
