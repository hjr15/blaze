# blaze board — zero-dependency Node app. Data (projects/ + .git) is bind-mounted
# at runtime, NOT baked. git is required: commit-on-edit shells out to it.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43
RUN apk add --no-cache git
WORKDIR /app
COPY package.json ./
COPY scripts/ ./scripts/
# No blaze.config.json here — engine and data are separate (the engine/data
# split): the data repo (blaze.config.json + projects/ + its own .git) is
# bind-mounted at runtime, not baked into the image. Do NOT mount the data
# repo at /app — that hides the image's own scripts/ (serve.mjs et al) and
# the container fails with "Cannot find module '/app/scripts/serve.mjs'".
# Mount it at its own path instead and let BLAZE_PROJECTS_DIR (defaulted
# below) point resolveRoots() at it:
#   docker run -v <data-repo>:/data -p 4321:4321 <image>
ENV BLAZE_PROJECTS_DIR=/data/projects
# serve.mjs binds HOST || 127.0.0.1 by default, which is loopback *inside*
# the container netns — unreachable via a published -p port from the host.
# Bind all interfaces here; host-level exposure is still gated by -p.
#
# BLZ-348 made ADR-0013's bind check actually run, and 0.0.0.0 is precisely the
# case it was written to refuse — so a container with no users exited 1 at startup
# rather than serving an unauthenticated board with every mutating route open to
# whatever could reach the published port.
#
# BLZ-358 REPLACED THAT REFUSAL, as the earlier note here said it would. The
# container now STARTS and serves a first-run setup flow, and NOTHING ELSE: every
# other route answers 503 until an admin exists. The security property is the same
# one the refusal bought — the board is never served unauthenticated on an
# interface something else can reach — and the operator gets a way forward instead
# of an exit code, which matters because a container has no TTY and `blaze init`'s
# wizard cannot prompt anyone here.
#
#   docker run -v <data-repo>:/data -p 4321:4321 <image>
#
# On first start the server writes a one-time token to <data>/.blaze/setup-token at
# mode 0600 and logs only its PATH. Read it off disk on the host and enter it at
# http://localhost:4321/setup. The VALUE is never logged — `docker logs` is shipped
# off-box by any log aggregator, and a token that lands there has to be rotated.
# Completing setup creates the admin through the same code path as
# `blaze user add`, removes the token file, and the setup route then 404s.
#
# Two alternatives, both still supported:
#
#   1. Bring an identity. Create it against the data repo on the host —
#        blaze user add --email you@example.com --role admin
#      (or blaze init --admin-email=you@example.com on a new board)
#      — which writes <data>/.blaze/identity.db. The bind-mount carries it in, and
#      every /api/* call then needs Authorization: Bearer blz_…
#
#   2. Or keep the container loopback-only and publish nothing:
#        docker run -v <data-repo>:/data -e HOST=127.0.0.1 --network host <image>
#
# `-p` alone is NOT a credential and never was; it is a routing decision made by
# whoever runs the container, and a wrong one is silent. See docs/architecture.md
# — HTTP surface.
#
# A READ-ONLY data mount cannot hold a setup token, so there is no setup flow to
# offer and the original refusal stands, saying why. Use option 1 or 2 there.
#
# A read-only data mount is supported and encouraged for a read-only board:
#   docker run -v <data-repo>:/data:ro -p 4321:4321 <image>
# Authentication works there — the last-used token stamp is best-effort and a
# failure to write it never fails a request, let alone the process.
ENV HOST=0.0.0.0
# node:alpine ships a uid-1000 `node` user; match the laptop owner so the
# bind-mounted .git/projects are writable and git raises no dubious-ownership.
USER node
EXPOSE 4321
CMD ["node", "scripts/serve.mjs"]
