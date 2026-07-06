# blaze board — zero-dependency Node app. Data (projects/ + .git) is bind-mounted
# at runtime, NOT baked. git is required: commit-on-edit shells out to it.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
RUN apk add --no-cache git
WORKDIR /app
COPY package.json ./
# blaze.config.json is app-structural config (projects list, key, board title):
# loadConfig() defaults projects to [] without it, so the board would render no
# project columns. Bake it (not live-edited data — it stays with the image).
COPY blaze.config.json ./
COPY scripts/ ./scripts/
# node:alpine ships a uid-1000 `node` user; match the laptop owner so the
# bind-mounted .git/projects are writable and git raises no dubious-ownership.
USER node
EXPOSE 4321
CMD ["node", "scripts/serve.mjs"]
