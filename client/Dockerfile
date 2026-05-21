# @jinn-network/client — OCI image
#
# Build from the repository root:
#   docker build -f client/Dockerfile -t jinn-client .
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

# Copy dependency manifests first for layer caching. The client depends on the
# mono checkout's SDK package through a Yarn portal, so Docker builds use the
# repository root as their build context.
COPY client/package.json client/yarn.lock client/.yarnrc.yml ./client/
COPY client/src/dashboard/spa/package.json ./client/src/dashboard/spa/package.json
COPY packages/sdk/package.json packages/sdk/yarn.lock packages/sdk/README.md ./packages/sdk/
RUN corepack enable && cd client && yarn install --immutable

# Copy SDK sources before the client build; `yarn build` builds the SDK first.
COPY packages/sdk/tsconfig.json ./packages/sdk/
COPY packages/sdk/src/ ./packages/sdk/src/

# Copy source and bundled deployment artifacts. `client/docs/` is needed at
# build time because the /build SPA page (hfmf) embeds `quickstart.md` via a
# Vite `?raw` import — `client/src/dashboard/spa/src/pages/build/IntroCard.tsx`
# resolves `../../../../../../docs/build/quickstart.md` relative to itself,
# which lands at `/app/client/docs/build/quickstart.md` inside the build stage.
COPY client/src/ ./client/src/
COPY client/deployments/ ./client/deployments/
COPY client/docs/ ./client/docs/
COPY client/plugins/ ./client/plugins/
COPY client/scripts/ ./client/scripts/
COPY client/templates/ ./client/templates/
COPY client/tsconfig.json ./client/

# Build TypeScript
WORKDIR /app/client
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
COPY --from=build /app/client/dist dist/
COPY --from=build /app/client/deployments deployments/
COPY --from=build /app/client/plugins plugins/
COPY --from=build /app/client/node_modules node_modules/
COPY --from=build /app/client/package.json ./

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
