# @jinn-network/indexer — production OCI image.
#
# Build context is the monorepo `packages/` directory (NOT packages/indexer/),
# because the indexer depends on @jinn-network/benchmarking-records via
# `portal:../benchmarking/records`, which resolves to a sibling directory
# outside packages/indexer/ (records itself depends on
# @jinn-network/task-execution-protocol via `portal:../../task-execution/protocol`
# and @jinn-network/trust-core via `portal:../../trust/core`).
# Both packages' exports maps point at compiled dist/*.js, and dist/ is
# gitignored, so both are built inside this image, in dependency order,
# before the indexer install resolves the portal symlink.
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

# Build @jinn-network/task-execution-protocol first (§7.8 cross-tree portal
# precedent, see benchmarking-ci.yml's `records` job). benchmarking-records'
# `portal:../../task-execution/protocol` dependency is a symlink to
# /app/task-execution/protocol, so its dist/ must exist before the records
# install, and must survive into the runtime stage (the symlink is followed
# at runtime).
WORKDIR /app/task-execution/protocol
COPY task-execution/protocol/package.json task-execution/protocol/yarn.lock task-execution/protocol/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY task-execution/protocol/tsconfig.json task-execution/protocol/tsconfig.build.json ./
COPY task-execution/protocol/scripts ./scripts
COPY task-execution/protocol/src ./src
RUN yarn build

# Build @jinn-network/trust-core before benchmarking-records. Signed Report v2
# parsing is part of the records public surface, so the records portal resolves
# this sibling during its own build and at runtime.
WORKDIR /app/trust/core
COPY trust/core/package.json trust/core/yarn.lock trust/core/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY trust/core/tsconfig.json trust/core/tsconfig.build.json ./
COPY trust/core/scripts ./scripts
COPY trust/core/src ./src
RUN yarn build

# Build @jinn-network/benchmarking-records next. The indexer's
# `portal:../benchmarking/records` dependency is a symlink to
# /app/benchmarking/records, so its dist/ must exist before the indexer
# install and must survive into the runtime stage (the symlink is followed
# at runtime).
WORKDIR /app/benchmarking/records
COPY benchmarking/records/package.json benchmarking/records/yarn.lock benchmarking/records/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable
COPY benchmarking/records/tsconfig.json benchmarking/records/tsconfig.build.json ./
COPY benchmarking/records/scripts ./scripts
COPY benchmarking/records/src ./src
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

# Copy the built cross-tree portal dependencies so the indexer's
# `portal:../benchmarking/records` symlink, and records' own
# `portal:../../task-execution/protocol` symlink, resolve at runtime
# (node_modules/@jinn-network/benchmarking-records → ../benchmarking/records
# → /app/benchmarking/records/dist).
COPY --from=build /app/task-execution/protocol /app/task-execution/protocol
COPY --from=build /app/trust/core /app/trust/core
COPY --from=build /app/benchmarking/records /app/benchmarking/records

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
CMD DATABASE_SCHEMA="$(node deploy/derive-schema.mjs)" && export DATABASE_SCHEMA && exec node node_modules/ponder/dist/esm/bin/ponder.js start --views-schema=jinn_indexer
