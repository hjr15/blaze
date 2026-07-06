# blaze board — zero-dependency Node app. Data (projects/ + .git) is bind-mounted
# at runtime, NOT baked. git is required: commit-on-edit shells out to it.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
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
ENV HOST=0.0.0.0
# node:alpine ships a uid-1000 `node` user; match the laptop owner so the
# bind-mounted .git/projects are writable and git raises no dubious-ownership.
USER node
EXPOSE 4321
CMD ["node", "scripts/serve.mjs"]
