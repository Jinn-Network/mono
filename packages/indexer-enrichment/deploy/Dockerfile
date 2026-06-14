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
# Unlike the indexer, the worker consumes the indexer's TS SOURCE through the
# indexer's `exports` map (./schema, ./enrichment-parse, ./ipfs) — those files
# are not built to dist, so the indexer source tree must survive into the
# runtime stage alongside the worker's compiled dist/.
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
# the indexer's exports map (./schema, ./enrichment-parse, ./ipfs). The indexer
# install resolves its own `portal:../sdk`, so copy the indexer's manifest +
# the source files the worker imports. No indexer build is needed — the worker's
# tsc (Bundler resolution) reads the .ts sources directly through the portal.
WORKDIR /app/indexer
COPY indexer/package.json indexer/yarn.lock ./
RUN corepack enable && yarn install --immutable
COPY indexer/ponder.schema.ts indexer/tsconfig.json ./
COPY indexer/src ./src

# ── Worker ──
WORKDIR /app/indexer-enrichment

# Install with the indexer portal already present at /app/indexer.
COPY indexer-enrichment/package.json indexer-enrichment/yarn.lock indexer-enrichment/.yarnrc.yml ./
RUN corepack enable && yarn install --immutable

# Compile the worker to dist/.
COPY indexer-enrichment/tsconfig.json ./
COPY indexer-enrichment/src ./src
RUN yarn build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_ENRICHMENT_COMMIT=unknown
ENV JINN_ENRICHMENT_COMMIT=$JINN_ENRICHMENT_COMMIT
ENV NODE_ENV=production
ENV YARN_NODE_LINKER=node-modules

WORKDIR /app/indexer-enrichment

# The portal symlinks are followed at runtime, so the sibling trees must be
# present. sdk → its built dist; indexer → its manifest + the TS sources the
# worker imports via the exports map.
COPY --from=build /app/sdk /app/sdk
COPY --from=build /app/indexer/package.json /app/indexer/yarn.lock /app/indexer/ponder.schema.ts /app/indexer/tsconfig.json /app/indexer/
COPY --from=build /app/indexer/src /app/indexer/src
COPY --from=build /app/indexer/node_modules /app/indexer/node_modules

# Worker's built tree + resolved node_modules (which contains the portal symlink
# node_modules/@jinn-network/indexer → ../indexer).
COPY --from=build /app/indexer-enrichment/node_modules ./node_modules
COPY --from=build /app/indexer-enrichment/package.json /app/indexer-enrichment/yarn.lock ./
COPY --from=build /app/indexer-enrichment/dist ./dist

EXPOSE 8738

# Fail-loud boot: a DB-connect failure exits non-zero so Railway ON_FAILURE
# restarts (the #1068 lesson). /ready gates traffic until the schema resolves.
CMD ["node", "dist/index.js"]
