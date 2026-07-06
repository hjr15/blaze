# blaze board — zero-dependency Node app. Data (projects/ + .git) is bind-mounted
# at runtime, NOT baked. git is required: commit-on-edit shells out to it.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
RUN apk add --no-cache git
WORKDIR /app
COPY package.json ./
# No blaze.config.json here — engine and data are separate (the engine/data
# split): the data repo (blaze.config.json + projects/ + its own .git) is
# bind-mounted at runtime, not baked into the image. Point resolveRoots() at it
# with BLAZE_PROJECTS_DIR, or mount it at /app so ./projects resolves directly.
COPY scripts/ ./scripts/
# node:alpine ships a uid-1000 `node` user; match the laptop owner so the
# bind-mounted .git/projects are writable and git raises no dubious-ownership.
USER node
EXPOSE 4321
CMD ["node", "scripts/serve.mjs"]
