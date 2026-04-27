# @jinn-network/client — OCI image
#
# Build from the client/ directory:
#   docker build -t jinn-client .
#
# Run:
#   docker run -e JINN_PASSWORD=secret jinn-client run
#   docker run jinn-client version --json
#   docker run jinn-client doctor --json

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

# Install build essentials for native addons (better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests first for layer caching
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install --immutable

# Copy source and bundled deployment artifacts
COPY src/ src/
COPY deployments/ deployments/
COPY scripts/ scripts/
COPY tsconfig.json ./

# Build TypeScript
RUN yarn build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime
# git and curl are often required by agent tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 git curl \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI globally so the daemon can spawn it
RUN npm install -g @anthropic-ai/claude-code

# Claude Code writes its main config to $HOME/.claude.json, but docker-compose
# mounts the auth volume at $HOME/.claude (the directory). Without this symlink
# .claude.json lives on the ephemeral overlay fs and is wiped on every
# `docker compose run --rm`, forcing a fresh `claude auth login` each run.
# The symlink redirects the file into the mounted directory so the OAuth
# token persists in the named volume.
RUN mkdir -p /root/.claude && ln -sf /root/.claude/claude.json /root/.claude.json

# Copy only what's needed to run
COPY --from=build /app/dist dist/
COPY --from=build /app/deployments deployments/
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/package.json ./

# Default data directory inside the container
ENV NODE_ENV=production
ENV JINN_EARNING_DIR=/data/earning
ENV JINN_DB_PATH=/data/jinn.db

# Expose API port
EXPOSE 7331

# Data volume for keystore, state, and database
VOLUME ["/data"]

ENTRYPOINT ["node", "dist/bin/jinn.js"]
CMD ["run"]
