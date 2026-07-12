# @jinn-network/indexer — production OCI image.
#
# Build context is the monorepo `packages/` directory (NOT packages/indexer/),
# because the indexer depends on @jinn-network/sdk via `portal:../sdk`, which
# resolves to a sibling directory outside packages/indexer/. The SDK's exports
# map points at compiled dist/*.js, and dist/ is gitignored, so the SDK is built
# inside this image before the indexer install resolves the portal symlink.
#
# Build (from packages/):
#   docker build -t jinn-indexer:latest -f indexer/deploy/Dockerfile .
#
# Run (Postgres backend, all required env via .env):
#   docker run --env-file indexer/deploy/.env -p 42069:42069 jinn-indexer:latest
#
# See deploy/README.md for production deployment guidance, including the
# DATABASE_SCHEMA views pattern for zero-downtime rolling deploys.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

ARG JINN_INDEXER_COMMIT=unknown
ENV JINN_INDEXER_COMMIT=$JINN_INDEXER_COMMIT

ENV YARN_NODE_LINKER=node-modules

# Build @jinn-network/sdk first. The indexer's `portal:../sdk` dependency is a
# symlink to /app/sdk, so its dist/ must exist before the indexer install and
# must survive into the runtime stage (the symlink is followed at runtime).
WORKDIR /app/sdk
COPY sdk/package.json sdk/yarn.lock sdk/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY sdk/tsconfig.json ./
COPY sdk/src ./src
RUN yarn build

# ── Indexer ──
WORKDIR /app/indexer

# Copy dependency manifests first for layer caching. The Yarn version is pinned
# by the `packageManager` field in package.json, so `corepack enable` resolves
# it without a vendored `.yarn/` cache or `.yarnrc.yml`. The runtime stage
# copies node_modules directly, so force Yarn's node-modules linker in Docker.
COPY indexer/package.json indexer/yarn.lock ./
RUN corepack enable && yarn install --immutable

# Copy source.
COPY indexer/ponder.config.ts indexer/ponder.schema.ts indexer/tsconfig.json ./
COPY indexer/deploy/derive-schema.mjs ./deploy/derive-schema.mjs
COPY indexer/abis ./abis
COPY indexer/src ./src

# Ponder codegen (regenerates ponder-env.d.ts; validates schema).
RUN yarn codegen

# Build the explorer SPA; output goes to /app/indexer/public/.
COPY indexer/explorer ./explorer
RUN cd explorer && corepack yarn install && corepack yarn build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_INDEXER_COMMIT=unknown
ENV JINN_INDEXER_COMMIT=$JINN_INDEXER_COMMIT
ENV NODE_ENV=production
ENV YARN_NODE_LINKER=node-modules

WORKDIR /app/indexer

# Copy the built SDK so the indexer's `portal:../sdk` symlink resolves at
# runtime (node_modules/@jinn-network/sdk → ../sdk → /app/sdk/dist).
COPY --from=build /app/sdk /app/sdk

# Copy built tree from build stage.
COPY --from=build /app/indexer/node_modules ./node_modules
COPY --from=build /app/indexer/package.json /app/indexer/yarn.lock ./
COPY --from=build /app/indexer/ponder.config.ts /app/indexer/ponder.schema.ts /app/indexer/tsconfig.json ./
COPY --from=build /app/indexer/deploy/derive-schema.mjs ./deploy/derive-schema.mjs
COPY --from=build /app/indexer/ponder-env.d.ts ./
COPY --from=build /app/indexer/abis ./abis
COPY --from=build /app/indexer/src ./src
COPY --from=build /app/indexer/public ./public

EXPOSE 42069

# `ponder start` runs both the indexer and the HTTP server (GraphQL + built-in
# /health and /ready endpoints). For HTTP-only replicas behind a proxy, use
# `ponder serve` instead — see Ponder's "Horizontal scaling" docs.
#
# DATABASE_SCHEMA is auto-derived at boot from a content hash of
# ponder.schema.ts (deploy/derive-schema.mjs, issue #1429): an unchanged schema
# resumes in place, and any onchainTable change lands in a fresh
# `jinn_indexer_<hash>` data schema automatically — no manual Railway bump.
# `--views-schema=jinn_indexer` swaps the public-facing `jinn_indexer` views
# onto that data schema on /ready (Ponder's zero-downtime views pattern). A
# hash-named data schema can never equal the literal `jinn_indexer` views
# schema, so they cannot collide. Set JINN_INDEXER_SCHEMA_AUTO=false +
# DATABASE_SCHEMA to pin a name (must match on the enrichment worker too).
# See deploy/README.md.
CMD export DATABASE_SCHEMA="$(node deploy/derive-schema.mjs)" && exec node node_modules/ponder/dist/esm/bin/ponder.js start --views-schema=jinn_indexer
