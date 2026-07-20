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

# Copy dependency manifests first for layer caching. The client resolves the
# mono checkout's SDK, core, plugin, and layer packages through Yarn portals,
# so Docker builds use the repository root as their build context.
COPY client/package.json client/yarn.lock client/.yarnrc.yml ./client/
COPY client/src/dashboard/spa/package.json ./client/src/dashboard/spa/package.json
COPY packages/sdk/package.json packages/sdk/yarn.lock packages/sdk/.yarnrc.yml packages/sdk/README.md ./packages/sdk/
COPY packages/core/package.json packages/core/yarn.lock packages/core/.yarnrc.yml ./packages/core/
COPY packages/plugin/package.json packages/plugin/yarn.lock packages/plugin/.yarnrc.yml packages/plugin/process-contract.json ./packages/plugin/
COPY packages/layer/package.json packages/layer/yarn.lock packages/layer/.yarnrc.yml ./packages/layer/
RUN corepack enable && cd client && yarn install --immutable

# Copy portal-package sources before the client build; `yarn build` builds them
# in dependency order before compiling the client.
COPY packages/sdk/tsconfig.json ./packages/sdk/
COPY packages/sdk/src/ ./packages/sdk/src/
COPY packages/plugin/tsconfig.json ./packages/plugin/
COPY packages/plugin/src/ ./packages/plugin/src/
COPY packages/core/tsconfig.json ./packages/core/
COPY packages/core/src/ ./packages/core/src/
COPY packages/layer/tsconfig.json ./packages/layer/
COPY packages/layer/src/ ./packages/layer/src/

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
COPY client/tsconfig.json client/tsconfig.jinn-layer-entry.json ./client/

# Build TypeScript
WORKDIR /app/client
RUN yarn build

# Portal links are valid only in the repository layout. Replace the bundled
# core/plugin links with their publish-shaped runtime directories before
# node_modules crosses into the final image.
RUN node scripts/materialize-bundled-workspaces.mjs prepare

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_BUILD_COMMIT=unknown
ENV JINN_BUILD_COMMIT=$JINN_BUILD_COMMIT

WORKDIR /app

# better-sqlite3 needs libstdc++ at runtime; git and curl are often required by
# agent tools. gosu lets the base entrypoint drop root → node at boot (see
# docker-entrypoint.sh); ca-certificates is needed for TLS once non-root.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 git curl ca-certificates gosu \
    && rm -rf /var/lib/apt/lists/*

# Claude CLI for the default claude-code harness. Pinned to the version verified
# in the #952 launcher spike (env-only CLAUDE_CODE_OAUTH_TOKEN auth confirmed at
# this version). claude-code stays in the base on purpose: this is the runnable
# claude/compose default image, and the operator launches it directly. The codex
# overlay (S8) adds its own CLI on top of this base.
RUN npm install -g @anthropic-ai/claude-code@2.1.159

# The daemon runs as the non-root `node` user (uid 1000, already present in the
# node:22-slim base): Claude Code refuses --dangerously-skip-permissions when
# running as root. Pre-create node's home + .claude dir so the CLI can write its
# session/config state; the entrypoint chowns $JINN_STATE_DIR and drops root →
# node. Auth is env-based by default (CLAUDE_CODE_OAUTH_TOKEN) — compose users
# who prefer file-auth mount their token at /home/node/.claude.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node

# Copy only what's needed to run
COPY --from=build /app/client/dist dist/
COPY --from=build /app/client/deployments deployments/
COPY --from=build /app/client/plugins plugins/
COPY --from=build /app/client/node_modules node_modules/
COPY --from=build /app/client/package.json ./

# Single volume-aware durable-state root (S3). The daemon derives earningDir,
# dbPath, and engine.impl-state under this when they are not set explicitly, so
# one ENV replaces the former per-key JINN_EARNING_DIR / JINN_DB_PATH lines.
ENV NODE_ENV=production
ENV JINN_STATE_DIR=/data

# Base-contract version (#1066): the contract that overlays depend on. Contract
# 1 == the #988 entrypoint dispatch that exec's an absolute-path CMD[0] (an
# overlay seed script) as-is. Overlay seed scripts read this and fail loud if a
# base is too old, turning future contract drift into a clear message instead of
# a cryptic "Unknown verb" crash. Bump only when the entrypoint contract changes.
ENV JINN_BASE_CONTRACT=1

# Expose API port
EXPOSE 7331

# NOTE: no `VOLUME ["/data"]` — Railway rejects the Dockerfile directive, and a
# baked VOLUME also masks the entrypoint's chown on some runtimes. Attach the
# /data volume at the service level instead: `docker run -v jinn-data:/data`,
# a compose-file `volumes:` mount, or `railway volume add --mount-path /data`.

# Base entrypoint: a gosu privilege-drop wrapper (chowns $JINN_STATE_DIR then
# re-execs itself as the node user). It is deliberately minimal — no pidfile
# cleanup, no dotfile pruning, no state seeding (the daemon owns those now per
# S1/S2/S3). Its final dispatch is back-compatible: a bare jinn subcommand
# (run/version/doctor) gets the `node dist/bin/jinn.js` prefix, preserving the
# historical `docker run IMAGE version` contract; an absolute-path/node/sh/bash
# first arg is exec'd as-is, so an S8 overlay passes its own seeding script as
# the CMD (e.g. ["/usr/local/bin/seed.sh","run"]) without replacing this entrypoint.
COPY client/docker-entrypoint.sh /usr/local/bin/jinn-entrypoint.sh
RUN chmod +x /usr/local/bin/jinn-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/jinn-entrypoint.sh"]
CMD ["run"]
