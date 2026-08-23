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
# BLZ-348: that reasoning is unchanged and still correct. What changed is that
# ADR-0013's bind check is now actually CALLED, and 0.0.0.0 is precisely the
# case it was written to refuse. A container started with no users configured
# therefore exits 1 at startup with the two fixes named, rather than serving an
# unauthenticated board with every mutating route open to whatever can reach the
# published port. That refusal is the point of the image change, not a
# regression in it. Two supported ways to run it:
#
#   1. Bring an identity. Create it once against the data repo on the host —
#        blaze user add --email you@example.com --role admin
#      — which writes <data>/.blaze/identity.db. The bind-mount at /data carries
#      it in, and every /api/* call then needs Authorization: Bearer blz_…
#
#   2. Or keep the container loopback-only and publish nothing:
#        docker run -v <data-repo>:/data -e HOST=127.0.0.1 --network host <image>
#
# `-p` alone is NOT a credential and never was; it is a routing decision made by
# whoever runs the container, and a wrong one is silent. See docs/architecture.md
# — HTTP surface.
ENV HOST=0.0.0.0
# node:alpine ships a uid-1000 `node` user; match the laptop owner so the
# bind-mounted .git/projects are writable and git raises no dubious-ownership.
USER node
EXPOSE 4321
CMD ["node", "scripts/serve.mjs"]
