# @jinn-network/indexer — production OCI image.
#
# Build (from packages/indexer/):
#   docker build -t jinn-indexer:latest -f deploy/Dockerfile .
#
# Run (Postgres backend, all required env via .env):
#   docker run --env-file deploy/.env -p 42069:42069 jinn-indexer:latest
#
# See deploy/README.md for production deployment guidance, including the
# DATABASE_SCHEMA views pattern for zero-downtime rolling deploys.

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build

ARG JINN_INDEXER_COMMIT=unknown
ENV JINN_INDEXER_COMMIT=$JINN_INDEXER_COMMIT

WORKDIR /app

# Copy dependency manifests first for layer caching. The Yarn version is pinned
# by the `packageManager` field in package.json, so `corepack enable` resolves
# it without a vendored `.yarn/` cache or `.yarnrc.yml`.
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --immutable

# Copy source.
COPY ponder.config.ts ponder.schema.ts tsconfig.json ./
COPY abis ./abis
COPY src ./src

# Ponder codegen (regenerates ponder-env.d.ts; validates schema).
RUN yarn codegen

# Build the explorer SPA; output goes to /app/public/.
COPY explorer ./explorer
RUN cd explorer && corepack yarn install && corepack yarn build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim

ARG JINN_INDEXER_COMMIT=unknown
ENV JINN_INDEXER_COMMIT=$JINN_INDEXER_COMMIT
ENV NODE_ENV=production

WORKDIR /app

# Copy built tree from build stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/yarn.lock ./
COPY --from=build /app/ponder.config.ts /app/ponder.schema.ts /app/tsconfig.json ./
COPY --from=build /app/ponder-env.d.ts ./
COPY --from=build /app/abis ./abis
COPY --from=build /app/src ./src
COPY --from=build /app/public ./public

EXPOSE 42069

# `ponder start` runs both the indexer and the HTTP server (GraphQL + built-in
# /health and /ready endpoints). For HTTP-only replicas behind a proxy, use
# `ponder serve` instead — see Ponder's "Horizontal scaling" docs.
CMD ["yarn", "start"]
