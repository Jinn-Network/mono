# @jinn-network/indexer-enrichment — production OCI image (#779).
#
# Build context is the monorepo `packages/` directory (NOT
# packages/indexer-enrichment/), because the worker depends on
# @jinn-network/indexer via `portal:../indexer`, which itself portal-links
# @jinn-network/sdk. Both siblings live outside packages/indexer-enrichment/,
# so they must be COPYed into the build context. Modelled on the indexer's
# Dockerfile (the portal-sibling pattern), not claim-relayer's (which is
# fully standalone).
#
# The worker consumes the indexer's TS SOURCE through the indexer's `exports`
# map (./enrichment-parse, ./ipfs) at BUILD time. esbuild INLINES those modules
# into dist/index.js (#779 FIX 2), so the RUNTIME stage carries only the bundle
# + the worker's external node_modules (pg, drizzle-orm) — it depends on neither
# Node's experimental `.ts` type-stripping nor the indexer source tree. The
# indexer src tree therefore stays in the build stage only.
#
# Build (from packages/):
#   docker build -t jinn-enrichment-worker:latest -f indexer-enrichment/deploy/Dockerfile .
#
# Run (Postgres backend, all required env via .env):
#   docker run --env-file indexer-enrichment/deploy/.env -p 8738:8738 jinn-enrichment-worker:latest
#
# See packages/indexer-enrichment/README.md for the shared-schema coupling and
# the O2/O3/O4 deploy caveats.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

ARG JINN_ENRICHMENT_COMMIT=unknown
ENV JINN_ENRICHMENT_COMMIT=$JINN_ENRICHMENT_COMMIT

ENV YARN_NODE_LINKER=node-modules

# Hydrate the indexer's complete local record dependency closure first. The
# enrichment bundle does not import these modules, but Yarn must still resolve
# every portal in the indexer manifest during its immutable install.
WORKDIR /app/task-execution/protocol
COPY task-execution/protocol/package.json task-execution/protocol/yarn.lock task-execution/protocol/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY task-execution/protocol/tsconfig.json task-execution/protocol/tsconfig.build.json ./
COPY task-execution/protocol/scripts ./scripts
COPY task-execution/protocol/src ./src
RUN yarn build

WORKDIR /app/trust/core
COPY trust/core/package.json trust/core/yarn.lock trust/core/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY trust/core/tsconfig.json trust/core/tsconfig.build.json ./
COPY trust/core/scripts ./scripts
COPY trust/core/src ./src
RUN yarn build

WORKDIR /app/benchmarking/records
COPY benchmarking/records/package.json benchmarking/records/yarn.lock benchmarking/records/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY benchmarking/records/tsconfig.json benchmarking/records/tsconfig.build.json ./
COPY benchmarking/records/scripts ./scripts
COPY benchmarking/records/src ./src
RUN yarn build

# Build @jinn-network/sdk first. The indexer's `portal:../sdk` dependency is a
# symlink to /app/sdk; its dist/ must exist before the indexer/worker installs
# resolve the portal, and must survive into the runtime stage.
WORKDIR /app/sdk
COPY sdk/package.json sdk/yarn.lock sdk/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY sdk/tsconfig.json ./
COPY sdk/src ./src
RUN yarn build

# The worker portal-links @jinn-network/indexer and consumes its TS source via
# the indexer's exports map (./enrichment-parse, ./ipfs). The indexer install
# resolves its own `portal:../sdk`, so copy the indexer's manifest + the source
# files the worker imports. No indexer build is needed — esbuild (Bundler
# resolution) reads the .ts sources directly through the portal and inlines them.
WORKDIR /app/indexer
COPY indexer/package.json indexer/yarn.lock ./
RUN corepack enable && yarn install --immutable
COPY indexer/ponder.schema.ts indexer/tsconfig.json ./
COPY indexer/deploy/derive-schema.mjs ./deploy/derive-schema.mjs
COPY indexer/src ./src

# ── Worker ──
WORKDIR /app/indexer-enrichment

# Install with the indexer portal already present at /app/indexer.
COPY indexer-enrichment/package.json indexer-enrichment/yarn.lock indexer-enrichment/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable

# Bundle the worker to dist/index.js (esbuild inlines the @jinn-network/* portal
# .ts sources — see scripts/build.mjs).
COPY indexer-enrichment/tsconfig.json ./
COPY indexer-enrichment/scripts ./scripts
COPY indexer-enrichment/src ./src
RUN yarn build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_ENRICHMENT_COMMIT=unknown
ENV JINN_ENRICHMENT_COMMIT=$JINN_ENRICHMENT_COMMIT
ENV NODE_ENV=production
ENV YARN_NODE_LINKER=node-modules

WORKDIR /app/indexer-enrichment

# The runtime needs ONLY the bundle + the worker's external node_modules (pg,
# drizzle-orm). The `@jinn-network/*` source is already inlined into dist/index.js
# by esbuild, so the indexer/sdk sibling trees are NOT copied into runtime. The
# worker's node_modules still carries a portal symlink to ../indexer, but nothing
# resolves it at runtime (the bundle is self-contained), so a dangling symlink is
# harmless.
COPY --from=build /app/indexer-enrichment/node_modules ./node_modules
COPY --from=build /app/indexer-enrichment/package.json /app/indexer-enrichment/yarn.lock ./
COPY --from=build /app/indexer-enrichment/dist ./dist

# The worker writes into the indexer's Ponder schema, so it MUST derive the same
# DATABASE_SCHEMA as the indexer. Both services COPY the byte-identical
# indexer/ponder.schema.ts + deploy/derive-schema.mjs and run the same hash, so
# the two names match (issue #1429). `../ponder.schema.ts` in derive-schema.mjs
# resolves to /app/indexer-enrichment/ponder.schema.ts, so it sits next to the
# script's ./deploy/ dir just like in the indexer image.
COPY --from=build /app/indexer/ponder.schema.ts ./ponder.schema.ts
COPY --from=build /app/indexer/deploy/derive-schema.mjs ./deploy/derive-schema.mjs

EXPOSE 8738

# Fail-loud boot: a DB-connect failure exits non-zero so Railway ON_FAILURE
# restarts (the #1068 lesson). /ready gates traffic until the schema resolves.
# DATABASE_SCHEMA is auto-derived from the shared ponder.schema.ts hash so it
# always matches the indexer's data schema; JINN_INDEXER_SCHEMA_AUTO=false +
# DATABASE_SCHEMA pins a name (set the SAME pair on both services).
CMD DATABASE_SCHEMA="$(node deploy/derive-schema.mjs)" && export DATABASE_SCHEMA && exec node dist/index.js
